-- 0004 Workflows and Tasks: шаблоны с версиями, экземпляры, задачи, зависимости, история (CORE-02…04).

create table public.workflow_template (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  kind text not null,
  name text not null,
  direction_id uuid references public.direction(id),
  created_at timestamptz not null default now()
);

create table public.workflow_template_version (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.workflow_template(id),
  version int not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  definition jsonb not null,
  change_note text,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (template_id, version)
);

create table public.workflow_instance (
  id uuid primary key default gen_random_uuid(),
  template_version_id uuid not null references public.workflow_template_version(id),
  subject_type text not null,
  subject_id uuid not null,
  partner_id uuid references public.partner(id),
  location_id uuid references public.location(id),
  anchors jsonb not null default '{}'::jsonb, -- {"start": "2026-10-12", "planned_open": "2026-12-01"}
  timezone text not null,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

create table public.task (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  kind text not null,
  title text not null,
  description text,
  instance_id uuid references public.workflow_instance(id),
  step_key text,
  stage_key text,
  stage_title text,
  stage_order int,
  step_order int,
  subject_type text,
  subject_id uuid,
  partner_id uuid references public.partner(id),
  location_id uuid references public.location(id),
  side text not null default 'company' check (side in ('company', 'partner')),
  partner_visible boolean not null default false,
  queue_role text not null references public.role(code),
  backup_role text references public.role(code),
  assignee_id uuid references public.app_user(id),
  status text not null default 'ready'
    check (status in ('planned', 'ready', 'in_progress', 'waiting_external', 'blocked', 'in_review', 'done', 'cancelled')),
  status_reason text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'critical')),
  due_at timestamptz,
  due_mode text not null default 'manual' check (due_mode in ('relative', 'manual')),
  due_anchor text,
  due_offset_days int,
  is_critical boolean not null default false,
  is_gate boolean not null default false,
  requires_evidence boolean not null default false,
  requires_review boolean not null default false,
  result text,
  completed_by uuid references public.app_user(id),
  completed_at timestamptz,
  kb_article_slug text,
  dedupe_key text unique,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1
);
create index on public.task (instance_id);
create index on public.task (assignee_id) where status not in ('done', 'cancelled');
create index on public.task (queue_role, status);
create index on public.task (subject_type, subject_id);

create table public.task_dependency (
  task_id uuid not null references public.task(id),
  depends_on uuid not null references public.task(id),
  primary key (task_id, depends_on),
  check (task_id <> depends_on)
);

create table public.task_event (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.task(id),
  actor_id uuid references public.app_user(id),
  action text not null,
  from_status text,
  to_status text,
  comment text,
  at timestamptz not null default now()
);
create index on public.task_event (task_id, at);

------------------------------------------------------------------------------
-- Проверка определения шаблона
------------------------------------------------------------------------------
create function app_private.workflow_validate(p_def jsonb) returns void
language plpgsql as $$
declare
  v_stages text[]; v_keys text[]; v_step jsonb; v_dep text; v_bad text;
  v_remaining text[]; v_progress boolean; v_k text;
