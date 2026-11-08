-- Partner controls: preserve identities/history; a daily declaration includes employee shifts.
insert into public.permission(code,description) values ('team.manage','Управляющие своего франчайзи');
insert into public.role(code,name,scope_type,description) values ('franchisee_manager','Управляющий','partner','Закупки, сотрудники и база знаний своего франчайзи');
insert into public.role_permission(role,permission) values
 ('franchisee','team.manage'),('franchise_manager','team.manage'),
 ('franchisee_manager','staff.manage'),('franchisee_manager','kb.read');

create or replace function app_private.can_manage_user(p_user uuid) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select p_user is distinct from auth.uid() and not exists (
  select 1 from public.role_assignment where user_id=p_user and scope_type='company' and revoked_at is null)
 and (app_private.has_perm('org.manage') or (
  not exists (select 1 from public.role_assignment where user_id=p_user and revoked_at is null and role <> 'franchisee_staff')
  and exists(select 1 from public.staff_member s where s.user_id=p_user and app_private.has_perm('staff.manage',s.partner_id)))
 or (not exists(select 1 from public.role_assignment where user_id=p_user and revoked_at is null and role <> 'franchisee_manager')
  and exists(select 1 from public.role_assignment a where a.user_id=p_user and a.role='franchisee_manager' and app_private.has_perm('team.manage',a.scope_id))))
$$;

create or replace function public.staff_update(p_user uuid, p_full_name text, p_locations uuid[], p_rate_bp int, p_shift_fee bigint) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare s public.staff_member;
begin
  perform app_private.require_user();
  select * into s from public.staff_member where user_id = p_user;
  if not found or not app_private.has_perm('staff.manage', s.partner_id) or not app_private.can_manage_user(p_user) then perform app_private.fail('not-found', 'Сотрудник не найден'); end if;
  if coalesce(trim(p_full_name), '') = '' then perform app_private.fail('validation', 'Укажите имя сотрудника', 'full_name'); end if;
  perform app_private.check_staff_locations(s.partner_id, p_locations);
  perform app_private.check_pay(p_rate_bp, p_shift_fee);
  update public.staff_member set location_ids = p_locations, rate_bp = p_rate_bp, shift_fee_minor = p_shift_fee, updated_at = now() where user_id = p_user;
  update public.app_user set full_name = trim(p_full_name), updated_at = now() where id = p_user;
  perform app_private.audit('staff.update', 'staff_member', p_user, s.partner_id, jsonb_build_object('rate_bp', p_rate_bp, 'fee', p_shift_fee, 'locations', p_locations));
end $$;

create or replace function public.staff_set_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); s public.staff_member;
begin
  select * into s from public.staff_member where user_id = p_user;
  if not found or not app_private.has_perm('staff.manage', s.partner_id) or not app_private.can_manage_user(p_user) then perform app_private.fail('not-found', 'Сотрудник не найден'); end if;
  if p_active then
    update auth.users set banned_until = null where id = p_user;
    update public.app_user set status = 'active', updated_at = now() where id = p_user;
    if not exists (select 1 from public.role_assignment where user_id = p_user and role = 'franchisee_staff' and revoked_at is null) then
      insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by) values (p_user, 'franchisee_staff', 'partner', s.partner_id, v_actor);
    end if;
  else
    update auth.users set banned_until = now() + interval '100 years' where id = p_user;
    update public.app_user set status = 'suspended', updated_at = now() where id = p_user;
    update public.role_assignment set revoked_at = now(), revoked_by = v_actor where user_id = p_user and revoked_at is null;
    delete from auth.sessions where user_id = p_user; -- preserve even open shifts
  end if;
  update public.staff_member set active = p_active, updated_at = now() where user_id = p_user;
  perform app_private.audit(case when p_active then 'staff.restore' else 'staff.remove' end, 'staff_member', p_user, s.partner_id);
