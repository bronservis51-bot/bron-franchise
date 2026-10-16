-- 0027 Должностные инструкции (решение владельца 14.10.2026): это статьи базы знаний типа «должностная инструкция»,
-- привязанные к роли. Обязательное ознакомление получают все с этой ролью — и при публикации новой редакции,
-- и сразу при назначении роли новому сотруднику. В профиле — «Моя должность».

do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'public.article'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%instruction%';
  execute format('alter table public.article drop constraint %I', c);
  select conname into c from pg_constraint where conrelid = 'public.kb_binding'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%ticket_category%';
  execute format('alter table public.kb_binding drop constraint %I', c);
end $$;
alter table public.article add constraint article_type_check
  check (type in ('article', 'instruction', 'faq', 'regulation', 'template', 'checklist', 'job_description'));
alter table public.kb_binding add constraint kb_binding_target_type_check
  check (target_type in ('ticket_category', 'workflow_step', 'catalog_item', 'task_kind', 'role'));

-- Привязка инструкции к роли: обязательное ознакомление — ровно этой роли
create or replace function app_private.kb_job_sync_ack_roles() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a_id uuid := coalesce(new.article_id, old.article_id);
begin
  if coalesce(new.target_type, old.target_type) <> 'role' then return null; end if;
  update public.article a set ack_roles = (select array_agg(target_key order by target_key) from public.kb_binding b where b.article_id = a.id and b.target_type = 'role')
  where a.id = a_id and a.type = 'job_description';
  return null;
end $$;
create trigger kb_binding_job_roles after insert or delete on public.kb_binding for each row execute function app_private.kb_job_sync_ack_roles();

-- Новый сотрудник с ролью сразу получает ознакомление с инструкцией своей должности
create function app_private.kb_job_ack_on_assign() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ack_assignment(article_id, revision_id, user_id, due_on)
  select a.id, a.published_revision_id, new.user_id, current_date + 7
  from public.article a join public.kb_binding b on b.article_id = a.id and b.target_type = 'role' and b.target_key = new.role
  where a.type = 'job_description' and a.published_revision_id is not null and a.status in ('published', 'needs_review')
    and not exists (select 1 from public.acknowledgement k where k.revision_id = a.published_revision_id and k.user_id = new.user_id)
  on conflict do nothing;
  return new;
end $$;
create trigger role_assignment_job_ack after insert on public.role_assignment for each row execute function app_private.kb_job_ack_on_assign();

-- «Моя должность»: роли пользователя и их инструкции
create function public.my_role() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user();
begin
  return coalesce((select jsonb_agg(x order by x.name) from (
    select distinct on (r.code) r.code, r.name, r.description,
      coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', v.title, 'summary', v.summary, 'published_at', v.published_at,
          'acknowledged', exists (select 1 from public.acknowledgement k where k.revision_id = a.published_revision_id and k.user_id = v_user)))
        from public.article a join public.kb_binding b on b.article_id = a.id and b.target_type = 'role' and b.target_key = r.code
        join public.article_revision v on v.id = a.published_revision_id
        where a.type = 'job_description' and a.status in ('published', 'needs_review')), '[]'::jsonb) as docs
    from app_private.active_assignments() s join public.role r on r.code = s.role) x), '[]'::jsonb);
end $$;

insert into app_private.client_command(fn) values ('public.my_role()');
select app_private.apply_grants();
