-- A monthly series is an opt-in. Old manual transfer flags do not start a series.
-- Reports derive occurrences from dated versions without changing rows as they read.
alter table public.expense add column repeat_series_id uuid;
create unique index expense_monthly_series on public.expense (repeat_series_id, month)
  where repeat_series_id is not null;

create table app_private.expense_repeat_schedule (
  series_id uuid not null,
  partner_id uuid not null references public.partner(id),
  from_month date not null check (isfinite(from_month) and extract(day from from_month) = 1),
  active boolean not null,
  location_id uuid references public.location(id),
  category text not null,
  amount_minor bigint not null check (amount_minor > 0),
  note text,
  changed_by uuid references public.app_user(id),
  changed_at timestamptz not null default now(),
  primary key (series_id, from_month)
);
create index expense_repeat_partner on app_private.expense_repeat_schedule (partner_id, from_month);

create table app_private.expense_repeat_omission (
  series_id uuid not null,
  month date not null,
  primary key (series_id, month)
);

-- Returning the same composite row as a booked expense keeps the statement, the
-- network rollup and the export consistent. An edited copy retains its report ID.
create function app_private.expense_effective_rows(p_partner uuid, p_from date, p_through date)
returns setof public.expense language sql stable
set search_path = pg_catalog, public, app_private, pg_temp as $$
  with schedule as (
    select r.*, lead(r.from_month) over (partition by r.series_id order by r.from_month) as until_month
    from app_private.expense_repeat_schedule r
    where (p_partner is null or r.partner_id = p_partner) and r.from_month <= p_through
  )
  select e.* from public.expense e
  where (p_partner is null or e.partner_id = p_partner) and e.month between p_from and p_through
  union all
  select md5(r.series_id::text || ':' || (m.month - date '2000-01-01')::text)::uuid,
    r.partner_id, r.location_id, m.month, r.category, r.amount_minor, r.note, r.changed_by,
    r.changed_at, r.changed_at, true, null::uuid, r.series_id
  from schedule r
  cross join lateral (
    select d::date as month
    from generate_series(
      greatest(r.from_month, date_trunc('month', p_from)::date)::timestamp,
      least(app_private.current_month(), p_through, r.until_month - 1)::timestamp,
      interval '1 month'
    ) d
  ) m
  where r.active and m.month >= p_from
    and not exists (
      select from public.expense e where e.repeat_series_id = r.series_id and e.month = m.month
    )
    and not exists (
      select from app_private.expense_repeat_omission o where o.series_id = r.series_id and o.month = m.month
    )
$$;

create or replace function app_private.expense_rows(p_partner uuid, p_locations uuid[], p_month date, p_include_common boolean)
returns setof public.expense language sql stable security definer
set search_path = pg_catalog, public, app_private, pg_temp as $$
  select e.* from app_private.expense_effective_rows(p_partner, p_month, p_month) e
  where e.location_id = any(p_locations) or (p_include_common and e.location_id is null)
$$;

create function app_private.expense_schedule_next(p_expense public.expense, p_active boolean)
returns void language sql volatile set search_path = pg_catalog, public, app_private, pg_temp as $$
  insert into app_private.expense_repeat_schedule(series_id, partner_id, from_month, active,
    location_id, category, amount_minor, note, changed_by)
  values (p_expense.repeat_series_id, p_expense.partner_id, (app_private.current_month() + interval '1 month')::date, p_active,
    p_expense.location_id, p_expense.category, p_expense.amount_minor, p_expense.note, auth.uid())
  on conflict (series_id, from_month) do update set active = excluded.active, location_id = excluded.location_id,
    category = excluded.category, amount_minor = excluded.amount_minor, note = excluded.note,
    changed_by = excluded.changed_by, changed_at = now()
$$;

create function app_private.expense_save_repeating(
  p_id uuid, p_month date, p_location uuid, p_category text, p_amount bigint, p_note text, p_recurring boolean
) returns uuid language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_month date := date_trunc('month', p_month)::date;
  v_current date := app_private.current_month(); previous public.expense; saved public.expense; v_id uuid; v_series uuid;
