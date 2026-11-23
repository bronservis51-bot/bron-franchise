-- A superseded attempt was never graded. Its previous edition stays in the activity report.
create or replace function public.learning_attempt_submit(p_attempt uuid,p_answers jsonb) returns jsonb language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare c jsonb:=app_private.learning_context();t app_private.learning_attempt;points int;percent int;streak int;days int;arr jsonb;res jsonb;d date:=(c->>'day')::date;
begin
 select * into t from app_private.learning_attempt where id=p_attempt and user_id=auth.uid() and partner_id=(c->>'partner')::uuid for update;
 if not found then perform app_private.fail('not-found','Попытка не найдена');end if;
 if t.result @> '{"superseded":true}'::jsonb then
  perform app_private.fail('version-conflict','Урок обновлён. Откройте новую редакцию из списка уроков');
 end if;
 if t.completed_at is not null then
  if t.answers is distinct from p_answers then perform app_private.fail('idempotency-conflict','Ответы уже записаны');end if;return t.result;
 end if;
 if not exists(select 1 from app_private.learning_available() l where l.article_id=t.article_id and l.revision_id=t.revision_id) then perform app_private.fail('version-conflict','Урок обновлён или снят с обучения');end if;
 if t.read_at is null then perform app_private.fail('validation','Сначала изучите материал');end if;
 if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers)<>jsonb_array_length(t.questions) then perform app_private.fail('validation','Ответьте на все вопросы');end if;
 if exists(select 1 from jsonb_array_elements(t.questions) with ordinality q(x,n) where coalesce(p_answers->>(n::int-1),'') !~ '^[0-5]$' or (p_answers->>(n::int-1))::int>=jsonb_array_length(x->'choices')) then perform app_private.fail('validation','Проверьте ответы');end if;
 select count(*)::int into points from jsonb_array_elements(t.questions) with ordinality q(x,n) where x->>'correct'=p_answers->>(n::int-1);
 percent:=floor(100.0*points/jsonb_array_length(t.questions));
 select p.streak into streak from app_private.learning_progress p where p.user_id=auth.uid() and p.article_id=t.article_id and p.revision_id=t.revision_id;
 streak:=coalesce(streak,0);
 if percent<t.pass_percent then days:=0;streak:=0;
 else arr:=t.policy->case when percent=100 then 'perfect' else 'passed' end;days:=(arr->>least(streak,jsonb_array_length(arr)-1))::int;streak:=streak+1;end if;
 res:=jsonb_build_object('score',points,'total',jsonb_array_length(t.questions),'percent',percent,'passed',percent>=t.pass_percent,'interval_days',days,'next_due',d+days,'completed_at',now(),
 'feedback',(select jsonb_agg(jsonb_build_object('prompt',x->>'prompt','correct',x->>'correct','choices',x->'choices','chosen',p_answers->(n::int-1)) order by n) from jsonb_array_elements(t.questions) with ordinality q(x,n)));
 update app_private.learning_attempt set completed_at=now(),answers=p_answers,score=points,result=res where id=t.id;
 insert into app_private.learning_activity(attempt_id,day,completed_at) values(t.id,d,now()) on conflict(attempt_id,day) do update set completed_at=excluded.completed_at;
 insert into app_private.learning_progress(user_id,article_id,revision_id,streak,due,last_percent) values(auth.uid(),t.article_id,t.revision_id,streak,d+days,percent)
 on conflict(user_id,article_id) do update set revision_id=excluded.revision_id,streak=excluded.streak,due=excluded.due,last_percent=excluded.last_percent;
 return res;
end $$;

-- Show the result recorded for this attempt, even after the lesson is edited.
create or replace function public.learning_report(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('staff.manage', p_partner);
  return coalesce((
    select jsonb_agg(item order by item->>'day' desc, item->>'user_name')
    from (
      select jsonb_build_object(
        'user_id', t.user_id, 'user_name', u.full_name, 'day', x.day, 'article_id', t.article_id,
        'article_title', t.title, 'read_at', x.read_at, 'completed_at', x.completed_at,
        'material_current', a.status = 'published' and a.published_revision_id is not distinct from t.revision_id,
        'superseded', t.score is null and (coalesce(t.result @> '{"superseded":true}'::jsonb, false)
          or (a.published_revision_id is not null and a.published_revision_id <> t.revision_id)),
        'score', case when x.completed_at is not null then t.score end, 'total', jsonb_array_length(t.questions),
        'percent', case when x.completed_at is not null then t.result->'percent' end,
        'passed', case when x.completed_at is not null then t.result->'passed' end,
        'pass_percent', t.pass_percent,
        'next_due', case when x.completed_at is not null then t.result->'next_due' end
      ) as item
      from app_private.learning_attempt t
      join app_private.learning_activity x on x.attempt_id = t.id
      join public.app_user u on u.id = t.user_id
      join public.article a on a.id = t.article_id
      where t.partner_id = p_partner and (app_private.staff_owner(p_partner) or app_private.staff_member_scope(t.user_id))
        and x.day >= date_trunc('month', p_month)::date and x.day < date_trunc('month', p_month) + interval '1 month'
      union all
      -- Original daily tasks recorded scores only.
      select jsonb_build_object(
        'user_id', t.user_id, 'user_name', u.full_name, 'day', t.day, 'article_id', t.article_id,
        'article_title', t.title, 'read_at', t.read_at, 'completed_at', t.completed_at,
        'material_current', a.status = 'published' and a.published_revision_id is not distinct from t.revision_id,
        'score', t.score, 'total', jsonb_array_length(t.questions), 'passed', null, 'pass_percent', null
      )
      from app_private.learning_task t join public.app_user u on u.id = t.user_id
      join public.article a on a.id = t.article_id
      where t.partner_id = p_partner and (app_private.staff_owner(p_partner) or app_private.staff_member_scope(t.user_id))
        and t.day >= date_trunc('month', p_month)::date and t.day < date_trunc('month', p_month) + interval '1 month'
    ) as activity
  ), '[]'::jsonb);
end $$;
