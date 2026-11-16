-- Managers are employees at explicitly assigned points. Owners retain partner-wide control.
-- Assignments may contain several points; no fixed rotation/schedule is assumed.
-- Intended role survives a suspension, but an explicit demotion must survive restore.
alter table public.staff_member add column manager_enabled boolean not null default false;
create function app_private.staff_initialize_manager_intent() returns void
language sql security definer set search_path=public,app_private,pg_temp as $$
 update public.staff_member s set manager_enabled=true where exists(select 1 from public.role_assignment a
 where a.user_id=s.user_id and a.scope_id=s.partner_id and a.role='franchisee_manager' and (a.revoked_at is null or not s.active))
$$;
select app_private.staff_initialize_manager_intent();
drop function app_private.staff_initialize_manager_intent();
create function app_private.staff_owner(p_partner uuid) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select app_private.has_perm('team.manage',p_partner)
$$;
create function app_private.staff_location_scope(p_location uuid) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select exists(select 1 from public.location l where l.id=p_location and
 (app_private.staff_owner(l.partner_id) or exists(
  select 1 from public.staff_member s where s.user_id=auth.uid() and s.active
  and s.partner_id=l.partner_id and l.id=any(s.location_ids)
  and app_private.has_perm('staff.manage',s.partner_id))))
$$;
create function app_private.staff_member_scope(p_user uuid) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select exists(select 1 from public.staff_member s where s.user_id=p_user and
 (app_private.staff_owner(s.partner_id) or exists(select 1 from unnest(s.location_ids) x where app_private.staff_location_scope(x))))
$$;
create or replace function app_private.can_manage_user(p_user uuid) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select p_user is distinct from auth.uid() and not exists(select 1 from role_assignment where user_id=p_user and scope_type='company' and revoked_at is null)
 and (app_private.has_perm('org.manage') or (
 not exists(select 1 from role_assignment a where a.user_id=p_user and a.revoked_at is null and
   (a.role not in ('franchisee_staff','franchisee_manager') or not app_private.has_perm(case when a.role='franchisee_manager' then 'team.manage' else 'staff.manage' end,a.scope_id)))
 and (exists(select 1 from staff_member s where s.user_id=p_user and app_private.has_perm('staff.manage',s.partner_id) and (not s.manager_enabled or app_private.staff_owner(s.partner_id))
   and (app_private.staff_owner(s.partner_id) or (cardinality(s.location_ids)>0 and not exists(select 1 from unnest(s.location_ids) x where not app_private.staff_location_scope(x)))))
 or exists(select 1 from role_assignment a where a.user_id=p_user and a.role='franchisee_manager' and app_private.has_perm('team.manage',a.scope_id)))))
$$;
create or replace function app_private.check_staff_locations(p_partner uuid,p_locations uuid[]) returns void
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 if coalesce(cardinality(p_locations),0)=0 or array_position(p_locations,null) is not null then perform app_private.fail('validation','Выберите хотя бы одну точку','locations');end if;
 if exists(select 1 from unnest(p_locations) x where not exists(select 1 from location l where l.id=x and l.partner_id=p_partner)) then perform app_private.fail('validation','Точка не принадлежит франчайзи','locations');end if;
 if not app_private.staff_owner(p_partner) and exists(select 1 from unnest(p_locations) x where not app_private.staff_location_scope(x)) then perform app_private.fail('forbidden','Можно назначать только свои точки','locations');end if;
end $$;
-- Applies also to older profile/motivation commands, not just the new UI.
create function app_private.staff_scope_guard() returns trigger
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
begin
 if auth.uid() is null then return new;end if; -- trusted migration/maintenance, no client grants
 if tg_op='UPDATE' then
  if old.partner_id is distinct from new.partner_id then perform app_private.fail('forbidden','Сотрудника нельзя переносить в другую компанию');end if;
  if not app_private.can_manage_user(old.user_id) then perform app_private.fail('forbidden','Условия этого сотрудника изменяет франчайзи');end if;
 end if;
 perform app_private.check_staff_locations(new.partner_id,new.location_ids);
 if tg_op='UPDATE' and old.location_ids is distinct from new.location_ids then delete from auth.sessions where user_id=new.user_id;end if;
 return new;
end $$;
create trigger staff_scope_guard before insert or update on public.staff_member for each row execute function app_private.staff_scope_guard();
alter policy read_scope on public.location using (app_private.in_scope(partner_id) and
 (not app_private.has_perm('staff.manage',partner_id) or app_private.staff_location_scope(id)));
