-- Operational roles, categorized support, versioned motivation and optional daily learning.
-- Public RPCs follow ADR-0004; private tables have no client grants.
insert into public.role(code,name,scope_type,description) values
 ('technical_specialist','Технический специалист','company','Технические вопросы и редактор базы знаний');
insert into public.role_permission(role,permission) values
 ('technical_specialist','kb.read'),('technical_specialist','kb.edit');
update public.role set name='Менеджер продаж' where code='franchisee_staff';

-- Company scope is not itself a financial/organizational permission.
create or replace function app_private.is_manager() returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select exists(select 1 from app_private.active_assignments() where role='franchise_manager')
$$;
create or replace function app_private.in_scope(p_partner uuid) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select exists(select 1 from app_private.active_assignments() a
 where a.role='franchise_manager' or (a.scope_type='partner' and a.scope_id=p_partner))
$$;
-- Cashiers have their own staff RPCs; the partner record includes a private ordering link.
alter policy read_scope on public.partner using
 (app_private.is_manager() or app_private.has_perm('staff.manage',id));

create function app_private.access_email(p_login text) returns text
language plpgsql immutable set search_path=pg_catalog,app_private,pg_temp as $$
declare v text:=lower(trim(p_login));
begin
 if v is null or v !~ '^[a-z][a-z0-9._-]{1,39}$' then perform app_private.fail('validation','Логин: 2–40 латинских букв, цифр, точек, _ или -. Начните с буквы','login'); end if;
 return v||'@access.bron.local';
end $$;

create function public.support_accounts() returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',u.id,'full_name',u.full_name,'login',split_part(u.email,'@',1),
 'active',u.status='active' and exists(select 1 from role_assignment z where z.user_id=u.id and z.role='technical_specialist' and z.revoked_at is null)))
 from public.app_user u where exists(select 1 from role_assignment a where a.user_id=u.id and a.role='technical_specialist')),'[]');
end $$;
create function public.support_account_create(p_full_name text,p_login text,p_password text) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user(); v_user uuid;
begin
 perform app_private.require_perm('org.manage');
 if coalesce(length(trim(p_full_name)),0) not between 1 and 160 then perform app_private.fail('validation','Укажите имя'); end if;
 v_user:=app_private.create_login(app_private.access_email(p_login),p_password,p_full_name);
 insert into public.role_assignment(user_id,role,scope_type,granted_by) values(v_user,'technical_specialist','company',v_actor);
 perform app_private.audit('support.create','app_user',v_user,null); return v_user;
end $$;
create function public.support_set_active(p_user uuid,p_active boolean) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user();
begin
 perform app_private.require_perm('org.manage');
 perform pg_advisory_xact_lock(hashtextextended('support:'||p_user,0));
 if p_active is null or p_user=v_actor or not exists(select 1 from role_assignment where user_id=p_user and role='technical_specialist')
 or exists(select 1 from role_assignment where user_id=p_user and role<>'technical_specialist' and revoked_at is null)
 then perform app_private.fail('forbidden','Нельзя изменить эту учётную запись'); end if;
 delete from auth.sessions where user_id=p_user;
 update auth.users set banned_until=case when p_active then null else now()+interval '100 years' end where id=p_user;
 update public.app_user set status=case when p_active then 'active' else 'suspended' end where id=p_user;
 if p_active then
  if not exists(select 1 from role_assignment where user_id=p_user and role='technical_specialist' and revoked_at is null) then
   insert into public.role_assignment(user_id,role,scope_type,granted_by) values(p_user,'technical_specialist','company',v_actor);
  end if;
 else update public.role_assignment set revoked_at=now(),revoked_by=v_actor where user_id=p_user and revoked_at is null;
 end if;
 perform app_private.audit('support.active','app_user',p_user,null,jsonb_build_object('active',p_active));
end $$;

