-- 0009 Knowledge and Learning: разделы, статьи, редакции, публикация, поиск, ознакомления, Drive (demo), экспорт (KB-01…19).
-- Формат тела — md-v1: CommonMark без HTML (ADR-0007).

create table public.kb_section (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.kb_section(id),
  slug text not null unique,
  title text not null,
  description text,
  sort int not null default 100,
  direction_id uuid references public.direction(id),
  created_at timestamptz not null default now()
);

create table public.article (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  section_id uuid not null references public.kb_section(id),
  type text not null default 'article' check (type in ('article', 'instruction', 'faq', 'regulation', 'template', 'checklist')),
  owner_id uuid references public.app_user(id),
  direction_id uuid references public.direction(id),
  audience text not null default 'all' check (audience in ('all', 'staff')),
  audience_roles text[], -- null = вся аудитория; иначе только эти роли
  status text not null default 'draft' check (status in ('draft', 'published', 'needs_review', 'suspended', 'archived')),
  published_revision_id uuid,
  review_due date,
  required_ack boolean not null default false,
  source_mode text not null default 'native' check (source_mode in ('native', 'drive_document', 'attachment')),
  export_status text not null default 'not_required' check (export_status in ('not_required', 'pending', 'done', 'failed')),
  export_error text,
  exported_at timestamptz,
  tags text[] not null default '{}',
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1
);

create table public.article_revision (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.article(id),
  rev_no int not null,
  title text not null,
  summary text,
  body_format text not null default 'md-v1' check (body_format in ('md-v1')),
  body text not null default '',
  body_text text not null default '',
  lang text not null default 'ru' check (lang in ('ru', 'tr')),
  search tsvector,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'superseded', 'rejected')),
  source text not null default 'editor' check (source in ('editor', 'drive', 'import')),
  external_version text,
  author_id uuid references public.app_user(id),
  submitted_at timestamptz,
  approved_by uuid references public.app_user(id),
  published_at timestamptz,
  requires_reack boolean not null default false,
  change_note text,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1,
  unique (article_id, rev_no)
);
alter table public.article add foreign key (published_revision_id) references public.article_revision(id);
create index article_revision_search on public.article_revision using gin (search);
create index article_revision_title_trgm on public.article_revision using gin (title extensions.gin_trgm_ops);

create function app_private.revision_prepare() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status in ('published', 'superseded')
     and (new.title, new.summary, new.body) is distinct from (old.title, old.summary, old.body) then
    perform app_private.fail('transition-not-allowed', 'Опубликованная редакция неизменна; создайте новую');
  end if;
  new.body_text := trim(regexp_replace(regexp_replace(coalesce(new.body, ''), '!\[[^\]]*\]\([^)]*\)', ' ', 'g'),
                                       '[#*_`>|~\[\]\(\)-]+', ' ', 'g'));
  new.search := setweight(to_tsvector(case new.lang when 'tr' then 'turkish'::regconfig else 'russian'::regconfig end, coalesce(new.title, '')), 'A')
    || setweight(to_tsvector(case new.lang when 'tr' then 'turkish'::regconfig else 'russian'::regconfig end, coalesce(new.summary, '')), 'B')
    || setweight(to_tsvector(case new.lang when 'tr' then 'turkish'::regconfig else 'russian'::regconfig end, new.body_text), 'C');
  return new;
end $$;
create trigger revision_prepare before insert or update on public.article_revision
  for each row execute function app_private.revision_prepare();

-- Привязка инструкции к контексту работы (KB-06): категория обращения, шаг шаблона, товар, вид задачи.
create table public.kb_binding (
  article_id uuid not null references public.article(id),
  target_type text not null check (target_type in ('ticket_category', 'workflow_step', 'catalog_item', 'task_kind')),
  target_key text not null,
  primary key (article_id, target_type, target_key)
);

create table public.ack_assignment (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.article(id),
  revision_id uuid not null references public.article_revision(id),
  user_id uuid not null references public.app_user(id),
  due_on date not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (revision_id, user_id)
);

create table public.acknowledgement (
  revision_id uuid not null references public.article_revision(id),
  user_id uuid not null references public.app_user(id),
  at timestamptz not null default now(),
  primary key (revision_id, user_id)
);

create table public.kb_feedback (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.article(id),
  revision_id uuid references public.article_revision(id),
  user_id uuid not null references public.app_user(id),
  kind text not null check (kind in ('helpful', 'not_helpful', 'outdated', 'suggestion')),
  comment text,
  created_at timestamptz not null default now()
);