alter policy read_scope on public.staff_member using (user_id=auth.uid() or app_private.can_manage_user(user_id));
alter policy read_scope on public.work_shift using (employee_id=auth.uid() or (app_private.has_perm('staff.manage',partner_id) and app_private.staff_location_scope(location_id)) or app_private.has_perm('revenue.read',partner_id));

create or replace function public.staff_list(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  perform app_private.require_user();
  perform app_private.require_perm('staff.manage', p_partner);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', s.phone, 'active', s.active,
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
create or replace function public.staff_open_shifts(p_partner uuid) returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('staff.manage',p_partner);
 return coalesce((select jsonb_agg(to_jsonb(w)||jsonb_build_object('user_name',u.full_name,'location_name',l.name,'currency',l.currency,'today',app_private.local_today(l.id),'can_resolve',app_private.can_manage_user(w.employee_id),'can_close',app_private.has_perm('revenue.enter',w.partner_id)) order by w.day,w.opened_at) from work_shift w join app_user u on u.id=w.employee_id join location l on l.id=w.location_id where w.partner_id=p_partner and w.status='open' and app_private.staff_location_scope(w.location_id)),'[]');
end $$;
create or replace function public.learning_report(p_partner uuid,p_month date) returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('staff.manage',p_partner);
 return coalesce((select jsonb_agg(j order by j->>'day' desc,j->>'user_name') from (
 select jsonb_build_object('user_id',t.user_id,'user_name',u.full_name,'day',x.day,'article_id',t.article_id,'article_title',t.title,'read_at',x.read_at,'completed_at',x.completed_at,'score',case when x.completed_at is not null then t.score else null end,'total',jsonb_array_length(t.questions),'percent',t.result->'percent','next_due',t.result->'next_due') j from app_private.learning_attempt t join app_private.learning_activity x on x.attempt_id=t.id join app_user u on u.id=t.user_id where t.partner_id=p_partner and (app_private.staff_owner(p_partner) or app_private.staff_member_scope(t.user_id)) and x.day>=date_trunc('month',p_month)::date and x.day<(date_trunc('month',p_month)+interval '1month')::date
 union all select jsonb_build_object('user_id',t.user_id,'user_name',u.full_name,'day',t.day,'article_id',t.article_id,'article_title',t.title,'read_at',t.read_at,'completed_at',t.completed_at,'score',t.score,'total',jsonb_array_length(t.questions)) from app_private.learning_task t join app_user u on u.id=t.user_id where t.partner_id=p_partner and (app_private.staff_owner(p_partner) or app_private.staff_member_scope(t.user_id)) and t.day>=date_trunc('month',p_month)::date and t.day<(date_trunc('month',p_month)+interval '1month')::date) s),'[]');
end $$;
create or replace function public.staff_account_create(p_partner uuid,p_full_name text,p_login text,p_password text,p_locations uuid[],p_manager boolean default false) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user(); v_user uuid;
begin
 perform app_private.require_perm(case when p_manager then 'team.manage' else 'staff.manage' end,p_partner);
 if p_manager is null or coalesce(length(trim(p_full_name)),0) not between 1 and 160 then perform app_private.fail('validation','Укажите имя и роль'); end if;
 if not exists(select 1 from partner where id=p_partner and status='active') then perform app_private.fail('not-found','Франчайзи не найден'); end if;
 perform app_private.check_staff_locations(p_partner,p_locations);
 v_user:=app_private.create_login(app_private.access_email(p_login),p_password,p_full_name);
 insert into public.staff_member(user_id,partner_id,phone,location_ids,created_by,manager_enabled) values(v_user,p_partner,lower(trim(p_login)),p_locations,v_actor,p_manager);
 insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(v_user,'franchisee_staff','partner',p_partner,v_actor);
 if p_manager then insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(v_user,'franchisee_manager','partner',p_partner,v_actor); end if;
 perform app_private.audit('staff.create','staff_member',v_user,p_partner,jsonb_build_object('manager',p_manager)); return v_user;
end $$;
create or replace function public.team_set_active(p_partner uuid,p_user uuid,p_active boolean) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user();
begin
 perform app_private.require_perm('team.manage',p_partner);
 perform pg_advisory_xact_lock(hashtextextended('team:'||p_user,0));
 if exists(select 1 from staff_member where user_id=p_user and not manager_enabled) then perform app_private.fail('forbidden','Роль управляющего снята. Назначьте её отдельно');end if;
 if p_active is null or not app_private.can_manage_user(p_user) or not exists(select 1 from role_assignment where user_id=p_user and role='franchisee_manager' and scope_id=p_partner)
 or exists(select 1 from role_assignment where user_id=p_user and revoked_at is null and (role not in ('franchisee_manager','franchisee_staff') or scope_id<>p_partner)) then perform app_private.fail('forbidden','Нельзя изменять эту учётную запись'); end if;
 delete from auth.sessions where user_id=p_user;
 update auth.users set banned_until=case when p_active then null else now()+interval '100 years' end where id=p_user;
 update public.app_user set status=case when p_active then 'active' else 'suspended' end,updated_at=now() where id=p_user;
 perform app_private.staff_sync_active(p_user,p_active);
 if p_active then
  if not exists(select 1 from role_assignment where user_id=p_user and role='franchisee_manager' and revoked_at is null) then
   insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(p_user,'franchisee_manager','partner',p_partner,v_actor);
  end if;
  if exists(select 1 from staff_member where user_id=p_user) and not exists(select 1 from role_assignment where user_id=p_user and role='franchisee_staff' and revoked_at is null) then
   insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(p_user,'franchisee_staff','partner',p_partner,v_actor);
  end if;
 else update public.role_assignment set revoked_at=now(),revoked_by=v_actor where user_id=p_user and revoked_at is null;
 end if;
 perform app_private.audit('team.active','app_user',p_user,p_partner,jsonb_build_object('active',p_active));
end $$;
create or replace function public.staff_set_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); s public.staff_member;
begin
  select * into s from public.staff_member where user_id = p_user;
  if not found or not app_private.has_perm('staff.manage', s.partner_id) or not app_private.can_manage_user(p_user) then perform app_private.fail('not-found', 'Сотрудник не найден'); end if;
  if s.manager_enabled then
    perform public.team_set_active(s.partner_id,p_user,p_active); return;
  end if;
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

