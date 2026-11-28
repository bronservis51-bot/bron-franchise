create table app_private.royalty_checkout_hold (
  partner_id uuid not null references public.partner(id),
  month date not null check (isfinite(month) and extract(day from month)=1),
  primary key(partner_id,month)
);
alter table app_private.royalty_checkout_hold enable row level security;
revoke all on app_private.royalty_checkout_hold from public,anon,authenticated,service_role;

alter table public.royalty_payment
  add column provider_payment_id uuid unique,
  add column refunded_minor bigint not null default 0,
  add column external_source text,
  add column external_reference text,
  add constraint royalty_payment_external_document
    check ((external_source is null and external_reference is null) or
      (external_source is not null and external_source in ('cash','bank') and
       external_reference is not null and length(btrim(external_reference)) between 1 and 120)),
  add constraint royalty_payment_refund_amount
    check (refunded_minor between 0 and amount_minor and (refunded_minor=0 or provider_payment_id is not null));

-- The same partner lock serializes a new checkout with manual writes and pause.
-- A row lock serializes a queued checkout with the worker's first dispatch.
create unique index royalty_external_document on public.royalty_payment
  (partner_id,external_source,lower(btrim(external_reference))) where external_reference is not null;

create function app_private.royalty_lock_invoice_amount(p_partner uuid,p_month date,p_future boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a app_private.royalty_checkout_attempt;
begin
  perform pg_advisory_xact_lock(hashtextextended('royalty-checkout:'||p_partner,0));
  for a in
    select t.* from app_private.royalty_checkout_attempt t
    left join app_private.royalty_checkout_pilot pilot on pilot.partner_id=t.partner_id
    where t.partner_id=p_partner and t.status='open'
      and (p_month is null or t.month=p_month or (p_future and t.month>=p_month))
      and (t.invoice_shop_id is not null or (t.first_dispatch_at is null and pilot.invoice_shop_id is not null))
    order by t.id for update of t
  loop
    if a.first_dispatch_at is not null or a.provider_id is not null or a.recovery_provider_id is not null then
      perform app_private.fail('version-conflict','Открытый счёт ЮKassa ещё может быть оплачен. Приостановите оплату и дождитесь подтверждения отмены счёта.');
    end if;
    update app_private.royalty_checkout_attempt set status='canceled' where id=a.id;
  end loop;
end $$;
revoke all on function app_private.royalty_lock_invoice_amount(uuid,date,boolean) from public,anon,authenticated,service_role;

create function app_private.royalty_guard_invoice_amount() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p uuid; m date; old_month date;
begin
  if tg_table_name='royalty_payment' and tg_op='INSERT' then
    if exists(select 1 from app_private.royalty_checkout_attempt t
      where t.id=new.id and t.partner_id=new.partner_id and t.status='succeeded') then
      return new;
    end if;
  end if;

  if tg_op<>'INSERT' then
    if tg_table_name='daily_revenue' then
      old_month:=date_trunc('month',old.day)::date;
    elsif tg_table_name='royalty_rate' then
      old_month:=old.effective_from;
    elsif tg_table_name<>'partner' then
      old_month:=old.month;
    end if;
  end if;

  if tg_table_name='partner' then
    perform app_private.royalty_lock_invoice_amount(old.id,null);
  elsif tg_op='DELETE' then
    perform app_private.royalty_lock_invoice_amount(old.partner_id,old_month,tg_table_name='royalty_rate');
  else
    p:=new.partner_id;
    if tg_table_name='daily_revenue' then
      m:=date_trunc('month',new.day)::date;
    elsif tg_table_name='royalty_rate' then
      m:=new.effective_from;
    else
      m:=new.month;
    end if;
    if tg_op='UPDATE' and (old.partner_id,old_month) is distinct from (p,m) then
      perform app_private.royalty_lock_invoice_amount(old.partner_id,old_month,tg_table_name='royalty_rate');
    end if;
    perform app_private.royalty_lock_invoice_amount(p,m,tg_table_name='royalty_rate');
    if tg_table_name='royalty_payment' and tg_op='INSERT' then
      if new.external_reference is not null then
        if exists(select 1 from public.royalty_payment r join app_private.royalty_checkout_attempt t on t.id=r.id
          where r.partner_id=p and t.invoice_shop_id is not null and t.status='succeeded'
            and lower(btrim(new.external_reference)) in (r.provider_payment_id::text,lower(t.provider_id))) then
          perform app_private.fail('version-conflict','Используйте документ отдельного поступления. Платёж ЮKassa уже учтён.');
        end if;
        if exists(select 1 from public.royalty_payment r where r.partner_id=p and r.external_source=new.external_source
          and lower(btrim(r.external_reference))=lower(btrim(new.external_reference))) then
          perform app_private.fail('version-conflict','Оплата с таким платёжным документом уже внесена.');
        end if;
      elsif exists(select 1 from public.royalty_payment r join app_private.royalty_checkout_attempt t on t.id=r.id
        where r.partner_id=p and t.invoice_shop_id is not null and t.status='succeeded'
          and ((r.paid_on=new.paid_on and r.amount_minor=new.amount_minor) or
            (r.month=m and new.amount_minor>coalesce((select g.debt_minor
              from app_private.royalty_ledger(p) g where g.month=m),0)))) then
        perform app_private.fail('version-conflict','ЮKassa уже подтвердила оплату. Для отдельного поступления укажите способ и номер платёжного документа.');
      end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function app_private.royalty_guard_invoice_amount() from public,anon,authenticated,service_role;

create trigger royalty_guard_manager_payment before insert or delete on public.royalty_payment
for each row execute function app_private.royalty_guard_invoice_amount();
create trigger royalty_guard_manager_accrual before insert or update or delete on public.royalty_manual
for each row execute function app_private.royalty_guard_invoice_amount();
create trigger royalty_guard_rate_amount before insert or update or delete on public.royalty_rate
for each row execute function app_private.royalty_guard_invoice_amount();
create trigger royalty_guard_revenue_amount before insert or update or delete on public.daily_revenue
for each row execute function app_private.royalty_guard_invoice_amount();
create trigger royalty_guard_partner_amount before update on public.partner for each row
when ((old.royalty_from,old.royalty_holiday_from,old.currency) is distinct from
      (new.royalty_from,new.royalty_holiday_from,new.currency))
execute function app_private.royalty_guard_invoice_amount();

create function public.royalty_invoice_manage(p_partner uuid,p_month date,p_pause boolean default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a app_private.royalty_checkout_attempt;
  enabled boolean;
  paused boolean;
  changed boolean;
begin
  perform app_private.royalty_partner_check(p_partner);
  if p_month is null or not isfinite(p_month) or extract(day from p_month)<>1 then
    perform app_private.fail('validation','Выберите месяц роялти');
  end if;
  if p_pause is not null then
    perform pg_advisory_xact_lock(hashtextextended('royalty-checkout:'||p_partner,0));
  end if;
  enabled:=exists(select 1 from app_private.royalty_checkout_pilot where partner_id=p_partner and invoice_shop_id is not null)
    or exists(select 1 from app_private.royalty_checkout_attempt
      where partner_id=p_partner and month=p_month and invoice_shop_id is not null);
  if p_pause is true and enabled then
    insert into app_private.royalty_checkout_hold(partner_id,month) values(p_partner,p_month) on conflict do nothing;
    changed:=found;
    update app_private.royalty_checkout_attempt set status='canceled'
    where partner_id=p_partner and month=p_month and status='open' and first_dispatch_at is null
      and provider_id is null and recovery_provider_id is null;
  elsif p_pause is false then
    delete from app_private.royalty_checkout_hold where partner_id=p_partner and month=p_month;
    changed:=found;
  end if;
  if changed then
    perform app_private.audit('royalty.invoice_pause','partner',p_partner,p_partner,
      jsonb_build_object('month',p_month,'paused',p_pause));
  end if;
  paused:=exists(select 1 from app_private.royalty_checkout_hold where partner_id=p_partner and month=p_month);
  select * into a from app_private.royalty_checkout_attempt
    where partner_id=p_partner and month=p_month and (invoice_shop_id is not null or (first_dispatch_at is null and enabled))
    order by (status='open') desc,first_dispatch_at desc nulls first,next_check_at desc,id desc limit 1;
  return jsonb_build_object('enabled',enabled or a.invoice_shop_id is not null,'paused',paused,
    'state',case when a.status='open' then case when a.provider_id is null then 'checking' else 'pending' end
      else coalesce(a.status,'none') end,
    'invoice_id',a.provider_id,'needs_review',
    coalesce(a.status='open' and a.provider_id is null and a.first_dispatch_at is not null
      and (paused or a.first_dispatch_at<=now()-interval '23 hours'),false));
end $$;
revoke execute on function public.royalty_invoice_manage(uuid,date,boolean) from public,anon,service_role;
grant execute on function public.royalty_invoice_manage(uuid,date,boolean) to authenticated;
insert into app_private.client_command(fn) values ('public.royalty_invoice_manage(uuid,date,boolean)');

create or replace function app_private.royalty_checkout_card(p_request boolean,p_month date,p_amount_minor bigint) returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare
  actor uuid := app_private.require_user();
  partner uuid := app_private.royalty_checkout_owner(actor);
  quote jsonb;
  attempt app_private.royalty_checkout_attempt;
  period date;
begin
  if partner is null then perform app_private.fail('forbidden','Нужен доступ владельца к одному франчайзи'); end if;
  if p_request then perform pg_advisory_xact_lock(hashtextextended('royalty-checkout:'||partner,0)); end if;
  quote := app_private.royalty_checkout_balance(partner,actor,now());
  period := (quote->>'month')::date;
  if p_request and (p_month is distinct from period or p_amount_minor is null or p_amount_minor<=0
    or quote->>'currency' is distinct from 'RUB' or quote->>'state' not in ('payable','overdue')
    or p_amount_minor is distinct from (quote->>'amount_minor')::bigint) then
    perform app_private.fail('version-conflict','Сумма или месяц оплаты изменились. Обновите карточку роялти.');
  end if;
  if quote->>'amount_minor' is null then return quote; end if;
  if quote->>'state' in ('payable','overdue') and exists (
    select 1 from app_private.royalty_checkout_hold where partner_id=partner and month=period
  ) then
    if p_request then perform app_private.fail('version-conflict','Менеджер приостановил оплату роялти по ссылке.'); end if;
    return quote || jsonb_build_object('state','paused');
  end if;
  select * into attempt from app_private.royalty_checkout_attempt where partner_id=partner and month=period and status='open';
  if found then
    if attempt.checkout_url is not null and attempt.amount_minor=(quote->>'amount_minor')::bigint then
      return quote || jsonb_build_object('checkout_url',attempt.checkout_url);
    end if;
    return quote || jsonb_build_object('state','checking');
  end if;
  if p_request and quote->>'state' in ('overdue','payable') then
    if p_amount_minor<100 and exists (
      select 1 from app_private.royalty_checkout_pilot where partner_id=partner and use_invoice
    ) then perform app_private.fail('validation','Счёт ЮKassa можно выставить на сумму от 1 ₽.'); end if;
    if exists (
      select 1 from app_private.royalty_checkout_pilot pilot join public.partner p on p.id=pilot.partner_id
      where pilot.partner_id=partner and pilot.invoice_shop_id is not null
        and app_private.royalty_receipt_email(p.contact_email) is null
    ) then perform app_private.fail('validation','Для чека ЮKassa нужен действующий email. Обратитесь к управляющей компании.'); end if;
    insert into app_private.royalty_checkout_attempt(partner_id,month,amount_minor,requested_by,session_id)
    values (partner,period,(quote->>'amount_minor')::bigint,actor,
      (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid);
    return quote || jsonb_build_object('state','checking');
  end if;
  return quote;
end $$;

create or replace function app_private.royalty_ledger(p_partner uuid)
returns table (month date, revenue_minor bigint, rate_bp int, accrued_minor bigint, manual_minor bigint, paid_minor bigint,
  debt_minor bigint, is_open boolean)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with start as (
    select royalty_from as f, royalty_holiday_from as holiday from public.partner where id = p_partner
  ), months as (
    select date_trunc('month', day)::date as m from public.daily_revenue, start
      where partner_id = p_partner and (start.f is null or day >= start.f)
    union select month from public.royalty_manual where partner_id = p_partner
    union select month from public.royalty_payment where partner_id = p_partner
  ), rev as (
    select date_trunc('month', day)::date as m, sum(total_minor)::bigint as v,
      sum(total_minor) filter (where not app_private.royalty_holiday_day(day, start.holiday)) as billable from public.daily_revenue, start
      where partner_id = p_partner and (start.f is null or day >= start.f) group by 1
  ), x as (
    select m.m, coalesce(rev.v, 0) as revenue, coalesce(rev.billable, 0) as billable, app_private.rate_bp(p_partner, m.m) as bp,
      coalesce((select sum(amount_minor) from public.royalty_manual r where r.partner_id = p_partner and r.month is not distinct from m.m), 0)::bigint as manual,
      coalesce((select sum(r.amount_minor-r.refunded_minor) from public.royalty_payment r where r.partner_id = p_partner and r.month is not distinct from m.m), 0)::bigint as paid,
      coalesce(m.m >= app_private.current_month(), false) as open
    from months m left join rev on rev.m = m.m
  )
  select x.m, x.revenue, x.bp, round(x.billable * x.bp / 10000.0)::bigint, x.manual, x.paid,
    case when x.open then x.manual - x.paid else round(x.billable * x.bp / 10000.0)::bigint + x.manual - x.paid end,
    x.open
  from x order by x.m
$$;

create or replace function public.royalty_ops_v2(p_partner uuid default null, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  return coalesce((select jsonb_agg(t.x order by t.created_at desc) from (
    select * from (
      select r.created_at, jsonb_build_object('id', r.id, 'op', 'payment', 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'paid_on', r.paid_on, 'refunded_minor', r.refunded_minor,
        'provider_payment_id', r.provider_payment_id, 'external_source',r.external_source,
        'external_reference',r.external_reference, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by)) as x
      from public.royalty_payment r join public.partner p on p.id = r.partner_id where p_partner is null or r.partner_id = p_partner
      union all
      select r.created_at, jsonb_build_object('id', r.id, 'op', r.kind, 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by))
      from public.royalty_manual r join public.partner p on p.id = r.partner_id where p_partner is null or r.partner_id = p_partner
    ) u order by created_at desc limit greatest(1, least(p_limit, 200))) t), '[]'::jsonb);
end $$;

create function app_private.royalty_live_invoice_checkout_observe(p_id uuid,p_lease uuid,p_invoice_id text,
  p_status text,p_checkout_url text,p_paid_on date,p_payment_id uuid,p_refunded_minor bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a app_private.royalty_checkout_attempt;
begin
  select * into a from app_private.royalty_checkout_attempt
  where id=p_id and lease=p_lease and status='open' and lease_until>clock_timestamp() and invoice_shop_id is not null
  for update;
  if not found then return false; end if;
  if p_status='succeeded' then
    if p_payment_id is null or p_refunded_minor is null or p_refunded_minor not between 0 and a.amount_minor then
      raise exception 'invalid-payment-details';
    end if;
  elsif p_payment_id is not null or p_refunded_minor is not null then
    raise exception 'invalid-payment-details';
  end if;
  if not app_private.royalty_checkout_observe(p_id,p_lease,p_invoice_id,p_status,p_checkout_url,p_paid_on) then
    return false;
  end if;
  if p_status='succeeded' then
    update public.royalty_payment set provider_payment_id=p_payment_id,refunded_minor=p_refunded_minor where id=a.id;
    update app_private.royalty_checkout_attempt set next_check_at=now() where id=a.id;
  end if;
  return true;
end $$;
revoke all on function app_private.royalty_live_invoice_checkout_observe(uuid,uuid,text,text,text,date,uuid,bigint)
  from public,anon,authenticated,service_role;

create index royalty_checkout_refund_queue on app_private.royalty_checkout_attempt(invoice_shop_id,next_check_at,id)
where status='succeeded' and invoice_shop_id is not null;

create function app_private.royalty_live_refund_work(p_limit integer,p_shop_id text)
returns table(id uuid,lease uuid,month date,amount_minor bigint,provider_id text,payment_id uuid)
language plpgsql strict security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_limit not between 1 and 50 or p_shop_id !~ '^[0-9]+$' then raise exception 'invalid-refund-check'; end if;
  return query with due as (
    select a.id,r.provider_payment_id
    from app_private.royalty_checkout_attempt a join public.royalty_payment r on r.id=a.id
    where a.status='succeeded' and a.invoice_shop_id=p_shop_id and a.next_check_at<=now()
      and (a.lease_until is null or a.lease_until<=now()) and r.refunded_minor<r.amount_minor
    order by a.next_check_at,a.id limit p_limit for update of a skip locked
  )
  update app_private.royalty_checkout_attempt a set lease=gen_random_uuid(),lease_until=now()+interval '90 seconds'
  from due where a.id=due.id
  returning a.id,a.lease,a.month,a.amount_minor,a.provider_id,due.provider_payment_id;
end $$;
revoke all on function app_private.royalty_live_refund_work(integer,text) from public,anon,authenticated,service_role;

create function app_private.royalty_live_refund_observe(p_id uuid,p_lease uuid,p_payment_id uuid,p_refunded_minor bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a app_private.royalty_checkout_attempt;
begin
  select * into a from app_private.royalty_checkout_attempt where id=p_id and lease=p_lease
    and status='succeeded' and invoice_shop_id is not null and lease_until>clock_timestamp() for update;
  if not found then return false; end if;
  if p_payment_id is null or p_refunded_minor is null or p_refunded_minor not between 0 and a.amount_minor then
    raise exception 'invalid-refund-observation';
  end if;
  update public.royalty_payment set provider_payment_id=p_payment_id,refunded_minor=greatest(refunded_minor,p_refunded_minor)
    where id=a.id and (provider_payment_id is null or provider_payment_id=p_payment_id);
  if not found then raise exception 'invalid-refund-payment'; end if;
  update app_private.royalty_checkout_attempt set lease=null,lease_until=null,next_check_at=now()+interval '15 minutes'
    where id=a.id;
  return true;
end $$;
revoke all on function app_private.royalty_live_refund_observe(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;

create or replace function app_private.google_finance_rows(p_from date, p_through date)
returns table (
  partner_id uuid, partner text, point_id uuid, point text, month text, day text,
  currency text, minor_unit int, kind text, key text, category text, amount text, cash text, card text
)
language sql stable security definer
set search_path = pg_catalog, public, app_private, pg_temp as $$
  with daily as (
    select r.partner_id, r.location_id, date_trunc('month', r.day)::date as month, r.day,
      r.currency, 'revenue'::text as kind, 'revenue:' || r.location_id || ':' || r.day || ':' || r.currency as key,
      null::text as category, sum(r.total_minor) as amount,
      case when sum(r.unallocated_minor) < sum(r.total_minor) or sum(r.total_minor) = 0 then sum(r.cash_minor) end as cash,
      case when sum(r.unallocated_minor) < sum(r.total_minor) or sum(r.total_minor) = 0 then sum(r.card_minor) end as card
    from public.daily_revenue r
    join public.location l on l.id = r.location_id and l.partner_id = r.partner_id
    where r.day between p_from and p_through
    group by r.partner_id, r.location_id, r.day, r.currency
  ), source as (
    select * from daily
    union all
    select l.partner_id, d.location_id, date_trunc('month', d.day)::date, d.day, l.currency,
      'day_off', 'day_off:' || d.location_id || ':' || d.day, null, null, null, null
    from app_private.revenue_day_off d join public.location l on l.id = d.location_id
    where d.day between p_from and p_through
    union all
    select l.partner_id, x.location_id, x.month, null, l.currency,
      'plan', 'plan:' || x.location_id || ':' || x.month, null, x.amount_minor, null, null
    from public.revenue_plan x join public.location l on l.id = x.location_id
    where x.month between p_from and p_through
    union all
    select w.partner_id, w.location_id, date_trunc('month', w.day)::date, w.day, l.currency,
      'payroll', 'payroll:' || w.location_id || ':' || w.day, null, sum(w.earned_minor), null, null
    from public.work_shift w join public.location l on l.id = w.location_id
    where w.status = 'closed' and w.day between p_from and p_through
    group by w.partner_id, w.location_id, w.day, l.currency
    union all
    select w.partner_id, w.location_id, date_trunc('month', w.day)::date, w.day, l.currency,
      'return', 'return:' || w.location_id || ':' || w.day, null, sum(w.return_minor), null, null
    from public.work_shift w join public.location l on l.id = w.location_id
    where w.status = 'closed' and w.return_minor > 0 and w.day between p_from and p_through
    group by w.partner_id, w.location_id, w.day, l.currency
    union all
    select e.partner_id, e.location_id, e.month, null, p.currency,
      'expense', 'expense:' || e.id, e.category, e.amount_minor, null, null
    from public.expense e join public.partner p on p.id = e.partner_id
    where e.month between p_from and p_through
    union all
    select p.id, null, d.month, null, p.currency,
      'royalty', 'royalty:' || p.id || ':' || d.month, null,
      round(coalesce(sum(d.amount) filter (where not app_private.royalty_holiday_day(d.day, p.royalty_holiday_from)), 0)
        * app_private.rate_bp(p.id, d.month) / 10000.0), null, null
    from daily d join public.partner p on p.id = d.partner_id and p.currency = d.currency
    where not p.is_demo and (p.royalty_from is null or d.month >= p.royalty_from)
    group by p.id, d.month
    union all
    select a.partner_id, null, a.month, null, p.currency,
      case when a.kind = 'past_debt' then 'royalty_past_debt' else 'royalty_adjustment' end,
      'royalty_adjustment:' || a.id, null, a.amount_minor, null, null
    from public.royalty_manual a join public.partner p on p.id = a.partner_id
    where a.month between p_from and p_through
      or (a.month is null and (a.created_at at time zone 'Europe/Moscow')::date between p_from and p_through)
    union all
    select x.partner_id, null, x.month, x.paid_on, p.currency,
      'royalty_payment', 'royalty_payment:' || x.id, case when x.refunded_minor>0 then 'Получено до возврата. Возвращено (в минорных единицах): '||x.refunded_minor
        when x.paid_on is null then 'Оплата подтверждена без даты' end, x.amount_minor, null, null
    from public.royalty_payment x join public.partner p on p.id = x.partner_id
    where (x.paid_on <= p_through and (x.month >= p_from or x.paid_on >= p_from))
      or (x.paid_on is null and (x.created_at at time zone 'Europe/Moscow')::date <= p_through
          and (x.month >= p_from or (x.created_at at time zone 'Europe/Moscow')::date >= p_from))
  )
  select s.partner_id, p.name, s.location_id, l.name, s.month::text, s.day::text, s.currency,
    c.minor_unit::int, s.kind, s.key, s.category, s.amount::text, s.cash::text, s.card::text
  from source s
  join public.partner p on p.id = s.partner_id and not p.is_demo
  left join public.location l on l.id = s.location_id and l.partner_id = s.partner_id
  join public.currency c on c.code = s.currency
  where p_from <= p_through and p_from = date_trunc('month', p_from)::date
    and (s.location_id is null or l.id is not null)
  order by s.month desc, p.name, s.partner_id, s.currency, s.day, s.key
$$;


create or replace function public.royalty_my() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid; v_partners uuid[]; p public.partner; v_cur date := app_private.current_month(); v_open record; v_elapsed int; v_days int; v_holiday date;
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into v_partners
    from app_private.active_assignments() a where a.role = 'franchisee' and a.scope_id is not null;
  if v_partners is null then perform app_private.fail('forbidden', 'Роялти видит франчайзи'); end if;
  if cardinality(v_partners) > 1 then perform app_private.fail('validation', 'К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  v_partner := v_partners[1];
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  v_holiday := p.royalty_holiday_from;
  select * into v_open from app_private.royalty_ledger(v_partner) g where g.month = v_cur;
  v_days := extract(day from (v_cur + interval '1 month - 1 day'))::int;
  v_elapsed := greatest(1, extract(day from (now() at time zone 'Europe/Moscow'))::int - 1);
  return jsonb_build_object(
    'partner_id', p.id, 'partner_name', p.name, 'currency', p.currency,
    'rate_bp', app_private.rate_bp(p.id, v_cur),
    'debt_minor', (select coalesce(sum(debt_minor), 0) from app_private.royalty_ledger(v_partner) g where not g.is_open),
    'live', jsonb_build_object('month', v_cur,
      'revenue_minor', coalesce(v_open.revenue_minor, 0), 'accrued_minor', coalesce(v_open.accrued_minor, 0),
      -- прогноз на конец месяца по темпу прошедших дней
      'projected_accrual_minor', round(coalesce(v_open.accrued_minor, 0)::numeric / v_elapsed * v_days)::bigint,
      'paid_minor', coalesce(v_open.paid_minor, 0),
      'royalty_holiday_until', case when v_cur < (v_holiday + interval '2 months')::date
        and (v_cur + interval '1 month')::date > v_holiday then (v_holiday + interval '2 months')::date end,
      'royalty_accrual_from', case when v_cur < (v_holiday + interval '2 months')::date
        and (v_cur + interval '1 month')::date > v_holiday
        then greatest((v_holiday + interval '2 months')::date, p.royalty_from) end,
      'waived_royalty_minor', round(coalesce(v_open.revenue_minor, 0)::numeric * app_private.rate_bp(p.id, v_cur) / 10000)::bigint
        - coalesce(v_open.accrued_minor, 0)),
    'undated', (select to_jsonb(g) from app_private.royalty_ledger(v_partner) g where g.month is null),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(v_partner, g.month) order by g.month desc) from app_private.royalty_ledger(v_partner) g where g.month is not null), '[]'::jsonb),
    'undated_payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor, 'refunded_minor', r.refunded_minor,
      'paid_on', r.paid_on, 'note', r.note) order by r.paid_on desc) from public.royalty_payment r
      where r.partner_id = v_partner and r.month is null), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor, 'refunded_minor', r.refunded_minor, 'paid_on', r.paid_on, 'note', r.note)
      order by r.paid_on desc) from public.royalty_payment r where r.partner_id = v_partner and r.month is not null), '[]'::jsonb));