begin
  if p_recurring is null then perform app_private.fail('validation', 'Укажите, повторяется ли расход'); end if;
  if v_month is null or not isfinite(v_month) or v_month > v_current then
    perform app_private.fail('validation', 'Выберите текущий или прошедший месяц', 'month');
  end if;
  -- Serialize changes to future schedules before locking the edited period.
  perform app_private.expense_month_lock(v_partner, v_current);
  perform app_private.expense_month_lock(v_partner, v_month);
  if p_id is not null then
    select e.* into previous from app_private.expense_effective_rows(v_partner, v_month, v_month) e where e.id = p_id;
    if previous.id is null then perform app_private.fail('not-found', 'Расход не найден'); end if;
    insert into public.expense select (previous).* on conflict (id) do nothing;
  end if;

  v_id := public.expense_save(p_id, v_month, p_location, p_category, p_amount, p_note);
  v_series := previous.repeat_series_id;
  if p_recurring and v_series is null then v_series := gen_random_uuid(); end if;
  update public.expense set repeat_series_id = v_series,
    recurring = p_recurring or (v_series is null and coalesce(previous.recurring, false))
    where id = v_id returning * into saved;

  if saved.recurring is distinct from coalesce(previous.recurring, false) or v_series is distinct from previous.repeat_series_id then
    perform app_private.audit('expense.recurring', 'expense', v_id, v_partner,
      jsonb_build_object('recurring', saved.recurring, 'repeat_series_id', v_series));
  end if;
  if p_recurring and (previous.repeat_series_id is null or not previous.recurring or v_month = v_current) then
    perform app_private.expense_schedule_next(saved, true);
  elsif not p_recurring and previous.repeat_series_id is not null and previous.recurring then
    perform app_private.expense_schedule_next(saved, false);
  end if;
  return v_id;
end $$;

