-- A phone is the public login. Existing email/short logins remain until an
-- authorized explicit edit. No existing account is renamed by this migration.
alter table public.app_user add column phone text
  check (phone ~ '^[1-9][0-9]{9,14}$');
create unique index app_user_phone_unique on public.app_user(phone) where phone is not null;

-- All application factories, including legacy clients, share this boundary.
-- Auth's existing insert trigger can adopt pending email assignments; an app
-- factory must never claim those implicitly, even if a reservation races the
-- precheck. CREATE OR REPLACE preserves the established function OID/owner.
create or replace function app_private.create_login(p_email text,p_password text,p_full_name text) returns uuid
language plpgsql security definer set search_path=public,app_private,extensions,pg_temp as $$
declare v uuid:=gen_random_uuid();v_email text:=lower(trim(p_email));
begin
 perform app_private.check_password(p_password);
 if exists(select 1 from public.pending_assignment where lower(email)=v_email) then
  perform app_private.fail('validation','Для этого логина уже подготовлен доступ. Менеджеру нужно сначала проверить его назначение','login');end if;
 if exists(select 1 from auth.users where lower(email)=v_email) then
  perform app_private.fail('validation','Этот логин уже занят','login');end if;
 insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,
  email_change_token_new,email_change,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('00000000-0000-0000-0000-000000000000',v,'authenticated','authenticated',v_email,
  extensions.crypt(p_password,extensions.gen_salt('bf')),now(),'','','','',
  '{"provider":"email","providers":["email"]}'::jsonb,jsonb_build_object('full_name',trim(p_full_name)),now(),now());
 if exists(select 1 from public.role_assignment where user_id=v) then
  perform app_private.fail('validation','Назначение доступа изменилось. Менеджеру нужно проверить его перед созданием','login');end if;
 insert into auth.identities(provider_id,user_id,identity_data,provider,created_at,updated_at,last_sign_in_at)
 values(v::text,v,jsonb_build_object('sub',v::text,'email',v_email,'email_verified',true),'email',now(),now(),now());
 return v;
end $$;

create function app_private.phone_login_digits(p_phone text) returns text
language plpgsql immutable set search_path=pg_catalog,app_private,pg_temp as $$
declare v text:=btrim(p_phone);d text;
begin
 if v is null or v !~ '^\+?[0-9()[:space:]-]+$' then
  perform app_private.fail('validation','Укажите полный номер телефона с кодом страны','phone');
 end if;
 d:=app_private.phone_digits(v);
 if d !~ '^[1-9][0-9]{9,14}$' then
  perform app_private.fail('validation','Укажите полный номер телефона с кодом страны','phone');
 end if;
 return d;
end $$;

-- Only called by the new, same-owner guarded commands below. It exposes no
-- credential or other user's identity and serializes claims to a phone number.
create function app_private.check_phone_login_available(p_user uuid,p_digits text) returns void
language plpgsql security definer set search_path=public,app_private,auth,pg_temp as $$
declare v_email text:=p_digits||'@staff.bron.local';
begin
 perform pg_advisory_xact_lock(hashtextextended('phone-login:'||p_digits,0));
 -- The legacy Auth insert trigger consumes pending assignments by email.
 -- Claiming a reserved alias must never inherit an unrelated partner/role.
 if exists(select 1 from public.pending_assignment where lower(email)=v_email) then
  perform app_private.fail('validation','Для этого номера уже подготовлен доступ. Менеджеру нужно сначала проверить его назначение','phone');end if;
 if exists(select 1 from public.app_user where id is distinct from p_user and phone=p_digits)
 or exists(select 1 from auth.users where id is distinct from p_user and
   (lower(email)=v_email or (phone ~ '^\+?[0-9()[:space:]-]+$' and app_private.phone_digits(phone)=p_digits)))
 or exists(select 1 from auth.identities where user_id is distinct from p_user and
   provider='email' and lower(identity_data->>'email')=v_email)
 or exists(select 1 from public.staff_member where user_id is distinct from p_user and
   phone ~ '^\+?[0-9()[:space:]-]+$' and app_private.phone_digits(phone)=p_digits)
 then perform app_private.fail('validation','Этот номер телефона уже используется для входа','phone');end if;
end $$;

create function public.account_create_phone(p_partner uuid,p_full_name text,p_phone text,p_password text) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare actor uuid:=app_private.require_user();d text;u uuid;
begin
 perform app_private.require_perm('org.manage');
 d:=app_private.phone_login_digits(p_phone);
 perform app_private.check_phone_login_available(null,d);
 u:=public.account_create(p_partner,p_full_name,d||'@staff.bron.local',p_password);
 update public.app_user set phone=d where id=u;
 return u;