end $$;

create or replace function public.royalty_partner(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare p public.partner;
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  select * into p from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  return jsonb_build_object(
    'partner_id', p.id, 'partner_name', p.name, 'currency', p.currency,
    'rate_bp', app_private.rate_bp(p.id, app_private.current_month()),
    'royalty_holiday_from', p.royalty_holiday_from,
    'royalty_holiday_until', (p.royalty_holiday_from + interval '2 months')::date,
    'royalty_accrual_from', greatest((p.royalty_holiday_from + interval '2 months')::date, p.royalty_from),
    'undated', (select to_jsonb(g) from app_private.royalty_ledger(p.id) g where g.month is null),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(p.id, g.month)
      || jsonb_build_object('waived_royalty_minor', round(g.revenue_minor::numeric * g.rate_bp / 10000)::bigint - g.accrued_minor)
      order by g.month desc) from app_private.royalty_ledger(p.id) g where g.month is not null), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'refunded_minor', r.refunded_minor, 'paid_on', r.paid_on,
        'note', r.note, 'created_at', r.created_at) order by r.paid_on desc, r.created_at desc)
      from public.royalty_payment r where r.partner_id = p.id), '[]'::jsonb),
    'manual', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note,
        'created_at', r.created_at) order by r.month desc)
      from public.royalty_manual r where r.partner_id = p.id), '[]'::jsonb),
    'rates', coalesce((select jsonb_agg(jsonb_build_object('effective_from', r.effective_from, 'rate_bp', r.rate_bp) order by r.effective_from desc)
      from public.royalty_rate r where r.partner_id = p.id), '[]'::jsonb));