create table public.kb_search_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  query text not null,
  results int not null,
  at timestamptz not null default now()
);

create table public.kb_synonym (
  term text primary key,
  expands_to text not null
);

create table public.source_link (
  article_id uuid primary key references public.article(id),
  provider text not null default 'google_drive',
  external_id text not null,
  external_version text,
  checksum text,
  sync_status text not null default 'synced' check (sync_status in ('pending', 'syncing', 'synced', 'error', 'conflict', 'unavailable')),
  last_synced_at timestamptz,
  error text
);

------------------------------------------------------------------------------
-- Видимость (KB-07, KB-08)
------------------------------------------------------------------------------
create function app_private.kb_is_editor() returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.has_perm_anywhere('kb.edit') or app_private.has_perm_anywhere('kb.publish')
$$;

create function app_private.kb_audience_match(a public.article) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.has_perm_anywhere('kb.read')
    and (a.audience = 'all' or (a.audience = 'staff' and app_private.is_staff()))
    and (a.audience_roles is null or exists (select 1 from app_private.active_assignments() x where x.role = any(a.audience_roles)))
$$;

create function app_private.can_read_article(a public.article) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.kb_is_editor()
    or (a.status in ('published', 'needs_review') and a.published_revision_id is not null and app_private.kb_audience_match(a))
$$;

create function app_private.can_read_revision(r public.article_revision) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.kb_is_editor()
    or exists (select 1 from public.article a where a.id = r.article_id and a.published_revision_id = r.id and app_private.can_read_article(a))
    or exists (select 1 from public.acknowledgement k where k.revision_id = r.id and k.user_id = auth.uid())
$$;

-- Пользователи аудитории статьи (для назначений ознакомления).
create function app_private.kb_audience_users(a public.article) returns setof uuid
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select distinct x.user_id from public.role_assignment x
  join public.app_user u on u.id = x.user_id and u.status = 'active'
  join public.role r on r.code = x.role
  join public.role_permission rp on rp.role = x.role and rp.permission = 'kb.read'
  where x.revoked_at is null and x.valid_from <= now() and (x.valid_to is null or x.valid_to > now())
    and (a.audience = 'all' or r.kind = 'staff')
    and (a.audience_roles is null or x.role = any(a.audience_roles))
$$;

------------------------------------------------------------------------------
-- Редакционные команды
------------------------------------------------------------------------------
create function app_private.article_load(p_article uuid) returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  select * into a from public.article where id = p_article for update;
  if not found or not app_private.can_read_article(a) then perform app_private.fail('not-found', 'Статья не найдена'); end if;
  return a;
end $$;

create function public.kb_section_upsert(p_id uuid, p_parent uuid, p_slug text, p_title text, p_description text, p_sort int) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.publish') then perform app_private.fail('forbidden', 'Структуру разделов меняет публикующий редактор'); end if;
  if coalesce(trim(p_title), '') = '' or coalesce(trim(p_slug), '') = '' then perform app_private.fail('validation', 'Укажите название и адрес раздела'); end if;
  insert into public.kb_section(id, parent_id, slug, title, description, sort) values (v_id, p_parent, p_slug, p_title, p_description, coalesce(p_sort, 100))
  on conflict (id) do update set parent_id = excluded.parent_id, slug = excluded.slug, title = excluded.title,
    description = excluded.description, sort = excluded.sort;
  return v_id;
end $$;

create function public.article_create(p_section uuid, p_type text, p_title text, p_audience text, p_owner uuid default null,
  p_slug text default null, p_lang text default 'ru') returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_id uuid := gen_random_uuid(); v_rev uuid; v_slug text;
begin
  if not app_private.has_perm_anywhere('kb.edit') then perform app_private.fail('forbidden', 'Нет прав на редактирование базы знаний'); end if;
  if coalesce(trim(p_title), '') = '' then perform app_private.fail('validation', 'Укажите название', 'title'); end if;
  v_slug := coalesce(nullif(trim(p_slug), ''), 'a-' || left(replace(v_id::text, '-', ''), 10));
  insert into public.article(id, slug, section_id, type, owner_id, audience, created_by)
  values (v_id, v_slug, p_section, coalesce(p_type, 'article'), coalesce(p_owner, v_user), coalesce(p_audience, 'all'), v_user);
  insert into public.article_revision(article_id, rev_no, title, body, lang, author_id) values (v_id, 1, p_title, '', coalesce(p_lang, 'ru'), v_user)
  returning id into v_rev;
  perform app_private.audit('kb.create', 'article', v_id, null, jsonb_build_object('title', p_title));
  return jsonb_build_object('article_id', v_id, 'revision_id', v_rev, 'slug', v_slug);
