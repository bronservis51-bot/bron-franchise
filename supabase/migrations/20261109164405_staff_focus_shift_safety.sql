create or replace function public.shift_close(p_shift uuid, p_cash bigint, p_card bigint, p_comment text default null) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); w public.work_shift; l public.location; v_month date;
begin
  perform app_private.my_staff();
  select * into w from public.work_shift where id = p_shift and employee_id = v_user for update;
  if not found then perform app_private.fail('not-found', 'Смена не найдена'); end if;
  if not app_private.revenue_day_open(w.location_id,w.day) then perform app_private.fail('period-locked','Период смены закрыт. Передайте дату и итог руководителю для сверки');end if;
  if w.status = 'closed' and w.day < app_private.local_today(w.location_id) then
    perform app_private.fail('period-locked', 'Прошлые смены исправляет франчайзи');
  end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_card, 0) < 0 then perform app_private.fail('validation', 'Сумма не может быть отрицательной', 'cash'); end if;
  if coalesce(p_cash, 0) + coalesce(p_card, 0) > 100000000000 then perform app_private.fail('validation', 'Слишком большая сумма', 'cash'); end if;
  select * into l from public.location where id = w.location_id;
  w := app_private.shift_store(l, v_user, w.day, coalesce(p_cash, 0), coalesce(p_card, 0), p_comment);
  perform app_private.audit('shift.close', 'work_shift', w.id, l.partner_id, jsonb_build_object('cash', w.cash_minor, 'card', w.card_minor, 'earned', w.earned_minor));
  v_month := date_trunc('month', w.day)::date;
  return jsonb_build_object('shift', to_jsonb(w), 'currency', l.currency,
    'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_shifts', (select count(*) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'));
end $$;


-- Staff-only learning; protect shift edits with an independent version, not an end time.
alter table public.work_shift add column revision bigint not null default 0;
create function app_private.shift_revision() returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
begin new.revision:=old.revision+1;return new;end $$;
create trigger shift_revision before update on public.work_shift for each row execute function app_private.shift_revision();

create function public.shift_close_versioned(p_shift uuid,p_cash bigint,p_card bigint,p_expected_revision bigint,p_operation uuid,p_comment text default null) returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare u uuid:=app_private.require_user();w public.work_shift;old app_private.operation_receipt;payload jsonb;answer jsonb;
begin
 perform app_private.my_staff();
 if p_operation is null or p_expected_revision is null or p_cash is null or p_card is null then perform app_private.fail('validation','Укажите обе суммы; если продаж не было — 0');end if;
 payload:=jsonb_build_object('shift',p_shift,'cash',p_cash,'card',p_card,'expected_revision',p_expected_revision,'comment',p_comment);
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_operation::text,0));
 select * into old from app_private.operation_receipt where user_id=u and operation_id=p_operation;
 if found then if old.command<>'shift_close_versioned' or old.payload<>payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные');end if;return old.result;end if;
 select * into w from work_shift where id=p_shift and employee_id=u;
 if not found then perform app_private.fail('not-found','Смена не найдена');end if;
 perform app_private.revenue_day_lock(w.location_id,w.day);
 select * into w from work_shift where id=p_shift and employee_id=u for update;
 if not found then perform app_private.fail('not-found','Смена отменена');end if;
 if w.revision<>p_expected_revision then perform app_private.fail('version-conflict','Смена уже изменена. Откройте её заново и сверьте суммы');end if;
 answer:=public.shift_close(p_shift,p_cash,p_card,p_comment);
 insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(u,p_operation,'shift_close_versioned',payload,answer);
 return answer;
end $$;
create or replace function public.shift_cancel(p_shift uuid) returns void language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare u uuid:=app_private.require_user();w public.work_shift;
begin
 perform app_private.my_staff();perform pg_advisory_xact_lock(hashtextextended('shift-user:'||u,0));
 select * into w from work_shift where id=p_shift and employee_id=u and status='open' for update;
 if not found then perform app_private.fail('not-found','Открытая смена не найдена');end if;
 if w.total_minor<>0 or exists(select 1 from daily_revenue where employee_id=u and location_id=w.location_id and day=w.day) then perform app_private.fail('validation','В смене уже есть данные. Обратитесь к руководителю');end if;
 perform app_private.audit('shift.cancel','work_shift',w.id,w.partner_id,jsonb_build_object('before',to_jsonb(w),'reason','Открыта по ошибке'));
 delete from work_shift where id=w.id;