end $$;

create or replace function public.royalty_checkout_return_status(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare
  actor uuid := app_private.require_user();
  partner uuid := app_private.royalty_checkout_owner(actor);
  attempt app_private.royalty_checkout_attempt;
  state text;
  refunded bigint;
begin
  select a.* into attempt from app_private.royalty_checkout_attempt a
    where a.id=p_attempt and a.partner_id=partner
      and exists (select 1 from public.app_user u where u.id=actor and not u.is_demo);
  state := case attempt.status when 'open' then 'checking' when 'succeeded' then 'paid'
    when 'canceled' then 'canceled' else 'unavailable' end;
  if state='paid' then
    select refunded_minor into refunded from public.royalty_payment where id=attempt.id;
    if refunded=attempt.amount_minor then
      state:='refunded';
    elsif refunded>0 then
      state:='partially_refunded';
    end if;
  end if;
  return jsonb_build_object('state',state,'month',attempt.month,'amount_minor',attempt.amount_minor::text,'currency','RUB');
end $$;

create function app_private.royalty_payment_reviewed(
  p_partner uuid, p_month date, p_amount bigint, p_paid_on date, p_note text, p_reviewed jsonb, p_source text, p_reference text
) returns jsonb language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_matches jsonb; v_ids jsonb; v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Укажите сумму оплаты', 'amount'); end if;
  if (p_month is null and not exists (select 1 from public.royalty_manual where partner_id = p_partner and month is null))
      or (p_month is not null and not isfinite(p_month)) then
    perform app_private.fail('validation', 'Укажите месяц, за который оплата', 'month');
  end if;
  if p_paid_on is null or not isfinite(p_paid_on) or p_paid_on > current_date + 1 then
    perform app_private.fail('validation', 'Неверная дата оплаты', 'paid_on');
  end if;
  if p_reviewed is not null and jsonb_typeof(p_reviewed) <> 'array' then
    perform app_private.fail('validation', 'Проверьте похожие оплаты');
  end if;
  if (p_source is not null or p_reference is not null) and
    (p_source is null or p_source not in ('cash','bank') or coalesce(length(btrim(p_reference)),0) not between 1 and 120) then
    perform app_private.fail('validation','Заполните способ оплаты и номер платёжного документа');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'royalty.payment:' || p_partner::text || ':' || (p_paid_on - date '2000-01-01')::text || ':' || p_amount::text, 0));

  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'note', r.note, 'provider_payment_id', r.provider_payment_id) order by r.month, r.id), '[]'::jsonb),
    coalesce(jsonb_agg(r.id), '[]'::jsonb) into v_matches, v_ids
  from public.royalty_payment r
  where r.partner_id = p_partner and r.paid_on = p_paid_on and r.amount_minor = p_amount;

  if v_ids <> '[]'::jsonb and not coalesce(v_ids @> p_reviewed and v_ids <@ p_reviewed, false) then
    return jsonb_build_object('matches', v_matches);
  end if;
  insert into public.royalty_payment(partner_id, month, amount_minor, paid_on, note, created_by, external_source, external_reference)
  values (p_partner, date_trunc('month', p_month)::date, p_amount, p_paid_on, nullif(trim(p_note), ''), auth.uid(), p_source, btrim(p_reference)) returning id into v_id;
  perform app_private.audit('royalty.payment', 'royalty_payment', v_id, p_partner,
    jsonb_build_object('month', p_month, 'amount', p_amount, 'reviewed', v_ids));
  return jsonb_build_object('id', v_id);