-- Legacy clients did not offer point selection. Preserve that creation contract
-- for NEW accounts only: the owner-created manager receives current active points.
-- Existing legacy accounts are not silently assigned any point.
create or replace function public.team_create(p_partner uuid,p_full_name text,p_phone text,p_password text) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare actor uuid:=app_private.require_user();u uuid;login text:=app_private.phone_digits(p_phone);locations uuid[];
begin
 perform app_private.require_perm('team.manage',p_partner);
 if not exists(select 1 from partner where id=p_partner and status='active') then perform app_private.fail('not-found','Франчайзи не найден');end if;
 if coalesce(length(trim(p_full_name)),0)=0 or length(login) not between 10 and 15 then perform app_private.fail('validation','Укажите имя и полный телефон');end if;
 select array_agg(id order by id) into locations from location where partner_id=p_partner and status='active';
 perform app_private.check_staff_locations(p_partner,locations);
 u:=app_private.create_login(app_private.staff_email(p_phone),p_password,p_full_name);
 insert into staff_member(user_id,partner_id,phone,location_ids,created_by,manager_enabled) values(u,p_partner,login,locations,actor,true);
 insert into role_assignment(user_id,role,scope_type,scope_id,granted_by) values
 (u,'franchisee_staff','partner',p_partner,actor),(u,'franchisee_manager','partner',p_partner,actor);
 perform app_private.audit('team.create','app_user',u,p_partner,jsonb_build_object('locations',locations));return u;
end $$;