exception when unique_violation then
 perform app_private.fail('validation','Этот номер телефона уже используется для входа','phone');
end $$;

-- Current employee form uses one atomic command, including pay/onboarding.
-- Legacy clients keep staff_profile_save unchanged. Edits never rename a login.
create function public.staff_profile_save_phone(p_user uuid,p_partner uuid,p_full_name text,p_phone text,p_password text,
 p_locations uuid[],p_rate_bp int,p_shift_fee bigint,p_use_partner boolean,p_settings jsonb) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare actor uuid:=app_private.require_user();d text;u uuid;
begin
 perform app_private.require_perm('staff.manage',p_partner);
 if p_user is null then
  perform app_private.check_staff_locations(p_partner,p_locations);
  d:=app_private.phone_login_digits(p_phone);
  perform app_private.check_phone_login_available(null,d);
  u:=public.staff_profile_save(null,p_partner,p_full_name,d,p_password,p_locations,p_rate_bp,p_shift_fee,p_use_partner,p_settings);
  update public.app_user set phone=d where id=u;
  return u;
 end if;
 if not exists(select 1 from public.staff_member where user_id=p_user and partner_id=p_partner) then
  perform app_private.fail('forbidden','Сотрудник не принадлежит этому франчайзи');end if;
 return public.staff_profile_save(p_user,p_partner,p_full_name,p_phone,p_password,p_locations,p_rate_bp,p_shift_fee,p_use_partner,p_settings);
exception when unique_violation then
 perform app_private.fail('validation','Этот номер телефона уже используется для входа','phone');
end $$;

-- Phone-only factory for current UI. The legacy short-login factory remains
-- compatible and does not silently rename or restore any existing account.
create function public.staff_account_create_phone(p_partner uuid,p_full_name text,p_phone text,p_password text,
 p_locations uuid[],p_manager boolean default false) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare actor uuid:=app_private.require_user();d text;u uuid;
begin
 perform app_private.require_perm(case when p_manager then 'team.manage' else 'staff.manage' end,p_partner);
 if p_manager is null or coalesce(length(trim(p_full_name)),0) not between 1 and 160 then
  perform app_private.fail('validation','Укажите имя и роль');end if;
 if not exists(select 1 from public.partner where id=p_partner and status='active') then
  perform app_private.fail('not-found','Франчайзи не найден');end if;
 perform app_private.check_staff_locations(p_partner,p_locations);
 d:=app_private.phone_login_digits(p_phone);
 perform app_private.check_phone_login_available(null,d);
 u:=app_private.create_login(d||'@staff.bron.local',p_password,p_full_name);
 update public.app_user set phone=d where id=u;
 insert into public.staff_member(user_id,partner_id,phone,location_ids,created_by,manager_enabled)
 values(u,p_partner,d,p_locations,actor,p_manager);
 insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by)
 values(u,'franchisee_staff','partner',p_partner,actor);
 if p_manager then insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by)
  values(u,'franchisee_manager','partner',p_partner,actor);end if;
 perform app_private.audit('staff.create','staff_member',u,p_partner,jsonb_build_object('manager',p_manager,'login_type','phone'));
 return u;
exception when unique_violation then
 perform app_private.fail('validation','Этот номер телефона уже используется для входа','phone');
end $$;

-- Staff owns the contact projection. Invoker-only, same transaction/authority as
-- the guarded account command; no client grant or separate public write path.
create function app_private.staff_phone_sync(p_user uuid,p_phone text) returns void
language sql set search_path=public,app_private,pg_temp as $$
 update public.staff_member set phone=p_phone,updated_at=now()
 where user_id=p_user and phone is distinct from p_phone
$$;

create function public.user_set_phone_login(p_user uuid,p_phone text) returns jsonb
language plpgsql security definer set search_path=public,app_private,auth,pg_temp as $$
declare actor uuid:=app_private.require_user();d text;e text;old_email text;old_phone text;native_phone text;
 changed boolean;scope uuid;email_id_count int;
