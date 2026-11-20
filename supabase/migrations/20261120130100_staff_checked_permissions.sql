-- NULL keeps the previous access defaults for existing assignments and clients.
-- Explicit choices are independent of the employee's position.
alter table public.staff_member add column checked_access jsonb;

create function app_private.staff_access_flags(s public.staff_member) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(s.checked_access, jsonb_build_object(
    'view_staff', s.manager_enabled, 'create_staff', s.manager_enabled, 'procurement', s.manager_enabled))
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
            or (s.active and s.checked_access is null)))
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

create or replace function app_private.has_perm_anywhere(p_perm text) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (select 1 from app_private.active_assignments() a where app_private.has_perm(p_perm, a.scope_id))
$$;

create or replace function app_private.staff_location_scope(p_location uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from public.location l where l.id = p_location and (
      app_private.staff_owner(l.partner_id) or exists (
        select 1 from public.staff_member s where s.user_id = auth.uid() and s.active
          and s.partner_id = l.partner_id and l.id = any(s.location_ids)
          and (app_private.has_perm('staff.manage', l.partner_id) or app_private.has_perm('staff.view', l.partner_id)
            or app_private.has_perm('staff.create', l.partner_id) or app_private.has_perm('staff.assigned_points', l.partner_id))
      )
    )
  )
$$;

alter policy read_scope on public.location using (app_private.in_scope(partner_id) and (
  not (app_private.has_perm('staff.manage', partner_id) or app_private.has_perm('staff.view', partner_id)
    or app_private.has_perm('staff.create', partner_id) or app_private.has_perm('staff.assigned_points', partner_id))
  or app_private.staff_location_scope(id)
));

create or replace function app_private.staff_scope_guard() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if not app_private.has_perm('staff.create', new.partner_id) and not app_private.staff_owner(new.partner_id) then
      perform app_private.fail('forbidden', 'Нет права добавлять сотрудников');
    end if;
  else
    if old.partner_id is distinct from new.partner_id then perform app_private.fail('forbidden', 'Сотрудника нельзя переносить в другую компанию'); end if;
    if not app_private.can_manage_user(old.user_id) then perform app_private.fail('forbidden', 'Условия этого сотрудника изменяет франчайзи'); end if;
    if old.location_ids is distinct from new.location_ids or old.checked_access is distinct from new.checked_access then
      delete from auth.sessions where user_id = new.user_id;
    end if;
  end if;
  perform app_private.check_staff_locations(new.partner_id, new.location_ids);
  return new;
end $$;

-- The active partner must be unique. An unmanaged legacy team account retains
-- its existing external ordering link until the owner configures checkboxes.
create or replace function public.order_link() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare ids uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct a.scope_id) into ids from app_private.active_assignments() a
    where a.scope_type = 'partner' and app_private.has_perm('procurement.order', a.scope_id);
  if coalesce(cardinality(ids), 0) = 0 then perform app_private.fail('forbidden', 'Нет доступа к заказу материалов'); end if;
  if cardinality(ids) <> 1 then perform app_private.fail('validation', 'Нужно выбрать франчайзи: к аккаунту привязано несколько компаний'); end if;
  return (select jsonb_build_object('url', order_url) from public.partner where id = ids[1]);
end $$;

create or replace function app_private.procurement_partner() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare ids uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct a.scope_id) into ids from app_private.active_assignments() a
    where a.scope_type = 'partner' and (a.role = 'franchisee' or exists (
      select 1 from public.staff_member s where s.user_id = a.user_id and s.partner_id = a.scope_id and s.active
        and s.checked_access @> '{"procurement": true}'::jsonb
        and a.role in ('franchisee_staff', 'franchisee_manager')));
  if coalesce(cardinality(ids), 0) <> 1 then perform app_private.fail('forbidden', 'Для закупки нужен однозначный доступ к партнёру'); end if;
  if not exists (select 1 from public.partner where id = ids[1] and status = 'active') then
    perform app_private.fail('forbidden', 'Партнёр неактивен');
  end if;
  return ids[1];