begin
  if jsonb_typeof(p_def -> 'stages') <> 'array' or jsonb_typeof(p_def -> 'steps') <> 'array' then
    perform app_private.fail('validation', 'Шаблон должен содержать stages и steps');
  end if;
  select array_agg(s ->> 'key') into v_stages from jsonb_array_elements(p_def -> 'stages') s;
  select array_agg(s ->> 'key') into v_keys from jsonb_array_elements(p_def -> 'steps') s;
  if v_keys is null then perform app_private.fail('validation', 'В шаблоне нет шагов'); end if;
  if (select count(distinct k) from unnest(v_keys) k) <> array_length(v_keys, 1) then
    perform app_private.fail('validation', 'Ключи шагов должны быть уникальны');
  end if;
  for v_step in select * from jsonb_array_elements(p_def -> 'steps') loop
    if coalesce(v_step ->> 'title', '') = '' then perform app_private.fail('validation', 'У шага нет названия', v_step ->> 'key'); end if;
    if not ((v_step ->> 'stage') = any(v_stages)) then perform app_private.fail('validation', 'Шаг ссылается на неизвестный этап', v_step ->> 'key'); end if;
    if not exists (select 1 from public.role where code = v_step ->> 'queue_role') then
      perform app_private.fail('validation', 'Неизвестная роль очереди', v_step ->> 'key');
    end if;
    for v_dep in select jsonb_array_elements_text(coalesce(v_step -> 'depends_on', '[]'::jsonb)) loop
      if not (v_dep = any(v_keys)) then perform app_private.fail('validation', 'Зависимость на неизвестный шаг', v_dep); end if;
    end loop;
  end loop;
  -- Проверка циклов: топологическое удаление шагов без незакрытых зависимостей.
  v_remaining := v_keys;
  loop
    v_progress := false;
    foreach v_k in array v_remaining loop
      if not exists (
        select 1 from jsonb_array_elements(p_def -> 'steps') s, jsonb_array_elements_text(coalesce(s -> 'depends_on', '[]'::jsonb)) d
        where s ->> 'key' = v_k and d = any(v_remaining)) then
        v_remaining := array_remove(v_remaining, v_k);
        v_progress := true;
      end if;
    end loop;
    exit when not v_progress or cardinality(v_remaining) = 0;
  end loop;
  if cardinality(v_remaining) > 0 then
    v_bad := array_to_string(v_remaining, ', ');
    perform app_private.fail('validation', 'В шаблоне цикл зависимостей', v_bad);
  end if;
end $$;

create function app_private.workflow_version_check() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' and new.definition is distinct from old.definition then
    perform app_private.fail('transition-not-allowed', 'Опубликованную версию шаблона нельзя изменить; создайте новую');
  end if;
  perform app_private.workflow_validate(new.definition);
  return new;
end $$;
create trigger workflow_version_check before insert or update on public.workflow_template_version
  for each row execute function app_private.workflow_version_check();

------------------------------------------------------------------------------
-- Сроки
------------------------------------------------------------------------------
create function app_private.due_from_anchor(p_anchor_date date, p_offset int, p_tz text) returns timestamptz
language sql immutable as $$
  select case when p_anchor_date is null then null
    else ((p_anchor_date + coalesce(p_offset, 0))::timestamp + time '18:00') at time zone p_tz end
$$;