-- A working manager also has a staff membership for shifts. Only owners create managers.
create function public.staff_account_create(p_partner uuid,p_full_name text,p_login text,p_password text,p_locations uuid[],p_manager boolean default false) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user(); v_user uuid;
begin
 perform app_private.require_perm(case when p_manager then 'team.manage' else 'staff.manage' end,p_partner);
 if p_manager is null or coalesce(length(trim(p_full_name)),0) not between 1 and 160 then perform app_private.fail('validation','Укажите имя и роль'); end if;
 if not exists(select 1 from partner where id=p_partner and status='active') then perform app_private.fail('not-found','Франчайзи не найден'); end if;
 perform app_private.check_staff_locations(p_partner,p_locations);
 v_user:=app_private.create_login(app_private.access_email(p_login),p_password,p_full_name);
 insert into public.staff_member(user_id,partner_id,phone,location_ids,created_by) values(v_user,p_partner,lower(trim(p_login)),p_locations,v_actor);
 insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(v_user,'franchisee_staff','partner',p_partner,v_actor);
 if p_manager then insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(v_user,'franchisee_manager','partner',p_partner,v_actor); end if;
 perform app_private.audit('staff.create','staff_member',v_user,p_partner,jsonb_build_object('manager',p_manager)); return v_user;
end $$;
create or replace function app_private.can_manage_user(p_user uuid) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select p_user is distinct from auth.uid() and not exists(select 1 from role_assignment where user_id=p_user and scope_type='company' and revoked_at is null)
 and (app_private.has_perm('org.manage') or (
 not exists(select 1 from role_assignment a where a.user_id=p_user and a.revoked_at is null and
   (a.role not in ('franchisee_staff','franchisee_manager') or not app_private.has_perm(case when a.role='franchisee_manager' then 'team.manage' else 'staff.manage' end,a.scope_id)))
 and (exists(select 1 from staff_member s where s.user_id=p_user and app_private.has_perm('staff.manage',s.partner_id))
 or exists(select 1 from role_assignment a where a.user_id=p_user and a.role='franchisee_manager' and app_private.has_perm('team.manage',a.scope_id)))))
$$;
create function app_private.staff_sync_active(p_user uuid,p_active boolean) returns void
language sql security definer set search_path=public,app_private,pg_temp as $$
 update public.staff_member set active=p_active where user_id=p_user
$$;
create or replace function public.team_set_active(p_partner uuid,p_user uuid,p_active boolean) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user();
begin
 perform app_private.require_perm('team.manage',p_partner);
 perform pg_advisory_xact_lock(hashtextextended('team:'||p_user,0));
 if p_active is null or not app_private.can_manage_user(p_user) or not exists(select 1 from role_assignment where user_id=p_user and role='franchisee_manager' and scope_id=p_partner)
 or exists(select 1 from role_assignment where user_id=p_user and revoked_at is null and (role not in ('franchisee_manager','franchisee_staff') or scope_id<>p_partner)) then perform app_private.fail('forbidden','Нельзя изменять эту учётную запись'); end if;
 delete from auth.sessions where user_id=p_user;
 update auth.users set banned_until=case when p_active then null else now()+interval '100 years' end where id=p_user;
 update public.app_user set status=case when p_active then 'active' else 'suspended' end,updated_at=now() where id=p_user;
 perform app_private.staff_sync_active(p_user,p_active);
 if p_active then
  if not exists(select 1 from role_assignment where user_id=p_user and role='franchisee_manager' and revoked_at is null) then
   insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(p_user,'franchisee_manager','partner',p_partner,v_actor);
  end if;
  if exists(select 1 from staff_member where user_id=p_user) and not exists(select 1 from role_assignment where user_id=p_user and role='franchisee_staff' and revoked_at is null) then
   insert into public.role_assignment(user_id,role,scope_type,scope_id,granted_by) values(p_user,'franchisee_staff','partner',p_partner,v_actor);
  end if;
 else update public.role_assignment set revoked_at=now(),revoked_by=v_actor where user_id=p_user and revoked_at is null;
 end if;
 perform app_private.audit('team.active','app_user',p_user,p_partner,jsonb_build_object('active',p_active));
end $$;

-- Preserve the setter contract but prevent arbitrary outbound URLs in a trusted button.
create or replace function public.partner_order_url_set(p_partner uuid,p_url text) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v text:=nullif(trim(p_url),''); v_old text;
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 if v is not null and v !~ '^https://(b2b\.moysklad\.ru/[A-Za-z0-9]+(/catalog)?|online\.moysklad\.ru/public/[A-Za-z0-9]+/catalog)/?$' then perform app_private.fail('validation','Нужна персональная ссылка b2b.moysklad.ru','url'); end if;
 select order_url into v_old from public.partner where id=p_partner for update;
 if not found then perform app_private.fail('not-found','Франчайзи не найден'); end if;
 update public.partner set order_url=v,updated_at=now() where id=p_partner;
 perform app_private.audit('partner.order_url','partner',p_partner,p_partner,jsonb_build_object('from',v_old,'to',v));
