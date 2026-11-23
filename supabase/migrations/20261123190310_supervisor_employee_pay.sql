-- Independent employee pay delegation; role and credential management stay separate.
insert into public.permission(code,description) values ('staff.pay_edit','Менять условия оплаты подчинённых сотрудников');

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
        or (p_perm = 'staff.pay_edit' and a.role = 'franchisee_manager' and s.active and s.manager_enabled
          and s.checked_access @> '{"manage_pay":true}'::jsonb)
        or (p_perm = 'staff.assigned_points' and a.role = 'franchisee_manager')
      )
  )
$$;

create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'is_demo', u.is_demo)
             from public.app_user u where u.id = auth.uid() and u.status = 'active' and app_private.session_is_current()),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'role', a.role, 'role_name', r.name, 'scope_type', a.scope_type, 'scope_id', a.scope_id,
        'scope_name', case when a.scope_type = 'company' then 'Вся сеть' else (select name from public.partner where id = a.scope_id) end,
        'permissions', (select coalesce(jsonb_agg(code order by code),'[]'::jsonb) from (
          select rp.permission as code from public.role_permission rp
            where rp.role = a.role and (rp.permission <> 'staff.manage' or app_private.has_perm(rp.permission,a.scope_id))
              and not (rp.permission = 'rating.read' and a.scope_type = 'partner'
                     and coalesce((select country from public.partner where id = a.scope_id), 'RU') <> 'RU')
          union
          select code from (values ('staff.view'),('staff.create'),('procurement.order'),('staff.pay_edit')) p(code)
            where a.role in ('franchise_manager','franchisee','franchisee_staff','franchisee_manager')
              and (code <> 'staff.pay_edit' or a.role = 'franchisee_manager')
              and app_private.has_perm(code,a.scope_id)
        ) permissions)
      ) order by r.name)
      from app_private.active_assignments() a join public.role r on r.code = a.role), '[]'::jsonb)
  )
$$;

-- Retire the explicit pay flag on demotion. Legacy manager defaults keep their own semantics.
create or replace function app_private.keep_legacy_staff_management() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if not new.manager_enabled then
    new.legacy_staff_management := false;
    new.checked_access := new.checked_access - 'manage_pay';
  elsif new.checked_access is null and (tg_op = 'INSERT' or not old.manager_enabled) then
    new.legacy_staff_management := true;
  end if;
  return new;
end $$;

create function app_private.can_edit_staff_pay(s public.staff_member) returns boolean
language sql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
  select app_private.can_manage_user(s.user_id) or (
    s.active and s.user_id <> auth.uid() and not s.manager_enabled
    and app_private.has_perm('staff.pay_edit', s.partner_id)
    and cardinality(s.location_ids) > 0
    and not exists (select 1 from unnest(s.location_ids) point_id where not app_private.staff_location_scope(point_id))
    and not exists (select 1 from public.role_assignment a where a.user_id = s.user_id and a.revoked_at is null
      and (a.role <> 'franchisee_staff' or a.scope_type <> 'partner' or a.scope_id is distinct from s.partner_id))
  )
$$;

create or replace function app_private.staff_scope_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare pay_columns constant text[] := array['rate_bp','shift_fee_minor','use_partner_motivation','custom_pay',
  'internship_floor_minor','pay_effective_from','pay_revision','pending_pay_effective_from','updated_at'];
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if not app_private.has_perm('staff.create', new.partner_id) and not app_private.staff_owner(new.partner_id) then
      perform app_private.fail('forbidden', 'Нет права добавлять сотрудников');
    end if;
  else
    if old.partner_id is distinct from new.partner_id then
      perform app_private.fail('forbidden', 'Сотрудника нельзя переносить к другому франчайзи');
    end if;
    if not app_private.can_manage_user(old.user_id) and not (
      app_private.can_edit_staff_pay(old) and to_jsonb(old) - pay_columns = to_jsonb(new) - pay_columns
    ) then
      perform app_private.fail('forbidden', 'Условия этого сотрудника изменяет франчайзи');
    end if;
    if old.location_ids is distinct from new.location_ids or old.checked_access is distinct from new.checked_access then
      delete from auth.sessions where user_id = new.user_id;
    end if;
  end if;
  perform app_private.check_staff_locations(new.partner_id, new.location_ids);
  return new;
end $$;

