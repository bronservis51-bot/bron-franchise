-- Recovery destinations are provisioned by a trusted operator. They never
-- change the manager's Auth identity or login.
create table app_private.manager_recovery_account (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (
    email=btrim(email) and length(email)<=254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and lower(email) !~ '@[^@]*\.bron\.local$'
  ),
  enabled boolean not null default false,
  -- Reset opt-in is separate from enrolling and verifying the mailbox.
  reset_enabled boolean not null default false,
  verified_at timestamptz,
  last_confirm_requested_at timestamptz,
  last_reset_requested_at timestamptz
);
create unique index manager_recovery_email_unique on app_private.manager_recovery_account(lower(email));

-- One outstanding item per manager and purpose. A digest is bound only when
-- the worker takes an item; the raw token is generated and sent by that worker.
create table app_private.manager_recovery_job (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_private.manager_recovery_account(user_id) on delete cascade,
  kind text not null check (kind in ('confirm','reset')),
  state_hash bytea not null,
  token_hash bytea unique,
  prior_token_hashes bytea[] not null default '{}'::bytea[] check (cardinality(prior_token_hashes)<=3),
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  next_attempt_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 3),
  unique(user_id,kind)
);

alter table app_private.manager_recovery_account enable row level security;
alter table app_private.manager_recovery_job enable row level security;
revoke all on app_private.manager_recovery_account, app_private.manager_recovery_job from public, anon, authenticated;

-- Only the current active network manager and a native password login are
-- eligible. This flow intentionally does not support verified MFA.
create function app_private.manager_recovery_state(p_user uuid) returns bytea
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  select extensions.digest(jsonb_build_array(
    u.email, u.encrypted_password, a.email, a.verified_at,
    (select jsonb_agg(jsonb_build_array(r.id,r.xmin::text) order by r.id)
      from public.role_assignment r where r.user_id=a.user_id)
  )::text,'sha256')
  from app_private.manager_recovery_account a
  join public.app_user p on p.id=a.user_id and p.status='active'
  join auth.users u on u.id=a.user_id
  where a.user_id=p_user and a.enabled
    and u.email is not null and u.email<>'' and coalesce(u.encrypted_password,'')<>''
    and (u.banned_until is null or u.banned_until<now())
    and not exists (select 1 from auth.mfa_factors f where f.user_id=u.id and f.status='verified')
    and exists (select 1 from public.role_assignment r where r.user_id=u.id
      and r.role='franchise_manager' and r.scope_type='company' and r.revoked_at is null)
$$;

create function app_private.manager_recovery_account_changed() returns trigger
language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  if old.email is distinct from new.email then new.verified_at:=null; end if;
  if old.email is distinct from new.email or old.enabled is distinct from new.enabled then
    delete from app_private.manager_recovery_job where user_id=old.user_id;
  elsif old.reset_enabled is distinct from new.reset_enabled then
    delete from app_private.manager_recovery_job where user_id=old.user_id and kind='reset';
  end if;
  return new;
end $$;

create trigger manager_recovery_account_changed
  before update of email,enabled,reset_enabled on app_private.manager_recovery_account
  for each row execute function app_private.manager_recovery_account_changed();

-- Changes to the Auth login/password invalidate pending work even if the login
-- is later restored. Ordinary sign-in metadata updates do not affect it.
create function app_private.manager_recovery_auth_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  delete from app_private.manager_recovery_job where user_id=new.id;
  return null;
end $$;

create trigger manager_recovery_auth_changed
  after update of email,phone,encrypted_password,banned_until on auth.users
  for each row when ((old.email,old.phone,old.encrypted_password,old.banned_until)
    is distinct from (new.email,new.phone,new.encrypted_password,new.banned_until))
  execute function app_private.manager_recovery_auth_changed();

create function app_private.manager_recovery_target(p_login text) returns uuid
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  select case when count(*)=1 then (array_agg(a.user_id))[1] end
  from app_private.manager_recovery_account a join auth.users u on u.id=a.user_id
  where a.enabled and a.reset_enabled and a.verified_at is not null and (lower(u.email)=p_login or lower(a.email)=p_login)
    and app_private.manager_recovery_state(a.user_id) is not null
$$;

create function app_private.manager_recovery_queue(p_user uuid,p_kind text,p_login text default null) returns boolean
language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  recovery app_private.manager_recovery_account;
  current_state bytea;
  queued_at timestamptz;