end $$;

-- Support routing: network manager can see both queues, specialist sees only technical.
alter table public.kb_question add column category text not null default 'other'
 check(category in ('films','equipment','app','orders','finance','team','other'));
alter table public.kb_question add column route text not null default 'franchise' check(route in ('franchise','technical'));
create function app_private.can_support(p_route text) returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select app_private.is_manager() or (p_route='technical' and exists(select 1 from app_private.active_assignments() where role='technical_specialist'))
$$;
alter policy read_own on public.kb_question using (user_id=auth.uid() or app_private.can_support(route));
create function public.kb_ask_categorized(p_question text,p_category text,p_article uuid default null) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); v uuid;
begin
 if not app_private.has_perm_anywhere('kb.read') then perform app_private.fail('forbidden','Недостаточно прав'); end if;
 if p_category is null or p_category not in ('films','equipment','app','orders','finance','team','other') then perform app_private.fail('validation','Выберите категорию','category'); end if;
 if coalesce(length(trim(p_question)),0) not between 3 and 2000 then perform app_private.fail('validation','Вопрос: от 3 до 2000 символов','question'); end if;
 if p_article is not null then perform app_private.article_load(p_article); end if;
 insert into public.kb_question(user_id,partner_id,article_id,question,category,route)
 values(v_user,(select scope_id from app_private.active_assignments() where scope_type='partner' limit 1),p_article,trim(p_question),p_category,
 case when p_category in ('films','equipment','app') then 'technical' else 'franchise' end) returning id into v;
 return v;
end $$;
create or replace function public.kb_ask(p_question text,p_article uuid default null) returns uuid
language sql security definer set search_path=public,app_private,pg_temp as $$ select public.kb_ask_categorized(p_question,'other',p_article) $$;
create or replace function public.kb_questions() returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); v jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'question',q.question,'answer',q.answer,'answered_at',q.answered_at,
 'created_at',q.created_at,'article_id',q.article_id,'category',q.category,'route',q.route,'user_name',u.full_name,
 'partner_name',p.name,'mine',q.user_id=v_user,'unseen',q.user_id=v_user and q.answer is not null and q.seen_at is null)
 order by (q.answer is null) desc,q.created_at desc),'[]') into v
 from public.kb_question q join public.app_user u on u.id=q.user_id left join public.partner p on p.id=q.partner_id
 where q.user_id=v_user or app_private.can_support(q.route);
 update public.kb_question set seen_at=now() where user_id=v_user and answer is not null and seen_at is null;
 return v;
end $$;
create function public.kb_answer_checked(p_question uuid,p_answer text,p_expected_answered_at timestamptz,p_article uuid default null) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); q public.kb_question;
begin
 if not app_private.kb_is_editor() then perform app_private.fail('forbidden','Отвечают сотрудники поддержки'); end if;
 select * into q from public.kb_question where id=p_question for update;
 if not found or not app_private.can_support(q.route) then perform app_private.fail('not-found','Вопрос не найден'); end if;
 if q.answered_at is distinct from p_expected_answered_at then perform app_private.fail('version-conflict','На вопрос уже ответили. Обновите список'); end if;
 if coalesce(length(trim(p_answer)),0) not between 2 and 5000 then perform app_private.fail('validation','Ответ: от 2 до 5000 символов'); end if;
 if p_article is not null then perform app_private.article_load(p_article); end if;
 update public.kb_question set answer=trim(p_answer),answered_by=v_user,answered_at=clock_timestamp(),seen_at=null,article_id=coalesce(p_article,article_id) where id=p_question;
 perform app_private.audit('kb.answer','kb_question',p_question,q.partner_id);
end $$;
create or replace function public.kb_answer(p_question uuid,p_answer text,p_article uuid default null) returns void
language sql security definer set search_path=public,app_private,pg_temp as $$ select public.kb_answer_checked(p_question,p_answer,null,p_article) $$;
create function public.kb_question_route(p_question uuid,p_route text) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare q public.kb_question;
begin
 perform app_private.require_user(); select * into q from public.kb_question where id=p_question for update;
 if not found or not app_private.can_support(q.route) then perform app_private.fail('not-found','Вопрос не найден'); end if;
 if p_route is null or p_route not in ('franchise','technical') then perform app_private.fail('validation','Выберите получателя'); end if;
 update public.kb_question set route=p_route where id=p_question;
 perform app_private.audit('kb.route','kb_question',p_question,q.partner_id,jsonb_build_object('route',p_route));
