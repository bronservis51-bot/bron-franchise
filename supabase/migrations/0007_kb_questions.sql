-- 0007 База знаний учится на вопросах: «Не нашли ответ? Спросите» → ответ менеджера → при необходимости новая статья.
-- Неудачные поиски (без результатов) видит менеджер — это список статей, которые стоит написать.

create table public.kb_question (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user(id),
  partner_id uuid references public.partner(id),
  article_id uuid references public.article(id),
  question text not null check (length(question) between 3 and 2000),
  answer text,
  answered_by uuid references public.app_user(id),
  answered_at timestamptz,
  seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.kb_question (user_id, created_at desc);

create table public.kb_search_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  query text not null,
  results int not null,
  at timestamptz not null default now()
);
create index on public.kb_search_log (at desc);

create function public.kb_ask(p_question text, p_article uuid default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_id uuid;
begin
  if not app_private.has_perm_anywhere('kb.read') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  if length(trim(coalesce(p_question, ''))) < 3 then perform app_private.fail('validation', 'Напишите вопрос', 'question'); end if;
  insert into public.kb_question(user_id, partner_id, article_id, question)
  values (v_user, (select scope_id from app_private.active_assignments() where scope_type = 'partner' limit 1), p_article, left(trim(p_question), 2000))
  returning id into v_id;
  return v_id;
end $$;

-- Мои вопросы (франчайзи, сотрудник) или все вопросы сети (менеджер). Открывая список, автор отмечает ответы прочитанными.
create function public.kb_questions() returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_editor boolean := app_private.kb_is_editor(); v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question, 'answer', q.answer, 'answered_at', q.answered_at,
      'created_at', q.created_at, 'article_id', q.article_id, 'user_name', u.full_name, 'partner_name', p.name, 'mine', q.user_id = v_user,
      'unseen', q.user_id = v_user and q.answer is not null and q.seen_at is null)
    order by (q.answer is null) desc, q.created_at desc), '[]'::jsonb) into v
  from public.kb_question q join public.app_user u on u.id = q.user_id left join public.partner p on p.id = q.partner_id
  where q.user_id = v_user or v_editor;
  update public.kb_question set seen_at = now() where user_id = v_user and answer is not null and seen_at is null;
  return v;
end $$;

create function public.kb_answer(p_question uuid, p_answer text, p_article uuid default null) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_editor();
begin
  if length(trim(coalesce(p_answer, ''))) < 2 then perform app_private.fail('validation', 'Напишите ответ', 'answer'); end if;
  update public.kb_question set answer = left(trim(p_answer), 5000), answered_by = v_user, answered_at = now(), seen_at = null,
    article_id = coalesce(p_article, article_id)
  where id = p_question;
  if not found then perform app_private.fail('not-found', 'Вопрос не найден'); end if;
end $$;

-- Счётчики для меню: у менеджера — вопросы без ответа, у остальных — новые ответы.
create function public.kb_inbox() returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select jsonb_build_object(
    'unanswered', case when app_private.kb_is_editor() then (select count(*) from public.kb_question where answer is null) else 0 end,
    'new_answers', (select count(*) from public.kb_question where user_id = auth.uid() and answer is not null and seen_at is null))
$$;

-- Что искали и не нашли за 60 дней (менеджеру).
create function public.kb_search_misses() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_editor();
  return coalesce((select jsonb_agg(jsonb_build_object('query', q, 'times', n, 'last_at', last_at) order by n desc, last_at desc)
    from (select lower(query) q, count(*) n, max(at) last_at from public.kb_search_log
          where results = 0 and at > now() - interval '60 days' group by 1 order by 2 desc, 3 desc limit 30) x), '[]'::jsonb);
end $$;

-- Поиск теперь записывает запрос и число результатов (кроме запросов самого менеджера).
create or replace function public.kb_search(p_query text, p_include_drafts boolean default false, p_limit int default 20)
returns table (article_id uuid, title text, snippet text, type text, section_title text, status text, published_at timestamptz, rank real)
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
#variable_conflict use_column
declare v_user uuid := app_private.require_user(); v_q text := trim(coalesce(p_query, '')); v_ts tsquery; v_expanded text; s record;
  v_editor boolean := app_private.kb_is_editor(); v_count int;
begin
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
  get diagnostics v_count = row_count;
  if not v_editor then insert into public.kb_search_log(user_id, query, results) values (v_user, left(v_q, 200), v_count); end if;
end $$;

alter table public.kb_question enable row level security;
alter table public.kb_search_log enable row level security;
create policy read_own on public.kb_question for select to authenticated using (user_id = auth.uid() or app_private.kb_is_editor());
create policy read_editor on public.kb_search_log for select to authenticated using (app_private.kb_is_editor());

insert into app_private.client_command(fn) values
  ('public.kb_ask(text, uuid)'), ('public.kb_questions()'), ('public.kb_answer(uuid, text, uuid)'),
  ('public.kb_inbox()'), ('public.kb_search_misses()');
select app_private.apply_grants();
