-- Store the franchisee's full-day declaration separately from the contribution to totals.
alter table public.daily_revenue
  add column reported_cash_minor bigint,
  add column reported_card_minor bigint,
  drop constraint daily_declaration_owner,
  add constraint daily_declaration_owner check (
    (reported_total_minor is null and reported_cash_minor is null and reported_card_minor is null)
    or (reported_total_minor is not null and employee_id is null and (
      (reported_cash_minor is null and reported_card_minor is null and cash_minor = 0 and card_minor = 0)
      or (reported_cash_minor is not null and reported_card_minor is not null
        and reported_cash_minor >= 0 and reported_card_minor >= 0
        and reported_cash_minor + reported_card_minor = reported_total_minor)
    ))
  );

-- The original CSV importer stored an unknown method in the cash column.
-- Match its exact provenance and preserve the row UUID and total.
create function app_private.revenue_reclassify_sheet_import() returns void
language sql set search_path = pg_catalog, public, pg_temp as $$
  update public.daily_revenue
  set unallocated_minor = unallocated_minor + cash_minor, cash_minor = 0, revision = revision + 1, updated_at = now()
  where employee_id is null and entered_by is null and reported_total_minor is null and cash_minor > 0 and card_minor = 0
    and comment = 'Перенесено из Google-таблицы (без разбивки на наличные и карту)';
$$;
select app_private.revenue_reclassify_sheet_import();
drop function app_private.revenue_reclassify_sheet_import();

create or replace function app_private.revenue_reconcile_declaration() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  v_location uuid := coalesce(new.location_id, old.location_id);
  v_day date := coalesce(new.day, old.day);
  v_staff bigint;
  v_cash bigint;
  v_card bigint;
begin
  if coalesce(new.employee_id, old.employee_id) is null then return null; end if;
  select coalesce(sum(total_minor),0), coalesce(sum(cash_minor),0), coalesce(sum(card_minor),0)
    into v_staff, v_cash, v_card
  from public.daily_revenue where location_id = v_location and day = v_day and employee_id is not null;
  -- When a corrected shift exceeds a declared payment method, retain the known
  -- shift amounts and keep the unresolved remainder undistributed.
  update public.daily_revenue set
    cash_minor = case when v_cash <= reported_cash_minor and v_card <= reported_card_minor
                        then reported_cash_minor - v_cash else 0 end,
    card_minor = case when v_cash <= reported_cash_minor and v_card <= reported_card_minor
                        then reported_card_minor - v_card else 0 end,
    unallocated_minor = case when v_cash <= reported_cash_minor and v_card <= reported_card_minor
                          then 0 else greatest(0, reported_total_minor - v_staff) end,
    revision = revision + 1, updated_at = now()
  where location_id = v_location and day = v_day and employee_id is null and reported_total_minor is not null;
  return null;
end $$;

create function app_private.revenue_declare(p_location uuid, p_day date, p_total bigint, p_cash bigint, p_card bigint,
  p_expected_version text, p_operation uuid, p_comment text) returns jsonb
language plpgsql set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); l public.location; v_staff bigint; v_staff_cash bigint; v_staff_card bigint; v_id uuid;
 v_kind text := case when p_cash is null then 'revenue_total_set' else 'revenue_split_set' end; v_payload jsonb; v_receipt app_private.operation_receipt; v_result jsonb;