begin
  select * into recovery from app_private.manager_recovery_account where user_id=p_user for update;
  if not found then return false; end if;
  queued_at:=clock_timestamp();
  current_state:=app_private.manager_recovery_state(p_user);
  if current_state is null then return false; end if;
  if exists(select 1 from app_private.manager_recovery_job j where j.user_id=p_user and j.kind=p_kind
    and j.expires_at>queued_at and j.state_hash=current_state
    and (j.token_hash is not null or cardinality(j.prior_token_hashes)>0 or j.attempts<3)) then
    return false;
  end if;

  if p_kind='confirm' then
    if recovery.verified_at is not null or recovery.last_confirm_requested_at>queued_at-interval '5 minutes' then return false; end if;
    update app_private.manager_recovery_account set last_confirm_requested_at=queued_at where user_id=p_user;
  else
    if not recovery.reset_enabled or recovery.verified_at is null or recovery.last_reset_requested_at>queued_at-interval '5 minutes'
      or app_private.manager_recovery_target(p_login) is distinct from p_user then return false; end if;
    update app_private.manager_recovery_account set last_reset_requested_at=queued_at where user_id=p_user;
  end if;

  delete from app_private.manager_recovery_job where user_id=p_user and kind=p_kind;
  insert into app_private.manager_recovery_job(user_id,kind,state_hash,requested_at,expires_at)
    values(p_user,p_kind,current_state,queued_at,queued_at+interval '15 minutes');
  return true;
end $$;

create function public.manager_recovery_status() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  current_state bytea := app_private.manager_recovery_state(actor);
begin
  if current_state is null then return null; end if;
  return (select jsonb_build_object('email',a.email,'verified',a.verified_at is not null,'reset_enabled',a.reset_enabled,'pending',exists(
    select 1 from app_private.manager_recovery_job j
      where j.user_id=actor and j.kind='confirm' and j.expires_at>now() and j.state_hash=current_state
        and (j.token_hash is not null or cardinality(j.prior_token_hashes)>0 or j.attempts<3)
  )) from app_private.manager_recovery_account a where a.user_id=actor);
end $$;