end $$;
create or replace function public.kb_inbox() returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();
 return jsonb_build_object('unanswered',(select count(*) from kb_question where answer is null and app_private.can_support(route)),
 'new_answers',(select count(*) from kb_question where user_id=auth.uid() and answer is not null and seen_at is null));
end $$;

-- Seven tiers are in minor units; ranges are [from, next_from).
create function app_private.motivation_default() returns jsonb language sql immutable as $$
 select '{"floor_minor":100000,"tiers":[{"from_minor":0,"rate_bp":1700,"bonus_minor":0},{"from_minor":500000,"rate_bp":1800,"bonus_minor":0},{"from_minor":600000,"rate_bp":1900,"bonus_minor":0},{"from_minor":800000,"rate_bp":2000,"bonus_minor":0},{"from_minor":1000000,"rate_bp":2200,"bonus_minor":20000},{"from_minor":1300000,"rate_bp":2300,"bonus_minor":20000},{"from_minor":1800000,"rate_bp":2500,"bonus_minor":30000}]}'::jsonb
$$;
create function app_private.motivation_validate(p jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,app_private,pg_temp as $$
declare x jsonb; last_from bigint:=-1; n int:=0;
begin
 if jsonb_typeof(p) is distinct from 'object' or coalesce(p->>'floor_minor','') !~ '^[0-9]{1,11}$' or jsonb_typeof(p->'tiers') is distinct from 'array' then perform app_private.fail('validation','Некорректная схема мотивации'); end if;
 if jsonb_array_length(p->'tiers') not between 1 and 20 then perform app_private.fail('validation','Нужно от 1 до 20 ступеней'); end if;
 for x in select value from jsonb_array_elements(p->'tiers') loop
  if coalesce(x->>'from_minor','') !~ '^[0-9]{1,11}$' or coalesce(x->>'rate_bp','') !~ '^[0-9]{1,5}$' or coalesce(x->>'bonus_minor','') !~ '^[0-9]{1,11}$' then perform app_private.fail('validation','Проверьте кассу, процент и премию'); end if;
  if (x->>'rate_bp')::int>10000 or (x->>'from_minor')::bigint<=last_from or (n=0 and (x->>'from_minor')::bigint<>0) then perform app_private.fail('validation','Ступени должны начинаться с 0 и возрастать; процент — от 0 до 100'); end if;
  last_from:=(x->>'from_minor')::bigint; n:=n+1;
 end loop;
end $$;
create function app_private.motivation_pay(p_total bigint,p jsonb) returns bigint
language sql immutable as $$
 select greatest((p->>'floor_minor')::bigint,round(p_total*(x->>'rate_bp')::numeric/10000)::bigint)+(x->>'bonus_minor')::bigint
 from jsonb_array_elements(p->'tiers') x where (x->>'from_minor')::bigint<=p_total order by (x->>'from_minor')::bigint desc limit 1
$$;
create table app_private.motivation_scheme(partner_id uuid primary key references public.partner(id),policy jsonb not null,version int not null default 1,updated_at timestamptz not null default now());
alter table app_private.motivation_scheme enable row level security;
alter table public.staff_member add column use_partner_motivation boolean not null default false;
alter table public.staff_member alter column use_partner_motivation set default true;
alter table public.work_shift add column pay_policy jsonb;
create function public.motivation_get(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user(); perform app_private.require_perm('staff.manage',p_partner);
 return jsonb_build_object('version',coalesce((select version from app_private.motivation_scheme where partner_id=p_partner),0),
 'policy',coalesce((select policy from app_private.motivation_scheme where partner_id=p_partner),app_private.motivation_default()),
 'currency',(select currency from public.partner where id=p_partner));
end $$;
create function public.motivation_set(p_partner uuid,p_policy jsonb,p_expected_version int) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v int;
begin
 perform app_private.require_user(); perform app_private.require_perm('team.manage',p_partner);
 perform app_private.motivation_validate(p_policy);
 perform pg_advisory_xact_lock(hashtextextended('motivation:'||p_partner,0));
 select version into v from app_private.motivation_scheme where partner_id=p_partner;
 if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Мотивация уже изменена. Обновите настройки'); end if;
 insert into app_private.motivation_scheme(partner_id,policy) values(p_partner,p_policy) on conflict(partner_id) do update set policy=excluded.policy,version=motivation_scheme.version+1,updated_at=now();
 perform app_private.audit('staff.motivation','partner',p_partner,p_partner);
end $$;
create function public.staff_motivation_set(p_user uuid,p_enabled boolean) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();
 if p_enabled is null or not app_private.can_manage_user(p_user) then perform app_private.fail('forbidden','Нельзя менять условия сотрудника'); end if;
 update public.staff_member set use_partner_motivation=p_enabled where user_id=p_user and app_private.has_perm('staff.manage',partner_id);
 if not found then perform app_private.fail('not-found','Сотрудник не найден'); end if;
 perform app_private.audit('staff.motivation_mode','staff_member',p_user,(select partner_id from staff_member where user_id=p_user),jsonb_build_object('enabled',p_enabled));
end $$;
create function app_private.shift_motivation() returns trigger
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare s public.staff_member;
begin
 if TG_OP='INSERT' then
  select * into s from public.staff_member where user_id=new.employee_id;
  if s.use_partner_motivation then new.pay_policy:=coalesce((select policy from app_private.motivation_scheme where partner_id=new.partner_id),app_private.motivation_default());
  else new.pay_policy:=jsonb_build_object('mode','legacy','rate_bp',s.rate_bp,'fee_minor',s.shift_fee_minor); end if;
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
create trigger shift_motivation before insert or update on public.work_shift for each row execute function app_private.shift_motivation();

-- Learning config is bound to a published revision. Answer keys never leave editor RPCs.
create table app_private.learning_config(article_id uuid primary key references public.article(id),revision_id uuid not null references public.article_revision(id),
 for_managers boolean not null default false,for_sales boolean not null default false,questions jsonb not null default '[]',version int not null default 1);
create table app_private.learning_task(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_user(id),partner_id uuid not null references public.partner(id),
 day date not null,article_id uuid not null references public.article(id),revision_id uuid not null references public.article_revision(id),title text not null,
 questions jsonb not null,read_at timestamptz,completed_at timestamptz,answers jsonb,score int,unique(user_id,day,article_id));
create index on app_private.learning_task(partner_id,day);
alter table app_private.learning_config enable row level security;
alter table app_private.learning_task enable row level security;
create function public.learning_config_get(p_article uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_editor();
 return coalesce((select to_jsonb(c) from app_private.learning_config c where article_id=p_article),jsonb_build_object('for_managers',false,'for_sales',false,'questions','[]'::jsonb,'version',0));
end $$;
create function public.learning_config_set(p_article uuid,p_for_managers boolean,p_for_sales boolean,p_questions jsonb,p_revision uuid,p_expected_version int) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare a public.article; q jsonb; v int;
begin
 perform app_private.require_editor();
 select * into a from public.article where id=p_article for update;
 if not found or a.status<>'published' or a.published_revision_id is distinct from p_revision then perform app_private.fail('version-conflict','Сначала опубликуйте статью и проверьте вопросы по новой редакции'); end if;
 if p_for_managers is null or p_for_sales is null or jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions)>10 then perform app_private.fail('validation','Проверьте параметры обучения'); end if;
 if (p_for_managers or p_for_sales) and jsonb_array_length(p_questions)=0 then perform app_private.fail('validation','Добавьте хотя бы один вопрос для квиза'); end if;
 for q in select value from jsonb_array_elements(p_questions) loop
  if coalesce(length(trim(q->>'prompt')),0) not between 3 and 1000 or jsonb_typeof(q->'choices') is distinct from 'array' then perform app_private.fail('validation','Укажите вопрос и варианты ответа'); end if;
  if jsonb_array_length(q->'choices') not between 2 and 6 or coalesce(q->>'correct','') !~ '^[0-5]$' or (q->>'correct')::int>=jsonb_array_length(q->'choices') then perform app_private.fail('validation','Выберите правильный ответ из 2–6 вариантов'); end if;
  if exists(select 1 from jsonb_array_elements_text(q->'choices') c where length(trim(c)) not between 1 and 500) then perform app_private.fail('validation','Заполните все варианты ответа'); end if;
 end loop;
 select version into v from app_private.learning_config where article_id=p_article;
 if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Настройки обучения изменились'); end if;
 insert into app_private.learning_config(article_id,revision_id,for_managers,for_sales,questions) values(p_article,p_revision,p_for_managers,p_for_sales,p_questions)
 on conflict(article_id) do update set revision_id=excluded.revision_id,for_managers=excluded.for_managers,for_sales=excluded.for_sales,questions=excluded.questions,version=learning_config.version+1;
 perform app_private.audit('kb.learning','article',p_article,null);
end $$;
create function public.learning_today() returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); v_partner uuid; v_manager boolean; v_day date; v_tz text; c record;
begin
 select scope_id into v_partner from app_private.active_assignments() where role in ('franchisee_manager','franchisee_staff') order by role limit 1;
 if v_partner is null then perform app_private.fail('forbidden','Обучение предназначено сотрудникам'); end if;
 if (select count(distinct scope_id) from app_private.active_assignments() where role in ('franchisee_manager','franchisee_staff'))<>1 then perform app_private.fail('validation','Выберите одну компанию для обучения'); end if;
 v_manager:=exists(select 1 from app_private.active_assignments() where role='franchisee_manager');
 select timezone into v_tz from location where partner_id=v_partner and status='active' order by id limit 1;
 v_day:=(now() at time zone coalesce(v_tz,'Europe/Moscow'))::date;
 perform pg_advisory_xact_lock(hashtextextended('learning:'||v_user||':'||v_day,0));
 if not exists(select 1 from app_private.learning_task where user_id=v_user and day=v_day) then
  for c in select lc.*,r.title from app_private.learning_config lc join article a on a.id=lc.article_id join article_revision r on r.id=lc.revision_id
   where a.status='published' and a.published_revision_id=lc.revision_id and case when v_manager then lc.for_managers else lc.for_sales end
   and jsonb_array_length(lc.questions)>0
   order by (select max(day) from app_private.learning_task t where t.user_id=v_user and t.article_id=lc.article_id) asc nulls first,lc.article_id limit 1 loop
    insert into app_private.learning_task(user_id,partner_id,day,article_id,revision_id,title,questions) values(v_user,v_partner,v_day,c.article_id,c.revision_id,c.title,c.questions);
  end loop;
 end if;
 return jsonb_build_object('day',v_day,'items',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'article_id',t.article_id,'revision_id',t.revision_id,'title',t.title,
 'read_at',t.read_at,'completed_at',t.completed_at,'score',t.score,'total',jsonb_array_length(t.questions),
 'questions',(select jsonb_agg(jsonb_build_object('prompt',x->>'prompt','choices',x->'choices') order by ord) from jsonb_array_elements(t.questions) with ordinality q(x,ord))))
 from app_private.learning_task t join article a on a.id=t.article_id where t.user_id=v_user and t.day=v_day and a.status='published' and a.published_revision_id=t.revision_id),'[]'));
