-- Legacy clients can still close an open shift. Editing a posted total requires
-- the revision observed by the employee, including during the first five minutes.
create function app_private.employee_shift_close(p_shift uuid, p_cash bigint, p_card bigint, p_comment text, p_expected_revision bigint) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); w public.work_shift; previous public.work_shift; l public.location; v_month date;
begin
 perform app_private.my_staff();
 select * into w from public.work_shift where id=p_shift and employee_id=v_user;
 if not found then perform app_private.fail('not-found','Смена не найдена');end if;
 perform app_private.revenue_day_lock(w.location_id,w.day);
 select * into w from public.work_shift where id=p_shift and employee_id=v_user for update;
 if not found then perform app_private.fail('not-found','Смена не найдена');end if;
 if p_expected_revision is not null and w.revision <> p_expected_revision then
  perform app_private.fail('version-conflict','Смена уже изменена. Откройте её заново и сверьте суммы');
 end if;
 if not app_private.revenue_day_open(w.location_id,w.day) then perform app_private.fail('period-locked','Период смены закрыт. Передайте дату и итог руководителю для сверки');end if;
 if w.status='closed' and (w.closed_at is null or clock_timestamp()>=w.closed_at+interval '5 minutes') then
  perform app_private.fail('period-locked','Пять минут после сдачи выручки истекли. Исправление доступно руководителю');
 end if;
 if w.status='closed' and p_expected_revision is null then
  perform app_private.fail('version-conflict','Смена уже закрыта. Обновите приложение и сверьте суммы перед исправлением');
 end if;
 if p_cash is null or p_card is null then perform app_private.fail('validation','Укажите обе суммы; если продаж не было — 0');end if;
 if p_cash<0 or p_card<0 then perform app_private.fail('validation','Сумма не может быть отрицательной','cash');end if;
 if p_cash::numeric+p_card::numeric>100000000000 then perform app_private.fail('validation','Слишком большая сумма','cash');end if;
 previous:=w;
 select * into l from public.location where id=w.location_id;
 w:=app_private.shift_store(l,v_user,w.day,p_cash,p_card,p_comment);
 if previous.status='closed' then
  perform app_private.audit('shift.correct','work_shift',w.id,l.partner_id,jsonb_build_object(
   'before',jsonb_build_object('cash',previous.cash_minor,'card',previous.card_minor,'earned',previous.earned_minor,'comment',previous.comment,'revision',previous.revision),
   'after',jsonb_build_object('cash',w.cash_minor,'card',w.card_minor,'earned',w.earned_minor,'comment',w.comment,'revision',w.revision),
   'first_closed_at',w.closed_at));
 else
  perform app_private.audit('shift.close','work_shift',w.id,l.partner_id,jsonb_build_object('cash',w.cash_minor,'card',w.card_minor,'earned',w.earned_minor));
 end if;
 v_month:=date_trunc('month',w.day)::date;
 return jsonb_build_object('shift',to_jsonb(w),'currency',l.currency,
  'month_earned_minor',(select coalesce(sum(earned_minor),0) from public.work_shift where employee_id=v_user and status='closed' and day>=v_month and day<v_month+interval '1 month'),
  'month_shifts',(select count(*) from public.work_shift where employee_id=v_user and status='closed' and day>=v_month and day<v_month+interval '1 month'));
end $$;

-- Entry points keep their original OIDs, grants, receipt names and signatures.
-- Only the definer RPCs can call the common writer.
revoke execute on function app_private.employee_shift_close(uuid,bigint,bigint,text,bigint)
  from public, anon, authenticated, service_role;

do $acl$
declare trusted_owner name;
begin
  for trusted_owner in select distinct pg_get_userbyid(proowner) from pg_proc
    where oid in ('public.shift_close(uuid,bigint,bigint,text)'::regprocedure,
      'public.shift_close_versioned(uuid,bigint,bigint,bigint,uuid,text)'::regprocedure)
  loop
    if trusted_owner not in ('postgres','supabase_admin') then raise exception 'Unexpected shift command owner'; end if;
    execute format('grant execute on function app_private.employee_shift_close(uuid,bigint,bigint,text,bigint) to %I', trusted_owner);
  end loop;
end $acl$;

create or replace function public.shift_close(p_shift uuid,p_cash bigint,p_card bigint,p_comment text default null)
returns jsonb language sql security definer set search_path=pg_catalog,app_private,pg_temp as $$
  select app_private.employee_shift_close(p_shift,p_cash,p_card,p_comment,null)
$$;

create or replace function public.shift_close_versioned(p_shift uuid,p_cash bigint,p_card bigint,p_expected_revision bigint,p_operation uuid,p_comment text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare u uuid:=app_private.require_user();old app_private.operation_receipt;payload jsonb;answer jsonb;
begin
 perform app_private.my_staff();
 if p_operation is null or p_expected_revision is null or p_cash is null or p_card is null then perform app_private.fail('validation','Укажите обе суммы; если продаж не было — 0');end if;
 payload:=jsonb_build_object('shift',p_shift,'cash',p_cash,'card',p_card,'expected_revision',p_expected_revision,'comment',p_comment);
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_operation::text,0));
 select * into old from app_private.operation_receipt where user_id=u and operation_id=p_operation;
 if found then if old.command<>'shift_close_versioned' or old.payload<>payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные');end if;return old.result;end if;
 answer:=app_private.employee_shift_close(p_shift,p_cash,p_card,p_comment,p_expected_revision);
 insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(u,p_operation,'shift_close_versioned',payload,answer);
 return answer;
end $$;

-- Take the shared day lock before locking the revenue row, in the same order as
-- the supervisor and employee writers. Preserve the original queue receipt format.
create or replace function public.revenue_save_checked(p_location uuid,p_day date,p_cash bigint,p_card bigint,p_expected_revision integer,p_operation uuid,p_comment text default null,p_employee uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid:=app_private.require_user(); old app_private.operation_receipt; rev integer; payload jsonb; answer jsonb;
begin
  perform app_private.revenue_location(p_location,'revenue.enter');
  if p_operation is null or p_expected_revision is null then perform app_private.fail('validation','Обновите приложение перед сохранением'); end if;
  payload:=jsonb_build_object('location',p_location,'day',p_day,'cash',p_cash,'card',p_card,'comment',p_comment,'employee',p_employee,'expected_revision',p_expected_revision);
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>'revenue_save' or old.payload<>payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные'); end if;
    return old.result;
  end if;
  perform app_private.revenue_day_lock(p_location,p_day);
  select revision into rev from public.daily_revenue where location_id=p_location and day=p_day and employee_id is not distinct from p_employee for update;
  if coalesce(rev,-1)<>p_expected_revision then perform app_private.fail('version-conflict','Запись уже изменена. Сохраните введённые суммы и откройте день заново, чтобы сверить данные.'); end if;
  answer:=to_jsonb(public.revenue_save(p_location,p_day,p_cash,p_card,p_comment,p_employee));
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'revenue_save',payload,answer);
  return answer;
end $$;
