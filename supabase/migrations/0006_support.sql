-- 0006 Support: обращения, маршрутизация, SLA по рабочему календарю, решения (SUP-02…04, SUP-08).

create table public.support_routing (
  category text primary key,
  title text not null,
  queue_role text not null references public.role(code),
  backup_role text references public.role(code),
  calendar_id uuid references public.business_calendar(id),
  required_fields text[] not null default '{}',
  kb_section_hint text
);

create table public.sla_policy (
  id uuid primary key default gen_random_uuid(),
  queue_role text references public.role(code), -- null = по умолчанию
  urgency text not null check (urgency in ('normal', 'high', 'stopped')),
  first_response_minutes int not null check (first_response_minutes > 0),
  resolve_minutes int not null check (resolve_minutes > 0),
  is_test boolean not null default false,
  unique (queue_role, urgency)
);

create table public.ticket (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  partner_id uuid references public.partner(id),
  location_id uuid not null references public.location(id),
  category text not null references public.support_routing(category),
  queue_role text not null references public.role(code),
  backup_role text references public.role(code),
  calendar_id uuid references public.business_calendar(id),
  urgency text not null default 'normal' check (urgency in ('normal', 'high', 'stopped')),
  urgency_reason text,
  subject text not null,
  description text not null,
  equipment_model text,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'new'
    check (status in ('new', 'assigned', 'in_progress', 'waiting_partner', 'waiting_vendor', 'resolved', 'closed')),
  assignee_id uuid references public.app_user(id),
  created_by uuid not null references public.app_user(id),
  client_key text,
  first_response_due timestamptz,
  resolve_due timestamptz,
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  sla_paused_at timestamptz,
  sla_paused_minutes int not null default 0,
  resolution_reason text,
  kb_article_id uuid,
  reopen_until timestamptz,
  reopen_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1,
  unique (created_by, client_key)
);
create index on public.ticket (location_id, status);
create index on public.ticket (queue_role, status);

create table public.ticket_message (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.ticket(id),
  author_id uuid not null references public.app_user(id),
  body text not null,
  internal boolean not null default false,
  lang text,
  created_at timestamptz not null default now()
);
create index on public.ticket_message (ticket_id, created_at);

create table public.ticket_event (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.ticket(id),
  actor_id uuid,
  action text not null,
  from_status text,
  to_status text,
  comment text,
  at timestamptz not null default now()
);

-- Заранее подготовленные переводы для демонстрации (COST-10): не машинный перевод.
create table public.demo_translation (
  source text not null,
  target_lang text not null,
  translated text not null,
  primary key (source, target_lang)
);

------------------------------------------------------------------------------
-- Рабочее время (CORE-05)
------------------------------------------------------------------------------
create function app_private.add_business_minutes(p_start timestamptz, p_minutes int, p_calendar uuid) returns timestamptz
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.business_calendar; v_cursor timestamptz := p_start; v_left numeric := p_minutes; v_day date;
  v_day_start timestamptz; v_day_end timestamptz; v_avail numeric; i int := 0;
begin
  select * into c from public.business_calendar where id = p_calendar;
  if not found then return p_start + make_interval(mins => p_minutes); end if; -- без календаря — астрономическое время
  loop
    i := i + 1;
    exit when i > 800;
    v_day := (v_cursor at time zone c.timezone)::date;
    if extract(isodow from v_day)::int = any(c.workdays) and not exists (select 1 from public.holiday h where h.calendar_id = c.id and h.day = v_day) then
      v_day_start := (v_day + c.work_start) at time zone c.timezone;
      v_day_end := (v_day + c.work_end) at time zone c.timezone;
      if v_cursor < v_day_start then v_cursor := v_day_start; end if;
      if v_cursor < v_day_end then
        v_avail := extract(epoch from (v_day_end - v_cursor)) / 60;
        if v_avail >= v_left then return v_cursor + make_interval(secs => v_left * 60); end if;
        v_left := v_left - v_avail;
      end if;
    end if;
    v_cursor := ((v_day + 1) + c.work_start) at time zone c.timezone;
  end loop;
  return v_cursor;
end $$;