end $$;
create function public.learning_read(p_task uuid) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();
 update app_private.learning_task t set read_at=coalesce(t.read_at,now()) from article a where t.id=p_task and t.user_id=auth.uid() and a.id=t.article_id and a.status='published' and a.published_revision_id=t.revision_id;
 if not found then perform app_private.fail('not-found','Материал недоступен или обновлён'); end if;
end $$;
create function public.learning_submit(p_task uuid,p_answers jsonb) returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare t app_private.learning_task; v_score int;
begin
 perform app_private.require_user(); select * into t from app_private.learning_task where id=p_task and user_id=auth.uid() for update;
 if not found then perform app_private.fail('not-found','Задание не найдено'); end if;
 if not exists(select 1 from app_private.active_assignments() where scope_id=t.partner_id and role in ('franchisee_manager','franchisee_staff')) then perform app_private.fail('forbidden','Доступ к обучению закрыт'); end if;
 if not exists(select 1 from article where id=t.article_id and status='published' and published_revision_id=t.revision_id) then perform app_private.fail('version-conflict','Материал обновлён — откройте новую редакцию'); end if;
 if t.completed_at is not null then
  if t.answers is distinct from p_answers then perform app_private.fail('idempotency-conflict','Результат уже записан'); end if;
  return jsonb_build_object('score',t.score,'total',jsonb_array_length(t.questions),'completed_at',t.completed_at);
 end if;
 if t.read_at is null then perform app_private.fail('validation','Сначала изучите материал'); end if;
 if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers)<>jsonb_array_length(t.questions) then perform app_private.fail('validation','Ответьте на все вопросы'); end if;
 if exists(select 1 from jsonb_array_elements(t.questions) with ordinality q(x,n) where coalesce(p_answers->>(n::int-1),'') !~ '^[0-5]$' or (p_answers->>(n::int-1))::int>=jsonb_array_length(x->'choices')) then perform app_private.fail('validation','Некорректный вариант ответа'); end if;
 select count(*)::int into v_score from jsonb_array_elements(t.questions) with ordinality q(x,n) where (x->>'correct')::int=(p_answers->>(n::int-1))::int;
 update app_private.learning_task set answers=p_answers,score=v_score,completed_at=now() where id=t.id;
 return jsonb_build_object('score',v_score,'total',jsonb_array_length(t.questions),'completed_at',now());
