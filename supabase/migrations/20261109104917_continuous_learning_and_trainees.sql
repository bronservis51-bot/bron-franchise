-- Continuous, role-scoped training. Private answer keys and immutable attempts.
alter table app_private.learning_config add column for_trainees boolean not null default false,
 add column for_franchisees boolean not null default false,add column stage text not null default 'Работа на точке',
 add column "position" integer not null default 100,add column pass_percent integer not null default 80,
 add column quiz_size integer not null default 0;
update app_private.learning_config set for_trainees=for_sales;
create table app_private.learning_partner_lesson(partner_id uuid references public.partner(id),article_id uuid references public.article(id),
 revision_id uuid not null references public.article_revision(id),settings jsonb not null,version integer not null default 1,primary key(partner_id,article_id));
create table app_private.learning_policy(scope text primary key,settings jsonb not null,version integer not null default 1);
create table app_private.learning_presence(user_id uuid primary key references public.app_user(id),day date not null);
create table app_private.learning_progress(user_id uuid references public.app_user(id),article_id uuid references public.article(id),
 revision_id uuid not null references public.article_revision(id),streak integer not null default 0,due date not null,last_percent integer not null,
 primary key(user_id,article_id));
create table app_private.learning_attempt(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_user(id),
 partner_id uuid not null references public.partner(id),day date not null,article_id uuid not null references public.article(id),revision_id uuid not null references public.article_revision(id),
 title text not null,questions jsonb not null,pass_percent integer not null,policy jsonb not null,started_at timestamptz not null default now(),read_at timestamptz,
 completed_at timestamptz,answers jsonb,score integer,result jsonb);
create table app_private.learning_activity(attempt_id uuid not null references app_private.learning_attempt(id),day date not null,read_at timestamptz,completed_at timestamptz,primary key(attempt_id,day));
alter table app_private.learning_activity enable row level security;
create unique index learning_one_active on app_private.learning_attempt(user_id,article_id) where completed_at is null;
create index learning_attempt_report on app_private.learning_attempt(partner_id,day);
alter table app_private.learning_partner_lesson enable row level security;
alter table app_private.learning_policy enable row level security;
alter table app_private.learning_presence enable row level security;
alter table app_private.learning_progress enable row level security;
alter table app_private.learning_attempt enable row level security;
alter table public.staff_member add column employee_kind text not null default 'employee' check(employee_kind in ('employee','trainee')),
 add column internship_from date,add column internship_until date,add column internship_floor_minor bigint not null default 50000 check(internship_floor_minor>=0),
 add column learning_enabled boolean not null default true;

