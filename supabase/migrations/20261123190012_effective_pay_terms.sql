-- Baselines preserve the last known terms for dates before versioning. Already
-- accepted shifts continue to use work_shift.pay_policy.
create table app_private.team_pay_version (
  partner_id uuid not null references public.partner(id) on delete cascade,
  effective_from date not null,
  policy jsonb not null,
  primary key (partner_id, effective_from)
);
create table app_private.employee_pay_version (
  employee_id uuid not null references public.app_user(id) on delete cascade,
  effective_from date not null,
  terms jsonb not null,
  primary key (employee_id, effective_from)
);
alter table app_private.team_pay_version enable row level security;
alter table app_private.employee_pay_version enable row level security;
revoke all on app_private.team_pay_version, app_private.employee_pay_version from public, anon, authenticated, service_role;
alter table public.staff_member add column pay_revision integer not null default 0,
  add column pay_effective_from date,
  add column pending_pay_effective_from date;

create function app_private.employee_pay_fields(s public.staff_member) returns jsonb
language sql immutable set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('partner',s.use_partner_motivation,'rate_bp',s.rate_bp,'fee_minor',s.shift_fee_minor,
    'custom',s.custom_pay,'kind',s.employee_kind,'start',s.internship_from,'end',s.internship_until,'floor',s.internship_floor_minor)
$$;
insert into app_private.employee_pay_version
  select s.user_id,'-infinity',app_private.employee_pay_fields(s) from public.staff_member s;
insert into app_private.team_pay_version
  select partner_id,'-infinity',policy from app_private.motivation_scheme;

-- All employee editing paths, including older clients, pass this trigger.
-- A dated profile save locks its employee row and carries the date through the
-- existing roster, pay and onboarding writers on that row. The temporary value
-- is cleared before commit. Legacy commands have no pending date.
create function app_private.record_employee_pay() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare fields jsonb:=app_private.employee_pay_fields(new);
  effective date;
begin
  if tg_op='INSERT' then
    effective:=coalesce(new.pay_effective_from,'-infinity'::date);
  else
    if fields=app_private.employee_pay_fields(old) and new.pay_effective_from is not distinct from old.pay_effective_from then return new; end if;
    effective:=coalesce(new.pending_pay_effective_from,
      case when new.employee_kind='trainee' and (old.employee_kind is distinct from new.employee_kind
        or old.internship_from is distinct from new.internship_from) then new.internship_from end,
      app_private.local_today(new.location_ids[1]));
    new.pay_revision:=old.pay_revision+1;
  end if;
  new.pay_effective_from:=case when isfinite(effective) then effective end;
  insert into app_private.employee_pay_version(employee_id,effective_from,terms) values(new.user_id,effective,fields)
    on conflict(employee_id,effective_from) do update set terms=excluded.terms;
  return new;
end $$;
create trigger staff_pay_terms before insert or update of rate_bp,shift_fee_minor,use_partner_motivation,custom_pay,
  employee_kind,internship_from,internship_until,internship_floor_minor,pay_effective_from on public.staff_member
  for each row execute function app_private.record_employee_pay();

create function app_private.partner_pay_today(p_partner uuid) returns date
language sql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
  select app_private.local_today((select id from public.location where partner_id=p_partner order by (status='active') desc,id limit 1))
$$;
create function app_private.team_pay_on(p_partner uuid,p_day date) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
  select coalesce((select policy from app_private.team_pay_version where partner_id=p_partner and effective_from<=p_day
      order by effective_from desc limit 1),app_private.motivation_default((select currency from public.partner where id=p_partner)))
$$;