end $$;
create or replace function public.staff_create(p_partner uuid, p_full_name text, p_phone text, p_password text, p_locations uuid[],
  p_rate_bp int default 0, p_shift_fee bigint default 0) returns uuid
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
declare v_actor uuid := app_private.require_user(); v_user uuid; v_old public.staff_member; v_digits text := app_private.phone_digits(p_phone);
begin
  perform app_private.require_perm('staff.manage', p_partner);
  if coalesce(trim(p_full_name), '') = '' then perform app_private.fail('validation', 'Укажите имя сотрудника', 'full_name'); end if;
  if length(v_digits) < 10 or length(v_digits) > 15 then perform app_private.fail('validation', 'Укажите номер телефона полностью', 'phone'); end if;
  perform app_private.check_staff_locations(p_partner, p_locations);
  perform app_private.check_pay(p_rate_bp, p_shift_fee);
  perform app_private.check_password(p_password);
  -- Ранее удалённый сотрудник этого же франчайзи — возвращаем, а не создаём второго
  select s.* into v_old from public.staff_member s join auth.users u on u.id = s.user_id
  where s.partner_id = p_partner and lower(u.email) = app_private.staff_email(p_phone);
  if v_old.user_id is not null then
    if v_old.active then perform app_private.fail('validation', 'Сотрудник с этим телефоном уже есть', 'phone'); end if;
    if not app_private.can_manage_user(v_old.user_id) then perform app_private.fail('forbidden','Нельзя восстановить эту учётную запись'); end if;
    v_user := v_old.user_id;
    delete from auth.sessions where user_id=v_user;
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), banned_until = null, updated_at = now() where id = v_user;
    update public.app_user set full_name = trim(p_full_name), status = 'active', updated_at = now() where id = v_user;
    update public.staff_member set location_ids = p_locations, rate_bp = p_rate_bp, shift_fee_minor = p_shift_fee, active = true, updated_at = now() where user_id = v_user;
  else
    v_user := app_private.create_login(app_private.staff_email(p_phone), p_password, p_full_name);
    insert into public.staff_member(user_id, partner_id, phone, location_ids, rate_bp, shift_fee_minor, created_by)
    values (v_user, p_partner, v_digits, p_locations, p_rate_bp, p_shift_fee, v_actor);
  end if;
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by) values (v_user, 'franchisee_staff', 'partner', p_partner, v_actor);
  perform app_private.audit('staff.create', 'staff_member', v_user, p_partner, jsonb_build_object('name', p_full_name, 'rate_bp', p_rate_bp, 'fee', p_shift_fee));
  return v_user;
end $$;

