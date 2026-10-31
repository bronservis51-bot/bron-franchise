-- Cost data never enters a partner-readable table or view.
create table app_private.supply_snapshot (
  month date primary key check (month = date_trunc('month', month)::date),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  fetched_at timestamptz not null,
  period_to timestamp not null,
  currency text not null default 'RUB' check (currency = 'RUB')
);
create table app_private.supply_counterparty (
  counterparty_id uuid primary key,
  partner_id uuid not null references public.partner(id),
  note text not null default '',
  updated_at timestamptz not null default now()
);
alter table app_private.supply_snapshot enable row level security;
alter table app_private.supply_counterparty enable row level security;
revoke all on app_private.supply_snapshot, app_private.supply_counterparty from public, anon, authenticated;

-- Administrator-side import. An error rolls the entire replacement back.
create function app_private.supply_store(p_month date, p_rows jsonb, p_fetched_at timestamptz, p_period_to timestamp)
returns void language plpgsql set search_path = pg_catalog, app_private, public, pg_temp as $$
declare r jsonb; seen uuid[] := '{}'; cp uuid; sales bigint; cost bigint; profit bigint;
begin
  if p_month is null or p_month <> date_trunc('month',p_month)::date
     or p_fetched_at is null or p_period_to < p_month or p_period_to >= p_month + interval '1 month'
     or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>10000 then
    raise exception 'Invalid supply snapshot';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    cp := (r->>'counterparty_id')::uuid;
    sales := (r->>'sales_minor')::bigint; cost := (r->>'cost_minor')::bigint; profit := (r->>'profit_minor')::bigint;
    if cp is null or cp=any(seen) or coalesce(length(r->>'name'),0)=0
      or sales is null or cost is null or profit is null or abs(sales-cost-profit)>1 then
      raise exception 'Invalid or duplicate supply row';
    end if;
    seen := array_append(seen,cp);
  end loop;
  insert into app_private.supply_snapshot(month,rows,fetched_at,period_to)
  values(p_month,p_rows,p_fetched_at,p_period_to)
  on conflict(month) do update set rows=excluded.rows, fetched_at=excluded.fetched_at, period_to=excluded.period_to
  where excluded.fetched_at >= app_private.supply_snapshot.fetched_at;
end $$;
revoke all on function app_private.supply_store(date,jsonb,timestamptz,timestamp) from public, anon, authenticated;

create function public.manager_supply_snapshot(p_month date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare snap app_private.supply_snapshot;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  select * into snap from app_private.supply_snapshot where month=date_trunc('month',p_month)::date;
  return jsonb_build_object(
    'month', date_trunc('month',p_month)::date, 'fetched_at',snap.fetched_at,'period_to',snap.period_to,'currency','RUB',
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
      'partner_id',p.id,'partner_name',p.name,'counterparties',coalesce(x.names,'[]'::jsonb),
      'mapped_count', (select count(*) from app_private.supply_counterparty c where c.partner_id=p.id),
      'sales_minor',coalesce(x.sales,0),'cost_minor',coalesce(x.cost,0),'profit_minor',coalesce(x.profit,0)
    ) order by p.name),'[]'::jsonb)
    from public.partner p left join lateral (
      select jsonb_agg(r.name order by r.name) names,sum(r.sales_minor) sales,sum(r.cost_minor) cost,sum(r.profit_minor) profit
      from jsonb_to_recordset(coalesce(snap.rows,'[]'::jsonb)) r(counterparty_id uuid,name text,sales_minor bigint,cost_minor bigint,profit_minor bigint)
      join app_private.supply_counterparty c on c.counterparty_id=r.counterparty_id where c.partner_id=p.id
    ) x on true where p.status='active'),
    'unmapped', (select coalesce(jsonb_agg(to_jsonb(r) order by r.name),'[]'::jsonb)
      from jsonb_to_recordset(coalesce(snap.rows,'[]'::jsonb)) r(counterparty_id uuid,name text,sales_minor bigint,cost_minor bigint,profit_minor bigint)
      where not exists(select 1 from app_private.supply_counterparty c where c.counterparty_id=r.counterparty_id))
  );
end $$;