end $$;
create function public.learning_report(p_partner uuid,p_month date) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user(); perform app_private.require_perm('staff.manage',p_partner);
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',t.user_id,'user_name',u.full_name,'day',t.day,'article_title',t.title,'article_id',t.article_id,
 'read_at',t.read_at,'completed_at',t.completed_at,'score',t.score,'total',jsonb_array_length(t.questions)) order by t.day desc,u.full_name)
 from app_private.learning_task t join app_user u on u.id=t.user_id where t.partner_id=p_partner and t.day>=date_trunc('month',p_month)::date and t.day<(date_trunc('month',p_month)+interval '1 month')::date),'[]');
end $$;

create or replace function public.staff_home(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; v_month date;
begin
  s := app_private.my_staff();
  v_month := date_trunc('month', coalesce(p_month, (select app_private.local_today(s.location_ids[1]))))::date;
  return jsonb_build_object(
    'month', v_month,
    'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation, 'pay_policy',case when s.use_partner_motivation then coalesce((select policy from app_private.motivation_scheme where partner_id=s.partner_id),app_private.motivation_default()) else null end,
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
      'pay_policy',case when s.use_partner_motivation then coalesce((select policy from app_private.motivation_scheme where partner_id=s.partner_id),app_private.motivation_default()) else null end,
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
create function public.staff_terms_set(p_user uuid,p_full_name text,p_locations uuid[],p_rate_bp int,p_shift_fee bigint,p_use_partner boolean) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();
 perform public.staff_update(p_user,p_full_name,p_locations,p_rate_bp,p_shift_fee);
 perform public.staff_motivation_set(p_user,p_use_partner);
end $$;
create function public.staff_create_terms(p_partner uuid,p_full_name text,p_phone text,p_password text,p_locations uuid[],p_rate_bp int,p_shift_fee bigint,p_use_partner boolean) returns uuid
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v uuid;
begin
 perform app_private.require_user(); perform app_private.require_perm('staff.manage',p_partner);
 if p_phone ~ '[a-zA-Z]' then
  v:=public.staff_account_create(p_partner,p_full_name,p_phone,p_password,p_locations,false);
  perform public.staff_update(v,p_full_name,p_locations,p_rate_bp,p_shift_fee);
 else v:=public.staff_create(p_partner,p_full_name,p_phone,p_password,p_locations,p_rate_bp,p_shift_fee);
 end if;
 perform public.staff_motivation_set(v,p_use_partner); return v;
end $$;
insert into app_private.client_command(fn) values ('public.staff_terms_set(uuid,text,uuid[],integer,bigint,boolean)'),('public.staff_create_terms(uuid,text,text,text,uuid[],integer,bigint,boolean)');
create or replace function public.staff_create(p_partner uuid, p_full_name text, p_phone text, p_password text, p_locations uuid[],
  p_rate_bp int default 0, p_shift_fee bigint default 0) returns uuid
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
declare v_actor uuid := app_private.require_user(); v_user uuid; v_old public.staff_member; v_digits text := app_private.phone_digits(p_phone);
begin
  perform app_private.require_perm('staff.manage', p_partner);
  if coalesce(trim(p_full_name), '') = '' then perform app_private.fail('validation', 'Укажите имя сотрудника', 'full_name'); end if;
  if length(v_digits) < 10 or length(v_digits) > 15 then perform app_private.fail('validation', 'Укажите номер телефона полностью', 'phone'); end if;
  perform app_private.check_staff_locations(p_partner, p_locations);
  perform app_private.check_pay(p_rate_bp, p_shift_fee);
  perform app_private.check_password(p_password);
  -- Ранее удалённый сотрудник этого же франчайзи — возвращаем, а не создаём второго
  select s.* into v_old from public.staff_member s join auth.users u on u.id = s.user_id
  where s.partner_id = p_partner and lower(u.email) = app_private.staff_email(p_phone);
  if v_old.user_id is not null then
    if v_old.active then perform app_private.fail('validation', 'Сотрудник с этим телефоном уже есть', 'phone'); end if;
    if not app_private.can_manage_user(v_old.user_id) then perform app_private.fail('forbidden','Нельзя восстановить эту учётную запись'); end if;
    v_user := v_old.user_id;
    delete from auth.sessions where user_id=v_user;
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), banned_until = null, updated_at = now() where id = v_user;
    update public.app_user set full_name = trim(p_full_name), status = 'active', updated_at = now() where id = v_user;
    update public.staff_member set use_partner_motivation=false, location_ids = p_locations, rate_bp = p_rate_bp, shift_fee_minor = p_shift_fee, active = true, updated_at = now() where user_id = v_user;
  else
    v_user := app_private.create_login(app_private.staff_email(p_phone), p_password, p_full_name);
    insert into public.staff_member(user_id, partner_id, phone, location_ids, rate_bp, shift_fee_minor, created_by, use_partner_motivation)
    values (v_user, p_partner, v_digits, p_locations, p_rate_bp, p_shift_fee, v_actor, false);
  end if;
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by) values (v_user, 'franchisee_staff', 'partner', p_partner, v_actor);
  perform app_private.audit('staff.create', 'staff_member', v_user, p_partner, jsonb_build_object('name', p_full_name, 'rate_bp', p_rate_bp, 'fee', p_shift_fee));
  return v_user;
