-- 0005 Сотрудники франчайзи и смены.
-- Франчайзи сам, без компании, добавляет и удаляет сотрудников, задаёт им пароль и оплату (ставка за смену + % от выручки смены).
-- Сотрудник входит по номеру телефона, открывает смену, при закрытии вносит выручку и сразу видит, сколько заработал.
-- Выручка точки за день = сумма записей: сотрудников (по сменам) и самого франчайзи.
-- Учётные записи создаются прямо в auth.users (как это делает Supabase): пароль хранится только в виде bcrypt-хеша.

insert into public.permission(code, description) values
  ('shift.work', 'Смены: открыть, закрыть, внести выручку смены, видеть свой заработок'),
  ('staff.manage', 'Сотрудники: добавить, удалить, пароль, оплата'),
  ('rating.read', 'Рейтинг франчайзи');

insert into public.role(code, name, scope_type, description) values
  ('franchisee_staff', 'Сотрудник', 'partner', 'Смены на своих точках, свой заработок, база знаний');

insert into public.role_permission(role, permission) values
  ('franchise_manager', 'staff.manage'), ('franchise_manager', 'rating.read'),
  ('franchisee', 'staff.manage'), ('franchisee', 'rating.read'),
  ('franchisee_staff', 'kb.read'), ('franchisee_staff', 'shift.work');

------------------------------------------------------------------------------
-- Учётные записи без панели Supabase
------------------------------------------------------------------------------
-- Логин сотрудника — номер телефона; внутри Supabase это служебный email на несуществующем домене.
create function app_private.phone_digits(p_phone text) returns text
language sql immutable as $$
  select case
    when d ~ '^8\d{10}$' then '7' || substr(d, 2)
    when d ~ '^9\d{9}$' then '7' || d
    else d end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') d) x
$$;

create function app_private.staff_email(p_phone text) returns text
language sql immutable as $$ select app_private.phone_digits(p_phone) || '@staff.bron.local' $$;

create function app_private.check_password(p_password text) returns void
language plpgsql immutable as $$
begin
  if p_password is null or length(p_password) < 6 then perform app_private.fail('validation', 'Пароль — минимум 6 символов', 'password'); end if;
  if length(p_password) > 72 then perform app_private.fail('validation', 'Слишком длинный пароль', 'password'); end if;
end $$;

