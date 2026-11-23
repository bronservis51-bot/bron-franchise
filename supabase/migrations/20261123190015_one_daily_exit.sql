-- Keep both location reports, but assign the daily guarantee to the first
-- accepted location. Cancellation of a report never silently moves the fee.
alter table public.work_shift add column counts_as_exit boolean not null default true;
create table app_private.employee_daily_exit(
  employee_id uuid not null references public.app_user(id) on delete cascade,
  day date not null,
  location_id uuid not null references public.location(id),
  primary key(employee_id,day)
);
alter table app_private.employee_daily_exit enable row level security;
revoke all on app_private.employee_daily_exit from public, anon, authenticated, service_role;
-- Pre-release posted amounts and counts stay intact; use their first accepted
-- report to prevent a new additional point from paying a fresh guarantee.
insert into app_private.employee_daily_exit
  select distinct on (employee_id,day) employee_id,day,location_id from public.work_shift
  where status='closed' order by employee_id,day,closed_at,opened_at,id;

create function app_private.pay_without_exit(p_policy jsonb) returns jsonb
language sql immutable strict set search_path=pg_catalog,pg_temp as $$
  select case when p_policy->>'mode'='legacy' then jsonb_set(p_policy,'{fee_minor}','0')
    else jsonb_set(p_policy,'{floor_minor}','0') end
$$;
create function app_private.pay_at_point(p_user uuid, p_location uuid, p_day date, p_policy jsonb) returns jsonb
language sql stable security definer set search_path=pg_catalog,app_private,pg_temp as $$
  select case when exists(select 1 from app_private.employee_daily_exit where employee_id=p_user and day=p_day and location_id<>p_location)
    then app_private.pay_without_exit(p_policy)||'{"additional_point":true}'::jsonb else p_policy end
$$;

create or replace function app_private.shift_motivation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare claimed_point uuid;
begin
  if tg_op='INSERT' then
    new.pay_policy:=app_private.staff_pay_policy(new.employee_id,new.day);
  else
    new.pay_policy:=old.pay_policy;
    if old.status='closed' then
      new.counts_as_exit:=old.counts_as_exit;
      if (new.cash_minor,new.card_minor) is not distinct from (old.cash_minor,old.card_minor) then
        new.earned_minor:=old.earned_minor;
        new.rate_bp:=old.rate_bp;
        new.shift_fee_minor:=old.shift_fee_minor;
        return new;
      end if;
    end if;
  end if;
  if new.status<>'closed' then return new; end if;
  if tg_op='INSERT' or old.status<>'closed' then
    -- INSERT ... ON CONFLICT returns the winner, including when concurrent
    -- reports arrived through different point or supervisor entry points.
    insert into app_private.employee_daily_exit as e(employee_id,day,location_id) values(new.employee_id,new.day,new.location_id)
      on conflict(employee_id,day) do update set location_id=e.location_id
      returning location_id into claimed_point;
    new.counts_as_exit:=claimed_point=new.location_id;
    if not new.counts_as_exit then
      if new.pay_policy is null then
        new.pay_policy:=jsonb_build_object('mode','legacy','rate_bp',coalesce(new.rate_bp,0),'fee_minor',0);
      else new.pay_policy:=app_private.pay_without_exit(new.pay_policy); end if;
    end if;
  end if;
  if new.pay_policy->>'mode'='legacy' then
    new.rate_bp:=(new.pay_policy->>'rate_bp')::integer;
    new.shift_fee_minor:=(new.pay_policy->>'fee_minor')::bigint;
    new.earned_minor:=app_private.shift_pay(new.cash_minor+new.card_minor,new.rate_bp,new.shift_fee_minor);
  elsif new.pay_policy is not null then
    new.earned_minor:=app_private.motivation_pay(new.cash_minor+new.card_minor,new.pay_policy);
    select (x->>'rate_bp')::int into new.rate_bp from jsonb_array_elements(new.pay_policy->'tiers') x
      where (x->>'from_minor')::bigint<=new.cash_minor+new.card_minor order by (x->>'from_minor')::bigint desc limit 1;
    new.shift_fee_minor:=(new.pay_policy->>'floor_minor')::bigint;
  end if;
  return new;
end $$;
revoke execute on function app_private.pay_without_exit(jsonb),app_private.pay_at_point(uuid,uuid,date,jsonb)
from public,anon,authenticated,service_role;
do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres','supabase_admin') loop
    execute format('grant execute on function app_private.pay_without_exit(jsonb),app_private.pay_at_point(uuid,uuid,date,jsonb) to %I',trusted);
    execute format('grant select,insert,update on app_private.employee_daily_exit to %I',trusted);
    execute format('create policy %I on app_private.employee_daily_exit to %I using (true) with check (true)',
      'trusted_writer_'||trusted,trusted);
  end loop;
