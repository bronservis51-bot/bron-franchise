-- Search keeps the existing RPC contract. Only visible current revisions enter
-- the corpus; terms, synonyms and fuzzy matching cannot reveal a hidden draft.
create function app_private.kb_search_normalize(p_text text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select trim(regexp_replace(replace(lower(coalesce(p_text, '')), 'ё', 'е'), '\s+', ' ', 'g'))
$$;

create or replace function public.kb_search(p_query text, p_include_drafts boolean default false, p_limit int default 20)
returns table (article_id uuid, title text, snippet text, type text, section_title text, status text, published_at timestamptz, rank real)
language plpgsql security definer set search_path = pg_catalog, public, app_private, extensions, pg_temp as $$
#variable_conflict use_column
declare
  v_user uuid := app_private.require_user();
  v_raw text := trim(left(coalesce(p_query, ''), 200));
  v_q text := app_private.kb_search_normalize(left(coalesce(p_query, ''), 200));
  v_keyboard text;
  v_editor boolean := app_private.kb_is_editor();
  v_count int;
begin
  if not app_private.has_perm_anywhere('kb.read') and not v_editor then
    perform app_private.fail('forbidden', 'Недостаточно прав');
  end if;
  if length(v_q) < 2 or v_q in ('не', 'нет', 'без') then return; end if;
  -- Offer a Russian keyboard interpretation alongside the original. Latin
  -- product names retain their original interpretation and its ranking bonus.
  v_keyboard := case when v_q ~ '[a-z]' and v_q !~ '[а-я]'
    then translate(v_q, 'qwertyuiop[]asdfghjkl;''zxcvbnm,.`', 'йцукенгшщзхъфывапролджэячсмитьбюе') end;

  return query
  with variants as (
    select v_q as q, 0 as variant
    union all select v_keyboard, 1 where v_keyboard is not null and v_keyboard <> v_q
  ),
  terms as materialized (
    select distinct v.q, v.variant, w.term,
      plainto_tsquery(case when w.term in ('не', 'нет', 'без') then 'simple' else 'russian' end::regconfig, w.term) as exact_query,
      case when w.term in ('не', 'нет', 'без') then plainto_tsquery('simple', w.term)
      else websearch_to_tsquery('russian', w.term || coalesce((
        select ' or ' || string_agg(s.expands_to, ' or ')
        from (
          select term, expands_to from public.kb_synonym
          union all select * from (values
            ('наня', 'найм or подбор'), ('найм', 'нанять or подбор'),
            ('собес', 'собеседование'), ('адаптац', 'стажировка or обучение'),
            ('восстанов', 'доступ or пароль or сбросить'),
            ('зарплат', 'оплата труда'), ('зп', 'зарплата'),
            ('ваканс', 'найм or подбор'), ('поклей', 'оклейка'), ('оклей', 'поклейка')
          ) aliases(term, expands_to)
        ) s
        where w.term like app_private.kb_search_normalize(s.term) || '%'
      ), '')) end as expanded_query
    from variants v
    cross join lateral (
      select token as term from regexp_split_to_table(v.q, '[^[:alnum:]]+') token
      where length(token) >= 2 and (numnode(plainto_tsquery('russian', token)) > 0 or token in ('не', 'нет', 'без'))
        and token not in ('делать', 'сделать', 'нужно', 'нужен', 'нужна', 'можно', 'пожалуйста', 'подскажите', 'проводить')
      limit 16
    ) w
  ),
  documents as materialized (
    select a.id as aid, r.id as rid, r.title, r.summary, r.body_text, a.type, a.section_id,
      case when r.status = 'draft' then 'draft' else a.status end as status,
      r.published_at,
      app_private.kb_search_normalize(r.title) as nt,
      app_private.kb_search_normalize(coalesce(r.summary, '')) as ns,
      app_private.kb_search_normalize(r.body_text) as nb,
      app_private.kb_search_normalize(array_to_string(a.tags, ' ')) as ng
    from public.article a
    join public.article_revision r on r.article_id = a.id
      and (r.id = a.published_revision_id
        or (v_editor and coalesce(p_include_drafts, false) and r.status = 'draft'
          and r.rev_no = (select max(x.rev_no) from public.article_revision x where x.article_id = a.id and x.status = 'draft')))
    where a.status <> 'archived'
      and (a.status = 'published' or (v_editor and coalesce(p_include_drafts, false)))
      and app_private.can_read_article(a)
  ),
  vectors as materialized (
    select d.*, to_tsvector('russian', nt) as vt, to_tsvector('russian', ns) as vs,
      to_tsvector('russian', nb) as vb, to_tsvector('russian', ng) as vg from documents d
  ),
  scored as (
    select d.rid, t.variant, t.q, t.term, t.expanded_query,
      case
        -- Russian stop dictionaries remove negation. Keep it literal: «нет
        -- товара» must not become a match for every mention of «товар».
        when t.term in ('не', 'нет', 'без') then
          case when d.nt ~ ('(^|[^[:alnum:]])' || t.term || '([^[:alnum:]]|$)') then 12.0
            when (d.ns || ' ' || d.nb || ' ' || d.ng) ~ ('(^|[^[:alnum:]])' || t.term || '([^[:alnum:]]|$)') then 5.0 else 0.0 end
        when d.vt @@ t.exact_query then 12.0
        when d.vg @@ t.exact_query then 10.0
        when d.vt @@ t.expanded_query then 12.0
        when d.vg @@ t.expanded_query then 7.0
        when d.vs @@ t.exact_query then 6.0
        when d.vb @@ t.exact_query then 5.0
        when d.vs @@ t.expanded_query or d.vb @@ t.expanded_query then 4.0
        when length(t.term) >= 3 and (d.nt ~ ('(^|[^[:alnum:]])' || t.term) or d.ng ~ ('(^|[^[:alnum:]])' || t.term)) then 3.5
        when length(t.term) >= 4 and greatest(strict_word_similarity(t.term, d.nt), strict_word_similarity(t.term, d.ng)) >= 0.45 then 3.0
        when length(t.term) >= 4 and greatest(strict_word_similarity(t.term, d.ns), strict_word_similarity(t.term, d.nb)) >= 0.55 then 2.0
        else 0.0 end as score
    from vectors d cross join terms t
  ),
  term_weights as (
    -- Common words such as «сотрудник» should not outrank the specific task
    -- «нанять». Document frequency is computed only over permitted revisions.
    select variant, term, 1 + ln(count(*)::numeric / greatest(count(*) filter (where score > 0), 1)) as weight
    from scored group by variant, term
  ),
  matched as (
    select s.rid, s.variant, s.q, sum(s.score * w.weight) / sum(w.weight) as term_score,
      string_agg('(' || s.expanded_query::text || ')', ' & ')::tsquery as headline_query
    from scored s join term_weights w on w.variant = s.variant and w.term = s.term
    group by s.rid, s.variant, s.q having min(s.score) > 0
  ),
  ranked as (
    select d.*, m.headline_query,
      (m.term_score + case when d.nt = m.q then 40 when strpos(d.nt, m.q) > 0 then 15 else 0 end
        + case when m.variant = 0 then 1 else 0 end)::real as rk
    from matched m join documents d on d.rid = m.rid
  ),
  best as (
    select distinct on (aid) * from ranked order by aid, rk desc, (status = 'draft') desc
  )
  select b.aid, b.title,
    ts_headline('russian', coalesce(nullif(b.summary, ''), b.title) || ' ' ||
      regexp_replace(b.body_text, 'https?://[^[:space:]]+', '', 'g'), b.headline_query,
      'MaxWords=32, MinWords=12, MaxFragments=2, FragmentDelimiter= … , StartSel=«, StopSel=»'),
    b.type, s.title, b.status, b.published_at, b.rk
  from best b join public.kb_section s on s.id = b.section_id
  order by b.rk desc, b.published_at desc nulls last, b.aid
  limit greatest(1, least(coalesce(p_limit, 20), 100));

  get diagnostics v_count = row_count;
  if not v_editor then
    insert into public.kb_search_log(user_id, query, results) values (v_user, v_raw, v_count);
  end if;
end $$;

-- The normalizer is not a public API; existing RPC grants are preserved.
revoke all on function app_private.kb_search_normalize(text) from public, anon, authenticated;
revoke all on function public.kb_search(text, boolean, int) from public, anon;
grant execute on function public.kb_search(text, boolean, int) to authenticated;