create function app_private.create_login(p_email text, p_password text, p_full_name text) returns uuid
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
declare v uuid := gen_random_uuid(); v_email text := lower(trim(p_email));
begin
  perform app_private.check_password(p_password);
  if exists (select 1 from auth.users where lower(email) = v_email) then
    perform app_private.fail('validation', 'Этот логин уже занят', 'login');
  end if;
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token,
    email_change_token_new, email_change, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(), '', '', '', '',
    '{"provider": "email", "providers": ["email"]}'::jsonb, jsonb_build_object('full_name', trim(p_full_name)), now(), now());
  insert into auth.identities(provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  values (v::text, v, jsonb_build_object('sub', v::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
  return v;
end $$;

------------------------------------------------------------------------------
-- Сотрудники
------------------------------------------------------------------------------
create table public.staff_member (
  user_id uuid primary key references public.app_user(id),
  partner_id uuid not null references public.partner(id),
  phone text not null,
  location_ids uuid[] not null default '{}',
  rate_bp int not null default 0 check (rate_bp between 0 and 10000),
  shift_fee_minor bigint not null default 0 check (shift_fee_minor >= 0),
  active boolean not null default true,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.staff_member (partner_id);

-- Кем может управлять текущий пользователь: менеджер — франчайзи и сотрудниками; франчайзи — своими сотрудниками.
create function app_private.can_manage_user(p_user uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select p_user is distinct from auth.uid() and (
    (app_private.has_perm('org.manage') and not exists (
       select 1 from public.role_assignment a where a.user_id = p_user and a.scope_type = 'company' and a.revoked_at is null))
    or exists (select 1 from public.staff_member s where s.user_id = p_user and app_private.has_perm('staff.manage', s.partner_id)))
$$;


create function app_private.check_staff_locations(p_partner uuid, p_locations uuid[]) returns void
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  if coalesce(array_length(p_locations, 1), 0) = 0 then perform app_private.fail('validation', 'Выберите хотя бы одну точку', 'locations'); end if;
  if exists (select 1 from unnest(p_locations) x where not exists (select 1 from public.location l where l.id = x and l.partner_id = p_partner)) then
    perform app_private.fail('validation', 'Точка не принадлежит франчайзи', 'locations');
  end if;
end $$;

create function app_private.check_pay(p_rate_bp int, p_fee bigint) returns void
language plpgsql immutable as $$
begin
  if p_rate_bp is null or p_rate_bp < 0 or p_rate_bp > 10000 then perform app_private.fail('validation', 'Процент от выручки — от 0 до 100', 'rate'); end if;
  if p_fee is null or p_fee < 0 then perform app_private.fail('validation', 'Ставка за смену не может быть отрицательной', 'fee'); end if;
end $$;

create function public.staff_create(p_partner uuid, p_full_name text, p_phone text, p_password text, p_locations uuid[],
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
    v_user := v_old.user_id;
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

create function public.staff_update(p_user uuid, p_full_name text, p_locations uuid[], p_rate_bp int, p_shift_fee bigint) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare s public.staff_member;
begin
  perform app_private.require_user();
  select * into s from public.staff_member where user_id = p_user;
  if not found or not app_private.has_perm('staff.manage', s.partner_id) then perform app_private.fail('not-found', 'Сотрудник не найден'); end if;
  if coalesce(trim(p_full_name), '') = '' then perform app_private.fail('validation', 'Укажите имя сотрудника', 'full_name'); end if;
  perform app_private.check_staff_locations(s.partner_id, p_locations);
  perform app_private.check_pay(p_rate_bp, p_shift_fee);
  update public.staff_member set location_ids = p_locations, rate_bp = p_rate_bp, shift_fee_minor = p_shift_fee, updated_at = now() where user_id = p_user;
  update public.app_user set full_name = trim(p_full_name), updated_at = now() where id = p_user;
  perform app_private.audit('staff.update', 'staff_member', p_user, s.partner_id, jsonb_build_object('rate_bp', p_rate_bp, 'fee', p_shift_fee, 'locations', p_locations));
end $$;

-- Удалить (и вернуть) сотрудника: вход блокируется сразу, история смен и выручки сохраняется.
create function public.staff_set_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); s public.staff_member;
begin
  select * into s from public.staff_member where user_id = p_user;
  if not found or not app_private.has_perm('staff.manage', s.partner_id) then perform app_private.fail('not-found', 'Сотрудник не найден'); end if;
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
    delete from public.work_shift where employee_id = p_user and status = 'open';
  end if;
  update public.staff_member set active = p_active, updated_at = now() where user_id = p_user;
  perform app_private.audit(case when p_active then 'staff.restore' else 'staff.remove' end, 'staff_member', p_user, s.partner_id);
end $$;

-- Новый пароль: франчайзи — своему сотруднику, менеджер — франчайзи и сотрудникам. Свой пароль меняют в профиле.
create function public.user_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.can_manage_user(p_user) then perform app_private.fail('forbidden', 'Нельзя менять пароль этому пользователю'); end if;
  perform app_private.check_password(p_password);
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_user;
  perform app_private.audit('user.password', 'app_user', p_user, (select partner_id from public.staff_member where user_id = p_user));
end $$;

-- Менеджер сразу создаёт учётную запись франчайзи (email + пароль) — без приглашения через Supabase.
create function public.account_create(p_partner uuid, p_full_name text, p_email text, p_password text) returns uuid
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
declare v_actor uuid := app_private.require_user(); v_user uuid;
begin
  perform app_private.require_perm('org.manage');
  if not exists (select 1 from public.partner where id = p_partner) then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  if coalesce(trim(p_full_name), '') = '' then perform app_private.fail('validation', 'Укажите имя', 'full_name'); end if;
  if lower(trim(p_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform app_private.fail('validation', 'Неверный email', 'email'); end if;
  if exists (select 1 from auth.users where lower(email) = lower(trim(p_email))) then
    perform app_private.fail('validation', 'Учётная запись с этим email уже есть — выдайте доступ кнопкой «Выдать»', 'email');
  end if;
  v_user := app_private.create_login(p_email, p_password, p_full_name);
  delete from public.pending_assignment where lower(email) = lower(trim(p_email));
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by) values (v_user, 'franchisee', 'partner', p_partner, v_actor);
  perform app_private.audit('account.create', 'app_user', v_user, p_partner, jsonb_build_object('email', lower(trim(p_email))));
  return v_user;
end $$;

------------------------------------------------------------------------------
-- Смены
------------------------------------------------------------------------------
create table public.work_shift (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner(id),
  location_id uuid not null references public.location(id),
  employee_id uuid not null references public.app_user(id),
  day date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  cash_minor bigint not null default 0 check (cash_minor >= 0),
  card_minor bigint not null default 0 check (card_minor >= 0),
  total_minor bigint generated always as (cash_minor + card_minor) stored,
  comment text,
  -- Оплата фиксируется при закрытии: изменение ставки не переписывает прошлые смены
  rate_bp int,
  shift_fee_minor bigint,
  earned_minor bigint,
  unique (employee_id, location_id, day)
);
create unique index work_shift_one_open on public.work_shift (employee_id) where status = 'open';
create index on public.work_shift (partner_id, day);

-- Выручка дня — теперь по строкам: сотрудники (по своим сменам) и сам франчайзи (employee_id = null)
alter table public.daily_revenue add column employee_id uuid references public.app_user(id);
alter table public.daily_revenue drop constraint daily_revenue_location_id_day_key;
alter table public.daily_revenue add constraint daily_revenue_location_day_employee_key unique nulls not distinct (location_id, day, employee_id);

create function app_private.shift_pay(p_total bigint, p_rate_bp int, p_fee bigint) returns bigint
language sql immutable as $$ select coalesce(p_fee, 0) + round(coalesce(p_total, 0) * coalesce(p_rate_bp, 0) / 10000.0)::bigint $$;

-- Записать смену и её строку выручки дня (одно действие — обе таблицы согласованы).
create function app_private.shift_store(p_location public.location, p_employee uuid, p_day date, p_cash bigint, p_card bigint, p_comment text)
returns public.work_shift
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare s public.staff_member; w public.work_shift;
begin
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

create function app_private.my_staff() returns public.staff_member
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare s public.staff_member;
begin
  select * into s from public.staff_member where user_id = auth.uid() and active;
  if not found or not app_private.has_perm('shift.work', s.partner_id) then perform app_private.fail('forbidden', 'Смены открывают сотрудники франчайзи'); end if;
  return s;
end $$;

create function public.shift_open(p_location uuid) returns public.work_shift
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; l public.location; w public.work_shift; v_day date;
begin
  s := app_private.my_staff();
  select * into l from public.location where id = p_location;
  if not found or not (p_location = any(s.location_ids)) then perform app_private.fail('not-found', 'Эта точка вам не назначена'); end if;
  if l.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
  select * into w from public.work_shift where employee_id = v_user and status = 'open';
  if found then
    if w.location_id = p_location then return w; end if;
    perform app_private.fail('validation', 'Сначала закройте смену на другой точке');
  end if;
  v_day := app_private.local_today(p_location);
  if exists (select 1 from public.work_shift where employee_id = v_user and location_id = p_location and day = v_day) then
    perform app_private.fail('validation', 'Смена за сегодня уже закрыта. Исправить сумму можно в списке смен ниже');
  end if;
  insert into public.work_shift(partner_id, location_id, employee_id, day) values (l.partner_id, l.id, v_user, v_day) returning * into w;
  perform app_private.audit('shift.open', 'work_shift', w.id, l.partner_id);
  return w;
end $$;

-- Закрыть смену (или исправить сегодняшнюю закрытую): выручка смены → строка дня, заработок по ставке сотрудника.
create function public.shift_close(p_shift uuid, p_cash bigint, p_card bigint, p_comment text default null) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); w public.work_shift; l public.location; v_month date;
begin
  perform app_private.my_staff();
  select * into w from public.work_shift where id = p_shift and employee_id = v_user for update;
  if not found then perform app_private.fail('not-found', 'Смена не найдена'); end if;
  if w.status = 'closed' and w.day < app_private.local_today(w.location_id) then
    perform app_private.fail('period-locked', 'Прошлые смены исправляет франчайзи');
  end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_card, 0) < 0 then perform app_private.fail('validation', 'Сумма не может быть отрицательной', 'cash'); end if;
  if coalesce(p_cash, 0) + coalesce(p_card, 0) > 100000000000 then perform app_private.fail('validation', 'Слишком большая сумма', 'cash'); end if;
  select * into l from public.location where id = w.location_id;
  w := app_private.shift_store(l, v_user, w.day, coalesce(p_cash, 0), coalesce(p_card, 0), p_comment);
  perform app_private.audit('shift.close', 'work_shift', w.id, l.partner_id, jsonb_build_object('cash', w.cash_minor, 'card', w.card_minor, 'earned', w.earned_minor));
  v_month := date_trunc('month', w.day)::date;
  return jsonb_build_object('shift', to_jsonb(w), 'currency', l.currency,
    'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_shifts', (select count(*) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'));
end $$;

create function public.shift_cancel(p_shift uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user();
begin
  delete from public.work_shift where id = p_shift and employee_id = v_user and status = 'open';
  if not found then perform app_private.fail('not-found', 'Открытая смена не найдена'); end if;
end $$;

-- Экран сотрудника: открытая смена, его точки с планом, заработок за месяц, последние смены.
create function public.staff_home(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; v_month date;
begin
  s := app_private.my_staff();
  v_month := date_trunc('month', coalesce(p_month, (select app_private.local_today(s.location_ids[1]))))::date;
  return jsonb_build_object(
    'month', v_month,
    'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor,
    'partner_name', (select name from public.partner where id = s.partner_id),
    'open_shift', (select to_jsonb(w) || jsonb_build_object('location_name', l.name, 'currency', l.currency)
                   from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = v_user and w.status = 'open'),
    'locations', coalesce((select jsonb_agg(app_private.location_month(l, v_month) || jsonb_build_object('today', app_private.local_today(l.id),
        'my_today', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id)))
        order by l.name)
      from public.location l where l.id = any(s.location_ids) and l.status = 'active'), '[]'::jsonb),
    'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_shifts', (select count(*) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'currency', (select currency from public.partner where id = s.partner_id),
    'shifts', coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object('location_name', l.name) order by w.day desc, w.opened_at desc)
      from public.work_shift w join public.location l on l.id = w.location_id
      where w.employee_id = v_user and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb));
end $$;

-- Франчайзи: сотрудники с заработком за месяц (ведомость), открытые смены.
create function public.staff_list(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  perform app_private.require_user();
  perform app_private.require_perm('staff.manage', p_partner);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', s.phone, 'active', s.active,
      'location_ids', to_jsonb(s.location_ids),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name), '[]'::jsonb) from public.location l where l.id = any(s.location_ids)),
      'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor,
      'open_shift', (select jsonb_build_object('id', w.id, 'location_name', l.name, 'opened_at', w.opened_at)
                     from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = s.user_id and w.status = 'open'),
      'month_shifts', (select count(*) from public.work_shift w where w.employee_id = s.user_id and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift w where w.employee_id = s.user_id and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift w where w.employee_id = s.user_id and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'shifts', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'day', w.day, 'location_name', l.name, 'total_minor', w.total_minor,
          'earned_minor', w.earned_minor, 'opened_at', w.opened_at, 'closed_at', w.closed_at) order by w.day desc)
        from public.work_shift w join public.location l on l.id = w.location_id
        where w.employee_id = s.user_id and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb)
    ) order by s.active desc, u.full_name)
    from public.staff_member s join public.app_user u on u.id = s.user_id where s.partner_id = p_partner), '[]'::jsonb);
