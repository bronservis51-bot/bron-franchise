-- Keep shutdown intervals when a point reopens. Empty days inside a shutdown cannot
-- become sales; an already recorded day can still be corrected by an authorized owner.
alter table public.location
  add column closed_days datemultirange not null default '{}',
  add column first_opened_on date;

-- Rebuild known transitions from status snapshots. If a legacy closed point has
-- no trusted last closure, only an existing financial/calendar record can prove a day.
with snapshots as (
  select l.id, l.status as current_status, l.timezone, e.at, e.id as event_id, e.diff->>'status' as status,
    lag(e.diff->>'status') over (partition by l.id order by e.at,e.id) as previous
  from public.location l join public.audit_event e on e.entity_type='location' and e.entity_id=l.id
  where e.action in ('location.create','location.update') and e.diff->>'status' in ('active','closed')
), transitions as (
  select *, lead(at) over (partition by id order by at,event_id) as next_transition
  from snapshots where status is distinct from previous
), closures as (
  select id, range_agg(daterange(
    case when previous='active' then (at at time zone timezone)::date end,
    case when next_transition is not null then (next_transition at time zone timezone)::date
         when current_status='active' then (now() at time zone timezone)::date end, '[)')) as days,
    bool_or(next_transition is null) as ends_closed
  from transitions where status='closed' group by id
), resolved as (
  select l.id, case when l.status='closed' and not coalesce(c.ends_closed,false)
    then datemultirange(daterange(null,null,'()')) else coalesce(c.days,'{}'::datemultirange) end as days
  from public.location l left join closures c on c.id=l.id
)
update public.location l set closed_days=r.days,
  first_opened_on=case when exists (select 1 from unnest(r.days) gap where l.opened_on <= lower(gap)) then l.opened_on end
from resolved r where l.id=r.id and r.days <> '{}';

create function app_private.track_point_closed_days() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare today date := (now() at time zone new.timezone)::date;
  since_today datemultirange := datemultirange(daterange(today,null,'[)'));
  since_opening datemultirange := datemultirange(daterange(greatest(today,new.opened_on),null,'[)'));
begin
  if tg_op='INSERT' then
    new.closed_days := case when new.status='closed' then datemultirange(daterange(null,null,'()'))
      else '{}'::datemultirange end;
  elsif old.status='active' and new.status='closed' then
    if old.opened_on <= today then
      new.first_opened_on := least(old.first_opened_on, old.opened_on);
    end if;
    new.closed_days := old.closed_days + since_today;
  elsif old.status='closed' and new.status='active' then
    new.closed_days := old.closed_days - since_opening;
  elsif new.status='active' and new.first_opened_on is not null and new.opened_on is distinct from old.opened_on
    and (old.opened_on > today or new.opened_on > today) then
    -- If a scheduled reopening moves, keep verified past days and adjust only its remaining downtime.
    new.closed_days := (old.closed_days + since_today) - since_opening;
  end if;
  return new;
end $$;
revoke all on function app_private.track_point_closed_days() from public, anon, authenticated, service_role;
create trigger point_closed_calendar before insert or update of status, opened_on on public.location
for each row execute function app_private.track_point_closed_days();

-- Permissions stay with each existing RPC. The calendar starts at opening and
-- ends on the point's local day. It has no monthly reporting cutoff.
create or replace function app_private.revenue_day_open(p_location uuid, p_day date) returns boolean
language sql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
  select exists (select 1 from public.location l where l.id = p_location
    and isfinite(p_day) and p_day <= app_private.local_today(l.id)
    and (((least(l.opened_on,l.first_opened_on) is null or p_day >= least(l.opened_on,l.first_opened_on))
          and not app_private.point_awaits_opening_date(l, app_private.local_today(l.id))
          and not (l.closed_days @> p_day) and (l.status='active' or least(l.opened_on,l.first_opened_on) is not null))
      -- A later opening date must not strand an already reported day.
      or exists(select 1 from public.daily_revenue r where r.location_id=l.id and r.day=p_day)
      or exists(select 1 from public.work_shift w where w.location_id=l.id and w.day=p_day and w.status='closed')
      or exists(select 1 from app_private.revenue_day_off d where d.location_id=l.id and d.day=p_day)))
$$;