end $$;
create function public.staff_open_shifts(p_partner uuid) returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('staff.manage',p_partner);
 return coalesce((select jsonb_agg(to_jsonb(w)||jsonb_build_object('user_name',u.full_name,'location_name',l.name,'currency',l.currency,'today',app_private.local_today(l.id),'can_resolve',app_private.can_manage_user(w.employee_id),'can_close',app_private.has_perm('revenue.enter',w.partner_id)) order by w.day,w.opened_at) from work_shift w join app_user u on u.id=w.employee_id join location l on l.id=w.location_id where w.partner_id=p_partner and w.status='open'),'[]');
end $$;
create function public.staff_shift_resolve(p_shift uuid,p_action text,p_cash bigint,p_card bigint,p_expected_revision bigint,p_reason text,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare actor uuid:=app_private.require_user();w public.work_shift;old app_private.operation_receipt;payload jsonb;answer jsonb;
begin
 select * into w from work_shift where id=p_shift;
 -- Receipts also allow a successful cancellation retry after the row is gone.
 payload:=jsonb_build_object('shift',p_shift,'action',p_action,'cash',p_cash,'card',p_card,'expected_revision',p_expected_revision,'reason',p_reason);
 if p_operation is null then perform app_private.fail('validation','Обновите приложение');end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||p_operation::text,0));
 select * into old from app_private.operation_receipt where user_id=actor and operation_id=p_operation;
 if found then if old.command<>'staff_shift_resolve' or old.payload<>payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные');end if;return old.result;end if;
 if w.id is null or not app_private.has_perm('staff.manage',w.partner_id) or not app_private.can_manage_user(w.employee_id) then perform app_private.fail('forbidden','Смену может исправить ответственный руководитель');end if;
 if p_action is null or p_action not in ('cancel','close') or coalesce(length(trim(p_reason)),0) not between 3 and 1000 then perform app_private.fail('validation','Укажите действие и причину');end if;
 perform app_private.revenue_day_lock(w.location_id,w.day);
 select * into w from work_shift where id=p_shift for update;
 if not found or w.status<>'open' or p_expected_revision is distinct from w.revision then perform app_private.fail('version-conflict','Состояние смены изменилось. Обновите список');end if;
 if p_action='cancel' then
  if w.total_minor<>0 or exists(select 1 from daily_revenue where employee_id=w.employee_id and location_id=w.location_id and day=w.day) then perform app_private.fail('validation','Нельзя отменить смену с внесённой выручкой');end if;
  perform app_private.audit('shift.resolve_cancel','work_shift',w.id,w.partner_id,jsonb_build_object('before',to_jsonb(w),'reason',trim(p_reason)));
  delete from work_shift where id=w.id;
 else
  if p_cash is null or p_card is null then perform app_private.fail('validation','Укажите обе суммы');end if;
  perform public.revenue_save(w.location_id,w.day,p_cash,p_card,trim(p_reason),w.employee_id);
  perform app_private.audit('shift.resolve_close','work_shift',w.id,w.partner_id,jsonb_build_object('before',to_jsonb(w),'reason',trim(p_reason)));
 end if;
 answer:=jsonb_build_object('ok',true);
 insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(actor,p_operation,'staff_shift_resolve',payload,answer);
 return answer;
end $$;
create or replace function public.shift_open(p_location uuid) returns public.work_shift
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; l public.location; w public.work_shift; v_day date;
begin
  s := app_private.my_staff();
  perform pg_advisory_xact_lock(hashtextextended('shift-user:'||v_user,0));
  select * into l from public.location where id = p_location;
  if not found or not (p_location = any(s.location_ids)) then perform app_private.fail('not-found', 'Эта точка вам не назначена'); end if;
  if l.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
  select * into w from public.work_shift where employee_id = v_user and status = 'open';
  if found then
    if w.location_id = p_location then return w; end if;
    perform app_private.fail('validation', 'Сначала закройте смену на другой точке');
  end if;
  v_day := app_private.local_today(p_location);
  if exists (select 1 from public.work_shift where employee_id = v_user and location_id = p_location and day = v_day) then
    perform app_private.fail('validation', 'Смена за сегодня уже закрыта. Исправить сумму можно в списке смен ниже');
  end if;
  insert into public.work_shift(partner_id, location_id, employee_id, day) values (l.partner_id, l.id, v_user, v_day) returning * into w;
  perform app_private.audit('shift.open', 'work_shift', w.id, l.partner_id);
  return w;