create function public.manager_recovery_enroll(p_previous_session uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  proof text := nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id';
begin
  if not exists (
    select 1 from auth.sessions fresh
    join auth.sessions previous on previous.id=p_previous_session and previous.user_id=actor
    join auth.mfa_amr_claims amr on amr.session_id=fresh.id and amr.authentication_method='password'
    where fresh.id::text=proof and fresh.user_id=actor and fresh.id<>previous.id
      and fresh.created_at>=previous.created_at and fresh.created_at between now()-interval '2 minutes' and now()
  ) then return false; end if;
  return app_private.manager_recovery_queue(actor,'confirm');
end $$;

create function public.manager_recovery_available() returns boolean
language sql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
  select exists (select 1 from app_private.manager_recovery_account a where a.enabled and a.reset_enabled and a.verified_at is not null
    and app_private.manager_recovery_state(a.user_id) is not null)
$$;

create function public.manager_recovery_request(p_login text) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  login text := lower(btrim(p_login));
  target uuid;
begin
  if p_login is null or length(p_login)>254 or login !~ '^[^@[:space:]]+@[^@[:space:]]+$' then return; end if;
  target:=app_private.manager_recovery_target(login);
  if target is not null then perform app_private.manager_recovery_queue(target,'reset',login); end if;
end $$;

-- Consume only the specified purpose. Auth row, recovery settings, then job:
-- the same order as an Auth change that invalidates its jobs.
create function app_private.manager_recovery_consume(p_token text,p_kind text) returns uuid
language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  token_digest bytea;
  target uuid;
  recovery app_private.manager_recovery_account;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return null; end if;
  token_digest:=extensions.digest(p_token,'sha256');
  select j.user_id into target from app_private.manager_recovery_job j
    where j.kind=p_kind and (j.token_hash=token_digest or token_digest=any(j.prior_token_hashes));
  if not found then return null; end if;
  perform 1 from auth.users u where u.id=target for update;
  if not found then return null; end if;
  perform 1 from public.role_assignment a where a.user_id=target and a.role='franchise_manager'
    and a.scope_type='company' and a.revoked_at is null for share;
  if not found then return null; end if;
  select * into recovery from app_private.manager_recovery_account a where a.user_id=target for update;
  if not found or (p_kind='confirm' and recovery.verified_at is not null)
    or (p_kind='reset' and (not recovery.reset_enabled or recovery.verified_at is null)) then return null; end if;
  delete from app_private.manager_recovery_job j where j.user_id=target and j.kind=p_kind
    and (j.token_hash=token_digest or token_digest=any(j.prior_token_hashes))
    and j.expires_at>clock_timestamp() and j.state_hash=app_private.manager_recovery_state(target);
  if not found then return null; end if;
  return target;
end $$;

create function public.manager_recovery_confirm(p_token text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare target uuid := app_private.manager_recovery_consume(p_token,'confirm');
begin
  if target is null then return false; end if;
  update app_private.manager_recovery_account set verified_at=clock_timestamp() where user_id=target;
  perform app_private.audit('user.recovery_email_verified','app_user',target);
  return true;
end $$;

create function public.manager_recovery_reset(p_token text,p_password text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare target uuid;
begin
  if p_password is null or length(p_password)<12 or octet_length(p_password)>72 then return false; end if;
  target:=app_private.manager_recovery_consume(p_token,'reset');
  if target is null then return false; end if;

  update auth.users set encrypted_password=extensions.crypt(p_password,extensions.gen_salt('bf',12)),
    recovery_token='',email_change='',email_change_token_new='',email_change_token_current='',
    email_change_confirm_status=0,updated_at=now() where id=target;
  delete from auth.one_time_tokens where user_id=target
    and token_type in ('recovery_token','email_change_token_new','email_change_token_current');
  delete from auth.sessions where user_id=target;
  perform app_private.audit('user.password_recovery','app_user',target);
  return true;
end $$;

create function app_private.manager_recovery_job_take(p_token_hash text) returns table(id uuid,email text,kind text,login text)
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare job_id uuid; digest_value bytea;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then return; end if;
  digest_value:=decode(p_token_hash,'hex');
  perform pg_advisory_xact_lock(hashtextextended('manager-recovery-token:'||p_token_hash,0));
  if exists(select 1 from app_private.manager_recovery_job j
    where j.token_hash=digest_value or digest_value=any(j.prior_token_hashes)) then return; end if;
  select j.id into job_id from app_private.manager_recovery_job j
    where j.delivered_at is null and j.attempts<3 and j.expires_at>clock_timestamp()
      and j.next_attempt_at<=clock_timestamp() and j.state_hash=app_private.manager_recovery_state(j.user_id)
      and (j.kind='confirm' or exists(select 1 from app_private.manager_recovery_account a where a.user_id=j.user_id and a.reset_enabled))
    order by j.requested_at,j.id limit 1 for update of j skip locked;
  if not found then return; end if;

  return query update app_private.manager_recovery_job j
    set prior_token_hashes=case when j.token_hash is null then j.prior_token_hashes
        else array_append(j.prior_token_hashes,j.token_hash) end,
      token_hash=digest_value,attempts=j.attempts+1,next_attempt_at=clock_timestamp()+interval '45 seconds'
    from app_private.manager_recovery_account a join auth.users u on u.id=a.user_id
    where j.id=job_id and a.user_id=j.user_id
    returning j.id,a.email,j.kind,case when j.kind='reset' then u.email::text end;
exception when unique_violation then
  return;
end $$;

create function app_private.manager_recovery_job_finish(p_id uuid,p_token_hash text,p_delivered boolean) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_delivered is null then return; end if;
  -- A send can have succeeded before the SMTP client lost its connection.
  -- Keep that link valid until the job is consumed or expires.
  update app_private.manager_recovery_job j set
    delivered_at=case when p_delivered then clock_timestamp() end,
    prior_token_hashes=case when p_delivered then j.prior_token_hashes else array_append(j.prior_token_hashes,j.token_hash) end,
    token_hash=case when p_delivered then j.token_hash end,
    next_attempt_at=case when p_delivered then j.next_attempt_at else clock_timestamp()+interval '30 seconds' end
    where j.id=p_id and j.delivered_at is null and j.expires_at>clock_timestamp() and j.token_hash=decode(p_token_hash,'hex');
end $$;

do $mailer$
begin
  if not exists(select 1 from pg_roles where rolname='bron_recovery_mailer') then
    create role bron_recovery_mailer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit;
  end if;
  if exists(select 1 from pg_roles where rolname='bron_recovery_mailer'
    and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) then
    raise exception 'BRON_RECOVERY_MAILER_ROLE_IS_UNSAFE';
  end if;
end
$mailer$;

revoke all on app_private.manager_recovery_account, app_private.manager_recovery_job from bron_recovery_mailer;
grant usage on schema app_private to bron_recovery_mailer;
revoke execute on function app_private.manager_recovery_state(uuid),
  app_private.manager_recovery_account_changed(), app_private.manager_recovery_auth_changed(),
  app_private.manager_recovery_target(text),
  app_private.manager_recovery_queue(uuid,text,text), app_private.manager_recovery_consume(text,text),
  app_private.manager_recovery_job_take(text), app_private.manager_recovery_job_finish(uuid,text,boolean)
  from public, anon, authenticated, bron_recovery_mailer;
grant execute on function app_private.manager_recovery_job_take(text),
  app_private.manager_recovery_job_finish(uuid,text,boolean) to bron_recovery_mailer;

revoke execute on function public.manager_recovery_status(), public.manager_recovery_enroll(uuid),
  public.manager_recovery_available(), public.manager_recovery_request(text), public.manager_recovery_confirm(text),
  public.manager_recovery_reset(text,text) from public, anon, authenticated;

grant execute on function public.manager_recovery_status(), public.manager_recovery_enroll(uuid) to authenticated;
grant execute on function public.manager_recovery_available(), public.manager_recovery_request(text),
  public.manager_recovery_confirm(text), public.manager_recovery_reset(text,text) to anon, authenticated;

insert into app_private.client_command(fn) values
 ('public.manager_recovery_status()'),('public.manager_recovery_enroll(uuid)'),
 ('public.manager_recovery_available()'),('public.manager_recovery_request(text)'),
 ('public.manager_recovery_confirm(text)'),('public.manager_recovery_reset(text,text)');
insert into app_private.anon_command(fn) values
 ('public.manager_recovery_available()'),('public.manager_recovery_request(text)'),
 ('public.manager_recovery_confirm(text)'),('public.manager_recovery_reset(text,text)');