create function app_private.learning_questions_validate(p jsonb) returns void language plpgsql immutable set search_path=pg_catalog,app_private,pg_temp as $$
declare q jsonb;
begin
 if jsonb_typeof(p) is distinct from 'array' or octet_length(p::text)>1048576 then perform app_private.fail('validation','Проверьте вопросы; большой банк разделите на несколько тем'); end if;
 for q in select value from jsonb_array_elements(p) loop
  if coalesce(length(trim(q->>'prompt')),0) not between 3 and 1000 or jsonb_typeof(q->'choices') is distinct from 'array' then perform app_private.fail('validation','Заполните вопрос и варианты'); end if;
  if jsonb_array_length(q->'choices') not between 2 and 6 or coalesce(q->>'correct','') !~ '^[0-5]$' or (q->>'correct')::int>=jsonb_array_length(q->'choices') then perform app_private.fail('validation','Выберите правильный ответ из 2–6 вариантов'); end if;
  if exists(select 1 from jsonb_array_elements(q->'choices') c where jsonb_typeof(c)<>'string' or coalesce(length(trim(c#>>'{}')),0) not between 1 and 500) then perform app_private.fail('validation','Заполните все варианты'); end if;
 end loop;
end $$;
create or replace function public.learning_config_set(p_article uuid,p_for_managers boolean,p_for_sales boolean,p_questions jsonb,p_revision uuid,p_expected_version int) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare a public.article; v int;
begin
 perform app_private.require_editor();select * into a from article where id=p_article for update;
 if not found or a.status<>'published' or a.published_revision_id is distinct from p_revision then perform app_private.fail('version-conflict','Опубликуйте статью и проверьте вопросы по текущей редакции'); end if;
 perform app_private.learning_questions_validate(p_questions);
 if p_for_managers is null or p_for_sales is null or ((p_for_managers or p_for_sales) and jsonb_array_length(p_questions)=0) then perform app_private.fail('validation','Добавьте вопросы'); end if;
 select version into v from app_private.learning_config where article_id=p_article;
 if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Обучение уже изменено'); end if;
 insert into app_private.learning_config(article_id,revision_id,for_managers,for_sales,for_trainees,questions) values(p_article,p_revision,p_for_managers,p_for_sales,p_for_sales,p_questions)
 on conflict(article_id) do update set revision_id=excluded.revision_id,for_managers=excluded.for_managers,for_sales=excluded.for_sales,questions=excluded.questions,version=learning_config.version+1;
 perform app_private.audit('kb.learning','article',p_article,null);
end $$;
create function public.learning_lesson_get(p_article uuid,p_partner uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();
 if p_partner is null then perform app_private.require_editor();
  return coalesce((select to_jsonb(c) from app_private.learning_config c where article_id=p_article),'{"version":0,"for_managers":false,"for_sales":false,"for_trainees":false,"for_franchisees":false,"questions":[],"stage":"Начало работы","position":100,"pass_percent":80,"quiz_size":0}'::jsonb);
 else perform app_private.require_perm('team.manage',p_partner);
  return coalesce((select settings||jsonb_build_object('version',version,'revision_id',revision_id) from app_private.learning_partner_lesson where partner_id=p_partner and article_id=p_article),'{"version":0,"enabled":true,"questions":[]}'::jsonb);
 end if;
end $$;
create function public.learning_lesson_save(p_article uuid,p_partner uuid,p_revision uuid,p_settings jsonb,p_expected_version int) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare a public.article;v int;q jsonb:=p_settings->'questions';k text;
begin
 perform app_private.require_user();
 if p_partner is null then perform app_private.require_editor(); else perform app_private.require_perm('team.manage',p_partner); end if;
 select * into a from article where id=p_article for update;
 if not found or a.status<>'published' or a.published_revision_id is distinct from p_revision then perform app_private.fail('version-conflict','Проверьте вопросы по опубликованной редакции'); end if;
 perform app_private.learning_questions_validate(q);
 foreach k in array array['for_managers','for_sales','for_trainees','for_franchisees','enabled'] loop
  if p_settings ? k and jsonb_typeof(p_settings->k)<>'boolean' then perform app_private.fail('validation','Проверьте аудитории'); end if;
 end loop;
 if p_partner is null then
  if coalesce(p_settings->>'position','') !~ '^[0-9]{1,6}$' or coalesce(p_settings->>'pass_percent','') !~ '^[0-9]{1,3}$' or (p_settings->>'pass_percent')::int not between 1 and 100 or coalesce(p_settings->>'quiz_size','') !~ '^[0-9]{1,6}$' or length(trim(p_settings->>'stage')) not between 1 and 160 then perform app_private.fail('validation','Укажите этап, порядок, проходной балл и размер теста'); end if;
  if jsonb_array_length(q)=0 and (coalesce((p_settings->>'for_managers')::bool,false) or coalesce((p_settings->>'for_sales')::bool,false) or coalesce((p_settings->>'for_trainees')::bool,false) or coalesce((p_settings->>'for_franchisees')::bool,false)) then perform app_private.fail('validation','Для включённого урока нужны вопросы'); end if;
  select version into v from app_private.learning_config where article_id=p_article;
  if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Урок уже изменён'); end if;
  insert into app_private.learning_config(article_id,revision_id,for_managers,for_sales,for_trainees,for_franchisees,stage,"position",pass_percent,quiz_size,questions)
  values(p_article,p_revision,coalesce((p_settings->>'for_managers')::bool,false),coalesce((p_settings->>'for_sales')::bool,false),coalesce((p_settings->>'for_trainees')::bool,false),coalesce((p_settings->>'for_franchisees')::bool,false),p_settings->>'stage',(p_settings->>'position')::int,(p_settings->>'pass_percent')::int,(p_settings->>'quiz_size')::int,q)
  on conflict(article_id) do update set revision_id=excluded.revision_id,for_managers=excluded.for_managers,for_sales=excluded.for_sales,for_trainees=excluded.for_trainees,for_franchisees=excluded.for_franchisees,stage=excluded.stage,"position"=excluded."position",pass_percent=excluded.pass_percent,quiz_size=excluded.quiz_size,questions=excluded.questions,version=learning_config.version+1;
 else
  select version into v from app_private.learning_partner_lesson where partner_id=p_partner and article_id=p_article;
  if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Вопросы уже изменены'); end if;
  insert into app_private.learning_partner_lesson(partner_id,article_id,revision_id,settings) values(p_partner,p_article,p_revision,p_settings-'version'-'revision_id')
  on conflict(partner_id,article_id) do update set revision_id=excluded.revision_id,settings=excluded.settings,version=learning_partner_lesson.version+1;
 end if;
 perform app_private.audit('learning.lesson','article',p_article,p_partner);
end $$;
create function app_private.learning_context() returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare u uuid:=app_private.require_user();p uuid;r text;d date;tz text;
begin
 if (select count(distinct scope_id) from app_private.active_assignments() where scope_type='partner')>1 then perform app_private.fail('validation','Для обучения нужна одна компания'); end if;
 select scope_id into p from app_private.active_assignments() where scope_type='partner' limit 1;
 if p is null then return jsonb_build_object('partner',null,'audience','none','day',(now() at time zone 'Europe/Moscow')::date,'enabled',false); end if;
 r:=case when exists(select 1 from app_private.active_assignments() where role='franchisee') then 'franchisees'
 when exists(select 1 from app_private.active_assignments() where role='franchisee_manager') then 'managers'
 when exists(select 1 from staff_member where user_id=u and employee_kind='trainee' and app_private.local_today(location_ids[1]) between internship_from and internship_until) then 'trainees' else 'sales' end;
 select timezone into tz from location where partner_id=p and status='active' order by id limit 1;
 d:=(now() at time zone coalesce(tz,'Europe/Moscow'))::date;
 return jsonb_build_object('partner',p,'audience',r,'day',d,'enabled',coalesce((select learning_enabled from staff_member where user_id=u),true));
end $$;
create function app_private.learning_effective_policy(p uuid) returns jsonb language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select '{"enabled":true,"perfect":[3,7,14,30],"passed":[1,3,7,14]}'::jsonb
 ||coalesce((select settings from app_private.learning_policy where scope='global'),'{}')
 ||coalesce((select settings from app_private.learning_policy where scope=p::text),'{}')
$$;
create function public.learning_policy_get(p_partner uuid default null) returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();if p_partner is null then perform app_private.require_perm('org.manage');else perform app_private.require_perm('team.manage',p_partner);end if;
 return jsonb_build_object('policy',app_private.learning_effective_policy(p_partner),'version',coalesce((select version from app_private.learning_policy where scope=coalesce(p_partner::text,'global')),0));
end $$;
create function public.learning_policy_save(p_partner uuid,p_settings jsonb,p_expected_version int) returns void language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare k text;v int;s text:=coalesce(p_partner::text,'global');
begin
 perform app_private.require_user();if p_partner is null then perform app_private.require_perm('org.manage');else perform app_private.require_perm('team.manage',p_partner);end if;
 if jsonb_typeof(p_settings->'enabled') is distinct from 'boolean' then perform app_private.fail('validation','Укажите, включено ли обучение');end if;
 foreach k in array array['perfect','passed'] loop
  if jsonb_typeof(p_settings->k) is distinct from 'array' then perform app_private.fail('validation','Укажите интервалы повторения');end if;
  if jsonb_array_length(p_settings->k) not between 1 and 20 or exists(select 1 from jsonb_array_elements_text(p_settings->k) x where x !~ '^[0-9]{1,3}$' or x::int not between 1 and 365) then perform app_private.fail('validation','Интервалы: от 1 до 365 дней');end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended('learning-policy:'||s,0));select version into v from app_private.learning_policy where scope=s;
 if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Настройки уже изменены');end if;
 insert into app_private.learning_policy(scope,settings) values(s,p_settings) on conflict(scope) do update set settings=excluded.settings,version=learning_policy.version+1;
 perform app_private.audit('learning.policy','partner',p_partner,p_partner);
end $$;
create function app_private.learning_available() returns table(article_id uuid,revision_id uuid,title text,stage text,"position" int,questions jsonb,pass_percent int,quiz_size int)
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 with ctx as(select app_private.learning_context() j)
 select a.id,a.published_revision_id,r.title,coalesce(c.stage,'Работа на точке'),coalesce(c."position",100),
 (case when c.revision_id=a.published_revision_id then c.questions else '[]'::jsonb end)||coalesce(l.settings->'questions','[]'::jsonb),coalesce(c.pass_percent,80),coalesce(c.quiz_size,0)
 from ctx cross join article a join article_revision r on r.id=a.published_revision_id
 left join app_private.learning_config c on c.article_id=a.id and c.revision_id=a.published_revision_id
 left join app_private.learning_partner_lesson l on l.article_id=a.id and l.partner_id=(ctx.j->>'partner')::uuid and l.revision_id=a.published_revision_id
 where a.status='published' and (ctx.j->>'enabled')::bool and coalesce((app_private.learning_effective_policy((ctx.j->>'partner')::uuid)->>'enabled')::bool,true)
 and coalesce((l.settings->>'enabled')::bool,true)
 and coalesce((l.settings->>('for_'||(ctx.j->>'audience')))::bool,(to_jsonb(c)->>('for_'||(ctx.j->>'audience')))::bool,false)
 and jsonb_array_length(coalesce(c.questions,'[]')||coalesce(l.settings->'questions','[]'))>0
$$;
create function public.learning_catalog(p_partner uuid default null) returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();if p_partner is null then perform app_private.require_editor();else perform app_private.require_perm('staff.manage',p_partner);end if;
 return coalesce((select jsonb_agg(jsonb_build_object('article_id',a.id,'revision_id',a.published_revision_id,'title',r.title,'stage',coalesce(c.stage,'Не настроено'),'position',coalesce(c."position",100),'questions',jsonb_array_length(coalesce(c.questions,'[]')),'local_questions',jsonb_array_length(coalesce(l.settings->'questions','[]')),'ready',c.revision_id=a.published_revision_id and jsonb_array_length(c.questions)>0,'local_current',l.revision_id=a.published_revision_id,'for_sales',coalesce(c.for_sales,false),'for_managers',coalesce(c.for_managers,false),'for_trainees',coalesce(c.for_trainees,false),'for_franchisees',coalesce(c.for_franchisees,false)) order by c."position" nulls last,r.title)
 from article a join article_revision r on r.id=a.published_revision_id left join app_private.learning_config c on c.article_id=a.id left join app_private.learning_partner_lesson l on l.article_id=a.id and l.partner_id=p_partner where a.status='published'),'[]');
end $$;
create function public.learning_notice() returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare c jsonb:=app_private.learning_context();
begin return jsonb_build_object('new_day',exists(select 1 from app_private.learning_available()) and not exists(select 1 from app_private.learning_presence where user_id=auth.uid() and day=(c->>'day')::date),'day',c->>'day');end $$;
create function public.learning_visit() returns void language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare c jsonb:=app_private.learning_context();begin
 insert into app_private.learning_presence(user_id,day) values(auth.uid(),(c->>'day')::date) on conflict(user_id) do update set day=excluded.day;
end $$;
create function public.learning_overview() returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare c jsonb:=app_private.learning_context();begin
 return jsonb_build_object('day',c->>'day','audience',c->>'audience','items',coalesce((select jsonb_agg(jsonb_build_object('article_id',l.article_id,'revision_id',l.revision_id,'title',l.title,'stage',l.stage,'questions',jsonb_array_length(l.questions),'due',p.due,'percent',p.last_percent,'completed',p.streak>0,'active',exists(select 1 from app_private.learning_attempt t where t.user_id=auth.uid() and t.article_id=l.article_id and t.revision_id=l.revision_id and t.completed_at is null)) order by case when p.due<=(c->>'day')::date then 0 when p.user_id is null or p.revision_id<>l.revision_id then 1 else 2 end,l."position",l.article_id)
 from app_private.learning_available() l left join app_private.learning_progress p on p.article_id=l.article_id and p.user_id=auth.uid()),'[]'));
end $$;
create function app_private.learning_attempt_public(t app_private.learning_attempt) returns jsonb language sql stable set search_path=public,app_private,pg_temp as $$
 select jsonb_build_object('id',t.id,'article_id',t.article_id,'revision_id',t.revision_id,'title',t.title,'read_at',t.read_at,'completed_at',t.completed_at,'result',t.result,'pass_percent',t.pass_percent,
 'questions',(select jsonb_agg(jsonb_build_object('prompt',x->>'prompt','choices',x->'choices') order by n) from jsonb_array_elements(t.questions) with ordinality q(x,n)))
$$;
create function public.learning_start(p_article uuid) returns jsonb language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare c jsonb:=app_private.learning_context();l record;t app_private.learning_attempt;q jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('learning:'||auth.uid()||':'||p_article,0));
 select * into l from app_private.learning_available() where article_id=p_article;
 if not found then perform app_private.fail('not-found','Урок не назначен или требует проверки новой редакции');end if;
 -- Keep abandoned old revisions in history, but allow the newly reviewed lesson.
 update app_private.learning_attempt set completed_at=now(),result='{"superseded":true}' where user_id=auth.uid() and article_id=p_article and revision_id<>l.revision_id and completed_at is null;
 select * into t from app_private.learning_attempt where user_id=auth.uid() and article_id=p_article and completed_at is null;
 if not found then
  select jsonb_agg(x order by n) into q from (select x,n from jsonb_array_elements(l.questions) with ordinality a(x,n) order by case when l.quiz_size>0 then random() else n::numeric end limit case when l.quiz_size>0 then l.quiz_size else jsonb_array_length(l.questions) end) s;
  insert into app_private.learning_attempt(user_id,partner_id,day,article_id,revision_id,title,questions,pass_percent,policy)
  values(auth.uid(),(c->>'partner')::uuid,(c->>'day')::date,p_article,l.revision_id,l.title,q,l.pass_percent,app_private.learning_effective_policy((c->>'partner')::uuid)) returning * into t;
 end if;
 insert into app_private.learning_activity(attempt_id,day) values(t.id,(c->>'day')::date) on conflict do nothing;
 return app_private.learning_attempt_public(t);
end $$;
create function public.learning_attempt_read(p_attempt uuid) returns void language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare c jsonb:=app_private.learning_context();begin
 update app_private.learning_attempt t set read_at=coalesce(t.read_at,now()) where t.id=p_attempt and t.user_id=auth.uid() and t.partner_id=(c->>'partner')::uuid and t.completed_at is null and exists(select 1 from app_private.learning_available() l where l.article_id=t.article_id and l.revision_id=t.revision_id);
 if not found then perform app_private.fail('not-found','Урок недоступен или обновлён');end if;
 insert into app_private.learning_activity(attempt_id,day,read_at) values(p_attempt,(c->>'day')::date,now()) on conflict(attempt_id,day) do update set read_at=coalesce(learning_activity.read_at,excluded.read_at);
end $$;
create function public.learning_attempt_submit(p_attempt uuid,p_answers jsonb) returns jsonb language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare c jsonb:=app_private.learning_context();t app_private.learning_attempt;points int;percent int;streak int;days int;arr jsonb;res jsonb;d date:=(c->>'day')::date;
begin
 select * into t from app_private.learning_attempt where id=p_attempt and user_id=auth.uid() and partner_id=(c->>'partner')::uuid for update;
 if not found then perform app_private.fail('not-found','Попытка не найдена');end if;
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
create or replace function public.learning_report(p_partner uuid,p_month date) returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('staff.manage',p_partner);
 return coalesce((select jsonb_agg(j order by j->>'day' desc,j->>'user_name') from (
 select jsonb_build_object('user_id',t.user_id,'user_name',u.full_name,'day',x.day,'article_id',t.article_id,'article_title',t.title,'read_at',x.read_at,'completed_at',x.completed_at,'score',case when x.completed_at is not null then t.score else null end,'total',jsonb_array_length(t.questions),'percent',t.result->'percent','next_due',t.result->'next_due') j from app_private.learning_attempt t join app_private.learning_activity x on x.attempt_id=t.id join app_user u on u.id=t.user_id where t.partner_id=p_partner and x.day>=date_trunc('month',p_month)::date and x.day<(date_trunc('month',p_month)+interval '1month')::date
 union all select jsonb_build_object('user_id',t.user_id,'user_name',u.full_name,'day',t.day,'article_id',t.article_id,'article_title',t.title,'read_at',t.read_at,'completed_at',t.completed_at,'score',t.score,'total',jsonb_array_length(t.questions)) from app_private.learning_task t join app_user u on u.id=t.user_id where t.partner_id=p_partner and t.day>=date_trunc('month',p_month)::date and t.day<(date_trunc('month',p_month)+interval '1month')::date) s),'[]');
end $$;

create function public.staff_onboarding_set(p_user uuid,p_settings jsonb) returns void language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare s public.staff_member;k text:=p_settings->>'employee_kind';f date;e date;fee bigint;
begin
 perform app_private.require_user();select * into s from staff_member where user_id=p_user for update;
 if not found or not app_private.can_manage_user(p_user) or not app_private.has_perm('staff.manage',s.partner_id) then perform app_private.fail('forbidden','Нельзя менять условия сотрудника');end if;
 if k is null or k not in ('employee','trainee') or jsonb_typeof(p_settings->'learning_enabled') is distinct from 'boolean' then perform app_private.fail('validation','Проверьте тип сотрудника и обучение');end if;
 if k='trainee' then
  f:=coalesce(nullif(p_settings->>'internship_from','')::date,app_private.local_today(s.location_ids[1]));
  e:=coalesce(nullif(p_settings->>'internship_until','')::date,(f+interval '1 month')::date-1);
  fee:=coalesce((p_settings->>'internship_floor_minor')::bigint,50000);
  if e<f or fee not between 0 and 99999999999 then perform app_private.fail('validation','Проверьте даты и фикс стажировки');end if;
 end if;
 update staff_member set employee_kind=k,internship_from=f,internship_until=e,internship_floor_minor=coalesce(fee,50000),learning_enabled=(p_settings->>'learning_enabled')::bool,updated_at=now() where user_id=p_user;
 perform app_private.audit('staff.onboarding','staff_member',p_user,s.partner_id,p_settings-'password');
end $$;
create function public.staff_profile_save(p_user uuid,p_partner uuid,p_full_name text,p_phone text,p_password text,p_locations uuid[],p_rate_bp int,p_shift_fee bigint,p_use_partner boolean,p_settings jsonb) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare u uuid:=p_user;begin
 perform app_private.require_user();
 if u is null then u:=public.staff_create_terms(p_partner,p_full_name,p_phone,p_password,p_locations,p_rate_bp,p_shift_fee,p_use_partner);
 else perform public.staff_terms_set(u,p_full_name,p_locations,p_rate_bp,p_shift_fee,p_use_partner);end if;
 perform public.staff_onboarding_set(u,p_settings);return u;
end $$;
create function app_private.staff_pay_policy(p_user uuid,p_day date) returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare s public.staff_member;p jsonb;begin
 select * into s from staff_member where user_id=p_user;
 if s.use_partner_motivation or (s.employee_kind='trainee' and p_day between s.internship_from and s.internship_until) then
 p:=coalesce((select policy from app_private.motivation_scheme where partner_id=s.partner_id),app_private.motivation_default());
 if s.employee_kind='trainee' and p_day between s.internship_from and s.internship_until then p:=jsonb_set(p,'{floor_minor}',to_jsonb(s.internship_floor_minor));end if;return p;
 else return jsonb_build_object('mode','legacy','rate_bp',s.rate_bp,'fee_minor',s.shift_fee_minor);end if;
end $$;

create or replace function app_private.shift_motivation() returns trigger
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare s public.staff_member;
begin
 if TG_OP='INSERT' then
  new.pay_policy:=app_private.staff_pay_policy(new.employee_id,new.day);
 elsif old.pay_policy is not null then new.pay_policy:=old.pay_policy;
 end if;
 if new.status='closed' and new.pay_policy is not null then
  if new.pay_policy->>'mode'='legacy' then new.earned_minor:=app_private.shift_pay(new.cash_minor+new.card_minor,(new.pay_policy->>'rate_bp')::int,(new.pay_policy->>'fee_minor')::bigint);
  else
   new.earned_minor:=app_private.motivation_pay(new.cash_minor+new.card_minor,new.pay_policy);
   select (x->>'rate_bp')::int into new.rate_bp from jsonb_array_elements(new.pay_policy->'tiers') x where (x->>'from_minor')::bigint<=new.cash_minor+new.card_minor order by (x->>'from_minor')::bigint desc limit 1;
   new.shift_fee_minor:=(new.pay_policy->>'floor_minor')::bigint;
  end if;
 end if; return new;
end $$;

create or replace function public.staff_home(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; v_month date;
begin
  s := app_private.my_staff();
  v_month := date_trunc('month', coalesce(p_month, (select app_private.local_today(s.location_ids[1]))))::date;
  return jsonb_build_object(
    'month', v_month,
    'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation, 'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
    'partner_name', (select name from public.partner where id = s.partner_id),
    'open_shift', (select to_jsonb(w) || jsonb_build_object('location_name', l.name, 'currency', l.currency)
                   from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = v_user and w.status = 'open'),
    -- только точки и своя смена сегодня; выручки и плана точки здесь нет
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'location_name', l.name, 'currency', l.currency,
        'today', app_private.local_today(l.id),
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

create or replace function public.staff_list(p_partner uuid, p_month date) returns jsonb
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
      'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation,
      'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
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

insert into app_private.client_command(fn) values
 ('public.learning_lesson_get(uuid,uuid)'),('public.learning_lesson_save(uuid,uuid,uuid,jsonb,integer)'),
 ('public.learning_catalog(uuid)'),('public.learning_policy_get(uuid)'),('public.learning_policy_save(uuid,jsonb,integer)'),
 ('public.learning_notice()'),('public.learning_visit()'),('public.learning_overview()'),('public.learning_start(uuid)'),
 ('public.learning_attempt_read(uuid)'),('public.learning_attempt_submit(uuid,jsonb)'),
 ('public.staff_onboarding_set(uuid,jsonb)'),('public.staff_profile_save(uuid,uuid,text,text,text,uuid[],integer,bigint,boolean,jsonb)');
select app_private.apply_grants();