create function app_private.staff_pay_details(s public.staff_member) returns jsonb
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  select jsonb_build_object('rate_bp',s.rate_bp,'shift_fee_minor',s.shift_fee_minor,
    'custom_pay',s.custom_pay,'use_partner_motivation',s.use_partner_motivation,
    'pay_revision',s.pay_revision,'pay_effective_from',s.pay_effective_from,
    'internship_from',s.internship_from,'internship_until',s.internship_until,
    'internship_floor_minor',s.internship_floor_minor,
    'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
    'pay_scheduled',coalesce((select jsonb_agg(jsonb_build_object('effective_from',v.effective_from,'label',
      case when (v.terms->>'partner')::boolean then 'Общая схема' when v.terms->'custom'->>'name' is not null then v.terms->'custom'->>'name'
        else 'Фикс + процент' end) order by v.effective_from) from app_private.employee_pay_version v
      where v.employee_id=s.user_id and v.effective_from>app_private.local_today(s.location_ids[1])),'[]'::jsonb))
$$;

create function public.staff_pay_save(p_partner uuid, p_user uuid, p_rate_bp int, p_shift_fee bigint,
  p_use_partner boolean, p_custom_pay jsonb, p_pay_effective_from date, p_expected_pay_revision int,
  p_internship_floor_minor bigint) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare s public.staff_member; effective date;
begin
  perform app_private.require_user();
  if not (app_private.has_perm('staff.manage',p_partner) or app_private.has_perm('staff.pay_edit',p_partner)) then
    perform app_private.fail('forbidden','Нет права менять оплату сотрудников');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('team:' || p_user,0));
  select * into s from public.staff_member where user_id=p_user and partner_id=p_partner for update;
  if not found or not app_private.can_edit_staff_pay(s) then
    perform app_private.fail('forbidden','Нет доступа к оплате этого сотрудника');
  end if;
  perform app_private.require_partner_operational(p_partner);
  if p_expected_pay_revision is distinct from s.pay_revision then
    perform app_private.fail('version-conflict','Условия оплаты сотрудника уже изменились. Откройте карточку заново');
  end if;
  effective := coalesce(p_pay_effective_from,app_private.local_today(s.location_ids[1]));
  if not isfinite(effective) or p_use_partner is null then
    perform app_private.fail('validation','Проверьте условия и дату начала оплаты');
  end if;
  if p_internship_floor_minor is not null and (s.employee_kind <> 'trainee' or p_internship_floor_minor not between 0 and 99999999999) then
    perform app_private.fail('validation','Проверьте гарантию стажёра');
  end if;
  perform app_private.check_pay(p_rate_bp,p_shift_fee);
  if not p_use_partner then perform app_private.staff_custom_pay_validate(p_custom_pay); end if;
  update public.staff_member set rate_bp=p_rate_bp,shift_fee_minor=p_shift_fee,
    use_partner_motivation=p_use_partner,custom_pay=case when p_use_partner then s.custom_pay else p_custom_pay end,
    internship_floor_minor=coalesce(p_internship_floor_minor,s.internship_floor_minor),
    pay_effective_from=effective,pending_pay_effective_from=effective,updated_at=now() where user_id=p_user;
  update public.staff_member set pending_pay_effective_from=null where user_id=p_user;
  perform app_private.audit('staff.pay','staff_member',p_user,p_partner,jsonb_build_object('effective_from',effective));
end $$;

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
  requested_pay boolean;
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
      or jsonb_typeof(requested_access->'procurement') is distinct from 'boolean'
      or (requested_access ? 'manage_pay' and jsonb_typeof(requested_access->'manage_pay') is distinct from 'boolean') then
      perform app_private.fail('validation', 'Проверьте разрешения сотрудника');
    end if;
    requested_pay := coalesce((requested_access->>'manage_pay')::boolean,
      previous.checked_access @> '{"manage_pay":true}'::jsonb, false);
    if not may_grant and requested_pay is distinct from coalesce(previous.checked_access @> '{"manage_pay":true}'::jsonb, false) then
      perform app_private.fail('forbidden', 'Право менять оплату назначает франчайзи');
    end if;
    requested_access := jsonb_build_object(
      'view_staff', requested_access->'view_staff',
      'create_staff', requested_access->'create_staff',
      'procurement', requested_access->'procurement')
      || case when manager and requested_pay then '{"manage_pay":true}'::jsonb else '{}'::jsonb end;
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
  if not manager then updated_access := updated_access - 'manage_pay'; end if;
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