end $$;

revoke all on function app_private.royalty_payment_reviewed(uuid,date,bigint,date,text,jsonb,text,text)
  from public,anon,authenticated,service_role;

create or replace function app_private.royalty_payment_reviewed(
  p_partner uuid,p_month date,p_amount bigint,p_paid_on date,p_note text,p_reviewed jsonb
) returns jsonb language sql set search_path=pg_catalog,pg_temp as $$
  select app_private.royalty_payment_reviewed(p_partner,p_month,p_amount,p_paid_on,p_note,p_reviewed,null,null)
$$;

create or replace function public.financial_operation(p_command text,p_args jsonb,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid := app_private.require_user(); old app_private.operation_receipt; answer jsonb;
begin
  if p_operation is null then perform app_private.fail('validation','Не указан ключ операции'); end if;
  if p_command in ('royalty_payment_reviewed', 'royalty_set_accrual_only') then
    perform app_private.royalty_partner_check((p_args->>'p_partner')::uuid);
  elsif p_command in ('expense_save_with_recurring', 'expense_repeat_checked') then
    perform app_private.expense_partner();
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>p_command or old.payload<>p_args then perform app_private.fail('idempotency-conflict','Повтор операции с другими суммами'); end if;
    return old.result;
  end if;
  case p_command
    when 'royalty_payment_reviewed' then answer:=app_private.royalty_payment_reviewed((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,(p_args->>'p_paid_on')::date,p_args->>'p_note',p_args->'p_reviewed',p_args->>'p_source',p_args->>'p_reference');
    when 'royalty_set_accrual_only' then answer:=app_private.royalty_apply_accrual((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_target')::bigint,p_args->>'p_note',true);
    when 'expense_save_with_recurring' then answer:=to_jsonb(app_private.expense_save_with_recurring((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,(p_args->>'p_location')::uuid,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note',(p_args->>'p_recurring')::boolean));
    when 'expense_repeat_checked' then answer:=to_jsonb(app_private.expense_repeat_checked((p_args->>'p_month')::date,p_args->'p_rows'));
    when 'royalty_payment_add' then answer:=to_jsonb(public.royalty_payment_add((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,(p_args->>'p_paid_on')::date,p_args->>'p_note'));
    when 'royalty_manual_add' then answer:=to_jsonb(public.royalty_manual_add((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    when 'royalty_set_accrual' then answer:=public.royalty_set_accrual((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_target')::bigint,p_args->>'p_note');
    when 'expense_save' then answer:=to_jsonb(public.expense_save((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,(p_args->>'p_location')::uuid,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    when 'manager_company_expense_save' then answer:=to_jsonb(public.manager_company_expense_save((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    else perform app_private.fail('validation','Неизвестная финансовая операция');
  end case;
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,p_command,p_args,answer);
  return answer;
end $$;

create or replace function public.royalty_holiday_start_set(p_partner uuid, p_started_on date, p_expected_start date) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare saved date;
begin
  perform app_private.royalty_partner_check(p_partner);
  if p_started_on is not null and (not isfinite(p_started_on) or p_started_on > (now() at time zone 'Europe/Moscow')::date) then
    perform app_private.fail('validation', 'Укажите фактическую дату открытия', 'started_on');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('royalty-checkout:'||p_partner,0));
  select royalty_holiday_from into saved from public.partner where id = p_partner for update;
  if saved is not distinct from p_started_on then return; end if;
  if saved is distinct from p_expected_start then
    perform app_private.fail('version-conflict', 'Дата открытия уже изменена. Откройте настройки каникул заново');
  end if;
  update public.partner set royalty_holiday_from = p_started_on, updated_at = now() where id = p_partner;
  perform app_private.audit('royalty.holiday', 'partner', p_partner, p_partner,
    jsonb_build_object('before', saved, 'after', p_started_on));
end $$;

create or replace function app_private.royalty_checkout_work(p_limit integer,p_invoice boolean,p_shop_id text)
returns table(id uuid, lease uuid, month date, amount_minor bigint, provider_id text,
  invoice_name text, first_dispatch_at timestamptz, invoice_receipt_email text)
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a app_private.royalty_checkout_attempt;
  quote jsonb;
  receipt_email text;
begin
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'invalid-limit'; end if;
  if p_invoice is null or (p_shop_id is not null and (not p_invoice or p_shop_id !~ '^[0-9]+$'))
    then raise exception 'invalid-checkout-mode'; end if;
  for a in select t.* from app_private.royalty_checkout_attempt t
      left join app_private.royalty_checkout_pilot pilot on pilot.partner_id=t.partner_id
      where t.status='open' and t.next_check_at<=now() and (t.lease_until is null or t.lease_until<=now())
        and p_invoice=case
          when t.first_dispatch_at is not null or t.provider_id is not null or t.recovery_provider_id is not null
            then t.invoice_name is not null
          else coalesce(pilot.use_invoice,false) end
        and p_shop_id is not distinct from case
          when t.first_dispatch_at is not null or t.provider_id is not null or t.recovery_provider_id is not null
            then t.invoice_shop_id
          else pilot.invoice_shop_id end
        and (p_shop_id is null or t.provider_id is not null or t.recovery_provider_id is not null or not exists (
          select 1 from app_private.royalty_checkout_hold h where h.partner_id=t.partner_id and h.month=t.month
        ))
        and (t.provider_id is not null or t.recovery_provider_id is not null or t.first_dispatch_at is null or t.first_dispatch_at>now()-interval '23 hours')
      order by t.next_check_at,t.id limit p_limit for update of t skip locked loop
    if p_invoice and a.amount_minor<100 and a.first_dispatch_at is null and a.provider_id is null then
      -- A partner can be switched to invoices after the original click.
      update app_private.royalty_checkout_attempt set status='canceled' where royalty_checkout_attempt.id=a.id;
      continue;
    end if;
    if a.provider_id is null and a.recovery_provider_id is null then
      quote := null;
      if app_private.royalty_checkout_owner(a.requested_by)=a.partner_id and
        (a.session_id is null or exists(select 1 from auth.sessions s where s.id=a.session_id and s.user_id=a.requested_by)) then
        quote := app_private.royalty_checkout_balance(a.partner_id,a.requested_by,now());
      end if;
      if (quote->>'state' in ('overdue','payable') and (quote->>'month')::date=a.month
        and (quote->>'amount_minor')::bigint=a.amount_minor) is not true then
        -- After possible transmission, only a confirmed terminal provider status
        -- can release this month. A changed balance must not cause a new create.
        update app_private.royalty_checkout_attempt set
          status=case when a.first_dispatch_at is null then 'canceled' else 'open' end,
          next_check_at=now()+interval '1 minute' where royalty_checkout_attempt.id=a.id;
        continue;
      end if;
    end if;
    receipt_email := a.invoice_receipt_email;
    if p_shop_id is not null and a.first_dispatch_at is null then
      select app_private.royalty_receipt_email(p.contact_email) into receipt_email
      from public.partner p where p.id=a.partner_id;
      if receipt_email is null then
        update app_private.royalty_checkout_attempt set status='canceled' where royalty_checkout_attempt.id=a.id;
        continue;
      end if;
    end if;
    update app_private.royalty_checkout_attempt t set lease=gen_random_uuid(),lease_until=now()+interval '90 seconds',
      first_dispatch_at=coalesce(t.first_dispatch_at,now()),
      -- Keep the same name and expiry after an uncertain create request.
      invoice_name=case when p_invoice and t.invoice_name is null then
        (select p.name from public.partner p where p.id=t.partner_id)
        else t.invoice_name end,
      invoice_shop_id=p_shop_id, invoice_receipt_email=receipt_email
      where t.id=a.id
      returning t.id,t.lease,t.month,t.amount_minor,
        coalesce(t.provider_id,(case when p_invoice then 'in-' else '' end)||t.recovery_provider_id::text),
        t.invoice_name,t.first_dispatch_at,t.invoice_receipt_email
      into id,lease,month,amount_minor,provider_id,invoice_name,first_dispatch_at,invoice_receipt_email;
    return next;
  end loop;
end $$;

create or replace function app_private.royalty_checkout_recover(p_id uuid,p_candidate uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  update app_private.royalty_checkout_attempt set recovery_provider_id=p_candidate,
    next_check_at=now(),lease=null,lease_until=null
  where id=p_id and p_candidate is not null and status='open' and provider_id is null
    and first_dispatch_at is not null and (lease_until is null or lease_until<=now())
    and (first_dispatch_at<=now()-interval '23 hours' or (invoice_shop_id is not null and exists (
      select 1 from app_private.royalty_checkout_hold h
      where h.partner_id=royalty_checkout_attempt.partner_id and h.month=royalty_checkout_attempt.month
    )));
  return found;
end $$;