create function public.manager_supply_map(p_counterparty uuid,p_partner uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if not exists(select 1 from public.partner where id=p_partner and status='active')
    or not exists(select 1 from app_private.supply_snapshot s, jsonb_array_elements(s.rows) r
      where (r->>'counterparty_id')::uuid=p_counterparty) then
    perform app_private.fail('validation','Партнёр или контрагент не найден');
  end if;
  insert into app_private.supply_counterparty(counterparty_id,partner_id,note)
  values(p_counterparty,p_partner,'Подтверждено менеджером в кабинете')
  on conflict(counterparty_id) do update set partner_id=excluded.partner_id,note=excluded.note,updated_at=now();
  perform app_private.audit('supply.map','partner',p_partner,p_partner,jsonb_build_object('counterparty_id',p_counterparty));
end $$;
insert into app_private.client_command(fn) values
  ('public.manager_supply_snapshot(date)'),('public.manager_supply_map(uuid,uuid)');

-- All private helpers resolve names in fixed schemas.
do $$ declare r record; begin
  for r in select p.oid::regprocedure fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app_private')
      and not exists(select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')
  loop execute format('alter function %s set search_path=pg_catalog,public,app_private,extensions,pg_temp',r.fn); end loop;
end $$;

-- Durable operation receipts: retries after a lost HTTP response cannot duplicate money.
create table app_private.operation_receipt (
  user_id uuid not null references auth.users(id), operation_id uuid not null,
  command text not null, payload jsonb not null, result jsonb,
  created_at timestamptz not null default now(), primary key(user_id,operation_id)
);
alter table app_private.operation_receipt enable row level security;
revoke all on app_private.operation_receipt from public,anon,authenticated;

create function public.financial_operation(p_command text,p_args jsonb,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid := app_private.require_user(); old app_private.operation_receipt; answer jsonb;
begin
  if p_operation is null then perform app_private.fail('validation','Не указан ключ операции'); end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>p_command or old.payload<>p_args then perform app_private.fail('idempotency-conflict','Повтор операции с другими суммами'); end if;
    return old.result;
  end if;
  case p_command
    when 'royalty_payment_add' then answer:=to_jsonb(public.royalty_payment_add((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,(p_args->>'p_paid_on')::date,p_args->>'p_note'));
    when 'royalty_manual_add' then answer:=to_jsonb(public.royalty_manual_add((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    when 'royalty_set_accrual' then answer:=public.royalty_set_accrual((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_target')::bigint,p_args->>'p_note');
    when 'expense_save' then answer:=to_jsonb(public.expense_save((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,(p_args->>'p_location')::uuid,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    else perform app_private.fail('validation','Неизвестная финансовая операция');
  end case;
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,p_command,p_args,answer);
  return answer;
end $$;

create function public.revenue_save_checked(p_location uuid,p_day date,p_cash bigint,p_card bigint,p_expected_revision integer,p_operation uuid,p_comment text default null,p_employee uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid:=app_private.require_user(); old app_private.operation_receipt; rev integer; payload jsonb; answer jsonb;
begin
  perform app_private.revenue_location(p_location,'revenue.enter');
  if p_operation is null or p_expected_revision is null then perform app_private.fail('validation','Обновите приложение перед сохранением'); end if;
  payload:=jsonb_build_object('location',p_location,'day',p_day,'cash',p_cash,'card',p_card,'comment',p_comment,'employee',p_employee,'expected_revision',p_expected_revision);
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>'revenue_save' or old.payload<>payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные'); end if;
    return old.result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_location::text||p_day::text||coalesce(p_employee::text,''),0));
  select revision into rev from public.daily_revenue where location_id=p_location and day=p_day and employee_id is not distinct from p_employee for update;
  if coalesce(rev,-1)<>p_expected_revision then perform app_private.fail('version-conflict','Запись уже изменена. Сохраните введённые суммы и откройте день заново, чтобы сверить данные.'); end if;
  answer:=to_jsonb(public.revenue_save(p_location,p_day,p_cash,p_card,p_comment,p_employee));
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'revenue_save',payload,answer);
  return answer;
end $$;

create function public.shift_close_checked(p_shift uuid,p_cash bigint,p_card bigint,p_expected_closed_at timestamptz,p_operation uuid,p_comment text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid:=app_private.require_user(); old app_private.operation_receipt; w public.work_shift; payload jsonb; answer jsonb;
begin
  perform app_private.my_staff();
  if p_operation is null then perform app_private.fail('validation','Обновите приложение'); end if;
  payload:=jsonb_build_object('shift',p_shift,'cash',p_cash,'card',p_card,'comment',p_comment,'expected_closed_at',p_expected_closed_at);
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>'shift_close' or old.payload<>payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные'); end if;
    return old.result;
  end if;
  select * into w from public.work_shift where id=p_shift and employee_id=uid for update;
  if not found then perform app_private.fail('not-found','Смена не найдена'); end if;
  if w.closed_at is distinct from p_expected_closed_at then perform app_private.fail('version-conflict','Смена уже изменена. Откройте её заново и сверьте суммы.'); end if;
  answer:=public.shift_close(p_shift,p_cash,p_card,p_comment);
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'shift_close',payload,answer);
  return answer;
end $$;
insert into app_private.client_command(fn) values ('public.financial_operation(text,jsonb,uuid)'),('public.revenue_save_checked(uuid,date,bigint,bigint,integer,uuid,text,uuid)'),('public.shift_close_checked(uuid,bigint,bigint,timestamptz,uuid,text)');

create or replace function public.revenue_month(p_location uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_month date := date_trunc('month', p_month)::date; v_today date; v_elapsed int; v_prev date;
begin
  perform app_private.require_user();
  l := app_private.revenue_location(p_location, 'revenue.read');
  v_today := app_private.local_today(l.id);
  v_prev := (v_month - interval '1 month')::date;
  -- сколько дней месяца прошло: для текущего — по вчера, для прошлых — весь месяц
  v_elapsed := case when v_today < v_month then 0
                    when v_today < v_month + interval '1 month' then extract(day from v_today)::int - 1
                    else extract(day from (v_month + interval '1 month - 1 day'))::int end;
  return app_private.location_month(l, v_month) || jsonb_build_object(
    'editable_from', case when app_private.is_manager() then null
      when extract(day from v_today) <= 5 then (date_trunc('month', v_today) - interval '1 month')::date
      else date_trunc('month', v_today)::date end,
    'prev_month_total_minor', (select coalesce(sum(total_minor), 0) from public.daily_revenue where location_id = l.id
      and day >= v_prev and day < v_month),
    -- тот же период прошлого месяца (1…N число), чтобы сравнивать честно
    'prev_same_period_minor', (select coalesce(sum(total_minor), 0) from public.daily_revenue where location_id = l.id
      and day >= v_prev and day < v_prev + v_elapsed),
    'same_period_minor', (select coalesce(sum(total_minor), 0) from public.daily_revenue where location_id = l.id
      and day >= v_month and day < v_month + v_elapsed),
    -- средняя выручка по дням недели за 8 недель (1 = понедельник)
    'weekday_avg', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'avg_minor', avg_minor) order by dow), '[]'::jsonb) from (
        select extract(isodow from day)::int dow, round(avg(t))::bigint avg_minor
        from (select day, sum(total_minor) t from public.daily_revenue where location_id = l.id and day >= v_today - 56 and day < v_today group by day) d
        group by 1) w),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'full_name', u.full_name) order by u.full_name)
      from public.staff_member s join public.app_user u on u.id = s.user_id where s.partner_id = l.partner_id and s.active and l.id = any(s.location_ids)), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(d order by d ->> 'day' desc) from (
        select jsonb_build_object('day', r.day, 'cash_minor', sum(r.cash_minor), 'card_minor', sum(r.card_minor), 'total_minor', sum(r.total_minor),
          'comment', string_agg(r.comment, '; '), 'updated_at', max(r.updated_at),
          'entries', jsonb_agg(jsonb_build_object('revision', r.revision, 'employee_id', r.employee_id, 'employee_name', u.full_name, 'cash_minor', r.cash_minor,
            'card_minor', r.card_minor, 'total_minor', r.total_minor, 'comment', r.comment) order by u.full_name nulls first)) d
        from public.daily_revenue r left join public.app_user u on u.id = r.employee_id
        where r.location_id = l.id and r.day between v_month and (v_month + interval '1 month - 1 day')::date
        group by r.day) x), '[]'::jsonb));
end $$;
select app_private.apply_grants();
