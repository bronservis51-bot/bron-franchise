-- Daily notice and internship audience use the assigned work location calendar.
create or replace function app_private.learning_context() returns jsonb language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare u uuid:=app_private.require_user();p uuid;r text;d date;tz text;
begin
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