create or replace function app_private.require_shift_point_open(p_point public.location, p_day date) returns void
language plpgsql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  if p_day < least(p_point.opened_on,p_point.first_opened_on) or p_point.closed_days @> p_day then
    perform app_private.fail('validation', 'В эту дату точка ещё не открылась или была закрыта', 'day');
  end if;
  if app_private.point_awaits_opening_date(p_point, app_private.local_today(p_point.id)) then
    perform app_private.fail('validation', 'Для точки ещё не указана дата открытия. Обратитесь к руководителю', 'day');
  end if;
end $$;

create or replace function public.shift_submit(
  p_location uuid, p_day date, p_cash bigint, p_card bigint, p_operation uuid, p_comment text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  employee public.staff_member;
  point public.location;
  shift public.work_shift;
  today date;
  receipt app_private.operation_receipt;
  payload jsonb;
  result jsonb;
begin
  employee := app_private.my_staff();
  if p_operation is null or p_location is null or p_day is null or not isfinite(p_day) then
    perform app_private.fail('validation', 'Укажите точку и дату смены и обновите приложение');
  end if;
  payload := jsonb_build_object('location', p_location, 'day', p_day, 'cash', p_cash, 'card', p_card, 'comment', p_comment);
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_operation::text, 0));
  select * into receipt from app_private.operation_receipt where user_id = actor and operation_id = p_operation;
  if found then
    if receipt.command <> 'shift_submit' or receipt.payload <> payload then
      perform app_private.fail('idempotency-conflict', 'Операция содержит другие данные');
    end if;
    return receipt.result;
  end if;

  -- Same order as shift_open and financial writers: employee, then day, then row.
  perform pg_advisory_xact_lock(hashtextextended('shift-user:' || actor, 0));
  perform app_private.revenue_day_lock(p_location, p_day);
  select * into shift from public.work_shift where employee_id = actor and status = 'open';
  if found and (shift.location_id <> p_location or shift.day <> p_day) then
    perform app_private.fail('version-conflict', 'Сначала закройте открытую смену или обратитесь к руководителю');
  end if;

  if shift.id is null then
    select * into point from public.location
      where id = p_location and partner_id = employee.partner_id and id = any(employee.location_ids) for share;
    if not found then perform app_private.fail('not-found', 'Эта точка вам не назначена'); end if;
    if point.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
    if exists (select 1 from public.work_shift where employee_id = actor and location_id = p_location and day = p_day) then
      perform app_private.fail('version-conflict', 'Смена за эту дату уже закрыта. Откройте её и сверьте суммы');
    end if;
    today := app_private.local_today(p_location);
    if p_day > today then
      perform app_private.fail('validation', 'Нельзя сдать смену за будущий день', 'day');
    end if;
    perform app_private.require_shift_point_open(point, p_day);
    insert into public.work_shift(partner_id, location_id, employee_id, day, submitted_without_open)
      values (point.partner_id, point.id, actor, p_day, true) returning * into shift;
  end if;
  result := public.shift_close(shift.id, p_cash, p_card, p_comment);
  insert into app_private.operation_receipt(user_id, operation_id, command, payload, result)
    values (actor, p_operation, 'shift_submit', payload, result);
  return result;
end $$;

