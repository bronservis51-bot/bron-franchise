-- 0004 Роялти: считаются сами из выручки (по умолчанию 7 %), видны только Менеджеру по франшизе.
-- Начисление за месяц = выручка всех точек франчайзи за месяц × ставка; не хранится, пересчитывается из выручки.
-- Долг = начислено за закрытые месяцы + прошлые неоплаченные роялти (ввод вручную) − оплаты. Суммы — в валюте франчайзи.

create table public.royalty_rate (
  partner_id uuid not null references public.partner(id),
  effective_from date not null check (extract(day from effective_from) = 1),
  rate_bp int not null check (rate_bp between 0 and 10000),
  set_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  primary key (partner_id, effective_from)
);

-- Прошлые неоплаченные роялти (до начала учёта в приложении) и другие ручные начисления.
create table public.royalty_manual (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner(id),
  month date not null check (extract(day from month) = 1),
  amount_minor bigint not null check (amount_minor > 0),
  note text,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);

create table public.royalty_payment (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner(id),
  month date not null check (extract(day from month) = 1),
  amount_minor bigint not null check (amount_minor > 0),
  paid_on date not null,
  note text,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
create index on public.royalty_payment (partner_id, month);

create function app_private.default_rate_bp() returns int language sql immutable as $$ select 700 $$;

create function app_private.rate_bp(p_partner uuid, p_month date) returns int
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select coalesce((select rate_bp from public.royalty_rate where partner_id = p_partner and effective_from <= p_month
                   order by effective_from desc limit 1), app_private.default_rate_bp())
$$;

create function app_private.current_month() returns date
language sql stable as $$ select date_trunc('month', now() at time zone 'Europe/Moscow')::date $$;

-- Помесячная книга роялти франчайзи: выручка, ставка, начислено, ручные начисления, оплаты, долг месяца.
create function app_private.royalty_ledger(p_partner uuid)
returns table (month date, revenue_minor bigint, rate_bp int, accrued_minor bigint, manual_minor bigint, paid_minor bigint,
  debt_minor bigint, is_open boolean)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with months as (
    select date_trunc('month', day)::date as m from public.daily_revenue where partner_id = p_partner
    union select month from public.royalty_manual where partner_id = p_partner
    union select month from public.royalty_payment where partner_id = p_partner
  ), rev as (
    select date_trunc('month', day)::date as m, sum(total_minor)::bigint as v from public.daily_revenue where partner_id = p_partner group by 1
  ), x as (
    select m.m, coalesce(rev.v, 0) as revenue, app_private.rate_bp(p_partner, m.m) as bp,
      coalesce((select sum(amount_minor) from public.royalty_manual r where r.partner_id = p_partner and r.month = m.m), 0)::bigint as manual,
      coalesce((select sum(amount_minor) from public.royalty_payment r where r.partner_id = p_partner and r.month = m.m), 0)::bigint as paid,
      m.m >= app_private.current_month() as open
    from months m left join rev on rev.m = m.m
  )
  select x.m, x.revenue, x.bp, round(x.revenue * x.bp / 10000.0)::bigint, x.manual, x.paid,
    -- текущий месяц ещё начисляется: в долг не входит, пока не закончится
    case when x.open then x.manual - x.paid else round(x.revenue * x.bp / 10000.0)::bigint + x.manual - x.paid end,
    x.open
  from x order by x.m
$$;

-- Сводная таблица по всем франчайзи. Без месяца — весь долг; с месяцем — начислено, оплачено и долг этого месяца.
create function public.royalty_summary(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date; v_rows jsonb; v_cur date := app_private.current_month();
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  select coalesce(jsonb_agg(row_data order by row_data ->> 'partner_name'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'partner_id', p.id, 'partner_name', p.name, 'status', p.status, 'country', p.country, 'currency', p.currency,
      'rate_bp', app_private.rate_bp(p.id, coalesce(v_month, v_cur)),
      'revenue_minor', coalesce(sum(g.revenue_minor) filter (where v_month is null and not g.is_open or g.month = v_month), 0),
      'accrued_minor', coalesce(sum(g.accrued_minor) filter (where v_month is null and not g.is_open or g.month = v_month), 0),
      'manual_minor', coalesce(sum(g.manual_minor) filter (where v_month is null or g.month = v_month), 0),
      'paid_minor', coalesce(sum(g.paid_minor) filter (where v_month is null or g.month = v_month), 0),
      'debt_minor', coalesce(sum(case when v_month is null then g.debt_minor
                                       when g.month = v_month then g.accrued_minor + g.manual_minor - g.paid_minor end), 0),
      'is_open', v_month is not null and v_month >= v_cur,
      'current_revenue_minor', coalesce(sum(g.revenue_minor) filter (where g.month = v_cur), 0),
      'current_accrual_minor', coalesce(sum(g.accrued_minor) filter (where g.month = v_cur), 0),
      'debt_months', coalesce(jsonb_agg(jsonb_build_object('month', g.month, 'debt_minor', g.debt_minor) order by g.month)
                      filter (where g.debt_minor > 0 and not g.is_open), '[]'::jsonb),
      'last_payment_on', (select max(paid_on) from public.royalty_payment r where r.partner_id = p.id),
      'fx_rub', app_private.fx_rub(p.currency, current_date)
    ) as row_data
    from public.partner p
    left join lateral app_private.royalty_ledger(p.id) g on true
    group by p.id
  ) t;
  return jsonb_build_object(
    'month', v_month, 'current_month', v_cur, 'rows', v_rows,
    'totals', (select coalesce(jsonb_agg(jsonb_build_object('currency', c, 'accrued_minor', a, 'paid_minor', pd, 'debt_minor', d) order by c), '[]'::jsonb)
      from (select x ->> 'currency' c, sum((x ->> 'accrued_minor')::bigint + (x ->> 'manual_minor')::bigint) a, sum((x ->> 'paid_minor')::bigint) pd,
                   sum((x ->> 'debt_minor')::bigint) d
            from jsonb_array_elements(v_rows) x group by 1) s),
    'debt_rub_minor', (select round(sum((x ->> 'debt_minor')::numeric * (x ->> 'fx_rub')::numeric)) from jsonb_array_elements(v_rows) x));
end $$;

-- Карточка роялти франчайзи: помесячно, оплаты, ручные начисления, история ставки.
create function public.royalty_partner(p_partner uuid) returns jsonb
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
    'months', coalesce((select jsonb_agg(to_jsonb(g) order by g.month desc) from app_private.royalty_ledger(p.id) g), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on,
        'note', r.note, 'created_at', r.created_at) order by r.paid_on desc, r.created_at desc)
      from public.royalty_payment r where r.partner_id = p.id), '[]'::jsonb),
    'manual', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note,
        'created_at', r.created_at) order by r.month desc)
      from public.royalty_manual r where r.partner_id = p.id), '[]'::jsonb),
    'rates', coalesce((select jsonb_agg(jsonb_build_object('effective_from', r.effective_from, 'rate_bp', r.rate_bp) order by r.effective_from desc)
      from public.royalty_rate r where r.partner_id = p.id), '[]'::jsonb));
