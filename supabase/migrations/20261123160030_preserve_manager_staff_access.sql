-- Preserve the broader management access of existing managers separately
-- from the three optional permissions. Explicitly limited accounts stay limited.
alter table public.staff_member add column legacy_staff_management boolean not null default false;

update public.staff_member
set legacy_staff_management = true
where manager_enabled and checked_access is null;

-- The existing legacy account and role commands retain their defaults. The
-- explicit profile command below continues to create and promote limited users.
create function app_private.keep_legacy_staff_management() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if not new.manager_enabled then
    new.legacy_staff_management := false;
  elsif new.checked_access is null and (tg_op = 'INSERT' or not old.manager_enabled) then
    new.legacy_staff_management := true;
  end if;
  return new;
end $$;

revoke all on function app_private.keep_legacy_staff_management() from public, anon, authenticated;
create trigger keep_legacy_staff_management
before insert or update of manager_enabled on public.staff_member
for each row execute function app_private.keep_legacy_staff_management();

-- The existing roster projection uses this JSON. The optional read-only flag
-- explains the inherited access in the owner’s card without changing new grants.
create or replace function app_private.staff_access_flags(s public.staff_member) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(s.checked_access, jsonb_build_object(
    'view_staff', s.manager_enabled, 'create_staff', s.manager_enabled, 'procurement', s.manager_enabled))
    || case when s.legacy_staff_management then '{"legacy_staff_management":true}'::jsonb else '{}'::jsonb end
$$;

create or replace function app_private.has_perm(p_perm text, p_partner uuid default null) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from app_private.active_assignments() a
    left join public.staff_member s on s.user_id = a.user_id and s.partner_id = a.scope_id
      and a.role in ('franchisee_staff', 'franchisee_manager')
    where (a.scope_type = 'company' or (p_partner is not null and a.scope_id = p_partner))
      and (
        (exists (select 1 from public.role_permission rp where rp.role = a.role and rp.permission = p_perm)
          and (a.role <> 'franchisee_manager' or p_perm <> 'staff.manage' or s.user_id is null
            or (s.active and s.legacy_staff_management and app_private.staff_access_flags(s) @> '{"view_staff":true}')))
        or (p_perm in ('staff.view', 'staff.create') and (
          (a.role not in ('franchisee_staff', 'franchisee_manager') and exists (
            select 1 from public.role_permission rp where rp.role = a.role and rp.permission = 'staff.manage'))
          or (s.active and (app_private.staff_access_flags(s)->>(case p_perm when 'staff.view' then 'view_staff' else 'create_staff' end))::boolean)))
        or (p_perm = 'procurement.order' and (
          a.role = 'franchisee' or (a.role = 'franchisee_manager' and s.user_id is null)
          or (s.active and (app_private.staff_access_flags(s)->>'procurement')::boolean)))
        or (p_perm = 'staff.assigned_points' and a.role = 'franchisee_manager')
      )
  )
$$;

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
      use_partner_motivation, employee_kind, internship_from, internship_until, internship_floor_minor, learning_enabled
    ) values (
      employee, p_partner, digits, p_locations, actor, manager, requested_access, requested_custom_pay, p_rate_bp, p_shift_fee,
      p_use_partner, kind, start_day, end_day, trainee_floor, (p_settings->>'learning_enabled')::boolean
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
  return p_user;
exception
  when unique_violation then perform app_private.fail('validation', 'Этот номер телефона уже используется для входа','phone');
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
    perform app_private.fail('validation', 'Проверьте условия оплаты и даты стажировки');
end $$;

-- Preserve the original audit event and return only the user-facing action.
-- Historical entries without an active value keep their existing generic label.
create or replace function public.staff_access_history(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('team.manage', p_partner);
  return coalesce((
    select jsonb_agg(entry order by (entry->>'at') desc, (entry->>'id')::bigint desc)
    from (
      select jsonb_build_object(
        'id', a.id, 'at', a.at, 'actor_name', actor.full_name, 'user_name', target.full_name,
        'action', case
          when a.action in ('staff.active', 'team.active') and a.diff->'active' = 'false'::jsonb
            then split_part(a.action, '.', 1)||'.remove'
          when a.action in ('staff.active', 'team.active') and a.diff->'active' = 'true'::jsonb
            then split_part(a.action, '.', 1)||'.restore'
          else a.action
        end
      ) entry
      from public.audit_event a
      left join public.app_user actor on actor.id = a.actor_id
      left join public.app_user target on target.id = a.entity_id
      where a.partner_id = p_partner and a.action in (
        'team.create', 'staff.create', 'staff.active', 'staff.update', 'staff.access', 'staff.restore',
        'staff.remove', 'team.active', 'team.restore', 'team.remove', 'user.password', 'user.login'
      )
      order by a.at desc, a.id desc
      limit 50
    ) recent
  ), '[]'::jsonb);
end $$;