create function public.team_list(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user(); perform app_private.require_perm('team.manage',p_partner);
 return coalesce((select jsonb_agg(x order by x->>'full_name') from (
  select jsonb_build_object('user_id',u.id,'full_name',u.full_name,'phone',split_part(u.email,'@',1),
    'active',bool_or(a.revoked_at is null) and u.status='active') x
  from public.role_assignment a join public.app_user u on u.id=a.user_id
  where a.role='franchisee_manager' and a.scope_id=p_partner group by u.id) q),'[]'::jsonb);
end $$;

create function public.team_create(p_partner uuid,p_full_name text,p_phone text,p_password text) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user(); v_user uuid; v_phone text:=app_private.phone_digits(p_phone);
begin
 perform app_private.require_perm('team.manage',p_partner);
 if not exists(select 1 from public.partner where id=p_partner and status='active') then perform app_private.fail('not-found','Франчайзи не найден'); end if;
 if coalesce(length(trim(p_full_name)),0)=0 or length(v_phone) not between 10 and 15 then perform app_private.fail('validation','Укажите имя и полный телефон'); end if;
 v_user:=app_private.create_login(app_private.staff_email(v_phone),p_password,p_full_name);
 insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(v_user,'franchisee_manager','partner',p_partner,v_actor);
 perform app_private.audit('team.create','app_user',v_user,p_partner);
 return v_user;
end $$;

create function public.team_set_active(p_partner uuid,p_user uuid,p_active boolean) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user();
begin
 perform app_private.require_perm('team.manage',p_partner);
 perform pg_advisory_xact_lock(hashtextextended('team:'||p_user,0));
 if p_active is null or not app_private.can_manage_user(p_user) or not exists(
  select 1 from public.role_assignment where user_id=p_user and role='franchisee_manager' and scope_id=p_partner)
  or exists(select 1 from public.role_assignment where user_id=p_user and revoked_at is null and (role<>'franchisee_manager' or scope_id<>p_partner))
 then perform app_private.fail('forbidden','Нельзя изменять эту учётную запись'); end if;
 delete from auth.sessions where user_id=p_user;
 update auth.users set banned_until=case when p_active then null else now()+interval '100 years' end where id=p_user;
 update public.app_user set status=case when p_active then 'active' else 'suspended' end,updated_at=now() where id=p_user;
 if p_active then
  if not exists(select 1 from public.role_assignment where user_id=p_user and role='franchisee_manager' and scope_id=p_partner and revoked_at is null) then
   insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(p_user,'franchisee_manager','partner',p_partner,v_actor);
  end if;
 else
  update public.role_assignment set revoked_at=now(),revoked_by=v_actor where user_id=p_user and revoked_at is null;
 end if;
 perform app_private.audit(case when p_active then 'team.restore' else 'team.remove' end,'app_user',p_user,p_partner);
end $$;
create or replace function public.order_link() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid;
begin
  perform app_private.require_user();
  select scope_id into v_partner from app_private.active_assignments() a where a.role in ('franchisee','franchisee_manager') limit 1;
  if v_partner is null then perform app_private.fail('forbidden', 'Заказ материалов доступен франчайзи'); end if;
  if (select count(distinct scope_id) from app_private.active_assignments() where role in ('franchisee','franchisee_manager')) <> 1 then perform app_private.fail('validation','Нужно выбрать франчайзи: к аккаунту привязано несколько компаний'); end if;
  return (select jsonb_build_object('url', order_url) from public.partner where id = v_partner);
end $$;

alter table public.daily_revenue add column unallocated_minor bigint not null default 0 check(unallocated_minor>=0);
alter table public.daily_revenue add column reported_total_minor bigint check(reported_total_minor between 0 and 100000000000);
alter table public.daily_revenue add constraint daily_declaration_owner check(reported_total_minor is null or (employee_id is null and cash_minor=0 and card_minor=0));
alter table public.daily_revenue alter column total_minor set expression as (cash_minor+card_minor+unallocated_minor);

create function app_private.revenue_day_version(p_location uuid,p_day date) returns text
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select coalesce(md5(string_agg(id::text||':'||revision::text,',' order by id)),'empty')
 from public.daily_revenue where location_id=p_location and day=p_day
$$;

-- All writers serialize by location/day; no second revenue ledger.
create function app_private.revenue_day_lock(p_location uuid,p_day date) returns void
language sql volatile set search_path=pg_catalog,pg_temp as $$
 select pg_advisory_xact_lock(hashtextextended('revenue-day:'||p_location||':'||p_day,0))
$$;

create function app_private.revenue_reconcile_declaration() returns trigger
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_location uuid:=coalesce(new.location_id,old.location_id); v_day date:=coalesce(new.day,old.day); v_staff bigint;
begin
 if coalesce(new.employee_id,old.employee_id) is null then return null; end if;
 select coalesce(sum(total_minor),0) into v_staff from public.daily_revenue where location_id=v_location and day=v_day and employee_id is not null;
 update public.daily_revenue set unallocated_minor=greatest(0,reported_total_minor-v_staff),revision=revision+1,updated_at=now()
 where location_id=v_location and day=v_day and employee_id is null and reported_total_minor is not null;
 return null;
end $$;
create trigger revenue_reconcile after insert or update or delete on public.daily_revenue for each row execute function app_private.revenue_reconcile_declaration();

create function public.revenue_total_set(p_location uuid,p_day date,p_total bigint,p_expected_version text,p_operation uuid,p_comment text default null) returns jsonb
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
 if l.status<>'active' or p_day is null or p_day>app_private.local_today(p_location) or p_total is null or p_total not between 0 and 100000000000 then perform app_private.fail('validation','Проверьте дату и сумму выручки'); end if;
 if not app_private.revenue_day_open(p_location,p_day) then perform app_private.fail('period-locked','Этот месяц закрыт — обратитесь к менеджеру'); end if;
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
create or replace function public.revenue_save(p_location uuid, p_day date, p_cash bigint, p_card bigint, p_comment text default null, p_employee uuid default null)
returns public.daily_revenue
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; r public.daily_revenue;
begin
  perform app_private.revenue_day_lock(p_location,p_day);
  l := app_private.revenue_location(p_location, 'revenue.enter');
  if l.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
  if p_day is null or p_day > app_private.local_today(p_location) then
    perform app_private.fail('validation', 'Нельзя внести выручку за будущий день', 'day');
  end if;
  if not app_private.revenue_day_open(p_location, p_day) then
    perform app_private.fail('period-locked', 'Этот месяц уже закрыт. Прошлый месяц можно поправить до 5-го числа — обратитесь к менеджеру', 'day');
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
create or replace function public.revenue_delete(p_location uuid, p_day date, p_employee uuid default null) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_id uuid;
begin
  perform app_private.revenue_day_lock(p_location,p_day);
  perform app_private.require_user();
  l := app_private.revenue_location(p_location, 'revenue.enter');
  if not app_private.revenue_day_open(p_location, p_day) then
    perform app_private.fail('period-locked', 'Этот месяц уже закрыт — обратитесь к менеджеру', 'day');
  end if;
  delete from public.daily_revenue where location_id = p_location and day = p_day and employee_id is not distinct from p_employee returning id into v_id;
  if v_id is null then perform app_private.fail('not-found', 'За этот день выручка не внесена'); end if;
  if p_employee is not null then
    delete from public.work_shift where location_id = p_location and day = p_day and employee_id = p_employee;
  end if;
  perform app_private.audit('revenue.delete', 'daily_revenue', v_id, l.partner_id, jsonb_build_object('day', p_day, 'employee', p_employee));
end $$;
create or replace function app_private.shift_store(p_location public.location, p_employee uuid, p_day date, p_cash bigint, p_card bigint, p_comment text)
returns public.work_shift
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare s public.staff_member; w public.work_shift;
begin
  perform app_private.revenue_day_lock(p_location.id,p_day);
  select * into s from public.staff_member where user_id = p_employee and partner_id = p_location.partner_id;
  if not found then perform app_private.fail('validation', 'Это не сотрудник этого франчайзи', 'employee'); end if;
  insert into public.work_shift(partner_id, location_id, employee_id, day, status, opened_at, closed_at, cash_minor, card_minor, comment,
    rate_bp, shift_fee_minor, earned_minor)
  values (p_location.partner_id, p_location.id, p_employee, p_day, 'closed', now(), now(), p_cash, p_card, nullif(trim(p_comment), ''),
    s.rate_bp, s.shift_fee_minor, app_private.shift_pay(p_cash + p_card, s.rate_bp, s.shift_fee_minor))
  on conflict (employee_id, location_id, day) do update set status = 'closed', closed_at = coalesce(public.work_shift.closed_at, now()),
    cash_minor = excluded.cash_minor, card_minor = excluded.card_minor, comment = excluded.comment,
    rate_bp = coalesce(public.work_shift.rate_bp, excluded.rate_bp), shift_fee_minor = coalesce(public.work_shift.shift_fee_minor, excluded.shift_fee_minor),
    earned_minor = app_private.shift_pay(excluded.cash_minor + excluded.card_minor, coalesce(public.work_shift.rate_bp, excluded.rate_bp),
      coalesce(public.work_shift.shift_fee_minor, excluded.shift_fee_minor))
  returning * into w;
  insert into public.daily_revenue(location_id, partner_id, day, currency, cash_minor, card_minor, comment, entered_by, employee_id)
  values (p_location.id, p_location.partner_id, p_day, p_location.currency, p_cash, p_card, nullif(trim(p_comment), ''), auth.uid(), p_employee)
  on conflict (location_id, day, employee_id) do update set cash_minor = excluded.cash_minor, card_minor = excluded.card_minor,
    comment = excluded.comment, entered_by = excluded.entered_by, updated_at = now(), revision = public.daily_revenue.revision + 1;
  return w;
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
    'editable_from', case when app_private.is_manager() then null
      when extract(day from v_today) <= 5 then (date_trunc('month', v_today) - interval '1 month')::date
      else date_trunc('month', v_today)::date end,
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
          'day_version',app_private.revenue_day_version(l.id,r.day),'reported_total_minor',max(r.reported_total_minor),'unallocated_minor',sum(r.unallocated_minor),'comment', string_agg(r.comment, '; '), 'updated_at', max(r.updated_at),
          'entries', jsonb_agg(jsonb_build_object('revision', r.revision,'reported_total_minor',r.reported_total_minor,'unallocated_minor',r.unallocated_minor, 'employee_id', r.employee_id, 'employee_name', u.full_name, 'cash_minor', r.cash_minor,
            'card_minor', r.card_minor, 'total_minor', r.total_minor, 'comment', r.comment) order by u.full_name nulls first)) d
        from public.daily_revenue r left join public.app_user u on u.id = r.employee_id
        where r.location_id = l.id and r.day between v_month and (v_month + interval '1 month - 1 day')::date
        group by r.day) x), '[]'::jsonb));