create or replace function app_private.employee_shift_close(p_shift uuid, p_cash bigint, p_card bigint, p_comment text, p_expected_revision bigint) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); w public.work_shift; previous public.work_shift; l public.location; v_month date;
begin
 perform app_private.my_staff();
 select * into w from public.work_shift where id=p_shift and employee_id=v_user;
 if not found then perform app_private.fail('not-found','Смена не найдена');end if;
 perform app_private.revenue_day_lock(w.location_id,w.day);
 select * into w from public.work_shift where id=p_shift and employee_id=v_user for update;
 if not found then perform app_private.fail('not-found','Смена не найдена');end if;
 if p_expected_revision is not null and w.revision <> p_expected_revision then
  perform app_private.fail('version-conflict','Смена уже изменена. Откройте её заново и сверьте суммы');
 end if;
 -- Preserve a real open shift even when the point's opening date was subsequently changed.
 if not isfinite(w.day) or w.day > app_private.local_today(w.location_id) then
  perform app_private.fail('validation','Нельзя сдать смену за будущий день','day');
 end if;
 if w.status='closed' and (w.closed_at is null or clock_timestamp()>=w.closed_at+interval '5 minutes') then
  perform app_private.fail('period-locked','Пять минут после сдачи выручки истекли. Исправление доступно руководителю');
 end if;
 if w.status='closed' and p_expected_revision is null then
  perform app_private.fail('version-conflict','Смена уже закрыта. Обновите приложение и сверьте суммы перед исправлением');
 end if;
 if p_cash is null or p_card is null then perform app_private.fail('validation','Укажите обе суммы; если продаж не было — 0');end if;
 if p_cash<0 or p_card<0 then perform app_private.fail('validation','Сумма не может быть отрицательной','cash');end if;
 if p_cash::numeric+p_card::numeric>100000000000 then perform app_private.fail('validation','Слишком большая сумма','cash');end if;
 previous:=w;
 select * into l from public.location where id=w.location_id;
 w:=app_private.shift_store(l,v_user,w.day,p_cash,p_card,p_comment);
 if previous.status='closed' then
  perform app_private.audit('shift.correct','work_shift',w.id,l.partner_id,jsonb_build_object(
   'before',jsonb_build_object('cash',previous.cash_minor,'card',previous.card_minor,'earned',previous.earned_minor,'comment',previous.comment,'revision',previous.revision),
   'after',jsonb_build_object('cash',w.cash_minor,'card',w.card_minor,'earned',w.earned_minor,'comment',w.comment,'revision',w.revision),
   'first_closed_at',w.closed_at));
 else
  perform app_private.audit('shift.close','work_shift',w.id,l.partner_id,jsonb_build_object('cash',w.cash_minor,'card',w.card_minor,'earned',w.earned_minor));
 end if;
 v_month:=date_trunc('month',w.day)::date;
 return jsonb_build_object('shift',to_jsonb(w),'currency',l.currency,
  'month_earned_minor',(select coalesce(sum(earned_minor),0) from public.work_shift where employee_id=v_user and status='closed' and day>=v_month and day<v_month+interval '1 month'),
  'month_shifts',(select count(*) from public.work_shift where employee_id=v_user and status='closed' and day>=v_month and day<v_month+interval '1 month'));
end $$;

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
      comment = excluded.comment, entered_by = excluded.entered_by, updated_at = now(), revision = public.daily_revenue.revision + 1
    returning * into r;
  end if;
  perform app_private.audit('revenue.save', 'daily_revenue', r.id, l.partner_id,
    jsonb_build_object('day', p_day, 'cash', r.cash_minor, 'card', r.card_minor, 'employee', p_employee));
  return r;
end $$;

create or replace function public.revenue_total_set(p_location uuid,p_day date,p_total bigint,p_expected_version text,p_operation uuid,p_comment text default null) returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); l public.location; v_staff bigint; v_id uuid; v_payload jsonb; v_receipt app_private.operation_receipt; v_result jsonb;
begin
 l:=app_private.revenue_location(p_location,'revenue.enter');
 if p_operation is null or p_expected_version is null then perform app_private.fail('validation','Обновите данные дня'); end if;
 v_payload:=jsonb_build_object('location',p_location,'day',p_day,'total',p_total,'version',p_expected_version,'comment',p_comment);
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':'||p_operation::text,0));
 select * into v_receipt from app_private.operation_receipt where user_id=v_user and operation_id=p_operation;
 if found then
  if v_receipt.command<>'revenue_total_set' or v_receipt.payload<>v_payload then perform app_private.fail('validation','Ключ операции уже использован'); end if;
  return v_receipt.result;
 end if;
 perform 1 from public.location where id=l.id for share;
 if p_day is null or p_day>app_private.local_today(p_location) or p_total is null or p_total not between 0 and 100000000000 then perform app_private.fail('validation','Проверьте дату и сумму выручки'); end if;
 if not app_private.revenue_day_open(p_location,p_day) then perform app_private.fail('validation','Выберите рабочую дату точки не раньше открытия','day'); end if;
 perform app_private.revenue_day_lock(p_location,p_day);
 if app_private.revenue_day_version(p_location,p_day)<>p_expected_version then perform app_private.fail('version-conflict','Выручка за день изменилась. Откройте день заново и проверьте сумму'); end if;
 select coalesce(sum(total_minor),0) into v_staff from public.daily_revenue where location_id=p_location and day=p_day and employee_id is not null;
 if p_total<v_staff then perform app_private.fail('validation','Общая выручка меньше уже внесённых смен. Сначала сотрудник должен проверить свою смену'); end if;
 insert into public.daily_revenue(location_id,partner_id,day,currency,cash_minor,card_minor,unallocated_minor,reported_total_minor,comment,entered_by)
 values(p_location,l.partner_id,p_day,l.currency,0,0,p_total-v_staff,p_total,nullif(trim(p_comment),''),v_user)
 on conflict(location_id,day,employee_id) do update set cash_minor=0,card_minor=0,unallocated_minor=excluded.unallocated_minor,reported_total_minor=p_total,
 comment=excluded.comment,entered_by=v_user,revision=public.daily_revenue.revision+1,updated_at=now() returning id into v_id;
 v_result:=jsonb_build_object('id',v_id,'total_minor',p_total);
 insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(v_user,p_operation,'revenue_total_set',v_payload,v_result);
 perform app_private.audit('revenue.total','daily_revenue',v_id,l.partner_id,jsonb_build_object('day',p_day,'total',p_total));
 return v_result;
