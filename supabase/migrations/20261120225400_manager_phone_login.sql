-- Managers can change only their own password-based login, after signing in
-- with the current password again. The password goes to Auth, never this RPC.
create function public.manager_set_my_phone_login(p_phone text, p_previous_session uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  proof text := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id');
  digits text;
  new_email text;
  old_email text;
  profile_email text;
  profile_phone text;
  native_phone text;
begin
  if not exists(select 1 from app_private.active_assignments()
    where role = 'franchise_manager' and scope_type = 'company') then
    perform app_private.fail('forbidden', 'Логин может изменить только менеджер своей учётной записи');
  end if;

  -- Serialize writes to this account before checking the two live sessions.
  select email, phone into profile_email, profile_phone from public.app_user where id = actor for update;
  select email, phone into old_email, native_phone from auth.users where id = actor for update;
  if not found then perform app_private.fail('not-found', 'Учётная запись не найдена'); end if;
  if not exists (
    select 1 from auth.sessions fresh
      join auth.sessions previous on previous.id = p_previous_session and previous.user_id = actor
      join auth.mfa_amr_claims amr on amr.session_id = fresh.id and amr.authentication_method = 'password'
    where fresh.id::text = proof and fresh.user_id = actor and fresh.id <> previous.id
      and fresh.created_at >= previous.created_at
      and fresh.created_at between now() - interval '2 minutes' and now()
  ) then
    perform app_private.fail('validation', 'Подтвердите действие текущим паролем ещё раз');
  end if;

  -- The current client only confirms a password. A verified second factor
  -- must never be bypassed by this AAL1 login.
  if exists(select 1 from auth.mfa_factors where user_id = actor and status = 'verified') then
    perform app_private.fail('forbidden', 'У этой учётной записи включена двухфакторная проверка. Обратитесь к администратору системы для смены логина.');
  end if;

  if old_email is null or (select count(*) from auth.identities where user_id = actor) <> 1
    or not exists(select 1 from auth.identities where user_id = actor and provider = 'email') then
    perform app_private.fail('validation', 'Телефон нельзя изменить для этого способа входа', 'phone');
  end if;
  digits := app_private.phone_login_digits(p_phone);
  new_email := digits || '@staff.bron.local';
  if coalesce(native_phone, '') <> '' and app_private.phone_digits(native_phone) is distinct from digits then
    perform app_private.fail('validation', 'Телефон связан с другим способом входа', 'phone');
  end if;
  perform app_private.check_phone_login_available(actor, digits);

  if old_email = new_email and profile_email = new_email and profile_phone = digits then
    return false;
  end if;

  update auth.users set email = new_email, email_confirmed_at = coalesce(email_confirmed_at, now()),
    confirmation_token = '', recovery_token = '', email_change = '', email_change_token_new = '',
    email_change_token_current = '', email_change_confirm_status = 0, updated_at = now()
  where id = actor;
  update auth.identities set identity_data = jsonb_set(jsonb_set(identity_data, '{email}', to_jsonb(new_email)),
    '{email_verified}', 'true'::jsonb), updated_at = now()
  where user_id = actor and provider = 'email';
  update public.app_user set phone = digits, email = new_email, updated_at = now() where id = actor;
  delete from auth.one_time_tokens where user_id = actor;
  delete from auth.sessions where user_id = actor and id <> p_previous_session;
  perform app_private.audit('user.login', 'app_user', actor, null,
    jsonb_build_object('login_type', 'phone', 'changed', true, 'phone_last4', right(digits, 4)));
  return true;
exception when unique_violation then
  perform app_private.fail('validation', 'Этот номер телефона уже используется для входа', 'phone');
end $$;

revoke all on function public.manager_set_my_phone_login(text, uuid) from public, anon;
grant execute on function public.manager_set_my_phone_login(text, uuid) to authenticated;
insert into app_private.client_command(fn) values ('public.manager_set_my_phone_login(text,uuid)');