end $acl$;

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
  'month_shifts',(select count(*) filter (where counts_as_exit) from public.work_shift where employee_id=v_user and status='closed' and day>=v_month and day<v_month+interval '1 month'));
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
    'open_shift', (select to_jsonb(w) || jsonb_build_object('location_name', l.name, 'currency', l.currency, 'pay_policy',app_private.pay_at_point(v_user,l.id,w.day,w.pay_policy))
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
        'pay_today', app_private.pay_at_point(v_user,l.id,app_private.local_today(l.id),app_private.staff_pay_policy(v_user, app_private.local_today(l.id))),
        'pay_yesterday', app_private.pay_at_point(v_user,l.id,app_private.local_today(l.id) - 1,app_private.staff_pay_policy(v_user, app_private.local_today(l.id) - 1)),
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
    'month_shifts', (select count(*) filter (where counts_as_exit) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'currency', (select currency from public.partner where id = s.partner_id),
    'shifts', coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object('location_name', l.name) order by w.day desc, w.opened_at desc)
      from public.work_shift w join public.location l on l.id = w.location_id
      where w.employee_id = v_user and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb));
end $$;

create or replace function public.staff_list(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  perform app_private.require_user();
  if not app_private.has_perm('staff.manage', p_partner) then
    perform app_private.require_perm('staff.view', p_partner);
    return coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', '', 'active', s.active, 'can_manage', false,
      'location_ids', (select coalesce(jsonb_agg(x),'[]') from unnest(s.location_ids) x where app_private.staff_location_scope(x)),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name),'[]')
        from public.location l where l.id = any(s.location_ids) and app_private.staff_location_scope(l.id)),
      'position', case when s.manager_enabled then 'manager' when s.employee_kind='trainee' then 'trainee' else 'sales_manager' end,
      'is_manager', s.manager_enabled, 'employee_kind', s.employee_kind,
      'internship_completed', s.employee_kind='trainee' and s.internship_until < app_private.local_today(s.location_ids[1]),
      'month_shifts', 0, 'month_revenue_minor', 0, 'month_earned_minor', 0, 'shifts', '[]'::jsonb,
      'rate_bp', 0, 'shift_fee_minor', 0, 'open_shift', null
    ) order by s.active desc, u.full_name)
      from public.staff_member s join public.app_user u on u.id=s.user_id
      where s.partner_id=p_partner and app_private.staff_member_scope(s.user_id)), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', s.phone, 'active', s.active,
      'position', case when s.manager_enabled then 'manager' when s.employee_kind='trainee' then 'trainee' else 'sales_manager' end,
      'access', app_private.staff_access_flags(s), 'custom_pay', s.custom_pay,
      'pay_revision',s.pay_revision,'pay_effective_from',s.pay_effective_from,
      'pay_scheduled',coalesce((select jsonb_agg(jsonb_build_object('effective_from',v.effective_from,'label',
        case when (v.terms->>'partner')::boolean then 'Общая схема' when v.terms->'custom'->>'name' is not null then v.terms->'custom'->>'name'
          else 'Фикс + процент' end) order by v.effective_from) from app_private.employee_pay_version v
        where v.employee_id=s.user_id and v.effective_from>app_private.local_today(s.location_ids[1])),'[]'::jsonb),
      'location_ids', (select coalesce(jsonb_agg(x),'[]') from unnest(s.location_ids) x where app_private.staff_location_scope(x)), 'can_manage',app_private.can_manage_user(s.user_id), 'is_manager',exists(select 1 from role_assignment a where a.user_id=s.user_id and a.role='franchisee_manager' and a.revoked_at is null),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name), '[]'::jsonb) from public.location l where l.id = any(s.location_ids) and app_private.staff_location_scope(l.id)),
      'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation,
      'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
      'internship_completed', s.employee_kind='trainee' and s.internship_until < app_private.local_today(s.location_ids[1]),
      'open_shift', (select jsonb_build_object('id', w.id, 'location_name', l.name, 'opened_at', w.opened_at)
                     from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'open'),
      'month_shifts', (select count(*) filter (where w.counts_as_exit) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'shifts', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'day', w.day, 'location_name', l.name, 'total_minor', w.total_minor,
          'earned_minor', w.earned_minor, 'return_minor',w.return_minor,'counts_as_exit',w.counts_as_exit,'opened_at', w.opened_at, 'closed_at', w.closed_at, 'timezone', l.timezone,
          'submitted_without_open', w.submitted_without_open, 'cash_minor', w.cash_minor, 'card_minor', w.card_minor, 'revision', w.revision,
          'can_correct', app_private.can_manage_user(s.user_id) and app_private.has_perm('revenue.enter', w.partner_id)
            and w.day <= app_private.local_today(l.id) and app_private.revenue_day_open(l.id,w.day)) order by w.day desc)
        from public.work_shift w join public.location l on l.id = w.location_id
        where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb)
    ) order by s.active desc, u.full_name)
    from public.staff_member s join public.app_user u on u.id = s.user_id where s.partner_id = p_partner and app_private.staff_member_scope(s.user_id)), '[]'::jsonb);
end $$;