end $$;

create function app_private.royalty_partner_check(p_partner uuid) returns public.partner
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare p public.partner;
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  select * into p from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  return p;
end $$;

create function public.royalty_payment_add(p_partner uuid, p_month date, p_amount bigint, p_paid_on date, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Укажите сумму оплаты', 'amount'); end if;
  if p_month is null then perform app_private.fail('validation', 'Укажите месяц, за который оплата', 'month'); end if;
  if p_paid_on is null or p_paid_on > current_date + 1 then perform app_private.fail('validation', 'Неверная дата оплаты', 'paid_on'); end if;
  insert into public.royalty_payment(partner_id, month, amount_minor, paid_on, note, created_by)
  values (p_partner, date_trunc('month', p_month)::date, p_amount, p_paid_on, nullif(trim(p_note), ''), auth.uid()) returning id into v_id;
  perform app_private.audit('royalty.payment', 'royalty_payment', v_id, p_partner, jsonb_build_object('month', p_month, 'amount', p_amount));
  return v_id;
end $$;

create function public.royalty_payment_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.royalty_payment;
begin
  select * into r from public.royalty_payment where id = p_id;
  if not found then perform app_private.fail('not-found', 'Оплата не найдена'); end if;
  perform app_private.royalty_partner_check(r.partner_id);
  delete from public.royalty_payment where id = p_id;
  perform app_private.audit('royalty.payment_delete', 'royalty_payment', p_id, r.partner_id, to_jsonb(r));
end $$;

create function public.royalty_manual_add(p_partner uuid, p_month date, p_amount bigint, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Укажите сумму долга', 'amount'); end if;
  if p_month is null or date_trunc('month', p_month)::date > app_private.current_month() then
    perform app_private.fail('validation', 'Укажите прошедший месяц', 'month');
  end if;
  insert into public.royalty_manual(partner_id, month, amount_minor, note, created_by)
  values (p_partner, date_trunc('month', p_month)::date, p_amount, nullif(trim(p_note), ''), auth.uid()) returning id into v_id;
  perform app_private.audit('royalty.manual', 'royalty_manual', v_id, p_partner, jsonb_build_object('month', p_month, 'amount', p_amount));
  return v_id;
end $$;

create function public.royalty_manual_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.royalty_manual;
begin
  select * into r from public.royalty_manual where id = p_id;
  if not found then perform app_private.fail('not-found', 'Запись не найдена'); end if;
  perform app_private.royalty_partner_check(r.partner_id);
  delete from public.royalty_manual where id = p_id;
  perform app_private.audit('royalty.manual_delete', 'royalty_manual', p_id, r.partner_id, to_jsonb(r));
end $$;

-- Ставка франчайзи с месяца (по умолчанию 7 %). Прошлые месяцы до этой даты считаются по прежней ставке.
create function public.royalty_rate_set(p_partner uuid, p_rate_bp int, p_from date) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.royalty_partner_check(p_partner);
  if p_rate_bp is null or p_rate_bp < 0 or p_rate_bp > 10000 then perform app_private.fail('validation', 'Ставка от 0 до 100 %', 'rate'); end if;
  if p_from is null then perform app_private.fail('validation', 'Укажите месяц, с которого действует ставка', 'from'); end if;
  insert into public.royalty_rate(partner_id, effective_from, rate_bp, set_by) values (p_partner, date_trunc('month', p_from)::date, p_rate_bp, auth.uid())
  on conflict (partner_id, effective_from) do update set rate_bp = excluded.rate_bp, set_by = excluded.set_by, created_at = now();
  perform app_private.audit('royalty.rate', 'partner', p_partner, p_partner, jsonb_build_object('rate_bp', p_rate_bp, 'from', p_from));
end $$;

alter table public.royalty_rate enable row level security;
alter table public.royalty_manual enable row level security;
alter table public.royalty_payment enable row level security;
-- Франчайзи роялти не видит: чтение только с royalty.manage (у менеджера).
create policy read_manager on public.royalty_rate for select to authenticated using (app_private.has_perm('royalty.manage'));
create policy read_manager on public.royalty_manual for select to authenticated using (app_private.has_perm('royalty.manage'));
create policy read_manager on public.royalty_payment for select to authenticated using (app_private.has_perm('royalty.manage'));

insert into app_private.client_table(tbl) values ('public.royalty_rate'), ('public.royalty_manual'), ('public.royalty_payment');
insert into app_private.client_command(fn) values
  ('public.royalty_summary(date)'), ('public.royalty_partner(uuid)'),
  ('public.royalty_payment_add(uuid, date, bigint, date, text)'), ('public.royalty_payment_delete(uuid)'),
  ('public.royalty_manual_add(uuid, date, bigint, text)'), ('public.royalty_manual_delete(uuid)'),
  ('public.royalty_rate_set(uuid, int, date)');
select app_private.apply_grants();