begin
 l:=app_private.revenue_location(p_location,'revenue.enter');
 if p_operation is null or p_expected_version is null then perform app_private.fail('validation','Обновите данные дня'); end if;
 v_payload:=jsonb_build_object('location',p_location,'day',p_day,'total',p_total,'version',p_expected_version,'comment',p_comment);
 if p_cash is not null then v_payload := v_payload || jsonb_build_object('cash',p_cash,'card',p_card); end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':'||p_operation::text,0));
 select * into v_receipt from app_private.operation_receipt where user_id=v_user and operation_id=p_operation;
 if found then
  if v_receipt.command<>v_kind or v_receipt.payload<>v_payload then perform app_private.fail('validation','Ключ операции уже использован'); end if;
  return v_receipt.result;
 end if;
 perform 1 from public.location where id=l.id for share;
 if p_day is null or p_day>app_private.local_today(p_location) or p_total is null or p_total not between 0 and 100000000000 then perform app_private.fail('validation','Проверьте дату и сумму выручки'); end if;
 if not app_private.revenue_day_open(p_location,p_day) then perform app_private.fail('validation','Выберите рабочую дату точки не раньше открытия','day'); end if;
 perform app_private.revenue_day_lock(p_location,p_day);
 if app_private.revenue_day_version(p_location,p_day)<>p_expected_version then perform app_private.fail('version-conflict','Выручка за день изменилась. Откройте день заново и проверьте сумму'); end if;
 if p_cash is null and exists (select 1 from public.daily_revenue
  where location_id=p_location and day=p_day and employee_id is null and reported_cash_minor is not null) then
  perform app_private.fail('version-conflict','Обновите приложение, чтобы сохранить наличные и карту');
 end if;
 select coalesce(sum(total_minor),0), coalesce(sum(cash_minor),0), coalesce(sum(card_minor),0)
 into v_staff,v_staff_cash,v_staff_card from public.daily_revenue where location_id=p_location and day=p_day and employee_id is not null;
 if p_total<v_staff then perform app_private.fail('validation','Общая выручка меньше уже внесённых смен. Сначала сотрудник должен проверить свою смену'); end if;
 if p_cash is not null and (p_cash < v_staff_cash or p_card < v_staff_card) then
  perform app_private.fail('validation','Наличные и карта должны включать выручку по сменам');
 end if;
 insert into public.daily_revenue(location_id,partner_id,day,currency,cash_minor,card_minor,unallocated_minor,reported_total_minor,reported_cash_minor,reported_card_minor,comment,entered_by)
 values(p_location,l.partner_id,p_day,l.currency,coalesce(p_cash-v_staff_cash,0),coalesce(p_card-v_staff_card,0),
   case when p_cash is null then p_total-v_staff else 0 end,p_total,p_cash,p_card,nullif(trim(p_comment),''),v_user)
 on conflict(location_id,day,employee_id) do update set cash_minor=excluded.cash_minor,card_minor=excluded.card_minor,
 unallocated_minor=excluded.unallocated_minor,reported_total_minor=p_total,
 reported_cash_minor=p_cash,reported_card_minor=p_card,
 comment=excluded.comment,entered_by=v_user,revision=public.daily_revenue.revision+1,updated_at=now() returning id into v_id;
 v_result:=jsonb_build_object('id',v_id,'total_minor',p_total);
 insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(v_user,p_operation,v_kind,v_payload,v_result);
 perform app_private.audit('revenue.total','daily_revenue',v_id,l.partner_id,jsonb_build_object('day',p_day,'total',p_total,'cash',p_cash,'card',p_card));
 return v_result;
end $$;

revoke execute on function app_private.revenue_declare(uuid,date,bigint,bigint,bigint,text,uuid,text)
  from public, anon, authenticated, service_role;
do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres','supabase_admin') loop
    execute format('grant execute on function app_private.revenue_declare(uuid,date,bigint,bigint,bigint,text,uuid,text) to %I', trusted);
  end loop;
end $acl$;

create or replace function public.revenue_total_set(p_location uuid,p_day date,p_total bigint,p_expected_version text,p_operation uuid,p_comment text default null)
returns jsonb language sql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
 select app_private.revenue_declare(p_location,p_day,p_total,null,null,p_expected_version,p_operation,p_comment)
$$;