end $$;

create or replace function public.revenue_delete(p_location uuid, p_day date, p_employee uuid default null) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_id uuid;
begin
  perform app_private.revenue_day_lock(p_location,p_day);
  perform app_private.require_user();
  l := app_private.revenue_location(p_location, 'revenue.enter');
  if not app_private.revenue_day_open(p_location, p_day) then
    perform app_private.fail('validation', 'Выберите рабочую дату точки не раньше открытия', 'day');
  end if;
  delete from public.daily_revenue where location_id = p_location and day = p_day and employee_id is not distinct from p_employee returning id into v_id;
  if v_id is null then perform app_private.fail('not-found', 'За этот день выручка не внесена'); end if;
  if p_employee is not null then
    delete from public.work_shift where location_id = p_location and day = p_day and employee_id = p_employee;
  end if;
  perform app_private.audit('revenue.delete', 'daily_revenue', v_id, l.partner_id, jsonb_build_object('day', p_day, 'employee', p_employee));
end $$;

create or replace function public.revenue_day_off_set(p_location uuid, p_day date, p_day_off boolean) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare
  v_user uuid := app_private.require_user();
  l public.location;
begin
  l := app_private.revenue_location(p_location, 'revenue.enter');
  perform 1 from public.location where id=l.id for share;
  if p_day_off is null or p_day is null or not isfinite(p_day) or p_day > app_private.local_today(l.id) then
    perform app_private.fail('validation', 'Выберите дату не позднее сегодняшнего дня', 'day');
  end if;
  if p_day_off and not app_private.revenue_day_open(l.id, p_day) then
    perform app_private.fail('validation', 'Выберите рабочую дату точки не раньше открытия', 'day');
  end if;

  perform app_private.revenue_day_lock(l.id, p_day);
  if p_day_off then
    if exists (select 1 from public.daily_revenue r where r.location_id = l.id and r.day = p_day) then
      perform app_private.fail('validation', 'За этот день уже внесена выручка', 'day');
    end if;
    if exists (select 1 from public.work_shift w where w.partner_id = l.partner_id and w.location_id = l.id and w.day = p_day) then
      perform app_private.fail('validation', 'На эту дату уже есть смена', 'day');
    end if;
    insert into app_private.revenue_day_off(location_id, day, marked_by) values (l.id, p_day, v_user)
    on conflict (location_id, day) do nothing;
  else
    delete from app_private.revenue_day_off where location_id = l.id and day = p_day;
  end if;
  if found then
    perform app_private.audit('revenue.day_off', 'location', l.id, l.partner_id, jsonb_build_object('day', p_day, 'day_off', p_day_off));
  end if;
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
          'day_version',app_private.revenue_day_version(l.id,r.day),'reported_total_minor',max(r.reported_total_minor),'unallocated_minor',sum(r.unallocated_minor),'comment', string_agg(r.comment, '; '), 'updated_at', max(r.updated_at),
          'entries', jsonb_agg(jsonb_build_object('revision', r.revision,'reported_total_minor',r.reported_total_minor,'unallocated_minor',r.unallocated_minor, 'employee_id', r.employee_id, 'employee_name', u.full_name, 'cash_minor', r.cash_minor,
            'card_minor', r.card_minor, 'total_minor', r.total_minor, 'comment', r.comment) order by u.full_name nulls first)) d
        from public.daily_revenue r left join public.app_user u on u.id = r.employee_id
        where r.location_id = l.id and r.day between v_month and (v_month + interval '1 month - 1 day')::date
        group by r.day) x), '[]'::jsonb));
