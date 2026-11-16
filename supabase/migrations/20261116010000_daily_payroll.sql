-- Owner's daily cash-register tiers, 16.11.2026. Explicit partner policies and
-- pay_policy snapshots on existing shifts remain unchanged.
create function app_private.motivation_default(p_currency text) returns jsonb
language sql immutable set search_path=pg_catalog,pg_temp as $$
 select case when p_currency='RUB' then '{"floor_minor":100000,"tiers":[{"from_minor":0,"rate_bp":1600,"bonus_minor":0},{"from_minor":800000,"rate_bp":1700,"bonus_minor":0},{"from_minor":1000000,"rate_bp":1800,"bonus_minor":0},{"from_minor":1300000,"rate_bp":1900,"bonus_minor":0},{"from_minor":1600000,"rate_bp":1900,"bonus_minor":20000},{"from_minor":1900000,"rate_bp":2000,"bonus_minor":20000},{"from_minor":2300000,"rate_bp":2100,"bonus_minor":30000}]}'::jsonb
 else app_private.motivation_default() end
$$;

create or replace function public.motivation_get(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
begin
 perform app_private.require_user();perform app_private.require_perm('staff.manage',p_partner);
 return jsonb_build_object('version',coalesce((select version from app_private.motivation_scheme where partner_id=p_partner),0),
 'policy',coalesce((select policy from app_private.motivation_scheme where partner_id=p_partner),app_private.motivation_default((select currency from public.partner where id=p_partner))),
 'currency',(select currency from public.partner where id=p_partner));
end $$;

create or replace function app_private.staff_pay_policy(p_user uuid,p_day date) returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare s public.staff_member;p jsonb;
begin
 select * into s from staff_member where user_id=p_user;
 if s.use_partner_motivation or (s.employee_kind='trainee' and p_day between s.internship_from and s.internship_until) then
  p:=coalesce((select policy from app_private.motivation_scheme where partner_id=s.partner_id),
   app_private.motivation_default((select currency from public.partner where id=s.partner_id)));
  if s.employee_kind='trainee' and p_day between s.internship_from and s.internship_until then p:=jsonb_set(p,'{floor_minor}',to_jsonb(s.internship_floor_minor));end if;
  return p;
 else return jsonb_build_object('mode','legacy','rate_bp',s.rate_bp,'fee_minor',s.shift_fee_minor);
 end if;
end $$;

-- All employee close/edit entry points delegate here, including legacy clients.
-- The first close time is preserved by shift_store; correcting never renews the
-- five-minute window. Managers keep the existing revenue_save audited path.
create or replace function public.shift_close(p_shift uuid, p_cash bigint, p_card bigint, p_comment text default null) returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare v_user uuid:=app_private.require_user(); w public.work_shift; previous public.work_shift; l public.location; v_month date;
begin
 perform app_private.my_staff();
 select * into w from public.work_shift where id=p_shift and employee_id=v_user;
 if not found then perform app_private.fail('not-found','Смена не найдена');end if;
 perform app_private.revenue_day_lock(w.location_id,w.day);
 select * into w from public.work_shift where id=p_shift and employee_id=v_user for update;
 if not found then perform app_private.fail('not-found','Смена не найдена');end if;
 if not app_private.revenue_day_open(w.location_id,w.day) then perform app_private.fail('period-locked','Период смены закрыт. Передайте дату и итог руководителю для сверки');end if;
 if w.status='closed' and (w.closed_at is null or clock_timestamp()>=w.closed_at+interval '5 minutes') then
  perform app_private.fail('period-locked','Пять минут после сдачи выручки истекли. Исправление доступно руководителю');
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