create function public.revenue_split_set(p_location uuid,p_day date,p_cash bigint,p_card bigint,p_expected_version text,p_operation uuid,p_comment text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  if p_cash is null or p_card is null or p_cash not between 0 and 100000000000 or p_card not between 0 and 100000000000 then
    perform app_private.fail('validation','Укажите наличные и оплату картой');
  end if;
  return app_private.revenue_declare(p_location,p_day,p_cash+p_card,p_cash,p_card,p_expected_version,p_operation,p_comment);
end $$;

revoke execute on function public.revenue_split_set(uuid,date,bigint,bigint,text,uuid,text) from public, anon;
grant execute on function public.revenue_split_set(uuid,date,bigint,bigint,text,uuid,text) to authenticated;
insert into app_private.client_command(fn) values ('public.revenue_split_set(uuid,date,bigint,bigint,text,uuid,text)');

create or replace function public.revenue_save(p_location uuid, p_day date, p_cash bigint, p_card bigint, p_comment text default null, p_employee uuid default null)
returns public.daily_revenue
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; r public.daily_revenue;
begin
  perform app_private.revenue_day_lock(p_location,p_day);
  l := app_private.revenue_location(p_location, 'revenue.enter');
  perform 1 from public.location where id=l.id for share;
  if p_day is null or p_day > app_private.local_today(p_location) then
    perform app_private.fail('validation', 'Нельзя внести выручку за будущий день', 'day');
  end if;
  if not app_private.revenue_day_open(p_location, p_day) then
    perform app_private.fail('validation', 'Выберите рабочую дату точки не раньше открытия', 'day');
  end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_card, 0) < 0 then perform app_private.fail('validation', 'Сумма не может быть отрицательной', 'cash'); end if;
  if coalesce(p_cash, 0) + coalesce(p_card, 0) > 100000000000 then perform app_private.fail('validation', 'Слишком большая сумма', 'cash'); end if;
  if p_employee is null and exists(select 1 from public.daily_revenue where location_id=p_location and day=p_day and employee_id is null and reported_total_minor is not null) then perform app_private.fail('version-conflict','Обновите приложение и введите общую выручку дня'); end if;
  if p_employee is not null then
    perform app_private.shift_store(l, p_employee, p_day, coalesce(p_cash, 0), coalesce(p_card, 0), p_comment);
    select * into r from public.daily_revenue where location_id = p_location and day = p_day and employee_id = p_employee;
  else
    insert into public.daily_revenue(location_id, partner_id, day, currency, cash_minor, card_minor, comment, entered_by)
    values (p_location, l.partner_id, p_day, l.currency, coalesce(p_cash, 0), coalesce(p_card, 0), nullif(trim(p_comment), ''), v_user)
    on conflict (location_id, day, employee_id) do update set cash_minor = excluded.cash_minor, card_minor = excluded.card_minor,
      unallocated_minor = 0, comment = excluded.comment, entered_by = excluded.entered_by, updated_at = now(), revision = public.daily_revenue.revision + 1
    returning * into r;
  end if;
  perform app_private.audit('revenue.save', 'daily_revenue', r.id, l.partner_id,
    jsonb_build_object('day', p_day, 'cash', r.cash_minor, 'card', r.card_minor, 'employee', p_employee));
  return r;
end $$;

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
    'editable_from', case when app_private.point_awaits_opening_date(l, v_today) then v_today + 1 else least(l.opened_on,l.first_opened_on) end,
    'return_minor', (select coalesce(sum(w.return_minor),0) from public.work_shift w
      where w.location_id=l.id and w.status='closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
    'prev_month_total_minor', (select coalesce(sum(total_minor), 0) from public.daily_revenue where location_id = l.id
      and day >= v_prev and day < v_month),
    -- тот же период прошлого месяца (1…N число), чтобы сравнивать честно
    'prev_same_period_minor', (select coalesce(sum(total_minor), 0) from public.daily_revenue where location_id = l.id
      and day >= v_prev and day < least(v_month,v_prev + v_elapsed)),
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
          'return_minor',(select coalesce(sum(w.return_minor),0) from public.work_shift w
            where w.location_id=l.id and w.status='closed' and w.day=r.day),
          'day_version',app_private.revenue_day_version(l.id,r.day),'reported_total_minor',max(r.reported_total_minor),
          'reported_cash_minor',max(r.reported_cash_minor),'reported_card_minor',max(r.reported_card_minor),'unallocated_minor',sum(r.unallocated_minor),'comment', string_agg(r.comment, '; '), 'updated_at', max(r.updated_at),
          'entries', jsonb_agg(jsonb_build_object('revision', r.revision,'reported_total_minor',r.reported_total_minor,'unallocated_minor',r.unallocated_minor, 'employee_id', r.employee_id, 'employee_name', u.full_name, 'cash_minor', r.cash_minor,
            'card_minor', r.card_minor, 'total_minor', r.total_minor, 'comment', r.comment) order by u.full_name nulls first)) d
        from public.daily_revenue r left join public.app_user u on u.id = r.employee_id
        where r.location_id = l.id and r.day between v_month and (v_month + interval '1 month - 1 day')::date
        group by r.day) x), '[]'::jsonb));
end $$;