end $$;

create or replace function public.staff_home(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; v_month date;
begin
  s := app_private.my_staff();
  v_month := date_trunc('month', coalesce(p_month, (select app_private.local_today(s.location_ids[1]))))::date;
  return jsonb_build_object(
    'month', v_month,
    'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation, 'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
    'partner_name', (select name from public.partner where id = s.partner_id),
    'open_shift', (select to_jsonb(w) || jsonb_build_object('location_name', l.name, 'currency', l.currency)
                   from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = v_user and w.status = 'open'),
    -- Reminders describe the assigned point; correction links contain only this employee’s shifts.
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'location_name', l.name, 'currency', l.currency,
        'today', app_private.local_today(l.id), 'opened_on', least(l.opened_on,l.first_opened_on),
        'awaiting_opening_date', app_private.point_awaits_opening_date(l, app_private.local_today(l.id)),
        'missing_count', gaps.days, 'missing_periods', gaps.periods,
        'recent_corrections', coalesce((select jsonb_agg(to_jsonb(w) order by w.closed_at desc)
          from public.work_shift w where w.employee_id=v_user and w.location_id=l.id and w.status='closed'
            and w.day < calendar.today - 1 and w.closed_at > now() - interval '5 minutes'), '[]'::jsonb),
        'days_off', coalesce((select jsonb_agg(unavailable.day order by unavailable.day) from (
          select d.day from app_private.revenue_day_off d where d.location_id = l.id
            and (d.day between calendar.today - 1 and calendar.today
              or (d.day >= v_month and d.day < v_month + interval '1 month'))
          union
          select day::date from unnest(l.closed_days * datemultirange(
              daterange(v_month,(v_month + interval '1 month')::date),
              daterange(calendar.today - 1,calendar.today + 1))) closure
            cross join lateral generate_series(lower(closure),upper(closure) - 1,interval '1 day') day
        ) unavailable), '[]'::jsonb),
        'pay_today', app_private.staff_pay_policy(v_user, app_private.local_today(l.id)),
        'pay_yesterday', app_private.staff_pay_policy(v_user, app_private.local_today(l.id) - 1),
        'my_today', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id)),
        'my_yesterday', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id) - 1))
        order by l.name)
      from public.location l
      cross join lateral (select app_private.local_today(l.id) as today) calendar
      cross join lateral (
        -- For an undated legacy point use recorded activity and the current reporting month.
        select case when app_private.point_awaits_opening_date(l, calendar.today) then calendar.today
          else least(calendar.today, coalesce(least(l.opened_on,l.first_opened_on), least(date_trunc('month', calendar.today)::date,
            (select min(r.day) from public.daily_revenue r where r.location_id=l.id),
            (select min(w.day) from public.work_shift w where w.location_id=l.id)))) end as start_day
      ) bounds
      cross join lateral (
        -- Subtract reported and explicitly closed dates as ranges. Large gaps stay compact.
        select datemultirange(daterange(bounds.start_day, calendar.today, '[)'))
          - coalesce(range_agg(daterange(reported.day, reported.day + 1, '[)')), '{}'::datemultirange) as missing
        from (
          select r.day from public.daily_revenue r where r.location_id=l.id and r.day >= bounds.start_day and r.day < calendar.today
          union all
          select d.day from app_private.revenue_day_off d where d.location_id=l.id and d.day >= bounds.start_day and d.day < calendar.today
        ) reported
      ) outstanding
      cross join lateral (
        select coalesce(sum(upper(gap) - lower(gap)),0) as days,
          coalesce(jsonb_agg(jsonb_build_object('from',lower(gap),'until',upper(gap) - 1) order by lower(gap)), '[]'::jsonb) as periods
        from unnest(outstanding.missing - l.closed_days) gap
      ) gaps
      where l.partner_id=s.partner_id and l.id = any(s.location_ids) and l.status = 'active'), '[]'::jsonb),
    'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_shifts', (select count(*) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'currency', (select currency from public.partner where id = s.partner_id),
    'shifts', coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object('location_name', l.name) order by w.day desc, w.opened_at desc)
      from public.work_shift w join public.location l on l.id = w.location_id
      where w.employee_id = v_user and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb));