end $$;
create or replace function app_private.loc_progress(l public.location, p_month date) returns table (
  active_days int, elapsed_days int, filled_days int, fact_minor bigint, plan_minor bigint, prev_same_minor bigint, fact_same_minor bigint)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with b as (
    select p_month as m, (p_month + interval '1 month - 1 day')::date as e, app_private.local_today(l.id) as today,
      greatest(p_month, coalesce(l.opened_on, p_month)) as start
  ), w as (
    select b.*, least(b.e, b.today - 1) as upto from b
  )
  select
    greatest(0, (w.e - w.start) + 1)::int,
    greatest(0, (w.upto - w.start) + 1)::int,
    (select count(distinct r.day) from public.daily_revenue r where r.location_id = l.id and r.day between w.start and w.upto)::int,
    (select coalesce(sum(r.total_minor), 0) from public.daily_revenue r where r.location_id = l.id and r.day between w.m and w.upto)::bigint,
    (select amount_minor from public.revenue_plan where location_id = l.id and month = w.m),
    (select coalesce(sum(r.total_minor), 0) from public.daily_revenue r where r.location_id = l.id
       and r.day >= (w.m - interval '1 month')::date and r.day < least(w.m,(w.m - interval '1 month')::date + greatest(0, (w.upto - w.m) + 1)))::bigint,
    (select coalesce(sum(r.total_minor), 0) from public.daily_revenue r where r.location_id = l.id and r.day between w.m and w.upto)::bigint
  from w