end $$;

------------------------------------------------------------------------------
-- Выручка дня: запись франчайзи (без сотрудника) или исправление смены сотрудника
------------------------------------------------------------------------------
delete from app_private.client_command where fn in ('public.revenue_save(uuid, date, bigint, bigint, text)'::regprocedure, 'public.revenue_delete(uuid, date)'::regprocedure);
drop function public.revenue_save(uuid, date, bigint, bigint, text);
drop function public.revenue_delete(uuid, date);

create function public.revenue_save(p_location uuid, p_day date, p_cash bigint, p_card bigint, p_comment text default null, p_employee uuid default null)
returns public.daily_revenue
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; r public.daily_revenue;
begin
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

create function public.revenue_delete(p_location uuid, p_day date, p_employee uuid default null) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_id uuid;
begin
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

-- Сводка месяца по точке: дни с разбивкой по сотрудникам и сравнение с прошлым месяцем.
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
      and day >= v_prev and day < v_prev + v_elapsed),
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
          'comment', string_agg(r.comment, '; '), 'updated_at', max(r.updated_at),
          'entries', jsonb_agg(jsonb_build_object('employee_id', r.employee_id, 'employee_name', u.full_name, 'cash_minor', r.cash_minor,
            'card_minor', r.card_minor, 'total_minor', r.total_minor, 'comment', r.comment) order by u.full_name nulls first)) d
        from public.daily_revenue r left join public.app_user u on u.id = r.employee_id
        where r.location_id = l.id and r.day between v_month and (v_month + interval '1 month - 1 day')::date
        group by r.day) x), '[]'::jsonb));
end $$;

alter table public.staff_member enable row level security;
alter table public.work_shift enable row level security;
create policy read_scope on public.staff_member for select to authenticated
  using (user_id = auth.uid() or app_private.has_perm('staff.manage', partner_id));
create policy read_scope on public.work_shift for select to authenticated
  using (employee_id = auth.uid() or app_private.has_perm('revenue.read', partner_id));

insert into app_private.client_table(tbl) values ('public.staff_member'), ('public.work_shift');
insert into app_private.client_command(fn) values
  ('public.staff_create(uuid, text, text, text, uuid[], int, bigint)'), ('public.staff_update(uuid, text, uuid[], int, bigint)'),
  ('public.staff_set_active(uuid, boolean)'), ('public.user_set_password(uuid, text)'), ('public.account_create(uuid, text, text, text)'),
  ('public.shift_open(uuid)'), ('public.shift_close(uuid, bigint, bigint, text)'), ('public.shift_cancel(uuid)'),
  ('public.staff_home(date)'), ('public.staff_list(uuid, date)'),
  ('public.revenue_save(uuid, date, bigint, bigint, text, uuid)'), ('public.revenue_delete(uuid, date, uuid)');
select app_private.apply_grants();