end $$;

-- Автосохранение черновика; если последняя редакция опубликована — создаётся новая (KB-04).
create function public.article_save_draft(p_article uuid, p_title text, p_summary text, p_body text, p_expected_revision int default null,
  p_change_note text default null) returns public.article_revision
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); a public.article; r public.article_revision;
begin
  if not app_private.has_perm_anywhere('kb.edit') then perform app_private.fail('forbidden', 'Нет прав на редактирование'); end if;
  a := app_private.article_load(p_article);
  if coalesce(trim(p_title), '') = '' then perform app_private.fail('validation', 'Укажите название', 'title'); end if;
  if length(coalesce(p_body, '')) > 200000 then perform app_private.fail('validation', 'Статья слишком длинная', 'body'); end if;
  select * into r from public.article_revision where article_id = p_article order by rev_no desc limit 1 for update;
  if r.status in ('draft', 'rejected') then
    if p_expected_revision is not null and r.revision <> p_expected_revision then
      perform app_private.fail('version-conflict', 'Черновик изменил другой редактор. Сравните изменения', r.revision::text);
    end if;
    update public.article_revision set title = p_title, summary = p_summary, body = coalesce(p_body, ''), status = 'draft',
      change_note = coalesce(p_change_note, change_note), author_id = v_user, updated_at = now(), revision = revision + 1
    where id = r.id returning * into r;
  elsif r.status = 'in_review' then
    perform app_private.fail('transition-not-allowed', 'Редакция на согласовании; дождитесь решения или отзовите её');
  else
    insert into public.article_revision(article_id, rev_no, title, summary, body, lang, author_id, change_note)
    values (p_article, r.rev_no + 1, p_title, p_summary, coalesce(p_body, ''), r.lang, v_user, p_change_note) returning * into r;
  end if;
  return r;
end $$;

create function public.article_update_meta(p_article uuid, p_section uuid, p_type text, p_audience text, p_audience_roles text[],
  p_owner uuid, p_tags text[], p_review_due date, p_required_ack boolean) returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.publish') then perform app_private.fail('forbidden', 'Метаданные меняет публикующий редактор'); end if;
  a := app_private.article_load(p_article);
  update public.article set section_id = coalesce(p_section, section_id), type = coalesce(p_type, type),
    audience = coalesce(p_audience, audience), audience_roles = p_audience_roles, owner_id = coalesce(p_owner, owner_id),
    tags = coalesce(p_tags, tags), review_due = p_review_due, required_ack = coalesce(p_required_ack, required_ack),
    updated_at = now(), revision = revision + 1 where id = p_article returning * into a;
  perform app_private.audit('kb.meta', 'article', p_article, null,
    jsonb_build_object('audience', a.audience, 'audience_roles', a.audience_roles, 'required_ack', a.required_ack, 'owner', a.owner_id));
  return a;
end $$;

create function public.article_submit(p_article uuid) returns public.article_revision
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article; r public.article_revision;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.edit') then perform app_private.fail('forbidden', 'Нет прав'); end if;
  a := app_private.article_load(p_article);
  select * into r from public.article_revision where article_id = p_article order by rev_no desc limit 1 for update;
  if r.status not in ('draft', 'rejected') then perform app_private.fail('transition-not-allowed', 'Нет черновика для согласования'); end if;
  if length(trim(r.body)) < 20 then perform app_private.fail('validation', 'Статья слишком короткая для публикации', 'body'); end if;
  update public.article_revision set status = 'in_review', submitted_at = now(), reject_reason = null, updated_at = now(), revision = revision + 1
  where id = r.id returning * into r;
  perform app_private.notify_queue('kb_editor', null, null, 'kb.review', 'Статья на согласовании: ' || r.title, 'Редакция ' || r.rev_no,
    'article', a.id, '/kb/articles/' || a.id || '/review', 'kb.review:' || r.id);
  return r;
end $$;