end $$;

create or replace function public.shift_close_checked(p_shift uuid,p_cash bigint,p_card bigint,p_expected_closed_at timestamptz,p_operation uuid,p_comment text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid:=app_private.require_user(); old app_private.operation_receipt; w public.work_shift; payload jsonb; answer jsonb;
begin
  perform app_private.my_staff();
  if p_operation is null then perform app_private.fail('validation','Обновите приложение'); end if;
  payload:=jsonb_build_object('shift',p_shift,'cash',p_cash,'card',p_card,'comment',p_comment,'expected_closed_at',p_expected_closed_at);
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>'shift_close' or old.payload<>payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные'); end if;
    return old.result;
  end if;
  select * into w from public.work_shift where id=p_shift and employee_id=uid for update;
  if not found then perform app_private.fail('not-found','Смена не найдена'); end if;
  if w.closed_at is distinct from p_expected_closed_at then perform app_private.fail('version-conflict','Смена уже изменена. Откройте её заново и сверьте суммы.'); end if;
  if w.status='closed' then perform app_private.fail('version-conflict','Обновите приложение для исправления закрытой смены. Запись сохранена, сверьте её заново');end if;
  answer:=public.shift_close(p_shift,p_cash,p_card,p_comment);
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'shift_close',payload,answer);
  return answer;
end $$;
create or replace function app_private.learning_context() returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare u uuid:=app_private.require_user();p uuid;r text;d date;tz text;
begin
 if not exists(select 1 from app_private.active_assignments() where role in ('franchisee_staff','franchisee_manager')) or exists(select 1 from app_private.active_assignments() where role='franchisee' or scope_type='company') then return jsonb_build_object('partner',null,'audience','none','day',(now() at time zone 'Europe/Moscow')::date,'enabled',false);end if;
 if (select count(distinct scope_id) from app_private.active_assignments() where scope_type='partner')>1 then perform app_private.fail('validation','Для обучения нужна одна компания'); end if;
 select scope_id into p from app_private.active_assignments() where scope_type='partner' limit 1;
 if p is null then return jsonb_build_object('partner',null,'audience','none','day',(now() at time zone 'Europe/Moscow')::date,'enabled',false); end if;
 r:=case when exists(select 1 from app_private.active_assignments() where role='franchisee') then 'franchisees'
 when exists(select 1 from staff_member where user_id=u and employee_kind='trainee' and app_private.local_today(location_ids[1]) between internship_from and internship_until) then 'trainees'
 when exists(select 1 from app_private.active_assignments() where role='franchisee_manager') then 'managers' else 'sales' end;
 select l.timezone into tz from staff_member sm join location l on l.id=sm.location_ids[1] where sm.user_id=u;
 if tz is null then select timezone into tz from location where partner_id=p and status='active' order by id limit 1;end if;
 d:=(now() at time zone coalesce(tz,'Europe/Moscow'))::date;
 return jsonb_build_object('partner',p,'audience',r,'day',d,'enabled',coalesce((select learning_enabled from staff_member where user_id=u),true));
end $$;

update app_private.learning_config set for_franchisees=false,version=version+1 where for_franchisees;
create or replace function public.learning_lesson_save(p_article uuid,p_partner uuid,p_revision uuid,p_settings jsonb,p_expected_version int) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare a public.article;v int;q jsonb:=p_settings->'questions';k text;
begin
 p_settings:=p_settings||'{"for_franchisees":false}'::jsonb;
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

insert into app_private.client_command(fn) values('public.shift_close_versioned(uuid,bigint,bigint,bigint,uuid,text)'),('public.staff_open_shifts(uuid)'),('public.staff_shift_resolve(uuid,text,bigint,bigint,bigint,text,uuid)');
select app_private.apply_grants();