create or replace function public.staff_list(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date; may_view boolean;
begin
  perform app_private.require_user();
  if not app_private.has_perm('staff.manage', p_partner) then
    may_view := app_private.has_perm('staff.view', p_partner);
    if not (may_view or app_private.has_perm('staff.pay_edit', p_partner)) then
      perform app_private.fail('forbidden','Нет доступа к списку сотрудников');
    end if;
    return coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', '', 'active', s.active, 'can_manage', false, 'can_edit_pay', pay.may_edit,
      'location_ids', (select coalesce(jsonb_agg(x),'[]') from unnest(s.location_ids) x where app_private.staff_location_scope(x)),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name),'[]')
        from public.location l where l.id = any(s.location_ids) and app_private.staff_location_scope(l.id)),
      'position', case when s.manager_enabled then 'manager' when s.employee_kind='trainee' then 'trainee' else 'sales_manager' end,
      'is_manager', s.manager_enabled, 'employee_kind', s.employee_kind,
      'internship_completed', s.employee_kind='trainee' and s.internship_until < app_private.local_today(s.location_ids[1]),
      'month_shifts', 0, 'month_revenue_minor', 0, 'month_earned_minor', 0, 'shifts', '[]'::jsonb,
      'rate_bp', 0, 'shift_fee_minor', 0, 'open_shift', null
    ) || case when pay.may_edit then app_private.staff_pay_details(s) else '{}'::jsonb end order by s.active desc, u.full_name)
      from public.staff_member s join public.app_user u on u.id=s.user_id
      cross join lateral (select app_private.can_edit_staff_pay(s) may_edit) pay
      where s.partner_id=p_partner and app_private.staff_member_scope(s.user_id) and (may_view or pay.may_edit)), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', s.phone, 'active', s.active,
      'position', case when s.manager_enabled then 'manager' when s.employee_kind='trainee' then 'trainee' else 'sales_manager' end,
      'access', app_private.staff_access_flags(s),
      'location_ids', (select coalesce(jsonb_agg(x),'[]') from unnest(s.location_ids) x where app_private.staff_location_scope(x)), 'can_manage',app_private.can_manage_user(s.user_id), 'can_edit_pay',app_private.can_edit_staff_pay(s), 'is_manager',exists(select 1 from role_assignment a where a.user_id=s.user_id and a.role='franchisee_manager' and a.revoked_at is null),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name), '[]'::jsonb) from public.location l where l.id = any(s.location_ids) and app_private.staff_location_scope(l.id)),
      'employee_kind',s.employee_kind,'learning_enabled',s.learning_enabled,
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
    ) || app_private.staff_pay_details(s) order by s.active desc, u.full_name)
    from public.staff_member s join public.app_user u on u.id = s.user_id where s.partner_id = p_partner and app_private.staff_member_scope(s.user_id)), '[]'::jsonb);
end $$;

create or replace function public.motivation_get(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare today date;
begin
  perform app_private.require_user();
  if not app_private.has_perm('staff.manage',p_partner) then
    perform app_private.require_perm('staff.pay_edit',p_partner);
    today:=app_private.partner_pay_today(p_partner);
    return jsonb_build_object('policy',app_private.team_pay_on(p_partner,today),'today',today,
      'currency',(select currency from public.partner where id=p_partner));
  end if;
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

revoke all on function app_private.can_edit_staff_pay(public.staff_member), app_private.staff_pay_details(public.staff_member),
  public.staff_pay_save(uuid,uuid,int,bigint,boolean,jsonb,date,int,bigint) from public, anon, authenticated, service_role;
grant execute on function public.staff_pay_save(uuid,uuid,int,bigint,boolean,jsonb,date,int,bigint) to authenticated;
insert into app_private.client_command(fn) values ('public.staff_pay_save(uuid,uuid,int,bigint,boolean,jsonb,date,int,bigint)');

do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres','supabase_admin') loop
    execute format('grant execute on function app_private.can_edit_staff_pay(public.staff_member),
      app_private.staff_pay_details(public.staff_member), app_private.staff_custom_pay_validate(jsonb) to %I',trusted);
  end loop;
end $acl$;