create function public.article_reject(p_revision uuid, p_reason text) returns public.article_revision
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.article_revision;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.publish') then perform app_private.fail('forbidden', 'Нет прав на согласование'); end if;
  select * into r from public.article_revision where id = p_revision for update;
  if not found or r.status <> 'in_review' then perform app_private.fail('transition-not-allowed', 'Редакция не на согласовании'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите замечания', 'reason'); end if;
  update public.article_revision set status = 'rejected', reject_reason = p_reason, updated_at = now(), revision = revision + 1
  where id = p_revision returning * into r;
  perform app_private.notify(r.author_id, 'kb.rejected', 'Статья возвращена: ' || r.title, p_reason, 'article', r.article_id,
    '/kb/articles/' || r.article_id || '/edit', 'kb.rejected:' || r.id);
  return r;
end $$;

-- Публикация конкретной редакции (KB-02, KB-04, KB-05).
create function public.article_publish(p_revision uuid, p_requires_reack boolean, p_review_due date default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); r public.article_revision; a public.article; v_owner public.app_user;
  v_assigned int := 0; v_first boolean;
begin
  if not app_private.has_perm_anywhere('kb.publish') then perform app_private.fail('forbidden', 'Нет прав на публикацию'); end if;
  select * into r from public.article_revision where id = p_revision for update;
  if not found then perform app_private.fail('not-found', 'Редакция не найдена'); end if;
  select * into a from public.article where id = r.article_id for update;
  if r.status <> 'in_review' then perform app_private.fail('transition-not-allowed', 'Публикуется только редакция на согласовании', r.status); end if;
  select * into v_owner from public.app_user where id = a.owner_id;
  if v_owner.id is null or v_owner.status <> 'active' then
    perform app_private.fail('validation', 'У статьи нет действующего владельца знания', 'owner_id');
  end if;
  perform app_private.sod_check(r.author_id, 'article_publish', 'article', a.id, null);
  v_first := a.published_revision_id is null;
  update public.article_revision set status = 'superseded', updated_at = now() where article_id = a.id and status = 'published';
  update public.article_revision set status = 'published', approved_by = v_user, published_at = now(),
    requires_reack = coalesce(p_requires_reack, false) or (v_first and a.required_ack), change_note = coalesce(p_note, change_note),
    updated_at = now(), revision = revision + 1 where id = r.id returning * into r;
  update public.article set status = 'published', published_revision_id = r.id, review_due = coalesce(p_review_due, review_due),
    export_status = 'pending', export_error = null, updated_at = now(), revision = revision + 1 where id = a.id returning * into a;
  if a.required_ack and r.requires_reack then
    insert into public.ack_assignment(article_id, revision_id, user_id, due_on)
    select a.id, r.id, u, current_date + 7 from app_private.kb_audience_users(a) u
    on conflict do nothing;
    get diagnostics v_assigned = row_count;
    insert into public.notification(user_id, kind, title, body, entity_type, entity_id, link, critical, dedupe_key)
    select u, 'kb.ack', 'Обязательно к ознакомлению: ' || r.title, 'До ' || to_char(current_date + 7, 'DD.MM.YYYY'), 'article', a.id,
      '/kb/articles/' || a.id, true, 'kb.ack:' || r.id
    from app_private.kb_audience_users(a) u on conflict do nothing;
  end if;
  -- Корпоративная копия опубликованной редакции (KB-10, KB-14): публикация не ждёт экспорта
  perform app_private.enqueue('drive.export_article', 'article', a.id, null, jsonb_build_object('revision_id', r.id), 'drive.export_article:' || r.id);
  perform app_private.audit('kb.publish', 'article', a.id, null, jsonb_build_object('rev_no', r.rev_no, 'requires_reack', r.requires_reack,
    'ack_assigned', v_assigned), p_note);
  return jsonb_build_object('article_id', a.id, 'revision_id', r.id, 'rev_no', r.rev_no, 'ack_assigned', v_assigned);
end $$;

create function public.article_archive(p_article uuid, p_reason text) returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.publish') then perform app_private.fail('forbidden', 'Нет прав'); end if;
  a := app_private.article_load(p_article);
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  -- Архив не уничтожает редакции, ознакомления и доказательства (KB-04)
  update public.article set status = 'archived', updated_at = now(), revision = revision + 1 where id = p_article returning * into a;
  perform app_private.audit('kb.archive', 'article', p_article, null, null, p_reason);
  return a;
end $$;

create function public.article_acknowledge(p_revision uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); r public.article_revision; a public.article;
begin
  select * into r from public.article_revision where id = p_revision;
  select * into a from public.article where id = r.article_id;
  if r.id is null or a.published_revision_id <> r.id or not app_private.can_read_article(a) then
    perform app_private.fail('not-found', 'Актуальная редакция не найдена');
  end if;
  insert into public.acknowledgement(revision_id, user_id) values (p_revision, v_user) on conflict do nothing;
  update public.ack_assignment set completed_at = now() where revision_id = p_revision and user_id = v_user and completed_at is null;
end $$;

create function public.kb_feedback_add(p_article uuid, p_kind text, p_comment text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); a public.article;
begin
  a := app_private.article_load(p_article);
  if p_kind not in ('helpful', 'not_helpful', 'outdated', 'suggestion') then perform app_private.fail('validation', 'Неверный тип отзыва'); end if;
  if p_kind in ('outdated', 'suggestion') and coalesce(trim(p_comment), '') = '' then
    perform app_private.fail('validation', 'Опишите, что устарело или что предлагаете', 'comment');
  end if;
  insert into public.kb_feedback(article_id, revision_id, user_id, kind, comment) values (p_article, a.published_revision_id, v_user, p_kind, left(p_comment, 2000));
  if p_kind in ('outdated', 'suggestion') then
    perform app_private.task_create('kb_feedback', 'Проверить замечание к статье', left(p_comment, 500), 'kb_editor', null, null,
      'article', p_article, now() + interval '5 days', 'normal', false, 'kb_feedback:' || p_article || ':' || md5(p_comment), a.owner_id);
  end if;
end $$;

create function public.kb_bind(p_article uuid, p_target_type text, p_target_key text, p_remove boolean default false) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.edit') then perform app_private.fail('forbidden', 'Нет прав'); end if;
  if p_remove then
    delete from public.kb_binding where article_id = p_article and target_type = p_target_type and target_key = p_target_key;
  else
    insert into public.kb_binding(article_id, target_type, target_key) values (p_article, p_target_type, p_target_key) on conflict do nothing;
  end if;
end $$;

-- Статьи, привязанные к контексту работы (KB-06), видимые пользователю.
create function public.kb_for_context(p_target_type text, p_target_key text)
returns table (article_id uuid, slug text, title text, summary text, type text)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select a.id, a.slug, r.title, r.summary, a.type
  from public.kb_binding b join public.article a on a.id = b.article_id join public.article_revision r on r.id = a.published_revision_id
  where b.target_type = p_target_type and b.target_key = p_target_key and app_private.can_read_article(a) and a.status <> 'archived'
  order by r.title
$$;

------------------------------------------------------------------------------
-- Поиск (KB-07, KB-08): только разрешённые статьи; число результатов не раскрывает чужое
------------------------------------------------------------------------------
create function public.kb_search(p_query text, p_include_drafts boolean default false, p_limit int default 20)
returns table (article_id uuid, revision_id uuid, slug text, title text, snippet text, type text, section_title text,
  status text, rev_no int, published_at timestamptz, review_due date, rank real)
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
#variable_conflict use_column
declare v_user uuid := app_private.require_user(); v_q text := trim(coalesce(p_query, '')); v_ts_ru tsquery; v_ts_tr tsquery;
  v_expanded text; s record; v_editor boolean := app_private.kb_is_editor(); v_count int;
begin
  if length(v_q) < 2 then return; end if;
  v_expanded := v_q;
  for s in select * from public.kb_synonym where v_q ilike '%' || term || '%' loop
    v_expanded := v_expanded || ' or ' || s.expands_to;
  end loop;
  v_ts_ru := websearch_to_tsquery('russian', v_expanded);
  v_ts_tr := websearch_to_tsquery('turkish', v_expanded);
  return query
    with candidates as (
      select a.id as aid, r.id as rid, a.slug, r.title, r.body_text, r.summary, a.type, a.section_id, a.status, r.rev_no, r.published_at, a.review_due,
        (ts_rank(r.search, v_ts_ru) + ts_rank(r.search, v_ts_tr) + similarity(r.title, v_q) + word_similarity(v_q, r.body_text) * 0.3)::real as rk
      from public.article a
      join public.article_revision r on r.article_id = a.id
        and (r.id = a.published_revision_id or (v_editor and p_include_drafts and r.rev_no = (select max(rev_no) from public.article_revision x where x.article_id = a.id)))
      where (a.status in ('published', 'needs_review') or (v_editor and p_include_drafts))
        and app_private.can_read_article(a)
        and (r.search @@ v_ts_ru or r.search @@ v_ts_tr or similarity(r.title, v_q) > 0.3 or word_similarity(v_q, r.body_text) > 0.6)
    )
    select c.aid, c.rid, c.slug, c.title,
      ts_headline('russian', coalesce(nullif(c.summary, ''), '') || ' ' || c.body_text, v_ts_ru, 'MaxWords=30, MinWords=12, StartSel=«, StopSel=»'),
      c.type, (select title from public.kb_section where id = c.section_id), c.status, c.rev_no, c.published_at, c.review_due, c.rk
    from candidates c order by c.rk desc limit greatest(1, least(p_limit, 50));
  get diagnostics v_count = row_count;
  insert into public.kb_search_log(user_id, query, results) values (v_user, left(v_q, 200), v_count);
end $$;

------------------------------------------------------------------------------
-- Google Drive: demo-адаптер (KB-10…16, AT-11). Не является синхронизацией с реальным Drive.
------------------------------------------------------------------------------
create function public.demo_drive_change(p_article uuid, p_new_body text, p_external_version text) returns public.article_revision
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article; last public.article_revision; r public.article_revision;
begin
  perform app_private.require_user();
  if not (app_private.has_perm_anywhere('integration.operate') or app_private.has_perm_anywhere('kb.publish')) then
    perform app_private.fail('forbidden', 'Нет прав на демонстрацию обмена');
  end if;
  select * into a from public.article where id = p_article for update;
  if a.source_mode <> 'drive_document' then perform app_private.fail('validation', 'Статья не связана с документом Drive'); end if;
  select * into last from public.article_revision where article_id = p_article order by rev_no desc limit 1;
  if last.status in ('draft', 'in_review') and last.source = 'editor' then
    update public.source_link set sync_status = 'conflict', error = 'Есть незавершённая правка в редакторе PWA' where article_id = p_article;
    perform app_private.task_create('kb_conflict', 'Конфликт исходника Drive и черновика', null, 'kb_editor', null, null, 'article', p_article,
      now() + interval '2 days', 'high', false, 'kb_conflict:' || p_article || ':' || p_external_version, a.owner_id);
    perform app_private.fail('version-conflict', 'Исходник изменён при открытом черновике — нужно решение редактора');
  end if;
  -- изменение исходника создаёт кандидатную редакцию; опубликованная остаётся действующей
  insert into public.article_revision(article_id, rev_no, title, summary, body, lang, status, source, external_version, author_id, submitted_at, change_note)
  values (p_article, last.rev_no + 1, last.title, last.summary, p_new_body, last.lang, 'in_review', 'drive', p_external_version, a.owner_id, now(),
          'Изменение исходного документа Drive (демо)')
  returning * into r;
  update public.source_link set sync_status = 'synced', external_version = p_external_version, last_synced_at = now(), error = null
  where article_id = p_article;
  perform app_private.notify_queue('kb_editor', null, null, 'kb.review', 'Исходник Drive изменён: ' || r.title, 'Кандидатная редакция ' || r.rev_no,
    'article', a.id, '/kb/articles/' || a.id || '/review', 'kb.review:' || r.id);
  return r;
end $$;

create function public.demo_drive_access(p_article uuid, p_available boolean) returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  perform app_private.require_user();
  if not (app_private.has_perm_anywhere('integration.operate') or app_private.has_perm_anywhere('kb.publish')) then
    perform app_private.fail('forbidden', 'Нет прав на демонстрацию обмена');
  end if;
  select * into a from public.article where id = p_article for update;
  if a.source_mode <> 'drive_document' then perform app_private.fail('validation', 'Статья не связана с документом Drive'); end if;
  if not p_available then
    -- отзыв доступа к исходнику: выдача приостановлена, статья исчезает из поиска, владельцу задача (KB-12)
    update public.article set status = 'suspended', updated_at = now(), revision = revision + 1 where id = p_article returning * into a;
    update public.source_link set sync_status = 'unavailable', error = 'Доступ к исходному документу отозван (демо)' where article_id = p_article;
    perform app_private.task_create('kb_source_revoked', 'Восстановить доступ к исходнику статьи', null, 'kb_editor', null, null, 'article', p_article,
      now() + interval '1 day', 'critical', false, 'kb_source_revoked:' || p_article || ':' || to_char(now(), 'YYYYMMDDHH24MI'), a.owner_id);
  else
    update public.article set status = case when published_revision_id is null then 'draft' else 'published' end, updated_at = now(),
      revision = revision + 1 where id = p_article returning * into a;
    update public.source_link set sync_status = 'synced', error = null, last_synced_at = now() where article_id = p_article;
  end if;
  perform app_private.audit(case when p_available then 'kb.source_restored' else 'kb.source_revoked' end, 'article', p_article);
  return a;
end $$;

------------------------------------------------------------------------------
-- Экспорт и восстановление базы знаний (KB-19)
------------------------------------------------------------------------------
create function public.kb_export() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_editor boolean;
begin
  perform app_private.require_user();
  v_editor := app_private.kb_is_editor();
  return jsonb_build_object(
    'format', 'bron-kb-export', 'version', 1, 'exported_at', now(), 'scope', case when v_editor then 'all' else 'published-visible' end,
    'sections', (select coalesce(jsonb_agg(to_jsonb(s) order by s.sort, s.title), '[]'::jsonb) from public.kb_section s),
    'articles', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'slug', a.slug, 'section_id', a.section_id, 'type', a.type, 'audience', a.audience, 'audience_roles', a.audience_roles,
        'status', a.status, 'required_ack', a.required_ack, 'tags', a.tags, 'review_due', a.review_due, 'source_mode', a.source_mode,
        'owner', (select full_name from public.app_user where id = a.owner_id),
        'published_revision_id', a.published_revision_id,
        'revisions', (select jsonb_agg(jsonb_build_object('id', r.id, 'rev_no', r.rev_no, 'title', r.title, 'summary', r.summary,
            'body_format', r.body_format, 'body', r.body, 'lang', r.lang, 'status', r.status, 'published_at', r.published_at,
            'change_note', r.change_note) order by r.rev_no)
          from public.article_revision r where r.article_id = a.id and (v_editor or r.id = a.published_revision_id)),
        'bindings', (select coalesce(jsonb_agg(jsonb_build_object('target_type', b.target_type, 'target_key', b.target_key)), '[]'::jsonb)
          from public.kb_binding b where b.article_id = a.id)
      ) order by a.slug), '[]'::jsonb)
      from public.article a where app_private.can_read_article(a))
  );