------------------------------------------------------------------------------
-- Создание задач
------------------------------------------------------------------------------
create function app_private.task_log(p_task uuid, p_action text, p_from text, p_to text, p_comment text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.task_event(task_id, actor_id, action, from_status, to_status, comment)
  values (p_task, auth.uid(), p_action, p_from, p_to, p_comment)
$$;

create function app_private.task_notify_new(t public.task) returns void
language sql security definer set search_path = public, app_private, pg_temp as $$
  select case
    when t.assignee_id is not null then
      app_private.notify(t.assignee_id, 'task.assigned', 'Новая задача: ' || t.title, t.number, 'task', t.id,
        '/tasks/' || t.id, 'task.assigned:' || t.id || ':' || t.assignee_id, t.priority = 'critical')
    when t.status = 'ready' then
      app_private.notify_queue(t.queue_role, t.partner_id, t.location_id, 'task.queue', 'Задача в очереди: ' || t.title,
        t.number, 'task', t.id, '/tasks/' || t.id, 'task.ready:' || t.id, t.priority = 'critical')
  end;
$$;

-- Публичный контракт модуля для других модулей (ARCH-02): создать одиночную задачу.
create function app_private.task_create(p_kind text, p_title text, p_description text, p_queue_role text,
  p_partner uuid, p_location uuid, p_subject_type text, p_subject_id uuid, p_due_at timestamptz,
  p_priority text default 'normal', p_partner_visible boolean default false, p_dedupe text default null,
  p_assignee uuid default null, p_backup_role text default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid; t public.task;
begin
  insert into public.task(number, kind, title, description, queue_role, backup_role, partner_id, location_id, subject_type,
    subject_id, due_at, priority, partner_visible, side, dedupe_key, assignee_id, created_by, status)
  values (app_private.next_number('ЗД'), p_kind, p_title, p_description, p_queue_role, p_backup_role, p_partner, p_location,
    p_subject_type, p_subject_id, p_due_at, p_priority, p_partner_visible,
    case when (select kind from public.role where code = p_queue_role) = 'partner' then 'partner' else 'company' end,
    p_dedupe, p_assignee, auth.uid(), 'ready')
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.task where dedupe_key = p_dedupe; -- повтор планировщика (CORE-02)
    return v_id;
  end if;
  perform app_private.task_log(v_id, 'created', null, 'ready', null);
  select * into t from public.task where id = v_id;
  perform app_private.task_notify_new(t);
  return v_id;
end $$;

-- Запуск процесса: снимок шагов версии шаблона в задачи (CORE-03).
create function app_private.workflow_start(p_version uuid, p_subject_type text, p_subject_id uuid,
  p_partner uuid, p_location uuid, p_anchors jsonb, p_timezone text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare
  v_ver public.workflow_template_version; v_inst uuid; v_step jsonb; v_stage jsonb; v_task uuid; v_dep text;
  v_map jsonb := '{}'::jsonb; v_stage_order int; v_step_order int := 0; t public.task;
begin
  select * into v_ver from public.workflow_template_version where id = p_version;
  if not found or v_ver.status <> 'published' then
    perform app_private.fail('validation', 'Версия шаблона не опубликована');
  end if;
  insert into public.workflow_instance(template_version_id, subject_type, subject_id, partner_id, location_id, anchors, timezone)
  values (p_version, p_subject_type, p_subject_id, p_partner, p_location, p_anchors, p_timezone) returning id into v_inst;

  for v_step in select * from jsonb_array_elements(v_ver.definition -> 'steps') loop
    v_step_order := v_step_order + 1;
    select ord into v_stage_order from jsonb_array_elements(v_ver.definition -> 'stages') with ordinality as s(val, ord)
      where val ->> 'key' = v_step ->> 'stage';
    select val into v_stage from jsonb_array_elements(v_ver.definition -> 'stages') as s(val) where val ->> 'key' = v_step ->> 'stage';
    insert into public.task(number, kind, title, description, instance_id, step_key, stage_key, stage_title, stage_order, step_order,
      subject_type, subject_id, partner_id, location_id, side, partner_visible, queue_role, backup_role, status, priority,
      due_mode, due_anchor, due_offset_days, due_at, is_critical, is_gate, requires_evidence, requires_review, kb_article_slug, created_by)
    values (app_private.next_number('ЗД'), coalesce(v_step ->> 'kind', 'workflow_step'), v_step ->> 'title', v_step ->> 'description',
      v_inst, v_step ->> 'key', v_step ->> 'stage', v_stage ->> 'title', v_stage_order, v_step_order,
      p_subject_type, p_subject_id, p_partner, p_location,
      case when (select kind from public.role where code = v_step ->> 'queue_role') = 'partner' then 'partner' else 'company' end,
      coalesce((v_step ->> 'partner_visible')::boolean, true),
      v_step ->> 'queue_role', v_step ->> 'backup_role',
      case when jsonb_array_length(coalesce(v_step -> 'depends_on', '[]'::jsonb)) = 0 then 'ready' else 'planned' end,
      case when coalesce((v_step ->> 'critical')::boolean, false) then 'high' else 'normal' end,
      case when v_step -> 'due' is null then 'manual' else 'relative' end,
      v_step -> 'due' ->> 'anchor', (v_step -> 'due' ->> 'offset_days')::int,
      app_private.due_from_anchor((p_anchors ->> (v_step -> 'due' ->> 'anchor'))::date, (v_step -> 'due' ->> 'offset_days')::int, p_timezone),
      coalesce((v_step ->> 'critical')::boolean, false), coalesce((v_step ->> 'gate')::boolean, false),
      coalesce((v_step ->> 'requires_evidence')::boolean, false), coalesce((v_step ->> 'requires_review')::boolean, false),
      v_step ->> 'kb_article', auth.uid())
    returning id into v_task;
    v_map := v_map || jsonb_build_object(v_step ->> 'key', v_task);
    perform app_private.task_log(v_task, 'created', null, null, 'Создано из шаблона, версия ' || v_ver.version);
  end loop;

  for v_step in select * from jsonb_array_elements(v_ver.definition -> 'steps') loop
    for v_dep in select jsonb_array_elements_text(coalesce(v_step -> 'depends_on', '[]'::jsonb)) loop
      insert into public.task_dependency(task_id, depends_on)
      values ((v_map ->> (v_step ->> 'key'))::uuid, (v_map ->> v_dep)::uuid);
    end loop;
  end loop;

  for t in select * from public.task where instance_id = v_inst and status = 'ready' loop
    perform app_private.task_notify_new(t);
  end loop;
  return v_inst;
end $$;

------------------------------------------------------------------------------
-- Права на задачу
------------------------------------------------------------------------------
create function app_private.can_read_task(t public.task) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select t.assignee_id = auth.uid()
    or (app_private.has_perm('task.read', t.partner_id, t.location_id)
        and (t.partner_visible or app_private.is_staff()))
$$;

create function app_private.task_load(p_task uuid, p_expected_revision int default null) returns public.task
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task;
begin
  select * into t from public.task where id = p_task for update;
  if not found or not app_private.can_read_task(t) then perform app_private.fail('not-found', 'Задача не найдена'); end if;
  if p_expected_revision is not null and p_expected_revision <> t.revision then
    perform app_private.fail('version-conflict', 'Задачу уже изменили. Обновите карточку', t.revision::text);
  end if;
  return t;
end $$;

create function app_private.can_work_task(t public.task) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.has_perm('task.manage', t.partner_id, t.location_id)
    or (app_private.has_perm('task.work', t.partner_id, t.location_id)
        and (t.assignee_id = auth.uid()
             or (t.assignee_id is null and (app_private.user_in_queue(auth.uid(), t.queue_role, t.partner_id, t.location_id)
                 or (t.backup_role is not null and app_private.user_in_queue(auth.uid(), t.backup_role, t.partner_id, t.location_id))))))
$$;

-- Хук для модулей-владельцев объектов: вызывается после изменения статуса задачи.
create table app_private.task_status_hook (subject_type text not null, fn regproc not null, primary key (subject_type, fn));

create function app_private.task_after_change(t public.task) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare h record; d public.task;
begin
  if t.status = 'done' then
    -- зависимые задачи становятся доступны, когда закрыты все их зависимости
    for d in
      select x.* from public.task x join public.task_dependency dep on dep.task_id = x.id
      where dep.depends_on = t.id and x.status = 'planned'
        and not exists (select 1 from public.task_dependency d2 join public.task y on y.id = d2.depends_on
                        where d2.task_id = x.id and y.status not in ('done', 'cancelled'))
    loop
      update public.task set status = 'ready', updated_at = now(), revision = revision + 1 where id = d.id;
      perform app_private.task_log(d.id, 'unblocked', 'planned', 'ready', 'Зависимости выполнены');
      d.status := 'ready';
      perform app_private.task_notify_new(d);
    end loop;
  end if;
  for h in select fn from app_private.task_status_hook where subject_type = t.subject_type loop
    execute format('select %s($1)', h.fn) using t.id;
  end loop;
end $$;

------------------------------------------------------------------------------
-- Команды задач
------------------------------------------------------------------------------
create function public.task_take(p_task uuid, p_expected_revision int default null) returns public.task
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.task;
begin
  t := app_private.task_load(p_task, p_expected_revision);
  if t.status in ('done', 'cancelled', 'planned') then
    perform app_private.fail('transition-not-allowed', 'Задачу нельзя взять в работу в текущем состоянии', t.status);
  end if;
  if t.assignee_id is not null and t.assignee_id <> v_user then
    perform app_private.fail('transition-not-allowed', 'У задачи уже есть исполнитель');
  end if;
  if not app_private.can_work_task(t) then perform app_private.fail('forbidden', 'Вы не в очереди этой задачи'); end if;
  update public.task set assignee_id = v_user,
    status = case when status = 'ready' then 'in_progress' else status end,
    updated_at = now(), revision = revision + 1
  where id = p_task returning * into t;
  perform app_private.task_log(p_task, 'taken', 'ready', t.status, null);
  return t;
end $$;

create function public.task_assign(p_task uuid, p_user uuid, p_expected_revision int default null) returns public.task
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.task;
begin
  t := app_private.task_load(p_task, p_expected_revision);
  if t.status in ('done', 'cancelled') then perform app_private.fail('transition-not-allowed', 'Задача закрыта'); end if;
  if not (app_private.has_perm('task.manage', t.partner_id, t.location_id) or t.assignee_id = v_user) then
    perform app_private.fail('forbidden', 'Передать задачу может исполнитель или руководитель');
  end if;
  if p_user is not null and not (app_private.user_in_queue(p_user, t.queue_role, t.partner_id, t.location_id)
      or (t.backup_role is not null and app_private.user_in_queue(p_user, t.backup_role, t.partner_id, t.location_id))) then
    perform app_private.fail('validation', 'Получатель не входит в очередь задачи', 'assignee');
  end if;
  update public.task set assignee_id = p_user, updated_at = now(), revision = revision + 1 where id = p_task returning * into t;
  perform app_private.task_log(p_task, case when p_user is null then 'returned_to_queue' else 'assigned' end, t.status, t.status,
    (select full_name from public.app_user where id = p_user));
  perform app_private.task_notify_new(t);
  return t;
end $$;

-- Переходы без завершения: в работу, ожидание, блокировка, на проверку, возврат с проверки.
create function public.task_transition(p_task uuid, p_to text, p_comment text default null, p_expected_revision int default null)
returns public.task
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.task; v_from text; v_ok boolean;
begin
  t := app_private.task_load(p_task, p_expected_revision);
  v_from := t.status;
  v_ok := case
    when v_from = 'ready' and p_to = 'in_progress' then true
    when v_from = 'in_progress' and p_to in ('waiting_external', 'blocked') then true
    when v_from in ('waiting_external', 'blocked') and p_to = 'in_progress' then true
    when v_from = 'in_progress' and p_to = 'in_review' then t.requires_review
    when v_from = 'in_review' and p_to = 'in_progress' then true -- возврат с проверки
    else false end;
  if not v_ok then
    perform app_private.fail('transition-not-allowed', 'Переход недоступен', v_from || ' → ' || p_to);
  end if;
  if p_to in ('waiting_external', 'blocked') or (v_from = 'in_review' and p_to = 'in_progress') then
    if coalesce(trim(p_comment), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'comment'); end if;
  end if;
  if v_from = 'in_review' then
    if not app_private.has_perm('task.manage', t.partner_id, t.location_id) or t.assignee_id = v_user then
      perform app_private.fail('forbidden', 'Вернуть с проверки может проверяющий, не исполнитель');
    end if;
  elsif not app_private.can_work_task(t) then
    perform app_private.fail('forbidden', 'Нет прав на задачу');
  end if;
  if p_to = 'in_review' and coalesce(trim(t.result), trim(p_comment), '') = '' then
    perform app_private.fail('validation', 'Опишите результат перед проверкой', 'result');
  end if;
  update public.task set status = p_to, status_reason = p_comment,
    result = case when p_to = 'in_review' then coalesce(p_comment, result) else result end,
    assignee_id = coalesce(assignee_id, v_user), updated_at = now(), revision = revision + 1
  where id = p_task returning * into t;
  perform app_private.task_log(p_task, 'transition', v_from, p_to, p_comment);
  if v_from = 'in_review' and t.assignee_id is not null then
    perform app_private.notify(t.assignee_id, 'task.returned', 'Задача возвращена: ' || t.title, p_comment, 'task', t.id,
      '/tasks/' || t.id, 'task.returned:' || t.id || ':' || t.revision);
  end if;
  perform app_private.task_after_change(t);
  return t;
end $$;

create function public.task_complete(p_task uuid, p_result text, p_expected_revision int default null) returns public.task
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); t public.task; v_from text; v_reviewer boolean;
begin
  t := app_private.task_load(p_task, p_expected_revision);
  v_from := t.status;
  if v_from not in ('ready', 'in_progress', 'in_review') then
    perform app_private.fail('transition-not-allowed', 'Задачу нельзя завершить в текущем состоянии', v_from);
  end if;
  if coalesce(trim(p_result), trim(t.result), '') = '' then
    perform app_private.fail('validation', 'Укажите результат: комментарий сам по себе не завершает задачу', 'result');
  end if;
  if t.requires_evidence and not exists (select 1 from public.attachment_link l join public.file_asset f on f.id = l.file_id
      where l.entity_type = 'task' and l.entity_id = t.id and f.status = 'ready') then
    perform app_private.fail('validation', 'Приложите доказательство выполнения', 'evidence');
  end if;
  v_reviewer := app_private.has_perm('task.manage', t.partner_id, t.location_id) and coalesce(t.assignee_id, v_user) <> v_user;
  if v_from = 'in_review' then
    if not v_reviewer then perform app_private.fail('forbidden', 'Завершить после проверки может проверяющий, не исполнитель'); end if;
  else
    if not app_private.can_work_task(t) then perform app_private.fail('forbidden', 'Нет прав на задачу'); end if;
    if t.requires_review then
      -- исполнитель отправляет на проверку
      update public.task set status = 'in_review', result = coalesce(p_result, result), assignee_id = coalesce(assignee_id, v_user),
        updated_at = now(), revision = revision + 1 where id = p_task returning * into t;
      perform app_private.task_log(p_task, 'submitted_for_review', v_from, 'in_review', p_result);
      perform app_private.notify_queue(coalesce(t.backup_role, 'direction_head'), t.partner_id, t.location_id, 'task.review',
        'Проверьте задачу: ' || t.title, t.number, 'task', t.id, '/tasks/' || t.id, 'task.review:' || t.id || ':' || t.revision);
      return t;
    end if;
  end if;
  update public.task set status = 'done', result = coalesce(p_result, result), completed_by = v_user, completed_at = now(),
    assignee_id = coalesce(assignee_id, v_user), updated_at = now(), revision = revision + 1
  where id = p_task returning * into t;
  perform app_private.task_log(p_task, 'completed', v_from, 'done', p_result);
  perform app_private.task_after_change(t);
  return t;
end $$;

create function public.task_cancel(p_task uuid, p_reason text) returns public.task
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task; v_from text;
begin
  perform app_private.require_user();
  t := app_private.task_load(p_task);
  if t.status in ('done', 'cancelled') then perform app_private.fail('transition-not-allowed', 'Задача уже закрыта'); end if;
  perform app_private.require_perm('task.manage', t.partner_id, t.location_id);
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  v_from := t.status;
  update public.task set status = 'cancelled', status_reason = p_reason, updated_at = now(), revision = revision + 1
  where id = p_task returning * into t;
  perform app_private.task_log(p_task, 'cancelled', v_from, 'cancelled', p_reason);
  perform app_private.task_after_change(t);
  return t;
end $$;

create function public.task_reopen(p_task uuid, p_reason text) returns public.task
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task;
begin
  perform app_private.require_user();
  t := app_private.task_load(p_task);
  if t.status <> 'done' then perform app_private.fail('transition-not-allowed', 'Переоткрыть можно только завершённую задачу'); end if;
  perform app_private.require_perm('task.manage', t.partner_id, t.location_id);
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  update public.task set status = 'in_progress', status_reason = p_reason, completed_at = null, completed_by = null,
    updated_at = now(), revision = revision + 1 where id = p_task returning * into t;
  perform app_private.task_log(p_task, 'reopened', 'done', 'in_progress', p_reason);
  perform app_private.audit('task.reopen', 'task', p_task, t.partner_id, null, p_reason);
  perform app_private.task_after_change(t);
  return t;
end $$;

create function public.task_comment(p_task uuid, p_text text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task;
begin
  perform app_private.require_user();
  t := app_private.task_load(p_task);
  if coalesce(trim(p_text), '') = '' then perform app_private.fail('validation', 'Пустой комментарий', 'text'); end if;
  perform app_private.task_log(p_task, 'comment', t.status, t.status, left(p_text, 4000));
end $$;

create function public.task_attach_prepare(p_task uuid, p_name text, p_mime text, p_size bigint, p_checksum text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task;
begin
  perform app_private.require_user();
  t := app_private.task_load(p_task);
  if not app_private.can_work_task(t) then perform app_private.fail('forbidden', 'Нет прав на задачу'); end if;
  return app_private.file_prepare('task.work', t.partner_id, t.location_id,
    case when t.partner_visible then 'scope' else 'staff' end, p_name, p_mime, p_size, p_checksum, 'task', t.id);
end $$;

-- Отзыв назначения: задачи, которые человек больше не может выполнять, возвращаются в очередь (AUTH-03).
create function app_private.tasks_on_revoke(p_assignment uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.role_assignment; t public.task;
begin
  select * into a from public.role_assignment where id = p_assignment;
  for t in select * from public.task where assignee_id = a.user_id and status not in ('done', 'cancelled') loop
    if not app_private.user_in_queue(a.user_id, t.queue_role, t.partner_id, t.location_id)
       and not (t.backup_role is not null and app_private.user_in_queue(a.user_id, t.backup_role, t.partner_id, t.location_id)) then
      update public.task set assignee_id = null, updated_at = now(), revision = revision + 1 where id = t.id;
      perform app_private.task_log(t.id, 'returned_to_queue', t.status, t.status, 'Исполнитель потерял доступ: ' || coalesce(a.revoke_reason, ''));
      perform app_private.notify_queue(t.queue_role, t.partner_id, t.location_id, 'task.queue', 'Задача вернулась в очередь: ' || t.title,
        t.number, 'task', t.id, '/tasks/' || t.id, 'task.requeued:' || t.id || ':' || p_assignment, true);
    end if;
  end loop;
end $$;
insert into app_private.revoke_hook(fn) values ('app_private.tasks_on_revoke');

------------------------------------------------------------------------------
-- Контракты модуля для владельцев процессов (ARCH-02)
------------------------------------------------------------------------------
-- Сдвиг якоря: пересчитываются только незавершённые задачи с относительным сроком от этого якоря (OPEN-04).
create function app_private.workflow_reschedule(p_instance uuid, p_anchor text, p_date date, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare i public.workflow_instance; t public.task; v_new timestamptz; v_changed jsonb := '[]'::jsonb;
begin
  select * into i from public.workflow_instance where id = p_instance for update;
  update public.workflow_instance set anchors = anchors || jsonb_build_object(p_anchor, p_date) where id = p_instance;
  for t in select * from public.task where instance_id = p_instance and due_mode = 'relative' and due_anchor = p_anchor
             and status not in ('done', 'cancelled') order by step_order loop
    v_new := app_private.due_from_anchor(p_date, t.due_offset_days, i.timezone);
    if v_new is distinct from t.due_at then
      update public.task set due_at = v_new, updated_at = now(), revision = revision + 1 where id = t.id;
      perform app_private.task_log(t.id, 'rescheduled', t.status, t.status,
        coalesce(to_char(t.due_at at time zone i.timezone, 'DD.MM.YYYY'), '—') || ' → ' || to_char(v_new at time zone i.timezone, 'DD.MM.YYYY') || '. ' || p_reason);
      v_changed := v_changed || jsonb_build_object('task_id', t.id, 'number', t.number, 'title', t.title, 'old_due', t.due_at, 'new_due', v_new);
    end if;
  end loop;
  return v_changed;
end $$;

create function app_private.workflow_cancel(p_instance uuid, p_reason text) returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task; n int := 0;
begin
  update public.workflow_instance set status = 'cancelled' where id = p_instance;
  for t in select * from public.task where instance_id = p_instance and status not in ('done', 'cancelled') loop
    update public.task set status = 'cancelled', status_reason = p_reason, updated_at = now(), revision = revision + 1 where id = t.id;
    perform app_private.task_log(t.id, 'cancelled', t.status, 'cancelled', p_reason);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Завершение шага системным решением (например, разрешение на открытие закрывает шаг-ворота).
create function app_private.workflow_complete_step(p_instance uuid, p_step text, p_result text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task;
begin
  select * into t from public.task where instance_id = p_instance and step_key = p_step and status not in ('done', 'cancelled') for update;
  if not found then return; end if;
  update public.task set status = 'done', result = p_result, completed_by = auth.uid(), completed_at = now(),
    assignee_id = coalesce(assignee_id, auth.uid()), updated_at = now(), revision = revision + 1 where id = t.id returning * into t;
  perform app_private.task_log(t.id, 'completed', 'ready', 'done', p_result);
  perform app_private.task_after_change(t);
end $$;

-- Публикация новой версии шаблона: начатые проекты сохраняют свою версию (CORE-03, AT-04).
create function public.workflow_template_publish(p_template_code text, p_definition jsonb, p_note text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_tpl uuid; v_ver int; v_id uuid;
begin
  if not exists (select 1 from app_private.active_assignments() a join public.role_permission rp on rp.role = a.role
                 where rp.permission = 'opening.approve' and a.scope_type in ('company', 'direction')) then
    perform app_private.fail('forbidden', 'Недостаточно прав для изменения шаблона');
  end if;
  if coalesce(trim(p_note), '') = '' then perform app_private.fail('validation', 'Опишите изменение', 'note'); end if;
  select id into v_tpl from public.workflow_template where code = p_template_code;
  if not found then perform app_private.fail('not-found', 'Шаблон не найден'); end if;
  select coalesce(max(version), 0) + 1 into v_ver from public.workflow_template_version where template_id = v_tpl;
  update public.workflow_template_version set status = 'retired' where template_id = v_tpl and status = 'published';
  insert into public.workflow_template_version(template_id, version, status, definition, change_note, created_by, published_at)
  values (v_tpl, v_ver, 'published', p_definition, p_note, v_user, now()) returning id into v_id;
  perform app_private.audit('workflow.publish', 'workflow_template', v_tpl, null, jsonb_build_object('version', v_ver), p_note);
  return v_id;
end $$;

create function app_private.workflow_complete(p_instance uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.workflow_instance set status = 'completed' where id = p_instance
$$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.workflow_template enable row level security;
alter table public.workflow_template_version enable row level security;
alter table public.workflow_instance enable row level security;
alter table public.task enable row level security;
alter table public.task_dependency enable row level security;
alter table public.task_event enable row level security;

create policy read_staff on public.workflow_template for select to authenticated using (app_private.is_staff());
create policy read_staff on public.workflow_template_version for select to authenticated using (app_private.is_staff());
create policy read_scope on public.workflow_instance for select to authenticated using (app_private.in_scope(partner_id, location_id));
create policy read_task on public.task for select to authenticated using (app_private.can_read_task(task));
create policy read_dep on public.task_dependency for select to authenticated
  using (exists (select 1 from public.task t where t.id = task_id and app_private.can_read_task(t)));
create policy read_event on public.task_event for select to authenticated
  using (exists (select 1 from public.task t where t.id = task_id and app_private.can_read_task(t)));

insert into app_private.client_table(tbl) values ('public.workflow_template'), ('public.workflow_template_version'),
  ('public.workflow_instance'), ('public.task'), ('public.task_dependency'), ('public.task_event');
insert into app_private.client_command(fn) values
  ('public.task_take(uuid, int)'), ('public.task_assign(uuid, uuid, int)'), ('public.task_transition(uuid, text, text, int)'),
  ('public.task_complete(uuid, text, int)'), ('public.task_cancel(uuid, text)'), ('public.task_reopen(uuid, text)'),
  ('public.task_comment(uuid, text)'), ('public.task_attach_prepare(uuid, text, text, bigint, text)'),
  ('public.workflow_template_publish(text, jsonb, text)');
insert into app_private.policy_helper(fn) values ('app_private.can_read_task(public.task)');
select app_private.apply_grants();