end $$;

create or replace function app_private.location_month(l public.location, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_today date := app_private.local_today(l.id);
  v_plan bigint; v_fact bigint; v_cash bigint; v_card bigint; v_missing date[]; v_editable date[]; v_days_off date[]; v_left int; v_last date;
begin
  select amount_minor into v_plan from public.revenue_plan where location_id = l.id and month = v_month;
  select coalesce(sum(total_minor), 0), coalesce(sum(cash_minor), 0), coalesce(sum(card_minor), 0), max(day)
    into v_fact, v_cash, v_card, v_last
  from public.daily_revenue where location_id = l.id and day between v_month and v_end;
  select coalesce(array_agg(day order by day), '{}') into v_days_off
    from app_private.revenue_day_off where location_id = l.id and day between v_month and v_end;
  select coalesce(array_agg(d::date order by d), '{}') into v_editable
  from generate_series(v_month,least(v_end,v_today),interval '1 day') d
  where app_private.revenue_day_open(l.id,d::date);
  select coalesce(array_agg(d order by d), '{}') into v_missing
  from unnest(v_editable) d
  where d < v_today and not (d = any(v_days_off))
    and not exists (select 1 from public.daily_revenue r where r.location_id=l.id and r.day=d);
  v_left := case when v_today between v_month and v_end then (v_end - v_today + 1) else 0 end;
  return jsonb_build_object(
    'location_id', l.id, 'location_name', l.name, 'city', l.city, 'currency', l.currency, 'status', l.status, 'opened_on', l.opened_on,
    'partner_id', l.partner_id, 'partner_name', (select name from public.partner where id = l.partner_id),
    'month', v_month, 'today', v_today, 'plan_minor', v_plan, 'fact_minor', v_fact, 'cash_minor', v_cash, 'card_minor', v_card,
    'pct', case when coalesce(v_plan, 0) > 0 then round(v_fact * 100.0 / v_plan, 1) end,
    'days_in_month', extract(day from v_end)::int,
    'days_left', v_left,
    'need_per_day_minor', case when v_plan is not null and v_left > 0 and v_plan > v_fact then (ceil((v_plan - v_fact)::numeric / v_left / 100) * 100)::bigint end,
    'editable_days', to_jsonb(v_editable), 'missing_days', to_jsonb(v_missing), 'days_off', to_jsonb(v_days_off),
    'last_day', v_last,
    'fx_rub', app_private.fx_rub(l.currency, least(v_end, v_today)));
end $$;

create or replace function public.revenue_overview(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_rows jsonb;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('revenue.read') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  select coalesce(jsonb_agg(detail.data order by p.name, l.name), '[]'::jsonb) into v_rows
  from public.location l join public.partner p on p.id = l.partner_id
  cross join lateral (select app_private.location_month(l,p_month) as data offset 0) detail
  where app_private.in_scope(l.partner_id) and (l.status='active' or jsonb_array_length(detail.data->'editable_days')>0
    or detail.data->>'last_day' is not null or jsonb_array_length(detail.data->'days_off')>0);
  return jsonb_build_object(
    'month', date_trunc('month', p_month)::date,
    'rows', v_rows,
    'fact_rub_minor', (select round(sum((x ->> 'fact_minor')::numeric * (x ->> 'fx_rub')::numeric)) from jsonb_array_elements(v_rows) x),
    'plan_rub_minor', (select round(sum((x ->> 'plan_minor')::numeric * (x ->> 'fx_rub')::numeric)) from jsonb_array_elements(v_rows) x),
    'missing_fx', (select coalesce(jsonb_agg(distinct x ->> 'currency'), '[]'::jsonb) from jsonb_array_elements(v_rows) x where x ->> 'fx_rub' is null));
end $$;