begin
 -- Keep the established account-management hierarchy: no self, company peers,
 -- other partners or staff spanning points the actor does not manage.
 if not app_private.can_manage_user(p_user) or exists(select 1 from public.role_assignment
   where user_id=p_user and scope_type='company') then
  perform app_private.fail('forbidden','Нельзя изменить телефон для входа этой учётной записи');end if;
 select phone into old_phone from public.app_user where id=p_user for update;
 if not found then perform app_private.fail('not-found','Учётная запись не найдена');end if;
 select email,phone into old_email,native_phone from auth.users where id=p_user for update;
 if not found then perform app_private.fail('not-found','Учётная запись не найдена');end if;
 select count(*) into email_id_count from auth.identities where user_id=p_user and provider='email';
 if email_id_count<>1 or exists(select 1 from auth.identities where user_id=p_user and provider<>'email') then
  perform app_private.fail('validation','Телефон нельзя изменить для этого способа входа','phone');end if;
 d:=app_private.phone_login_digits(p_phone);e:=d||'@staff.bron.local';
 if coalesce(native_phone,'')<>'' and app_private.phone_digits(native_phone) is distinct from d then
  perform app_private.fail('validation','Телефон связан с другим способом входа; обычное изменение недоступно','phone');end if;
 perform app_private.check_phone_login_available(p_user,d);
 changed:=old_email is distinct from e;
 if not changed and old_phone=d and not exists(select 1 from public.staff_member where user_id=p_user and phone<>d) then
  return jsonb_build_object('phone',d,'login',d,'changed',false);
 end if;
 if changed then
  update auth.users set email=e,email_confirmed_at=coalesce(email_confirmed_at,now()),
   confirmation_token='',recovery_token='',email_change='',email_change_token_new='',
   email_change_token_current='',email_change_confirm_status=0,updated_at=now() where id=p_user;
  update auth.identities set identity_data=jsonb_set(jsonb_set(identity_data,'{email}',to_jsonb(e)),
   '{email_verified}','true'::jsonb),updated_at=now() where user_id=p_user and provider='email';
  delete from auth.sessions where user_id=p_user;
 end if;
 update public.app_user set phone=d,email=e,updated_at=now() where id=p_user;
 perform app_private.staff_phone_sync(p_user,d);
 -- No password, tokens or full phone in the access audit.
 for scope in
  select distinct scope_id from public.role_assignment
   where user_id=p_user and scope_type='partner' and revoked_at is null
  union select partner_id from public.staff_member where user_id=p_user
   and not exists(select 1 from public.role_assignment where user_id=p_user and scope_type='partner' and revoked_at is null)
  union select null::uuid where not exists(select 1 from public.staff_member where user_id=p_user)
   and not exists(select 1 from public.role_assignment where user_id=p_user and scope_type='partner' and revoked_at is null)
 loop
  perform app_private.audit('user.login','app_user',p_user,scope,
   jsonb_build_object('login_type','phone','changed',changed,'phone_last4',right(d,4)));
 end loop;
 return jsonb_build_object('phone',d,'login',d,'changed',changed);
exception when unique_violation then
 perform app_private.fail('validation','Этот номер телефона уже используется для входа','phone');
end $$;

create or replace function public.staff_access_history(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('team.manage',p_partner);
 return coalesce((select jsonb_agg(x order by x->>'at' desc) from (
 select jsonb_build_object('id',a.id,'at',a.at,'action',a.action,'actor_name',u.full_name,'user_name',target.full_name) x
 from audit_event a left join app_user u on u.id=a.actor_id left join app_user target on target.id=a.entity_id
 where a.partner_id=p_partner and a.action in ('team.create','staff.create','staff.active','staff.update','staff.access',
  'staff.restore','staff.remove','team.active','team.restore','team.remove','user.password','user.login')
 order by a.at desc,a.id desc limit 50) q),'[]');
end $$;

create or replace function public.partner_access(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('org.manage');
 return jsonb_build_object(
 'users',coalesce((select jsonb_agg(jsonb_build_object('assignment_id',a.id,'user_id',u.id,
  'full_name',u.full_name,'email',u.email,'phone',u.phone,'since',a.created_at) order by u.full_name)
  from public.role_assignment a join public.app_user u on u.id=a.user_id
  where a.scope_id=p_partner and a.revoked_at is null),'[]'::jsonb),
 'invites',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'created_at',i.created_at) order by i.created_at)
  from public.pending_assignment i where i.partner_id=p_partner),'[]'::jsonb));
end $$;

insert into app_private.client_command(fn) values
 ('public.account_create_phone(uuid,text,text,text)'),('public.staff_account_create_phone(uuid,text,text,text,uuid[],boolean)'),
 ('public.user_set_phone_login(uuid,text)'),
 ('public.staff_profile_save_phone(uuid,uuid,text,text,text,uuid[],integer,bigint,boolean,jsonb)');
select app_private.apply_grants();