-- Owner can promote an existing employee and change/rotate the managed points.
create function public.staff_access_set(p_partner uuid,p_user uuid,p_manager boolean,p_locations uuid[]) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare actor uuid:=app_private.require_user();s public.staff_member;was_manager boolean;
begin
 perform app_private.require_perm('team.manage',p_partner);
 perform pg_advisory_xact_lock(hashtextextended('team:'||p_user,0));
 if p_manager is null or not app_private.can_manage_user(p_user) then perform app_private.fail('forbidden','Выберите своего действующего сотрудника');end if;
 perform app_private.check_staff_locations(p_partner,p_locations);
 select * into s from staff_member where user_id=p_user and partner_id=p_partner for update;
 if not found then
  if exists(select 1 from staff_member where user_id=p_user) or not exists(select 1 from role_assignment a join app_user u on u.id=a.user_id where a.user_id=p_user and a.role='franchisee_manager' and a.scope_id=p_partner and a.revoked_at is null and u.status='active') then perform app_private.fail('forbidden','Выберите своего действующего сотрудника');end if;
  insert into staff_member(user_id,partner_id,phone,location_ids,created_by) select p_user,p_partner,split_part(email,'@',1),p_locations,actor from app_user where id=p_user returning * into s;
  insert into role_assignment(user_id,role,scope_type,scope_id,granted_by) values(p_user,'franchisee_staff','partner',p_partner,actor);
 end if;
 if not s.active then perform app_private.fail('forbidden','Сначала верните сотруднику доступ');end if;
 was_manager:=exists(select 1 from role_assignment where user_id=p_user and role='franchisee_manager' and scope_id=p_partner and revoked_at is null);
 -- Always record this explicit access action, including legacy-membership repair.
 if p_manager and not was_manager then
  insert into role_assignment(user_id,role,scope_type,scope_id,granted_by) values(p_user,'franchisee_manager','partner',p_partner,actor);
 elsif not p_manager and was_manager then
  update role_assignment set revoked_at=now(),revoked_by=actor where user_id=p_user and role='franchisee_manager' and scope_id=p_partner and revoked_at is null;
 end if;
 update staff_member set location_ids=p_locations,manager_enabled=p_manager,updated_at=now() where user_id=p_user;
 delete from auth.sessions where user_id=p_user;
 perform app_private.audit('staff.access','staff_member',p_user,p_partner,jsonb_build_object('manager_before',was_manager,'manager_after',p_manager,'locations_before',s.location_ids,'locations_after',p_locations));
end $$;
create or replace function public.team_list(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('team.manage',p_partner);
 return coalesce((select jsonb_agg(x order by x->>'full_name') from (
 select jsonb_build_object('user_id',u.id,'full_name',u.full_name,'phone',split_part(u.email,'@',1),
 'active',bool_or(a.revoked_at is null) and u.status='active','location_ids',coalesce(to_jsonb(s.location_ids),'[]'),
 'location_names',(select coalesce(jsonb_agg(l.name order by l.name),'[]') from location l where l.id=any(s.location_ids))) x
 from role_assignment a join app_user u on u.id=a.user_id left join staff_member s on s.user_id=u.id and s.partner_id=p_partner
 where a.role='franchisee_manager' and a.scope_id=p_partner and (s.manager_enabled or s.user_id is null) group by u.id,s.location_ids) q),'[]');
end $$;
-- Point revenue is a dedicated read-only command. Managers do not receive partner-wide
-- revenue.read / revenue.enter, owner finances or royalty access.
create function public.team_revenue_month(p_partner uuid,p_month date) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare m date:=date_trunc('month',p_month)::date;
begin
 perform app_private.require_user();perform app_private.require_perm('staff.manage',p_partner);
 if p_month is null then perform app_private.fail('validation','Выберите месяц');end if;
 return coalesce((select jsonb_agg(jsonb_build_object('location_id',l.id,'location_name',l.name,'currency',l.currency,
 'total_minor',(select coalesce(sum(total_minor),0) from daily_revenue where location_id=l.id and day>=m and day<m+interval '1 month'),
 'days',coalesce((select jsonb_agg(x order by x->>'day' desc) from
 (select jsonb_build_object('day',r.day,'total_minor',sum(r.total_minor)) x from daily_revenue r where r.location_id=l.id and r.day>=m and r.day<m+interval '1 month' group by r.day) days),'[]')) order by l.name)
 from location l where l.partner_id=p_partner and app_private.staff_location_scope(l.id)),'[]');
end $$;
create function public.staff_access_history(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('team.manage',p_partner);
 return coalesce((select jsonb_agg(x order by x->>'at' desc) from (
 select jsonb_build_object('id',a.id,'at',a.at,'action',a.action,'actor_name',u.full_name,'user_name',target.full_name) x
 from audit_event a left join app_user u on u.id=a.actor_id left join app_user target on target.id=a.entity_id
 where a.partner_id=p_partner and a.action in ('team.create','staff.create','staff.active','staff.update','staff.access','staff.restore','staff.remove','team.active','team.restore','team.remove','user.password')
 order by a.at desc,a.id desc limit 50) q),'[]');
end $$;
insert into app_private.policy_helper(fn) values
 ('app_private.staff_location_scope(uuid)'),('app_private.staff_member_scope(uuid)'),('app_private.can_manage_user(uuid)');
insert into app_private.client_command(fn) values
 ('public.staff_access_set(uuid,uuid,boolean,uuid[])'),('public.team_revenue_month(uuid,date)'),('public.staff_access_history(uuid)');
select app_private.apply_grants();