end $$;

-- Восстановление из экспорта в пустую или другую установку: существующие slug не перезаписываются.
create function public.kb_import(p_export jsonb) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s jsonb; a jsonb; r jsonb; v_sec_map jsonb := '{}'::jsonb; v_sec uuid; v_art uuid;
  v_rev uuid; v_pub uuid; n_art int := 0; n_skip int := 0;
begin
  if not app_private.has_perm_anywhere('kb.publish') then perform app_private.fail('forbidden', 'Нет прав'); end if;
  if p_export ->> 'format' <> 'bron-kb-export' then perform app_private.fail('validation', 'Неизвестный формат файла'); end if;
  for s in select * from jsonb_array_elements(p_export -> 'sections') loop
    select id into v_sec from public.kb_section where slug = s ->> 'slug';
    if v_sec is null then
      insert into public.kb_section(slug, title, description, sort) values (s ->> 'slug', s ->> 'title', s ->> 'description', coalesce((s ->> 'sort')::int, 100))
      returning id into v_sec;
    end if;
    v_sec_map := v_sec_map || jsonb_build_object(s ->> 'id', v_sec);
  end loop;
  for a in select * from jsonb_array_elements(p_export -> 'articles') loop
    if exists (select 1 from public.article where slug = a ->> 'slug') then n_skip := n_skip + 1; continue; end if;
    insert into public.article(slug, section_id, type, owner_id, audience, audience_roles, required_ack, tags, source_mode, created_by)
    values (a ->> 'slug', (v_sec_map ->> (a ->> 'section_id'))::uuid, a ->> 'type', v_user, a ->> 'audience',
      case when jsonb_typeof(a -> 'audience_roles') = 'array' then array(select jsonb_array_elements_text(a -> 'audience_roles')) end,
      coalesce((a ->> 'required_ack')::boolean, false), array(select jsonb_array_elements_text(coalesce(a -> 'tags', '[]'::jsonb))), 'native', v_user)
    returning id into v_art;
    v_pub := null;
    for r in select * from jsonb_array_elements(a -> 'revisions') loop
      insert into public.article_revision(article_id, rev_no, title, summary, body, lang, status, source, author_id, approved_by, published_at, change_note)
      values (v_art, (r ->> 'rev_no')::int, r ->> 'title', r ->> 'summary', r ->> 'body', coalesce(r ->> 'lang', 'ru'),
        case when r ->> 'status' in ('published', 'superseded') then r ->> 'status' else 'draft' end, 'import', v_user,
        case when r ->> 'status' in ('published', 'superseded') then v_user end, (r ->> 'published_at')::timestamptz, r ->> 'change_note')
      returning id into v_rev;
      if r ->> 'id' = a ->> 'published_revision_id' then v_pub := v_rev; end if;
    end loop;
    update public.article set published_revision_id = v_pub, status = case when v_pub is null then 'draft' else 'published' end where id = v_art;
    insert into public.kb_binding(article_id, target_type, target_key)
    select v_art, b ->> 'target_type', b ->> 'target_key' from jsonb_array_elements(coalesce(a -> 'bindings', '[]'::jsonb)) b on conflict do nothing;
    n_art := n_art + 1;
  end loop;
  perform app_private.audit('kb.import', 'article', null, null, jsonb_build_object('imported', n_art, 'skipped', n_skip));
  return jsonb_build_object('imported', n_art, 'skipped', n_skip);