end $$;
create or replace function public.staff_set_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); s public.staff_member;
begin
  select * into s from public.staff_member where user_id = p_user;
  if not found or not app_private.has_perm('staff.manage', s.partner_id) or not app_private.can_manage_user(p_user) then perform app_private.fail('not-found', 'Сотрудник не найден'); end if;
  if exists(select 1 from role_assignment where user_id=p_user and role='franchisee_manager' and scope_id=s.partner_id) then
    perform public.team_set_active(s.partner_id,p_user,p_active); return;
  end if;
  if p_active then
    update auth.users set banned_until = null where id = p_user;
    update public.app_user set status = 'active', updated_at = now() where id = p_user;
    if not exists (select 1 from public.role_assignment where user_id = p_user and role = 'franchisee_staff' and revoked_at is null) then
      insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by) values (p_user, 'franchisee_staff', 'partner', s.partner_id, v_actor);
    end if;
  else
    update auth.users set banned_until = now() + interval '100 years' where id = p_user;
    update public.app_user set status = 'suspended', updated_at = now() where id = p_user;
    update public.role_assignment set revoked_at = now(), revoked_by = v_actor where user_id = p_user and revoked_at is null;
    delete from auth.sessions where user_id = p_user; -- preserve even open shifts
  end if;
  update public.staff_member set active = p_active, updated_at = now() where user_id = p_user;
  perform app_private.audit(case when p_active then 'staff.restore' else 'staff.remove' end, 'staff_member', p_user, s.partner_id);
end $$;
insert into app_private.policy_helper(fn) values ('app_private.can_support(text)');
insert into app_private.client_command(fn) values
 ('public.support_accounts()'),('public.support_account_create(text,text,text)'),('public.support_set_active(uuid,boolean)'),
 ('public.staff_account_create(uuid,text,text,text,uuid[],boolean)'),
 ('public.kb_ask_categorized(text,text,uuid)'),('public.kb_answer_checked(uuid,text,timestamp with time zone,uuid)'),('public.kb_question_route(uuid,text)'),
 ('public.motivation_get(uuid)'),('public.motivation_set(uuid,jsonb,integer)'),('public.staff_motivation_set(uuid,boolean)'),
 ('public.learning_config_get(uuid)'),('public.learning_config_set(uuid,boolean,boolean,jsonb,uuid,integer)'),
 ('public.learning_today()'),('public.learning_read(uuid)'),('public.learning_submit(uuid,jsonb)'),('public.learning_report(uuid,date)');
select app_private.apply_grants();
