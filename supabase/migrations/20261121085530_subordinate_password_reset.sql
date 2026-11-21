-- CREATE OR REPLACE preserves the legacy RPC owner. On mixed-owner Timeweb
-- installs this can be the non-superuser postgres, while GoTrue owns its tables.
-- Existing Auth access still covers the password update and session revocation.
-- Grant only the additional privileges this command needs to clear tokens.
do $grants$
declare
  reset_owner name := (select pg_get_userbyid(proowner) from pg_proc
    where oid = 'public.user_set_password(uuid,text)'::regprocedure);
  token_columns constant text[] := array['recovery_token', 'email_change', 'email_change_token_new',
    'email_change_token_current', 'email_change_confirm_status'];
begin
  if reset_owner not in ('postgres', 'supabase_admin') then
    raise exception 'PASSWORD_RESET_UNEXPECTED_OWNER';
  end if;
  if exists (select 1 from unnest(token_columns) c
    where not has_column_privilege(reset_owner, 'auth.users', c, 'UPDATE')) then
    execute format('grant update (recovery_token, email_change, email_change_token_new,
      email_change_token_current, email_change_confirm_status) on auth.users to %I', reset_owner);
  end if;
  if not has_table_privilege(reset_owner, 'auth.one_time_tokens', 'DELETE')
    or not has_column_privilege(reset_owner, 'auth.one_time_tokens', 'user_id', 'SELECT')
    or not has_column_privilege(reset_owner, 'auth.one_time_tokens', 'token_type', 'SELECT') then
    execute format('grant delete, select (user_id, token_type) on auth.one_time_tokens to %I', reset_owner);
  end if;
  -- GRANT can warn and do nothing when the migration runner has no grant option.
  if exists (select 1 from unnest(token_columns) c
    where not has_column_privilege(reset_owner, 'auth.users', c, 'UPDATE'))
    or not has_table_privilege(reset_owner, 'auth.one_time_tokens', 'DELETE')
    or not has_column_privilege(reset_owner, 'auth.one_time_tokens', 'user_id', 'SELECT')
    or not has_column_privilege(reset_owner, 'auth.one_time_tokens', 'token_type', 'SELECT') then
    raise exception 'PASSWORD_RESET_AUTH_PRIVILEGES_MISSING';
  end if;
end
$grants$;

create or replace function public.user_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.can_manage_user(p_user) or exists (select 1 from public.role_assignment
    where user_id = p_user and scope_type = 'company') then
    perform app_private.fail('forbidden', 'Нельзя менять пароль этому пользователю');
  end if;
  -- Network scope is never sufficient to reset a bare Auth user.
  if not exists (select 1 from public.role_assignment where user_id = p_user and scope_type = 'partner')
    and not exists (select 1 from public.staff_member where user_id = p_user) then
    perform app_private.fail('not-found', 'Учётная запись не найдена');
  end if;

  perform app_private.check_password(p_password);
  update auth.users
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
    recovery_token = '', email_change = '', email_change_token_new = '', email_change_token_current = '',
    email_change_confirm_status = 0, updated_at = now()
  where id = p_user;
  if not found then
    perform app_private.fail('not-found', 'Учётная запись не найдена');
  end if;

  delete from auth.one_time_tokens where user_id = p_user
    and token_type in ('recovery_token', 'email_change_token_new', 'email_change_token_current');
  delete from auth.sessions where user_id = p_user;
  perform app_private.audit('user.password', 'app_user', p_user,
    (select partner_id from public.staff_member where user_id = p_user));
end $$;
