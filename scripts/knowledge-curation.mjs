// Build a reviewable, transactional content update from a PRIVATE source-backed plan.
// No credentials, article contents or database connection are included here.
export function knowledgeCurationSql(plan) {
  if (!/^[a-z0-9-]{8,100}$/.test(plan.id ?? '')) throw new Error('Нужен уникальный идентификатор проверки');
  const seen = new Set();
  for (const a of plan.articles ?? []) {
    if (seen.has(a.slug)) throw new Error(`Повтор статьи: ${a.slug}`);
    seen.add(a.slug);
    if (!['published', 'draft', 'archived'].includes(a.status)) throw new Error('Неверный статус');
    if (a.status === 'published' && (!(a.sources?.length) || !a.body?.trim() || !a.reason)) throw new Error(`Нет подтверждённого источника: ${a.slug}`);
    if (a.status === 'draft' && a.body?.trim()) throw new Error('Пустой блок не должен содержать выдуманный текст');
    if (!a.title?.trim() || !a.reason) throw new Error('Нужны заголовок и причина изменения');
  }
  const payload = JSON.stringify(plan);
  let tag = '$knowledge_curation$';
  while (payload.includes(tag)) tag = tag.slice(0, -1) + '_$';
  const json = payload.replace(/'/g, "''");
  return `begin;
set local lock_timeout = '5s';
lock table public.kb_section, public.article, public.article_revision in share row exclusive mode;
do ${tag}
declare p jsonb := '${json}'::jsonb; s jsonb; x jsonb; a public.article; r public.article_revision; v_parent uuid; v_section uuid; v_no int; v_id uuid; v_note text;
begin
  for s in select value from jsonb_array_elements(p->'sections') loop
    v_parent := null;
    if s->>'parent' is not null then
      select id into strict v_parent from public.kb_section where slug=s->>'parent';
    end if;
    if exists(select 1 from public.kb_section where slug=s->>'slug' and id<>(s->>'id')::uuid) then raise exception 'Конфликт раздела: %',s->>'slug'; end if;
    insert into public.kb_section(id,slug,title,description,parent_id,icon,sort)
    values ((s->>'id')::uuid,s->>'slug',s->>'title',s->>'description',v_parent,coalesce(s->>'icon','book'),(s->>'sort')::int)
    on conflict (slug) do nothing;
  end loop;
  for x in select value from jsonb_array_elements(p->'articles') loop
    v_note := (p->>'id') || ': ' || (x->>'reason');
    select * into a from public.article where slug=x->>'slug' for update;
    if found then
      if exists(select 1 from public.article_revision where article_id=a.id and change_note=v_note) or
        (x->>'status'='archived' and a.status='archived' and a.id=(x->>'id')::uuid) then continue; end if;
      if x->>'expected_revision' is null or a.id<>(x->>'id')::uuid or a.revision<>(x->>'expected_revision')::int then
        raise exception 'Статья изменилась после проверки: %',x->>'slug';
      end if;
    else
      if x->>'expected_revision' is not null then raise exception 'Исходная статья исчезла: %',x->>'slug'; end if;
      select id into strict v_section from public.kb_section where slug=x->>'section';
      insert into public.article(id,slug,section_id,type) values ((x->>'id')::uuid,x->>'slug',v_section,coalesce(x->>'type','instruction')) returning * into a;
    end if;
    if x->>'status'='archived' then
      update public.article set status='archived', updated_at=now(),revision=revision+1 where id=a.id;
    else
      if exists(select 1 from public.article_revision where article_id=a.id and status='draft') and x->>'expected_revision' is not null then
        raise exception 'Есть авторский черновик, нужна отдельная проверка: %',x->>'slug';
      end if;
      select coalesce(max(rev_no),0)+1 into v_no from public.article_revision where article_id=a.id;
      insert into public.article_revision(article_id,rev_no,title,summary,body,status,published_at,change_note)
      values (a.id,v_no,x->>'title',x->>'summary',coalesce(x->>'body',''),x->>'status',case when x->>'status'='published' then now() end,v_note) returning id into v_id;
      update public.article_revision set status='superseded',updated_at=now() where article_id=a.id and status='published' and id<>v_id;
      select id into strict v_section from public.kb_section where slug=x->>'section';
      update public.article set section_id=v_section,status=x->>'status',published_revision_id=case when x->>'status'='published' then v_id end,
        updated_at=now(),revision=revision+1 where id=a.id;
    end if;
    perform app_private.audit('kb.curate','article',a.id,null,jsonb_build_object('before',to_jsonb(a),'status',x->>'status','check',p->>'id'),x->>'reason');
  end loop;
end ${tag};
commit;`;
}