$$;
create or replace function app_private.plan_forecast(l public.location, p_month date, p_stretch_bp int default 500) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_cut date := least(app_private.local_today(l.id), v_month);
  v_n int; v_avg numeric; v_overall numeric; v_f numeric[] := array[1,1,1,1,1,1,1]; d int; v_med numeric;
  v_level numeric; v_slope numeric; v_weeks int; v_g numeric := 0; v_h numeric; v_trend numeric := 1;
  v_season numeric; v_season_src text := 'нет'; v_forecast numeric := 0; v_day date; v_plan numeric; v_guard text := null;
  v_last numeric; v_last_days int; v_weekend int := 0; v_method text := 'full';
begin
  select count(*), avg(total) into v_n, v_avg from app_private.daily_totals(l.id, v_cut - 182, v_cut);
  if v_n = 0 then
    return jsonb_build_object('location_id', l.id, 'method', 'none', 'reason', 'Нет выручки — план нужно поставить вручную');
  end if;
  -- профиль недели: медиана по дню недели / средняя медиана
  if v_n >= 14 then
    for d in 1..7 loop
      select percentile_cont(0.5) within group (order by total) into v_med
      from app_private.daily_totals(l.id, v_cut - 84, v_cut) t where extract(isodow from t.day) = d;
      v_f[d] := v_med;
    end loop;
    select avg(x) into v_overall from unnest(v_f) x where x is not null;
    for d in 1..7 loop v_f[d] := coalesce(v_f[d] / nullif(v_overall, 0), 1); end loop;
  else
    v_method := 'short';
  end if;
  -- недельные уровни, очищенные от дня недели (k = 0 — последняя неделя)
  with t as (
    select floor((v_cut - 1 - day) / 7)::int as k, total / nullif(v_f[extract(isodow from day)::int],0) as x
    from app_private.daily_totals(l.id, v_cut - 84, v_cut)
  ), w as (select k, avg(x) as lvl from t group by k)
  select count(*), regr_slope(lvl, -k) into v_weeks, v_slope from w;
  -- уровень: экспоненциальное сглаживание (α = 0,35) от старых недель к новым
  select lvl into v_level from (
    with t as (
      select floor((v_cut - 1 - day) / 7)::int as k, total / nullif(v_f[extract(isodow from day)::int],0) as x
      from app_private.daily_totals(l.id, v_cut - 84, v_cut)
    ) select k, avg(x) as lvl from t group by k order by k desc limit 1) z;
  declare r record; begin
    for r in with t as (
        select floor((v_cut - 1 - day) / 7)::int as k, total / nullif(v_f[extract(isodow from day)::int],0) as x
        from app_private.daily_totals(l.id, v_cut - 84, v_cut)
      ) select k, avg(x) as lvl from t group by k order by k desc loop
      v_level := 0.35 * r.lvl + 0.65 * v_level;
    end loop;
  end;
  if v_level is null then v_level := v_avg; end if;
  -- тренд: только при 6+ неделях истории
  if v_weeks >= 6 and v_slope is not null and v_level > 0 then
    v_g := greatest(-0.10, least(0.10, (v_slope / 7.0 * 30.4 / v_level) * 0.5));
    v_h := greatest(0, ((v_month + 15) - (v_cut - 4))::numeric / 30.4);
    v_trend := power(1 + v_g, v_h);
  end if;
  -- сезонность: точка, иначе вся сеть
  v_season := app_private.season_factor(l.id, v_month);
  if v_season is not null then v_season_src := 'точка'; else
    v_season := case when (select count(distinct currency) from public.location where status='active')=1 then app_private.season_factor(null, v_month) else null end;
    if v_season is not null then v_season_src := 'сеть'; else v_season := 1; end if;
  end if;
  -- календарь нужного месяца (с даты открытия, если точка открывается в этом месяце)
  v_day := greatest(v_month, coalesce(l.opened_on, v_month));
  while v_day <= v_end loop
    v_forecast := v_forecast + v_level * v_f[extract(isodow from v_day)::int] * v_trend * v_season;
    if extract(isodow from v_day) in (6, 7) then v_weekend := v_weekend + 1; end if;
    v_day := v_day + 1;
  end loop;
  v_plan := v_forecast * (1 + p_stretch_bp / 10000.0);
  -- коридор относительно прошлого полного месяца (пересчёт на число дней)
  select sum(total), count(*) into v_last, v_last_days
  from app_private.daily_totals(l.id, (v_month - interval '1 month')::date, v_month);
  if v_last_days >= 20 and v_last > 0 then
    v_last := v_last / v_last_days * ((v_end - greatest(v_month, coalesce(l.opened_on, v_month))) + 1);
    if v_plan < v_last * 0.85 then v_plan := v_last * 0.85; v_guard := 'не ниже 85 % прошлого месяца'; end if;
    if v_plan > v_last * 1.30 then v_plan := v_last * 1.30; v_guard := 'не выше 130 % прошлого месяца'; end if;
  else
    v_last := null;
  end if;
  return jsonb_build_object(
    'location_id', l.id, 'method', v_method,
    'forecast_minor', round(v_forecast)::bigint,
    -- до тысячи единиц валюты
    'proposed_minor', (round(v_plan / 100000) * 100000)::bigint,
    'level_day_minor', round(v_level)::bigint,
    'weekday_factors', to_jsonb(v_f),
    'trend_month_pct', round(v_g * 100, 1),
    'season_factor', round(v_season, 3), 'season_source', v_season_src,
    'days', (v_end - greatest(v_month, coalesce(l.opened_on, v_month))) + 1, 'weekend_days', v_weekend,
    'stretch_pct', p_stretch_bp / 100.0,
    'last_month_scaled_minor', round(v_last)::bigint,
    'guard', v_guard,
    'history_days', v_n);