------------------------------------------------------------------------------
-- Чтение и загрузка
------------------------------------------------------------------------------
create function app_private.can_read_ticket(t public.ticket) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select t.created_by = auth.uid() or app_private.has_perm('ticket.read', t.partner_id, t.location_id)
$$;

create function app_private.ticket_load(p_ticket uuid, p_expected_revision int default null) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.ticket;
begin
  select * into t from public.ticket where id = p_ticket for update;
  if not found or not app_private.can_read_ticket(t) then perform app_private.fail('not-found', 'Обращение не найдено'); end if;
  if p_expected_revision is not null and t.revision <> p_expected_revision then
    perform app_private.fail('version-conflict', 'Обращение уже изменили. Обновите карточку', t.revision::text);
  end if;
  return t;
end $$;

create function app_private.ticket_is_worker(t public.ticket) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.has_perm('ticket.manage', t.partner_id, t.location_id)
    or (app_private.has_perm('ticket.work', t.partner_id, t.location_id)
        and (t.assignee_id = auth.uid()
             or app_private.user_in_queue(auth.uid(), t.queue_role, t.partner_id, t.location_id)
             or (t.backup_role is not null and app_private.user_in_queue(auth.uid(), t.backup_role, t.partner_id, t.location_id))))
$$;

create function app_private.ticket_log(p_ticket uuid, p_action text, p_from text, p_to text, p_comment text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.ticket_event(ticket_id, actor_id, action, from_status, to_status, comment)
  values (p_ticket, auth.uid(), p_action, p_from, p_to, p_comment)
$$;

------------------------------------------------------------------------------
-- Команды
------------------------------------------------------------------------------
create function public.ticket_create(p_location uuid, p_category text, p_urgency text, p_urgency_reason text,
  p_subject text, p_description text, p_equipment_model text default null, p_details jsonb default '{}'::jsonb,
  p_client_key text default null) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; r public.support_routing; s public.sla_policy;
  t public.ticket; v_field text; v_members int;
begin
  if p_client_key is not null then
    select * into t from public.ticket where created_by = v_user and client_key = p_client_key;
    if found then return t; end if; -- повтор отправки офлайн-черновика (PWA-03)
  end if;
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm('ticket.create', l.partner_id, l.id);
  select * into r from public.support_routing where category = p_category;
  if not found then perform app_private.fail('validation', 'Неизвестная категория', 'category'); end if;
  if coalesce(p_urgency, 'normal') not in ('normal', 'high', 'stopped') then perform app_private.fail('validation', 'Неверная срочность', 'urgency'); end if;
  if p_urgency in ('high', 'stopped') and coalesce(trim(p_urgency_reason), '') = '' then
    perform app_private.fail('validation', 'Поясните срочность', 'urgency_reason');
  end if;
  if coalesce(trim(p_subject), '') = '' then perform app_private.fail('validation', 'Укажите тему', 'subject'); end if;
  if coalesce(trim(p_description), '') = '' then perform app_private.fail('validation', 'Опишите проблему', 'description'); end if;
  foreach v_field in array r.required_fields loop
    if v_field = 'equipment_model' and coalesce(trim(p_equipment_model), '') = '' then
      perform app_private.fail('validation', 'Укажите устройство или модель', 'equipment_model');
    elsif v_field <> 'equipment_model' and coalesce(trim(p_details ->> v_field), '') = '' then
      perform app_private.fail('validation', 'Заполните обязательное поле', v_field);
    end if;
  end loop;
  select * into s from public.sla_policy where queue_role = r.queue_role and urgency = coalesce(p_urgency, 'normal');
  if not found then select * into s from public.sla_policy where queue_role is null and urgency = coalesce(p_urgency, 'normal'); end if;

  insert into public.ticket(number, partner_id, location_id, category, queue_role, backup_role, calendar_id, urgency, urgency_reason,
    subject, description, equipment_model, details, created_by, client_key, first_response_due, resolve_due)
  values (app_private.next_number('ОБ'), l.partner_id, l.id, p_category, r.queue_role, r.backup_role, r.calendar_id,
    coalesce(p_urgency, 'normal'), p_urgency_reason, left(p_subject, 200), left(p_description, 8000), p_equipment_model,
    coalesce(p_details, '{}'::jsonb), v_user, p_client_key,
    app_private.add_business_minutes(now(), coalesce(s.first_response_minutes, 240), r.calendar_id),
    app_private.add_business_minutes(now(), coalesce(s.resolve_minutes, 1440), r.calendar_id))
  returning * into t;
  perform app_private.ticket_log(t.id, 'created', null, 'new', null);

  select count(*) into v_members from app_private.queue_members(r.queue_role, l.partner_id, l.id);
  if v_members > 0 then
    perform app_private.notify_queue(r.queue_role, l.partner_id, l.id, 'ticket.new', 'Новое обращение: ' || t.subject,
      t.number || ' · ' || l.name, 'ticket', t.id, '/support/' || t.id, 'ticket.new:' || t.id, t.urgency = 'stopped');
  elsif r.backup_role is not null then
    -- в очереди никого нет — срабатывает резерв (SUP-03)
    perform app_private.notify_queue(r.backup_role, l.partner_id, l.id, 'ticket.new', 'Обращение без исполнителя: ' || t.subject,
      t.number || ' · ' || l.name, 'ticket', t.id, '/support/' || t.id, 'ticket.new.backup:' || t.id, true);
    perform app_private.ticket_log(t.id, 'routed_to_backup', 'new', 'new', 'В очереди ' || r.queue_role || ' нет доступных исполнителей');
  end if;
  if t.urgency = 'stopped' then
    perform app_private.notify_queue('direction_head', l.partner_id, l.id, 'ticket.stopped', 'Точка не работает: ' || l.name,
      t.subject, 'ticket', t.id, '/support/' || t.id, 'ticket.stopped:' || t.id, true);
  end if;
  return t;
end $$;

create function public.ticket_take(p_ticket uuid) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.ticket; v_from text;
begin
  t := app_private.ticket_load(p_ticket);
  if not app_private.ticket_is_worker(t) then perform app_private.fail('forbidden', 'Вы не в очереди этого обращения'); end if;
  if t.status in ('resolved', 'closed') then perform app_private.fail('transition-not-allowed', 'Обращение уже решено'); end if;
  v_from := t.status;
  update public.ticket set assignee_id = v_user, status = case when status = 'new' then 'assigned' else status end,
    updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
  perform app_private.ticket_log(p_ticket, 'taken', v_from, t.status, null);
  return t;
end $$;

create function public.ticket_assign(p_ticket uuid, p_user uuid) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.ticket; v_from text;
begin
  t := app_private.ticket_load(p_ticket);
  if not (app_private.has_perm('ticket.manage', t.partner_id, t.location_id) or t.assignee_id = v_user) then
    perform app_private.fail('forbidden', 'Передать обращение может исполнитель или руководитель');
  end if;
  if not (app_private.user_in_queue(p_user, t.queue_role, t.partner_id, t.location_id)
          or (t.backup_role is not null and app_private.user_in_queue(p_user, t.backup_role, t.partner_id, t.location_id))) then
    perform app_private.fail('validation', 'Получатель не входит в очередь', 'assignee');
  end if;
  v_from := t.status;
  update public.ticket set assignee_id = p_user, status = case when status = 'new' then 'assigned' else status end,
    updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
  perform app_private.ticket_log(p_ticket, 'assigned', v_from, t.status, (select full_name from public.app_user where id = p_user));
  perform app_private.notify(p_user, 'ticket.assigned', 'Вам передано обращение: ' || t.subject, t.number, 'ticket', t.id,
    '/support/' || t.id, 'ticket.assigned:' || t.id || ':' || p_user);
  return t;
end $$;

create function app_private.ticket_resume_sla(t public.ticket) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_paused int;
begin
  if t.sla_paused_at is null then return t; end if;
  v_paused := ceil(extract(epoch from now() - t.sla_paused_at) / 60);
  update public.ticket set sla_paused_at = null, sla_paused_minutes = sla_paused_minutes + v_paused,
    resolve_due = resolve_due + make_interval(mins => v_paused) where id = t.id returning * into t;
  perform app_private.ticket_log(t.id, 'sla_resumed', t.status, t.status, 'Пауза таймера решения: ' || v_paused || ' мин');
  return t;
end $$;

create function public.ticket_reply(p_ticket uuid, p_body text, p_internal boolean default false, p_lang text default null)
returns public.ticket_message
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.ticket; m public.ticket_message; v_staff boolean; v_from text;
begin
  t := app_private.ticket_load(p_ticket);
  if t.status = 'closed' then perform app_private.fail('transition-not-allowed', 'Обращение закрыто'); end if;
  if coalesce(trim(p_body), '') = '' then perform app_private.fail('validation', 'Пустое сообщение', 'body'); end if;
  v_staff := app_private.ticket_is_worker(t);
  if p_internal and not (v_staff and app_private.is_staff()) then
    perform app_private.fail('forbidden', 'Внутренние заметки доступны только сотрудникам');
  end if;
  if not v_staff and t.created_by <> v_user and not app_private.has_perm('ticket.create', t.partner_id, t.location_id) then
    perform app_private.fail('forbidden', 'Нет прав отвечать в обращении');
  end if;
  insert into public.ticket_message(ticket_id, author_id, body, internal, lang)
  values (p_ticket, v_user, left(p_body, 8000), coalesce(p_internal, false), p_lang) returning * into m;
  v_from := t.status;
  if v_staff and not p_internal then
    update public.ticket set first_response_at = coalesce(first_response_at, now()),
      assignee_id = coalesce(assignee_id, v_user),
      status = case when status in ('new', 'assigned') then 'in_progress' else status end,
      updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
    perform app_private.notify(t.created_by, 'ticket.reply', 'Ответ по обращению ' || t.number, left(p_body, 140), 'ticket', t.id,
      '/support/' || t.id, 'ticket.reply:' || m.id);
  elsif not v_staff then
    if t.status = 'waiting_partner' then
      t := app_private.ticket_resume_sla(t);
      update public.ticket set status = 'in_progress', updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
    else
      update public.ticket set updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
    end if;
    if t.assignee_id is not null then
      perform app_private.notify(t.assignee_id, 'ticket.reply', 'Ответ партнёра ' || t.number, left(p_body, 140), 'ticket', t.id,
        '/support/' || t.id, 'ticket.reply:' || m.id);
    end if;
  end if;
  perform app_private.ticket_log(p_ticket, case when p_internal then 'internal_note' else 'message' end, v_from, t.status, null);
  return m;
end $$;

create function public.ticket_set_status(p_ticket uuid, p_status text, p_comment text, p_expected_revision int default null) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.ticket; v_from text;
begin
  perform app_private.require_user();
  t := app_private.ticket_load(p_ticket, p_expected_revision);
  if not app_private.ticket_is_worker(t) then perform app_private.fail('forbidden', 'Нет прав на обращение'); end if;
  v_from := t.status;
  if not ((v_from in ('assigned', 'in_progress', 'waiting_vendor') and p_status = 'waiting_partner')
       or (v_from in ('assigned', 'in_progress', 'waiting_partner') and p_status = 'waiting_vendor')
       or (v_from in ('assigned', 'waiting_partner', 'waiting_vendor') and p_status = 'in_progress')) then
    perform app_private.fail('transition-not-allowed', 'Переход недоступен', v_from || ' → ' || p_status);
  end if;
  if coalesce(trim(p_comment), '') = '' then perform app_private.fail('validation', 'Укажите, чего ждём', 'comment'); end if;
  if v_from = 'waiting_partner' then t := app_private.ticket_resume_sla(t); end if;
  update public.ticket set status = p_status,
    sla_paused_at = case when p_status = 'waiting_partner' then now() else sla_paused_at end, -- ожидание поставщика таймер не останавливает
    updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
  perform app_private.ticket_log(p_ticket, 'status', v_from, p_status, p_comment);
  if p_status = 'waiting_partner' then
    perform app_private.notify(t.created_by, 'ticket.waiting', 'Нужен ваш ответ по обращению ' || t.number, p_comment, 'ticket', t.id,
      '/support/' || t.id, 'ticket.waiting:' || t.id || ':' || t.revision, false);
  end if;
  return t;
end $$;

create function public.ticket_resolve(p_ticket uuid, p_reason text, p_kb_article uuid default null) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.ticket; v_from text; v_days int := 3;
begin
  perform app_private.require_user();
  t := app_private.ticket_load(p_ticket);
  if not app_private.ticket_is_worker(t) then perform app_private.fail('forbidden', 'Нет прав на обращение'); end if;
  if t.status in ('new', 'resolved', 'closed') then perform app_private.fail('transition-not-allowed', 'Сначала возьмите обращение в работу', t.status); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Опишите решение', 'resolution_reason'); end if;
  if t.status = 'waiting_partner' then t := app_private.ticket_resume_sla(t); end if;
  v_from := t.status;
  update public.ticket set status = 'resolved', resolution_reason = p_reason, kb_article_id = p_kb_article, resolved_at = now(),
    first_response_at = coalesce(first_response_at, now()), reopen_until = now() + make_interval(days => v_days),
    updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
  perform app_private.ticket_log(p_ticket, 'resolved', v_from, 'resolved', p_reason);
  perform app_private.notify(t.created_by, 'ticket.resolved', 'Обращение решено: ' || t.subject,
    'Подтвердите решение или переоткройте до ' || to_char(t.reopen_until, 'DD.MM HH24:MI'), 'ticket', t.id,
    '/support/' || t.id, 'ticket.resolved:' || t.id || ':' || t.revision);
  return t;
end $$;

create function public.ticket_confirm(p_ticket uuid) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.ticket;
begin
  t := app_private.ticket_load(p_ticket);
  if t.status <> 'resolved' then perform app_private.fail('transition-not-allowed', 'Обращение не в статусе «решено»'); end if;
  if t.created_by <> v_user and not app_private.has_perm('ticket.manage', t.partner_id, t.location_id) then
    perform app_private.fail('forbidden', 'Подтверждает автор обращения');
  end if;
  update public.ticket set status = 'closed', closed_at = now(), updated_at = now(), revision = revision + 1
  where id = p_ticket returning * into t;
  perform app_private.ticket_log(p_ticket, 'confirmed', 'resolved', 'closed', null);
  return t;
end $$;

create function public.ticket_reopen(p_ticket uuid, p_reason text) returns public.ticket
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.ticket;
begin
  t := app_private.ticket_load(p_ticket);
  if t.status <> 'resolved' then perform app_private.fail('transition-not-allowed', 'Переоткрыть можно решённое обращение'); end if;
  if t.created_by <> v_user then perform app_private.fail('forbidden', 'Переоткрывает автор обращения'); end if;
  if now() > t.reopen_until then perform app_private.fail('transition-not-allowed', 'Срок переоткрытия истёк — создайте новое обращение'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Опишите, что не решено', 'reason'); end if;
  update public.ticket set status = 'in_progress', reopen_count = reopen_count + 1, resolved_at = null,
    updated_at = now(), revision = revision + 1 where id = p_ticket returning * into t;
  perform app_private.ticket_log(p_ticket, 'reopened', 'resolved', 'in_progress', p_reason);
  if t.assignee_id is not null then
    perform app_private.notify(t.assignee_id, 'ticket.reopened', 'Обращение переоткрыто: ' || t.subject, p_reason, 'ticket', t.id,
      '/support/' || t.id, 'ticket.reopened:' || t.id || ':' || t.reopen_count, true);
  end if;
  return t;
end $$;

create function public.ticket_attach_prepare(p_ticket uuid, p_name text, p_mime text, p_size bigint, p_checksum text,
  p_internal boolean default false) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.ticket;
begin
  t := app_private.ticket_load(p_ticket);
  if p_internal and not (app_private.is_staff() and app_private.ticket_is_worker(t)) then
    perform app_private.fail('forbidden', 'Внутренние файлы доступны только сотрудникам');
  end if;
  return app_private.file_prepare(case when app_private.ticket_is_worker(t) then 'ticket.work' else 'ticket.create' end,
    t.partner_id, t.location_id, case when p_internal then 'staff' else 'scope' end, p_name, p_mime, p_size, p_checksum, 'ticket', t.id);
end $$;

-- Демо-перевод: только заранее подготовленные тексты, помечены (SUP-08, COST-10).
create function public.ticket_message_translate(p_message uuid, p_target text) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare m public.ticket_message; t public.ticket; v text;
begin
  perform app_private.require_user();
  select * into m from public.ticket_message where id = p_message;
  if not found then perform app_private.fail('not-found', 'Сообщение не найдено'); end if;
  t := app_private.ticket_load(m.ticket_id);
  if m.internal and not app_private.is_staff() then perform app_private.fail('not-found', 'Сообщение не найдено'); end if;
  select translated into v from public.demo_translation where source = m.body and target_lang = p_target;
  return jsonb_build_object('original', m.body, 'translated', v, 'kind', 'demo', 'available', v is not null);
end $$;

-- Таймеры SLA и автозакрытие (фоновая обработка, ADR-0005).
create function app_private.support_timers() returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.ticket; n int := 0;
begin
  for t in select * from public.ticket where status in ('new', 'assigned') and first_response_at is null and first_response_due < now() loop
    perform app_private.notify_queue(coalesce(t.backup_role, 'direction_head'), t.partner_id, t.location_id, 'ticket.sla',
      'Нет первой реакции: ' || t.subject, t.number, 'ticket', t.id, '/support/' || t.id, 'ticket.sla.first:' || t.id, true);
    n := n + 1;
  end loop;
  for t in select * from public.ticket where status in ('new', 'assigned', 'in_progress', 'waiting_vendor') and resolve_due < now() loop
    perform app_private.notify_queue('direction_head', t.partner_id, t.location_id, 'ticket.sla',
      'Просрочено решение: ' || t.subject, t.number, 'ticket', t.id, '/support/' || t.id, 'ticket.sla.resolve:' || t.id, true);
    n := n + 1;
  end loop;
  for t in select * from public.ticket where status = 'resolved' and reopen_until < now() for update skip locked loop
    update public.ticket set status = 'closed', closed_at = now(), updated_at = now(), revision = revision + 1 where id = t.id;
    insert into public.ticket_event(ticket_id, actor_id, action, from_status, to_status, comment)
    values (t.id, null, 'auto_closed', 'resolved', 'closed', 'Истёк срок подтверждения');
    n := n + 1;
  end loop;
  return n;
end $$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.support_routing enable row level security;
alter table public.sla_policy enable row level security;
alter table public.ticket enable row level security;
alter table public.ticket_message enable row level security;
alter table public.ticket_event enable row level security;
alter table public.demo_translation enable row level security;

create policy read_all on public.support_routing for select to authenticated using (true);
create policy read_all on public.sla_policy for select to authenticated using (true);
create policy read_ticket on public.ticket for select to authenticated using (app_private.can_read_ticket(ticket));
create policy read_message on public.ticket_message for select to authenticated using (
  exists (select 1 from public.ticket t where t.id = ticket_id and app_private.can_read_ticket(t))
  and (not internal or app_private.is_staff()));
create policy read_event on public.ticket_event for select to authenticated using (
  exists (select 1 from public.ticket t where t.id = ticket_id and app_private.can_read_ticket(t))
  and (action <> 'internal_note' or app_private.is_staff()));

insert into app_private.client_table(tbl) values ('public.support_routing'), ('public.sla_policy'), ('public.ticket'),
  ('public.ticket_message'), ('public.ticket_event');
insert into app_private.client_command(fn) values
  ('public.ticket_create(uuid, text, text, text, text, text, text, jsonb, text)'), ('public.ticket_take(uuid)'),
  ('public.ticket_assign(uuid, uuid)'), ('public.ticket_reply(uuid, text, boolean, text)'),
  ('public.ticket_set_status(uuid, text, text, int)'), ('public.ticket_resolve(uuid, text, uuid)'),
  ('public.ticket_confirm(uuid)'), ('public.ticket_reopen(uuid, text)'),
  ('public.ticket_attach_prepare(uuid, text, text, bigint, text, boolean)'), ('public.ticket_message_translate(uuid, text)');
insert into app_private.policy_helper(fn) values ('app_private.can_read_ticket(public.ticket)');
select app_private.apply_grants();