create or replace function app_private.staff_pay_policy(p_user uuid,p_day date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare partner uuid; terms jsonb; team jsonb; trainee boolean;
begin
  select partner_id into partner from public.staff_member where user_id=p_user;
  select v.terms into terms from app_private.employee_pay_version v where employee_id=p_user and effective_from<=p_day
    order by effective_from desc limit 1;
  trainee:=terms->>'kind'='trainee' and p_day between (terms->>'start')::date and (terms->>'end')::date;
  if terms is null or (terms->>'partner')::boolean or trainee then
    team:=app_private.team_pay_on(partner,p_day);
    if trainee then return jsonb_set(team,'{floor_minor}',terms->'floor'); end if;
    return team;
  end if;
  return coalesce(nullif(terms->'custom','null'::jsonb),
    jsonb_build_object('mode','legacy','rate_bp',terms->'rate_bp','fee_minor',terms->'fee_minor'));
end $$;

-- Latest version number protects the entire timeline. Each date introduces
-- a full set of terms up to the next effective date.
create or replace function public.motivation_set(p_partner uuid,p_policy jsonb,p_expected_version int) returns void
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v int; effective date; policy jsonb:=p_policy-'effective_from';
begin
  perform app_private.require_user(); perform app_private.require_perm('team.manage',p_partner);
  effective:=coalesce((p_policy->>'effective_from')::date,app_private.partner_pay_today(p_partner));
  if not isfinite(effective) then perform app_private.fail('validation','Проверьте дату начала оплаты'); end if;
  perform app_private.motivation_validate(policy);
  perform pg_advisory_xact_lock(hashtextextended('motivation:'||p_partner,0));
  select version into v from app_private.motivation_scheme where partner_id=p_partner;
  if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Мотивация уже изменена. Обновите настройки'); end if;
  insert into app_private.motivation_scheme(partner_id,policy) values(p_partner,policy) on conflict(partner_id)
    do update set policy=excluded.policy,version=motivation_scheme.version+1,updated_at=now();
  insert into app_private.team_pay_version(partner_id,effective_from,policy) values(p_partner,effective,policy)
    on conflict(partner_id,effective_from) do update set policy=excluded.policy;
  perform app_private.audit('staff.motivation','partner',p_partner,p_partner,policy||jsonb_build_object('effective_from',effective));
exception when invalid_datetime_format or datetime_field_overflow then
  perform app_private.fail('validation','Проверьте дату начала оплаты');
end $$;

create or replace function public.motivation_get(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare today date;
begin
  perform app_private.require_user(); perform app_private.require_perm('staff.manage',p_partner);
  today:=app_private.partner_pay_today(p_partner);
  return jsonb_build_object('version',coalesce((select version from app_private.motivation_scheme where partner_id=p_partner),0),
    'policy',app_private.team_pay_on(p_partner,today),'today',today,
    'baseline',app_private.team_pay_on(p_partner,'-infinity'::date),
    'history',coalesce((select jsonb_agg(jsonb_build_object('effective_from',effective_from,'policy',policy) order by effective_from)
      from app_private.team_pay_version where partner_id=p_partner and isfinite(effective_from) and effective_from<=today),'[]'::jsonb),
    'scheduled',coalesce((select jsonb_agg(jsonb_build_object('effective_from',effective_from,'policy',policy) order by effective_from)
      from app_private.team_pay_version where partner_id=p_partner and effective_from>today),'[]'::jsonb),
    'currency',(select currency from public.partner where id=p_partner));
end $$;

revoke execute on function app_private.employee_pay_fields(public.staff_member), app_private.record_employee_pay(),
  app_private.partner_pay_today(uuid),app_private.team_pay_on(uuid,date) from public, anon, authenticated, service_role;
do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres','supabase_admin') loop
    execute format('grant execute on function app_private.employee_pay_fields(public.staff_member), app_private.partner_pay_today(uuid),
      app_private.team_pay_on(uuid,date) to %I',trusted);
    execute format('grant select,insert,update on app_private.team_pay_version,app_private.employee_pay_version to %I',trusted);
    execute format('create policy %I on app_private.team_pay_version to %I using (true) with check (true)','trusted_writer_'||trusted,trusted);
    execute format('create policy %I on app_private.employee_pay_version to %I using (true) with check (true)','trusted_writer_'||trusted,trusted);
  end loop;
end $acl$;

create or replace function public.staff_profile_save_phone(
  p_user uuid, p_partner uuid, p_full_name text, p_phone text, p_password text,
  p_locations uuid[], p_rate_bp int, p_shift_fee bigint, p_use_partner boolean, p_settings jsonb
) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  may_grant boolean := app_private.has_perm('team.manage', p_partner);
  may_edit boolean := app_private.has_perm('staff.manage', p_partner);
  previous public.staff_member;
  requested_position text := p_settings->>'position';
  requested_access jsonb := p_settings->'access';
  updated_access jsonb;
  requested_custom_pay jsonb := nullif(p_settings->'custom_pay', 'null'::jsonb);
  manager boolean;
  kind text;
  start_day date;
  end_day date;
  trainee_floor bigint := 50000;
  digits text;
  employee uuid;
  pay_date date;
  checked_pay boolean := p_settings ? 'expected_pay_revision';
begin
  if p_user is null then
    perform app_private.require_perm('staff.create', p_partner);
  else
    perform app_private.require_perm('staff.manage', p_partner);
    perform pg_advisory_xact_lock(hashtextextended('team:'||p_user,0));
    select * into previous from public.staff_member where user_id = p_user and partner_id = p_partner for update;
    if not found or not app_private.can_manage_user(p_user) then
      perform app_private.fail('forbidden', 'Сотрудник не принадлежит этому франчайзи или недоступен для редактирования');
    end if;
  end if;

  if p_user is not null and checked_pay
    and previous.pay_revision is distinct from (p_settings->>'expected_pay_revision')::integer then
    perform app_private.fail('version-conflict','Условия оплаты сотрудника уже изменились. Откройте карточку заново');
  end if;
  if p_settings ? 'pay_effective_from' then
    pay_date:=(p_settings->>'pay_effective_from')::date;
    if pay_date is null or not isfinite(pay_date) then perform app_private.fail('validation','Проверьте дату начала оплаты'); end if;
  end if;
  p_settings:=p_settings-array['pay_effective_from','expected_pay_revision'];
  if p_settings ? 'position' and (requested_position is null or requested_position not in ('trainee','sales_manager','manager')) then
    perform app_private.fail('validation', 'Выберите должность сотрудника');
  end if;
  manager := coalesce(requested_position = 'manager', previous.manager_enabled, false);
  if not may_grant and manager is distinct from coalesce(previous.manager_enabled, false) then
    perform app_private.fail('forbidden', 'Должность управляющего назначает франчайзи');
  end if;

  if p_settings ? 'access' then
    if jsonb_typeof(requested_access) is distinct from 'object'
      or jsonb_typeof(requested_access->'view_staff') is distinct from 'boolean'
      or jsonb_typeof(requested_access->'create_staff') is distinct from 'boolean'
      or jsonb_typeof(requested_access->'procurement') is distinct from 'boolean' then
      perform app_private.fail('validation', 'Проверьте разрешения сотрудника');
    end if;
    requested_access := jsonb_build_object(
      'view_staff', requested_access->'view_staff',
      'create_staff', requested_access->'create_staff',
      'procurement', requested_access->'procurement');
    if not may_grant and requested_access is distinct from (case when p_user is null
      then '{"view_staff":false,"create_staff":false,"procurement":false}'::jsonb
      else app_private.staff_access_flags(previous) - 'legacy_staff_management' end) then
      perform app_private.fail('forbidden', 'Разрешения сотрудников меняет франчайзи');
    end if;
  elsif p_user is null and requested_position is not null then
    requested_access := '{"view_staff":false,"create_staff":false,"procurement":false}'::jsonb;
  end if;

  if p_settings ? 'custom_pay' then
    if requested_custom_pay is not null and not may_edit then perform app_private.fail('forbidden', 'Нет права назначать схему оплаты'); end if;
    perform app_private.staff_custom_pay_validate(requested_custom_pay);
  end if;

  kind := case requested_position when 'trainee' then 'trainee' when 'sales_manager' then 'employee'
    when 'manager' then 'employee' else p_settings->>'employee_kind' end;

  if p_user is null then
    if coalesce(length(trim(p_full_name)), 0) not between 1 and 160 or p_use_partner is null then
      perform app_private.fail('validation', 'Укажите имя и условия оплаты');
    end if;
    if not exists (select 1 from public.partner where id = p_partner and status = 'active') then
      perform app_private.fail('not-found', 'Франчайзи не найден');
    end if;
    perform app_private.check_staff_locations(p_partner, p_locations);
    perform app_private.check_pay(p_rate_bp, p_shift_fee);
    if kind is null or kind not in ('employee','trainee') or jsonb_typeof(p_settings->'learning_enabled') is distinct from 'boolean' then
      perform app_private.fail('validation', 'Проверьте должность и обучение');
    end if;
    if kind = 'trainee' then
      start_day := coalesce(nullif(p_settings->>'internship_from','')::date, app_private.local_today(p_locations[1]));
      end_day := coalesce(nullif(p_settings->>'internship_until','')::date, (start_day+interval '1 month')::date-1);
      trainee_floor := coalesce((p_settings->>'internship_floor_minor')::bigint, 50000);
      if end_day < start_day or trainee_floor not between 0 and 99999999999 then
        perform app_private.fail('validation', 'Проверьте даты и фикс стажировки');
      end if;
    end if;
    digits := app_private.phone_login_digits(p_phone);
    perform app_private.check_phone_login_available(null, digits);
    employee := app_private.create_login(digits||'@staff.bron.local', p_password, p_full_name);
    update public.app_user set phone = digits where id = employee;
    insert into public.staff_member(
      user_id, partner_id, phone, location_ids, created_by, manager_enabled, checked_access, custom_pay, rate_bp, shift_fee_minor,
      use_partner_motivation, employee_kind, internship_from, internship_until, internship_floor_minor, learning_enabled, pay_effective_from
    ) values (
      employee, p_partner, digits, p_locations, actor, manager, requested_access, requested_custom_pay, p_rate_bp, p_shift_fee,
      p_use_partner, kind, start_day, end_day, trainee_floor, (p_settings->>'learning_enabled')::boolean, pay_date
    );
    insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by)
      values (employee,'franchisee_staff','partner',p_partner,actor);
    if manager then
      insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by)
        values (employee,'franchisee_manager','partner',p_partner,actor);
    end if;
    perform app_private.audit('staff.create', 'staff_member', employee, p_partner,
      jsonb_build_object('manager',manager,'access',requested_access,'employee_kind',kind));
    return employee;
  end if;

  -- The nested rate and onboarding writes form one dated profile edit.
  -- Older forms may specify a training start without a separate pay date.
  if kind='trainee' then start_day:=nullif(p_settings->>'internship_from','')::date; end if;
  update public.staff_member set pending_pay_effective_from=coalesce(pay_date,
    case when not checked_pay and kind='trainee' and (previous.employee_kind is distinct from kind
      or previous.internship_from is distinct from start_day) then start_day end,
    app_private.local_today(p_locations[1])) where user_id=p_user;
  perform public.staff_profile_save(p_user, p_partner, p_full_name, p_phone, p_password, p_locations,
    p_rate_bp, p_shift_fee, p_use_partner, (p_settings-'position'-'access'-'custom_pay')||jsonb_build_object('employee_kind',kind));
  if manager is distinct from previous.manager_enabled then
    perform public.staff_access_set(p_partner, p_user, manager, p_locations);
  end if;
  updated_access := case when p_settings ? 'access' and may_grant then requested_access
    when manager is distinct from previous.manager_enabled then app_private.staff_access_flags(previous) - 'legacy_staff_management'
    else previous.checked_access end;
  if updated_access is distinct from previous.checked_access or p_settings ? 'custom_pay' then
    update public.staff_member set
      checked_access = updated_access,
      -- An explicit promotion on the employee card must not inherit the old
      -- promotion command's full-management default.
      legacy_staff_management = manager and previous.legacy_staff_management,
      custom_pay = case when p_settings ? 'custom_pay' then requested_custom_pay else previous.custom_pay end
    where user_id = p_user;
    if updated_access is distinct from previous.checked_access then
      perform app_private.audit('staff.access','staff_member',p_user,p_partner,jsonb_build_object('before',app_private.staff_access_flags(previous),'after',updated_access));
    end if;
  end if;
  if pay_date is not null then
    update public.staff_member set pay_effective_from=pay_date where user_id=p_user and pay_effective_from is distinct from pay_date;
  end if;
  update public.staff_member set pending_pay_effective_from=null where user_id=p_user;
  return p_user;
exception
  when unique_violation then perform app_private.fail('validation', 'Этот номер телефона уже используется для входа','phone');
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
    perform app_private.fail('validation', 'Проверьте условия оплаты и даты стажировки');
end $$;