end $$;

-- Пересмотр по сроку (фоновая обработка): статья → «требуется пересмотр», задача владельцу или очереди.
create function app_private.kb_timers() returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article; n int := 0; v_owner_active boolean;
begin
  for a in select * from public.article where status = 'published' and review_due is not null and review_due < current_date for update skip locked loop
    update public.article set status = 'needs_review', updated_at = now() where id = a.id;
    select status = 'active' into v_owner_active from public.app_user where id = a.owner_id;
    perform app_private.task_create('kb_review', 'Пересмотреть статью', null, 'kb_editor', null, null, 'article', a.id,
      now() + interval '7 days', 'normal', false, 'kb_review:' || a.id || ':' || a.review_due,
      case when coalesce(v_owner_active, false) then a.owner_id end);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Контракт для модуля Integrations: результат сохранения корпоративной копии (KB-14).
create function app_private.article_export_result(p_article uuid, p_revision uuid, p_ok boolean, p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.article set export_status = case when p_ok then 'done' else 'failed' end,
    export_error = case when p_ok then null else p_error end,
    exported_at = case when p_ok then now() else exported_at end
  where id = p_article and published_revision_id = p_revision
$$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.kb_section enable row level security;
alter table public.article enable row level security;
alter table public.article_revision enable row level security;
alter table public.kb_binding enable row level security;
alter table public.ack_assignment enable row level security;
alter table public.acknowledgement enable row level security;
alter table public.kb_feedback enable row level security;
alter table public.kb_search_log enable row level security;
alter table public.kb_synonym enable row level security;
alter table public.source_link enable row level security;

create policy read_kb on public.kb_section for select to authenticated using (app_private.has_perm_anywhere('kb.read'));
create policy read_kb on public.article for select to authenticated using (app_private.can_read_article(article));
create policy read_kb on public.article_revision for select to authenticated using (app_private.can_read_revision(article_revision));
create policy read_kb on public.kb_binding for select to authenticated
  using (exists (select 1 from public.article a where a.id = article_id and app_private.can_read_article(a)));
create policy read_own on public.ack_assignment for select to authenticated
  using (user_id = auth.uid() or app_private.has_perm_anywhere('kb.publish') or app_private.has_perm_anywhere('metrics.read'));
create policy read_own on public.acknowledgement for select to authenticated
  using (user_id = auth.uid() or app_private.has_perm_anywhere('kb.publish'));
create policy read_editor on public.kb_feedback for select to authenticated using (user_id = auth.uid() or app_private.kb_is_editor());
create policy read_editor on public.kb_search_log for select to authenticated using (app_private.kb_is_editor());
create policy read_all on public.kb_synonym for select to authenticated using (true);
create policy read_editor on public.source_link for select to authenticated using (app_private.kb_is_editor());

insert into app_private.client_table(tbl) values ('public.kb_section'), ('public.article'), ('public.article_revision'), ('public.kb_binding'),
  ('public.ack_assignment'), ('public.acknowledgement'), ('public.kb_feedback'), ('public.kb_search_log'), ('public.kb_synonym'),
  ('public.source_link');
insert into app_private.client_command(fn) values
  ('public.kb_section_upsert(uuid, uuid, text, text, text, int)'), ('public.article_create(uuid, text, text, text, uuid, text, text)'),
  ('public.article_save_draft(uuid, text, text, text, int, text)'),
  ('public.article_update_meta(uuid, uuid, text, text, text[], uuid, text[], date, boolean)'),
  ('public.article_submit(uuid)'), ('public.article_reject(uuid, text)'), ('public.article_publish(uuid, boolean, date, text)'),
  ('public.article_archive(uuid, text)'), ('public.article_acknowledge(uuid)'), ('public.kb_feedback_add(uuid, text, text)'),
  ('public.kb_bind(uuid, text, text, boolean)'), ('public.kb_for_context(text, text)'), ('public.kb_search(text, boolean, int)'),
  ('public.demo_drive_change(uuid, text, text)'), ('public.demo_drive_access(uuid, boolean)'), ('public.kb_export()'), ('public.kb_import(jsonb)');
insert into app_private.policy_helper(fn) values ('app_private.kb_is_editor()'), ('app_private.can_read_article(public.article)'),
  ('app_private.can_read_revision(public.article_revision)');
select app_private.apply_grants();