end $$;
create or replace function public.rating(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date))::date; v_rows jsonb; v_my uuid;
  v_fx_day date := least((date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date)) + interval '1 month - 1 day')::date,
                         (now() at time zone 'Europe/Moscow')::date);
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('rating.read') or not app_private.rating_allowed() then
    perform app_private.fail('forbidden', 'Рейтинг ведётся по франчайзи в России');
  end if;
  select scope_id into v_my from app_private.active_assignments() where scope_type = 'partner' limit 1;
  with per_loc as (
    select l.partner_id, x.*,
      case when x.elapsed_days > 0 then x.fact_minor::numeric / x.elapsed_days * x.active_days end as forecast_minor
    from public.location l join public.partner p on p.id = l.partner_id
    cross join lateral app_private.loc_progress(l, v_month) x
    where p.status = 'active' and p.country = 'RU' and l.status = 'active' and x.active_days > 0
  ), per_partner as (
    select p.id, p.name, p.currency,
      (select string_agg(distinct l.city, ', ') from public.location l where l.partner_id = p.id and l.status = 'active') as cities,
      count(*)::int as points,
      sum(g.forecast_minor) filter (where g.plan_minor is not null) as forecast_planned,
      case when count(g.plan_minor)=count(*) then sum(g.plan_minor) end as plan_minor,
      sum(g.fact_minor) filter (where g.plan_minor is not null) as fact_planned,
      sum(g.fact_minor) as fact_minor,
      sum(g.forecast_minor) as forecast_minor,
      sum(g.elapsed_days) as elapsed, sum(g.filled_days) as filled,
      sum(g.fact_same_minor) as same, sum(g.prev_same_minor) as prev_same
    from public.partner p join per_loc g on g.partner_id = p.id group by p.id, p.name, p.currency
  ), scored as (
    select *,
      case when plan_minor > 0 and elapsed > 0 then round(forecast_planned * 100.0 / plan_minor, 1) end as forecast_pct,
      case when plan_minor > 0 then round(coalesce(fact_planned, 0) * 100.0 / plan_minor, 1) end as pct_to_date,
      case when elapsed > 0 then round(filled * 100.0 / elapsed) end as fill_pct,
      case when prev_same > 0 then round((same - prev_same) * 100.0 / prev_same, 1) end as growth_pct,
      app_private.fx_rub(currency, v_fx_day) as fx
    from per_partner
  ), ranked as (
    select *, row_number() over (order by pct_to_date desc nulls last, fact_minor desc, name) as rank from scored
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'rank', rank, 'partner_id', id, 'partner_name', name, 'cities', cities, 'is_me', id = v_my, 'points', points,
      'currency', currency, 'fact_minor', fact_minor, 'plan_minor', plan_minor, 'forecast_minor', round(forecast_minor)::bigint,
      'fact_rub_minor', round(fact_minor * fx)::bigint, 'forecast_rub_minor', round(forecast_minor * fx)::bigint,
      'forecast_pct', forecast_pct, 'pct_to_date', pct_to_date, 'fill_pct', fill_pct, 'growth_pct', growth_pct,
      'badges', to_jsonb(array_remove(array[
        case when rank = 1 and forecast_pct is not null then 'leader' end,
        case when forecast_pct >= 100 then 'plan' end,
        case when fill_pct = 100 and elapsed >= 3 then 'no_gaps' end,
        case when growth_pct >= 10 then 'growth' end], null))
    ) order by rank), '[]'::jsonb) into v_rows
  from ranked;
  if not app_private.is_manager() then
    select coalesce(jsonb_agg((x-'fill_pct'-'growth_pct')||jsonb_build_object('badges','[]'::jsonb)),'[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) x;
  end if;
  return jsonb_build_object('month', v_month, 'rows', v_rows);
end $$;
create or replace function app_private.fin_month(p_partner uuid, p_locations uuid[], p_month date) returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with r as (
    select coalesce(sum(total_minor), 0)::bigint t, coalesce(sum(cash_minor), 0)::bigint c, coalesce(sum(card_minor), 0)::bigint k
    from public.daily_revenue where location_id = any(p_locations) and day >= p_month and day < (p_month + interval '1 month')::date
  ), w as (
    select coalesce(sum(earned_minor), 0)::bigint e, count(*)::int n from public.work_shift
    where location_id = any(p_locations) and status = 'closed' and day >= p_month and day < (p_month + interval '1 month')::date
  ), p as (
    select case when count(*)=cardinality(p_locations) then sum(amount_minor)::bigint end v from public.revenue_plan where location_id = any(p_locations) and month = p_month
  ), x as (
    select coalesce(sum(amount_minor), 0)::bigint v from app_private.expense_rows(p_partner, p_locations, p_month)
  ), q as (
    select round(r.t * app_private.rate_bp(p_partner, p_month) / 10000.0)::bigint v from r
  )
  select jsonb_build_object(
    'month', p_month, 'revenue_minor', r.t, 'cash_minor', r.c, 'card_minor', r.k, 'plan_minor', p.v,
    'pct', case when p.v > 0 then round(r.t * 100.0 / p.v, 1) end,
    'payroll_minor', w.e, 'shifts', w.n,
    'rate_bp', app_private.rate_bp(p_partner, p_month),
    'royalty_minor', q.v,
    'expenses_minor', x.v,
    'net_minor', r.t - w.e - q.v - x.v,
    'is_open', p_month >= app_private.current_month())
  from r, w, p, x, q
$$;

insert into app_private.client_command(fn) values
 ('public.team_list(uuid)'),('public.team_create(uuid,text,text,text)'),('public.team_set_active(uuid,uuid,boolean)'),
 ('public.revenue_total_set(uuid,date,bigint,text,uuid,text)');
select app_private.apply_grants();
