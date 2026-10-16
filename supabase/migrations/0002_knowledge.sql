-- 0002 База знаний: разделы, статьи, редакции (история версий), публикация, поиск, ознакомление.
-- Пишет и публикует только Менеджер по франшизе (kb.edit), без согласования. Франчайзи читают и отмечают «Ознакомлен».
-- Формат тела — Markdown (CommonMark без HTML).

create table public.kb_section (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text,
  sort int not null default 100,
  created_at timestamptz not null default now()
);

create table public.article (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  section_id uuid not null references public.kb_section(id),
  type text not null default 'article' check (type in ('article', 'instruction', 'faq', 'regulation', 'checklist')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_revision_id uuid,
  required_ack boolean not null default false,
  -- С какой редакции нужно (заново) подтвердить ознакомление и с какого момента идёт срок
  ack_rev_no int,
  ack_since timestamptz,
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
  body text not null default '',
  body_text text not null default '',
  search tsvector,
  status text not null default 'draft' check (status in ('draft', 'published', 'superseded')),
  author_id uuid references public.app_user(id),
  published_by uuid references public.app_user(id),
  published_at timestamptz,
  change_note text,
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
  new.search := setweight(to_tsvector('russian', coalesce(new.title, '')), 'A')
    || setweight(to_tsvector('russian', coalesce(new.summary, '')), 'B')
    || setweight(to_tsvector('russian', new.body_text), 'C');
  return new;
end $$;
create trigger revision_prepare before insert or update on public.article_revision
  for each row execute function app_private.revision_prepare();

create table public.acknowledgement (
  article_id uuid not null references public.article(id),
  user_id uuid not null references public.app_user(id),
  rev_no int not null,
  at timestamptz not null default now(),
  primary key (article_id, user_id, rev_no)
);

create table public.kb_synonym (
  term text primary key,
  expands_to text not null
);

------------------------------------------------------------------------------
-- Видимость
------------------------------------------------------------------------------
create function app_private.kb_is_editor() returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.has_perm_anywhere('kb.edit')
$$;

create function app_private.can_read_article(a public.article) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.kb_is_editor()
    or (a.status = 'published' and a.published_revision_id is not null and app_private.has_perm_anywhere('kb.read'))
$$;

create function app_private.can_read_revision(r public.article_revision) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.kb_is_editor()
    or exists (select 1 from public.article a where a.id = r.article_id and a.published_revision_id = r.id and app_private.can_read_article(a))
$$;

-- Читатели, которым нужно подтверждать ознакомление: франчайзи (читают, но не пишут).
create function app_private.kb_readers() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct x.user_id from public.role_assignment x
  join public.app_user u on u.id = x.user_id and u.status = 'active'
  join public.role_permission rp on rp.role = x.role and rp.permission = 'kb.read'
  where x.revoked_at is null
    and not exists (select 1 from public.role_assignment y join public.role_permission e on e.role = y.role and e.permission = 'kb.edit'
                    where y.user_id = x.user_id and y.revoked_at is null)
$$;

create function app_private.article_load(p_article uuid) returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  select * into a from public.article where id = p_article for update;
  if not found or not app_private.can_read_article(a) then perform app_private.fail('not-found', 'Статья не найдена'); end if;
  return a;
end $$;

create function app_private.require_editor() returns uuid
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v uuid := app_private.require_user();
begin
  if not app_private.kb_is_editor() then perform app_private.fail('forbidden', 'Статьи пишет Менеджер по франшизе'); end if;
  return v;
end $$;

------------------------------------------------------------------------------
-- Команды менеджера
------------------------------------------------------------------------------
create function public.kb_section_save(p_id uuid, p_title text, p_description text, p_sort int) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  perform app_private.require_editor();
  if coalesce(trim(p_title), '') = '' then perform app_private.fail('validation', 'Укажите название раздела', 'title'); end if;
  insert into public.kb_section(id, slug, title, description, sort)
  values (v_id, 's-' || left(replace(v_id::text, '-', ''), 10), trim(p_title), nullif(trim(p_description), ''), coalesce(p_sort, 100))
  on conflict (id) do update set title = excluded.title, description = excluded.description, sort = excluded.sort;
  return v_id;
end $$;

create function public.article_create(p_section uuid, p_type text, p_title text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_editor(); v_id uuid := gen_random_uuid(); v_rev uuid;
begin
  if coalesce(trim(p_title), '') = '' then perform app_private.fail('validation', 'Укажите название', 'title'); end if;
  if not exists (select 1 from public.kb_section where id = p_section) then perform app_private.fail('validation', 'Выберите раздел', 'section'); end if;
  insert into public.article(id, slug, section_id, type, created_by)
  values (v_id, 'a-' || left(replace(v_id::text, '-', ''), 10), p_section, coalesce(p_type, 'article'), v_user);
  insert into public.article_revision(article_id, rev_no, title, author_id) values (v_id, 1, trim(p_title), v_user) returning id into v_rev;
  perform app_private.audit('kb.create', 'article', v_id, null, jsonb_build_object('title', p_title));
  return jsonb_build_object('article_id', v_id, 'revision_id', v_rev);
end $$;

-- Сохранение черновика; если последняя редакция опубликована — создаётся новая.
create function public.article_save_draft(p_article uuid, p_title text, p_summary text, p_body text, p_expected_revision int default null)
returns public.article_revision
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_editor(); r public.article_revision;
begin
  perform app_private.article_load(p_article);
  if coalesce(trim(p_title), '') = '' then perform app_private.fail('validation', 'Укажите название', 'title'); end if;
  if length(coalesce(p_body, '')) > 200000 then perform app_private.fail('validation', 'Статья слишком длинная', 'body'); end if;
  select * into r from public.article_revision where article_id = p_article order by rev_no desc limit 1 for update;
  if r.status = 'draft' then
    if p_expected_revision is not null and r.revision <> p_expected_revision then
      perform app_private.fail('version-conflict', 'Черновик уже изменён в другой вкладке. Обновите страницу', r.revision::text);
    end if;
    update public.article_revision set title = trim(p_title), summary = nullif(trim(p_summary), ''), body = coalesce(p_body, ''),
      author_id = v_user, updated_at = now(), revision = revision + 1
    where id = r.id returning * into r;
  else
    insert into public.article_revision(article_id, rev_no, title, summary, body, author_id)
    values (p_article, r.rev_no + 1, trim(p_title), nullif(trim(p_summary), ''), coalesce(p_body, ''), v_user) returning * into r;
  end if;
  update public.article set updated_at = now() where id = p_article;
  return r;
end $$;

create function public.article_update_meta(p_article uuid, p_section uuid, p_type text, p_required_ack boolean, p_tags text[])
returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article; v_pub int;
begin
  perform app_private.require_editor();
  a := app_private.article_load(p_article);
  select rev_no into v_pub from public.article_revision where id = a.published_revision_id;
  update public.article set section_id = coalesce(p_section, section_id), type = coalesce(p_type, type),
    required_ack = coalesce(p_required_ack, required_ack), tags = coalesce(p_tags, tags),
    -- включили обязательное ознакомление у опубликованной статьи — срок пошёл сейчас
    ack_rev_no = case when coalesce(p_required_ack, required_ack) and not required_ack and v_pub is not null then v_pub else ack_rev_no end,
    ack_since = case when coalesce(p_required_ack, required_ack) and not required_ack and v_pub is not null then now() else ack_since end,
    updated_at = now(), revision = revision + 1
  where id = p_article returning * into a;
  perform app_private.audit('kb.meta', 'article', p_article, null, jsonb_build_object('required_ack', a.required_ack, 'type', a.type));
  return a;
end $$;

-- Публикация последнего черновика. p_requires_reack — франчайзи должны заново подтвердить ознакомление.
create function public.article_publish(p_article uuid, p_requires_reack boolean default false, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_editor(); a public.article; r public.article_revision; v_first boolean;
begin
  a := app_private.article_load(p_article);
  select * into r from public.article_revision where article_id = p_article order by rev_no desc limit 1 for update;
  if r.status <> 'draft' then perform app_private.fail('transition-not-allowed', 'Нет изменений для публикации'); end if;
  if length(trim(r.body)) < 20 then perform app_private.fail('validation', 'Статья слишком короткая для публикации', 'body'); end if;
  v_first := a.published_revision_id is null;
  update public.article_revision set status = 'superseded', updated_at = now() where article_id = a.id and status = 'published';
  update public.article_revision set status = 'published', published_by = v_user, published_at = now(),
    change_note = coalesce(nullif(trim(p_note), ''), change_note), updated_at = now(), revision = revision + 1
  where id = r.id returning * into r;
  update public.article set status = 'published', published_revision_id = r.id,
    ack_rev_no = case when required_ack and (v_first or coalesce(p_requires_reack, false) or ack_rev_no is null) then r.rev_no else ack_rev_no end,
    ack_since = case when required_ack and (v_first or coalesce(p_requires_reack, false) or ack_rev_no is null) then now() else ack_since end,
    updated_at = now(), revision = revision + 1
  where id = a.id returning * into a;
  perform app_private.audit('kb.publish', 'article', a.id, null, jsonb_build_object('rev_no', r.rev_no, 'reack', p_requires_reack), p_note);
  return jsonb_build_object('article_id', a.id, 'revision_id', r.id, 'rev_no', r.rev_no);
end $$;

-- В архив и обратно: архив скрывает статью от франчайзи, история редакций и ознакомлений сохраняется.
create function public.article_archive(p_article uuid, p_archived boolean) returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  perform app_private.require_editor();
  a := app_private.article_load(p_article);
  update public.article set status = case when p_archived then 'archived' when published_revision_id is null then 'draft' else 'published' end,
    updated_at = now(), revision = revision + 1
  where id = p_article returning * into a;
  perform app_private.audit(case when p_archived then 'kb.archive' else 'kb.restore' end, 'article', p_article);
  return a;
end $$;

------------------------------------------------------------------------------
-- Чтение и ознакомление
------------------------------------------------------------------------------
create function public.article_acknowledge(p_article uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); a public.article; v_rev int;
begin
  select * into a from public.article where id = p_article;
  if not found or a.status <> 'published' or not app_private.can_read_article(a) then
    perform app_private.fail('not-found', 'Статья не найдена');
  end if;
  select rev_no into v_rev from public.article_revision where id = a.published_revision_id;
  insert into public.acknowledgement(article_id, user_id, rev_no) values (p_article, v_user, v_rev) on conflict do nothing;
end $$;

-- Что мне нужно прочитать: обязательные статьи без подтверждения актуальной редакции.
create function public.kb_to_read() returns table (article_id uuid, title text, summary text, due_on date, published_at timestamptz)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select a.id, r.title, r.summary, (a.ack_since + interval '7 days')::date, r.published_at
  from public.article a join public.article_revision r on r.id = a.published_revision_id
  where a.status = 'published' and a.required_ack and a.ack_rev_no is not null
    and auth.uid() in (select app_private.kb_readers())
    and not exists (select 1 from public.acknowledgement k where k.article_id = a.id and k.user_id = auth.uid() and k.rev_no >= a.ack_rev_no)
  order by a.ack_since
$$;

-- Менеджеру: кто из франчайзи подтвердил ознакомление с актуальной редакцией.
create function public.kb_ack_status(p_article uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  perform app_private.require_editor();
  select * into a from public.article where id = p_article;
  if not found then perform app_private.fail('not-found', 'Статья не найдена'); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', u.id, 'full_name', u.full_name,
      'partner', (select string_agg(p.name, ', ') from public.role_assignment x join public.partner p on p.id = x.scope_id
                  where x.user_id = u.id and x.revoked_at is null),
      'acknowledged_at', (select max(k.at) from public.acknowledgement k where k.article_id = a.id and k.user_id = u.id
                          and k.rev_no >= coalesce(a.ack_rev_no, 0))) order by u.full_name)
    from public.app_user u where u.id in (select app_private.kb_readers())), '[]'::jsonb);
end $$;

-- Поиск: только доступные статьи; черновики — менеджеру по запросу.
create function public.kb_search(p_query text, p_include_drafts boolean default false, p_limit int default 20)
returns table (article_id uuid, title text, snippet text, type text, section_title text, status text, published_at timestamptz, rank real)
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
#variable_conflict use_column
declare v_q text := trim(coalesce(p_query, '')); v_ts tsquery; v_expanded text; s record; v_editor boolean;
begin
  perform app_private.require_user();
  v_editor := app_private.kb_is_editor();
  if length(v_q) < 2 then return; end if;
  v_expanded := v_q;
  for s in select * from public.kb_synonym where v_q ilike '%' || term || '%' loop
    v_expanded := v_expanded || ' or ' || s.expands_to;
  end loop;
  v_ts := websearch_to_tsquery('russian', v_expanded);
  return query
    with candidates as (
      select a.id as aid, r.title, r.body_text, r.summary, a.type, a.section_id, a.status, r.published_at,
        (ts_rank(r.search, v_ts) + similarity(r.title, v_q) + word_similarity(v_q, r.body_text) * 0.3)::real as rk
      from public.article a
      join public.article_revision r on r.article_id = a.id
        and (r.id = a.published_revision_id or (v_editor and p_include_drafts and r.rev_no = (select max(rev_no) from public.article_revision x where x.article_id = a.id)))
      where (a.status = 'published' or (v_editor and p_include_drafts))
        and app_private.can_read_article(a)
        and (r.search @@ v_ts or similarity(r.title, v_q) > 0.3 or word_similarity(v_q, r.body_text) > 0.6)
    )
    select c.aid, c.title,
      ts_headline('russian', coalesce(nullif(c.summary, ''), '') || ' ' || c.body_text, v_ts, 'MaxWords=30, MinWords=12, StartSel=«, StopSel=»'),
      c.type, (select title from public.kb_section where id = c.section_id), c.status, c.published_at, c.rk
    from candidates c order by c.rk desc limit greatest(1, least(p_limit, 50));
end $$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.kb_section enable row level security;
alter table public.article enable row level security;
alter table public.article_revision enable row level security;
alter table public.acknowledgement enable row level security;
alter table public.kb_synonym enable row level security;

create policy read_kb on public.kb_section for select to authenticated using (app_private.has_perm_anywhere('kb.read') or app_private.kb_is_editor());
create policy read_kb on public.article for select to authenticated using (app_private.can_read_article(article));
create policy read_kb on public.article_revision for select to authenticated using (app_private.can_read_revision(article_revision));
create policy read_own on public.acknowledgement for select to authenticated using (user_id = auth.uid() or app_private.kb_is_editor());
create policy read_all on public.kb_synonym for select to authenticated using (true);

insert into app_private.client_table(tbl) values ('public.kb_section'), ('public.article'), ('public.article_revision'),
  ('public.acknowledgement'), ('public.kb_synonym');
insert into app_private.client_command(fn) values
  ('public.kb_section_save(uuid, text, text, int)'), ('public.article_create(uuid, text, text)'),
  ('public.article_save_draft(uuid, text, text, text, int)'), ('public.article_update_meta(uuid, uuid, text, boolean, text[])'),
  ('public.article_publish(uuid, boolean, text)'), ('public.article_archive(uuid, boolean)'),
  ('public.article_acknowledge(uuid)'), ('public.kb_to_read()'), ('public.kb_ack_status(uuid)'),
  ('public.kb_search(text, boolean, int)');
insert into app_private.policy_helper(fn) values ('app_private.kb_is_editor()'), ('app_private.can_read_article(public.article)'),
  ('app_private.can_read_revision(public.article_revision)');
select app_private.apply_grants();