create or replace function public.expense_delete(p_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_current date := app_private.current_month();
  v_first date; e public.expense;
begin
  perform app_private.expense_month_lock(v_partner, v_current);
  select * into e from public.expense x where x.id = p_id and x.partner_id = v_partner;
  if e.id is null then
    select min(r.from_month) into v_first from app_private.expense_repeat_schedule r where r.partner_id = v_partner;
    if v_first is not null then
      select x.* into e from app_private.expense_effective_rows(v_partner, v_first, v_current) x where x.id = p_id;
    end if;
  end if;
  if e.id is null then perform app_private.fail('not-found', 'Расход не найден'); end if;

  perform app_private.expense_month_lock(v_partner, e.month);
  perform app_private.require_partner_operational(v_partner);
  delete from public.expense x where x.id = p_id and x.partner_id = v_partner;
  if e.repeat_series_id is not null then
    insert into app_private.expense_repeat_omission(series_id, month) values (e.repeat_series_id, e.month) on conflict do nothing;
    if e.recurring then perform app_private.expense_schedule_next(e, false); end if;
  end if;
  perform app_private.audit('expense.delete', 'expense', p_id, v_partner, to_jsonb(e));
end $$;

-- Only legacy/manual repeats are eligible for the existing review and transfer.
create or replace function app_private.expense_repeat_candidates(p_partner uuid, p_month date)
returns setof public.expense language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  select e.* from public.expense e
  where e.partner_id = p_partner and e.month = (p_month - interval '1 month')::date and e.recurring and e.repeat_series_id is null
    and not exists (
      select from app_private.expense_effective_rows(p_partner, p_month, p_month) x
      where x.carried_from = e.id or (x.carried_from is null and x.category = e.category
        and x.location_id is not distinct from e.location_id)
    )
$$;

revoke execute on function app_private.expense_effective_rows(uuid,date,date),
  app_private.expense_schedule_next(public.expense,boolean),
  app_private.expense_save_repeating(uuid,date,uuid,text,bigint,text,boolean) from public, anon, authenticated;
grant execute on function app_private.expense_effective_rows(uuid,date,date),
  app_private.expense_schedule_next(public.expense,boolean),
  app_private.expense_save_repeating(uuid,date,uuid,text,bigint,text,boolean) to postgres;
grant select, insert, update on app_private.expense_repeat_schedule, app_private.expense_repeat_omission to postgres;
do $private_expense_roles$
begin
  if exists (select from pg_roles where rolname = 'supabase_admin') then
    grant execute on function app_private.expense_effective_rows(uuid,date,date),
      app_private.expense_schedule_next(public.expense,boolean),
      app_private.expense_save_repeating(uuid,date,uuid,text,bigint,text,boolean) to supabase_admin;
    grant select, insert, update on app_private.expense_repeat_schedule, app_private.expense_repeat_omission to supabase_admin;
  end if;
end
$private_expense_roles$;

-- Retry checked financial writes with the same operation receipt.
create or replace function public.financial_operation(p_command text,p_args jsonb,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid := app_private.require_user(); old app_private.operation_receipt; answer jsonb;
  handler text := p_command; expense_owner uuid; expense_month date;
begin
  if p_operation is null then perform app_private.fail('validation','Не указан ключ операции'); end if;
  if p_command in ('royalty_payment_reviewed', 'royalty_set_accrual_only') then
    perform app_private.royalty_partner_check((p_args->>'p_partner')::uuid);
  elsif p_command in ('expense_save_with_recurring', 'expense_save_repeating', 'expense_repeat_checked') then
    expense_owner := app_private.expense_partner();
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>p_command or old.payload<>p_args then perform app_private.fail('idempotency-conflict','Повтор операции с другими суммами'); end if;
    return old.result;
  end if;
  -- A cached app may edit an automatic occurrence with the older command.
  -- Keep that command's manual behavior for expenses outside an automatic series.
  if p_command = 'expense_save_with_recurring' and p_args->>'p_id' is not null then
    expense_month := date_trunc('month', (p_args->>'p_month')::date)::date;
    perform app_private.expense_month_lock(expense_owner, app_private.current_month());
    if exists (select from app_private.expense_effective_rows(expense_owner, expense_month, expense_month) e
        where e.id = (p_args->>'p_id')::uuid and e.repeat_series_id is not null) then
      handler := 'expense_save_repeating';
    end if;
  end if;
  case handler
    when 'royalty_payment_reviewed' then answer:=app_private.royalty_payment_reviewed((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,(p_args->>'p_paid_on')::date,p_args->>'p_note',p_args->'p_reviewed');
    when 'royalty_set_accrual_only' then answer:=app_private.royalty_apply_accrual((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_target')::bigint,p_args->>'p_note',true);
    when 'expense_save_with_recurring' then answer:=to_jsonb(app_private.expense_save_with_recurring((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,(p_args->>'p_location')::uuid,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note',(p_args->>'p_recurring')::boolean));
    when 'expense_save_repeating' then answer:=to_jsonb(app_private.expense_save_repeating((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,(p_args->>'p_location')::uuid,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note',(p_args->>'p_recurring')::boolean));
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

create function app_private.finance_month_with_payroll_status(p_partner uuid, p_locations uuid[], p_month date, p_include_common boolean)
returns jsonb language sql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
  select app_private.fin_month(p_partner, p_locations, p_month, p_include_common) || jsonb_build_object('payroll_pending', count(*))
  from public.work_shift w where w.location_id = any(p_locations) and w.day >= p_month and w.day < p_month + interval '1 month'
    and w.status = 'closed' and w.pay_policy ? 'automatic' and w.earned_minor is null
$$;
revoke execute on function app_private.finance_month_with_payroll_status(uuid,uuid[],date,boolean) from public, anon, authenticated;
do $finance_payroll_acl$
declare caller name := (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.finance_my(date,uuid)'::regprocedure);
begin
  if caller is null or caller not in ('postgres', 'supabase_admin') then
    raise exception 'Unexpected finance_my owner';
  end if;
  execute format('grant execute on function app_private.finance_month_with_payroll_status(uuid,uuid[],date,boolean) to %I', caller);
end
$finance_payroll_acl$;

create or replace function public.finance_my(p_month date, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid; v_partners uuid[]; p public.partner; v_month date := date_trunc('month', p_month)::date; v_locs uuid[]; v_all uuid[]; m date;
  v_months jsonb := '[]'::jsonb;
  v_include_common boolean := p_location is null;
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into v_partners
    from app_private.active_assignments() a where a.role = 'franchisee' and a.scope_id is not null;
  if v_partners is null then perform app_private.fail('forbidden', 'Финансы видит франчайзи'); end if;
  if cardinality(v_partners) > 1 then perform app_private.fail('validation', 'К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  v_partner := v_partners[1];
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select coalesce(array_agg(id order by name), '{}'::uuid[]) into v_all from public.location where partner_id = v_partner;
  if p_location is not null and not (p_location = any(v_all)) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_locs := case when v_include_common then v_all else array[p_location] end;
  for m in select generate_series(v_month - interval '5 months', v_month, interval '1 month')::date loop
    v_months := v_months || jsonb_build_array(app_private.finance_month_with_payroll_status(v_partner, v_locs, m, v_include_common));
  end loop;
  return jsonb_build_object(
    'partner_name', p.name, 'partner_status', p.status, 'currency', p.currency, 'month', v_month, 'location_id', p_location,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status) order by name)
      from public.location where partner_id = v_partner), '[]'::jsonb),
    'current', app_private.finance_month_with_payroll_status(v_partner, v_locs, v_month, v_include_common),
    'months', v_months,
    'by_location', case when v_include_common then coalesce((select jsonb_agg(app_private.finance_month_with_payroll_status(v_partner, array[l.id], v_month, false)
        || jsonb_build_object('location_id', l.id, 'location_name', l.name) order by l.name)
      from public.location l where l.partner_id = v_partner), '[]'::jsonb) end,
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id, 'full_name', u.full_name,
        'shifts', x.n, 'revenue_minor', x.t, 'earned_minor', x.e,
        'payroll_halves', jsonb_build_array(x.first_half, x.second_half)) order by x.e desc)
      from (select employee_id, (count(*) filter (where counts_as_exit))::int n,
            sum(total_minor)::bigint t, sum(earned_minor)::bigint e,
            coalesce(sum(earned_minor) filter (where day < v_month + 15), 0)::bigint first_half,
            coalesce(sum(earned_minor) filter (where day >= v_month + 15), 0)::bigint second_half
          from public.work_shift
          where location_id = any(v_locs) and status = 'closed' and day >= v_month and day < v_month + interval '1 month'
          group by employee_id) x
      join public.app_user u on u.id = x.employee_id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'month', e.month, 'location_id', e.location_id, 'location_name', l.name,
        'category', e.category, 'amount_minor', e.amount_minor, 'note', e.note, 'recurring', e.recurring)
      || case when e.repeat_series_id is null then '{}'::jsonb else jsonb_build_object('repeat_series_id', e.repeat_series_id) end
      order by e.category, l.name nulls first)
      from app_private.expense_rows(v_partner, v_locs, v_month, v_include_common) e left join public.location l on l.id = e.location_id), '[]'::jsonb),
    'expense_categories', coalesce((select jsonb_agg(c order by n desc, c) from (
        select category c, count(*) n from public.expense where partner_id = v_partner group by category) t), '[]'::jsonb),
    'prev_expenses_count', (select count(*) from app_private.expense_repeat_candidates(v_partner, v_month)),
    'royalty', case when v_include_common then public.royalty_my() end);
end $$;

create or replace function public.manager_economy(p_month date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v_month date := date_trunc('month',p_month)::date;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return jsonb_build_object(
    'month',v_month,
    'company_expenses',coalesce((select jsonb_agg(jsonb_build_object(
      'id',e.id,'category',e.category,'amount_minor',e.amount_minor,'note',e.note,'created_at',e.created_at
    ) order by e.category,e.created_at,e.id) from app_private.network_expense e where e.month=v_month),'[]'::jsonb),
    'company_expense_totals',coalesce((select jsonb_agg(jsonb_build_object('category',x.category,'amount_minor',x.amount_minor)
      order by x.category) from (select category,sum(amount_minor)::bigint amount_minor
        from app_private.network_expense where month=v_month group by category) x),'[]'::jsonb),
    'partners',coalesce((select jsonb_agg(jsonb_build_object(
      'partner_id',p.id,'partner_name',p.name,'currency',p.currency,
      'payroll_minor',coalesce(w.payroll_minor,0),
      'payroll_pending',coalesce(w.payroll_pending,0),
      'payroll_halves',jsonb_build_array(coalesce(w.first_half,0),coalesce(w.second_half,0)),
      'closed_shifts',coalesce(w.closed_shifts,0),
      'expenses_minor',coalesce(x.expenses_minor,0),
      'expense_categories',coalesce(x.categories,'[]'::jsonb)
    ) order by p.name) from public.partner p
      left join lateral (
        select sum(s.earned_minor)::bigint payroll_minor, count(*)::int closed_shifts,
          count(*) filter (where s.pay_policy ? 'automatic' and s.earned_minor is null) payroll_pending,
          sum(s.earned_minor) filter (where s.day < v_month + 15)::bigint first_half,
          sum(s.earned_minor) filter (where s.day >= v_month + 15)::bigint second_half
        from public.work_shift s where s.partner_id=p.id and s.status='closed'
          and s.day>=v_month and s.day<(v_month+interval '1 month')::date
      ) w on true
      left join lateral (
        select sum(e.category_total)::bigint expenses_minor,
          jsonb_agg(jsonb_build_object('category',e.category,'amount_minor',e.category_total) order by e.category) categories
        from (select category,sum(amount_minor)::bigint category_total
          from app_private.expense_effective_rows(p.id, v_month, v_month) group by category) e
      ) x on true where p.status='active'),'[]'::jsonb)
  );
end $$;

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
      'payroll', 'payroll:' || w.location_id || ':' || w.day,
      case when bool_or(w.pay_policy ? 'automatic' and w.earned_minor is null) then 'Смены на подтверждение' end,
      sum(w.earned_minor), null, null
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
    from app_private.expense_effective_rows(null, p_from, p_through) e join public.partner p on p.id = e.partner_id
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
      'royalty_payment', 'royalty_payment:' || x.id, case when x.paid_on is null then 'Оплата подтверждена без даты' end, x.amount_minor, null, null
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