end $$;

-- Turn off employee-list access without taking away the manager's existing
-- revenue view for their assigned points.
create or replace function public.team_revenue_month(p_partner uuid,p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare
  m date := date_trunc('month', p_month)::date;
  manager boolean;
begin
  perform app_private.require_user();
  select exists(select 1 from app_private.active_assignments() a
    where a.role = 'franchisee_manager' and a.scope_type = 'partner' and a.scope_id = p_partner) into manager;
  if not manager then perform app_private.require_perm('staff.manage',p_partner); end if;
  if p_month is null then perform app_private.fail('validation','Выберите месяц'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('location_id',l.id,'location_name',l.name,'currency',l.currency,
    'total_minor',(select coalesce(sum(total_minor),0) from public.daily_revenue where location_id=l.id and day>=m and day<m+interval '1 month'),
    'days',coalesce((select jsonb_agg(x order by x->>'day' desc) from
      (select jsonb_build_object('day',r.day,'total_minor',sum(r.total_minor)) x from public.daily_revenue r
        where r.location_id=l.id and r.day>=m and r.day<m+interval '1 month' group by r.day) days),'[]')) order by l.name)
    from public.location l where l.partner_id=p_partner and (app_private.staff_owner(p_partner) or (manager and exists (
      select 1 from public.staff_member s where s.user_id=auth.uid() and s.partner_id=p_partner and s.active and l.id=any(s.location_ids))))),'[]');
end $$;

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
          select code from (values ('staff.view'),('staff.create'),('procurement.order')) p(code)
            where a.role in ('franchise_manager','franchisee','franchisee_staff','franchisee_manager')
              and app_private.has_perm(code,a.scope_id)
        ) permissions)
      ) order by r.name)
      from app_private.active_assignments() a join public.role r on r.code = a.role), '[]'::jsonb)
  )
$$;


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
      'location_ids', (select coalesce(jsonb_agg(x),'[]') from unnest(s.location_ids) x where app_private.staff_location_scope(x)), 'can_manage',app_private.can_manage_user(s.user_id), 'is_manager',exists(select 1 from role_assignment a where a.user_id=s.user_id and a.role='franchisee_manager' and a.revoked_at is null),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name), '[]'::jsonb) from public.location l where l.id = any(s.location_ids) and app_private.staff_location_scope(l.id)),
      'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation,
      'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
      'open_shift', (select jsonb_build_object('id', w.id, 'location_name', l.name, 'opened_at', w.opened_at)
                     from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'open'),
      'month_shifts', (select count(*) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'shifts', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'day', w.day, 'location_name', l.name, 'total_minor', w.total_minor,
          'earned_minor', w.earned_minor, 'opened_at', w.opened_at, 'closed_at', w.closed_at) order by w.day desc)
        from public.work_shift w join public.location l on l.id = w.location_id
        where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb)
    ) order by s.active desc, u.full_name)
    from public.staff_member s join public.app_user u on u.id = s.user_id where s.partner_id = p_partner and app_private.staff_member_scope(s.user_id)), '[]'::jsonb);
end $$;

-- The existing phone RPC is the atomic profile command. Older clients omit the
-- new keys. Add-only access never flows through the existing edit commands.
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
      else app_private.staff_access_flags(previous) end) then
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
    when manager is distinct from previous.manager_enabled then app_private.staff_access_flags(previous)
    else previous.checked_access end;
  if updated_access is distinct from previous.checked_access or p_settings ? 'custom_pay' then
    update public.staff_member set
      checked_access = updated_access,
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

-- Existing trusted definers can be owned by either role on older installations.
revoke execute on function app_private.staff_access_flags(public.staff_member) from public, anon, authenticated;
do $grants$
declare trusted text;
begin
  foreach trusted in array array['postgres','supabase_admin'] loop
    if to_regrole(trusted) is not null then
      execute format('grant execute on function app_private.staff_access_flags(public.staff_member) to %I', trusted);
    end if;
  end loop;
end
$grants$;
