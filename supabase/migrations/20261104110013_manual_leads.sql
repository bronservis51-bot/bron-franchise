-- Manual CRM: one contact is enough; the public landing questionnaire remains unchanged.
alter table public.franchise_lead
  add column instagram text check (instagram is null or instagram ~ '^[A-Za-z0-9_][A-Za-z0-9_.]{0,29}$'),
  add column pipeline_column text check (pipeline_column in ('000','010','001','100','011','110','101','111')),
  alter column budget drop not null,
  alter column timing drop not null,
  alter column manage drop not null,
  alter column experience drop not null,
  alter column place drop not null;
alter table public.franchise_lead drop constraint franchise_lead_phone_check;
alter table public.franchise_lead add constraint franchise_lead_phone_check check (phone = '' or length(phone) between 5 and 30);
alter table public.franchise_lead drop constraint franchise_lead_city_check;
alter table public.franchise_lead add constraint franchise_lead_city_check check (city = '' or length(trim(city)) between 2 and 80);
alter table public.franchise_lead drop constraint franchise_lead_contact_via_check;
alter table public.franchise_lead add constraint franchise_lead_contact_via_check check (contact_via in ('whatsapp','telegram','call','instagram','other'));
create unique index franchise_lead_instagram on public.franchise_lead(lower(instagram)) where instagram is not null;

-- Same manager-only command boundary as the existing lead_list/update. No direct table grants.
create function app_private.lead_json(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog,public,pg_temp as $$
  select to_jsonb(l)-'phone_digits'-'updated_by' || jsonb_build_object('updated_by_name',u.full_name)
  from public.franchise_lead l left join public.app_user u on u.id=l.updated_by where l.id=p_id
$$;
create function app_private.check_lead_column(p_column text) returns void
language plpgsql immutable set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
 if p_column is null or p_column not in ('auto','000','010','001','100','011','110','101','111','in_work','call_back','meeting','won','lost') then
   perform app_private.fail('validation','Выберите колонку заявки','column');
 end if;
end $$;

create function public.lead_move(p_id uuid,p_column text,p_expected_updated_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare l public.franchise_lead; v_status text;
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 perform app_private.check_lead_column(p_column);
 select * into l from public.franchise_lead where id=p_id for update;
 if not found then perform app_private.fail('not-found','Заявка не найдена'); end if;
 if p_expected_updated_at is null or l.updated_at is distinct from p_expected_updated_at then
   perform app_private.fail('version-conflict','Заявка уже изменилась. Откройте её заново');
 end if;
 v_status:=case when p_column in ('in_work','call_back','meeting','won','lost') then p_column else 'new' end;
 update public.franchise_lead set status=v_status,
   pipeline_column=case when p_column ~ '^[01]{3}$' then p_column else case when p_column='auto' then null else pipeline_column end end,
   updated_by=auth.uid(),updated_at=clock_timestamp() where id=p_id;
 perform app_private.audit('lead.move','franchise_lead',p_id,null,jsonb_build_object('from',l.status,'column',p_column));
 return app_private.lead_json(p_id);
end $$;

create function public.lead_save(p_lead jsonb,p_expected_updated_at timestamptz default null,p_operation uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare
 v_id uuid := nullif(p_lead->>'id','')::uuid; l public.franchise_lead; v_new boolean := v_id is null;
 v_name text := trim(coalesce(p_lead->>'name','')); v_ig text := nullif(trim(p_lead->>'instagram'),'');
 v_phone text := trim(coalesce(p_lead->>'phone','')); v_city text := trim(coalesce(p_lead->>'city',''));
 v_note text := nullif(trim(coalesce(p_lead->>'note','')),''); v_col text := coalesce(p_lead->>'column','000'); v_status text; v_pipeline text;
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 if length(v_name) not between 1 and 80 then perform app_private.fail('validation','Укажите ник Instagram или имя','name'); end if;
 if v_ig is not null and v_ig !~ '^[A-Za-z0-9_][A-Za-z0-9_.]{0,29}$' then perform app_private.fail('validation','Проверьте ник Instagram','name'); end if;
 if v_phone<>'' and (length(v_phone)>30 or length(regexp_replace(v_phone,'\D','','g')) not between 10 and 15) then perform app_private.fail('validation','Проверьте телефон','phone'); end if;
 if v_city<>'' and length(v_city) not between 2 and 80 then perform app_private.fail('validation','Проверьте город','city'); end if;
 if length(v_note)>2000 then perform app_private.fail('validation','Заметка слишком длинная','note'); end if;
 perform app_private.check_lead_column(v_col);
 v_status:=case when v_col in ('in_work','call_back','meeting','won','lost') then v_col else 'new' end;
 v_pipeline:=case when v_col ~ '^[01]{3}$' then v_col else null end;
 if v_new then
   if p_operation is null then perform app_private.fail('validation','Не задан ключ создания заявки'); end if;
   v_id:=p_operation;
   -- Serializes retries of the same creation and does not create another row after a lost response.
   perform pg_advisory_xact_lock(hashtextextended(v_id::text,0));
   select * into l from public.franchise_lead where id=v_id;
   if found then
     if l.name is distinct from v_name or l.instagram is distinct from v_ig or l.phone is distinct from v_phone or l.city is distinct from v_city
        or l.note is distinct from v_note or l.status is distinct from v_status or l.pipeline_column is distinct from v_pipeline then
       perform app_private.fail('idempotency-conflict','Этот ключ уже использован для другой заявки');
     end if;
     return app_private.lead_json(v_id);
   end if;
 else
   select * into l from public.franchise_lead where id=v_id for update;
   if not found then perform app_private.fail('not-found','Заявка не найдена'); end if;
   if p_expected_updated_at is null or l.updated_at is distinct from p_expected_updated_at then perform app_private.fail('version-conflict','Заявка уже изменилась. Скопируйте заметку и откройте карточку заново'); end if;
 end if;
 if v_ig is not null and exists(select 1 from public.franchise_lead where lower(instagram)=lower(v_ig) and id<>v_id) then
   perform app_private.fail('validation','Заявка с этим Instagram уже есть','name');
 end if;
 if v_new then
   insert into public.franchise_lead(id,name,instagram,phone,phone_digits,city,contact_via,score,tier,status,pipeline_column,note,source,updated_by)
   values(v_id,v_name,v_ig,v_phone,regexp_replace(v_phone,'\D','','g'),v_city,case when v_ig is not null then 'instagram' when v_phone<>'' then 'call' else 'other' end,0,'cold',v_status,v_pipeline,v_note,'manual',auth.uid());
 else
   update public.franchise_lead set name=v_name,instagram=v_ig,phone=v_phone,phone_digits=regexp_replace(v_phone,'\D','','g'),city=v_city,note=v_note,status=v_status,
     pipeline_column=case when v_col ~ '^[01]{3}$' or v_col='auto' then v_pipeline else pipeline_column end,
     updated_by=auth.uid(),updated_at=clock_timestamp() where id=v_id;
 end if;
 perform app_private.audit(case when v_new then 'lead.create' else 'lead.edit' end,'franchise_lead',v_id,null,jsonb_build_object('column',v_col));
 return app_private.lead_json(v_id);
exception when unique_violation then perform app_private.fail('validation','Заявка с этим Instagram уже есть','name');
end $$;

-- Old clients keep their existing status/note contract and can return a lead to automatic qualification.
create or replace function public.lead_update(p_id uuid,p_status text,p_note text) returns void
language plpgsql volatile security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare l public.franchise_lead;
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 if coalesce(p_status,'') not in ('new','in_work','call_back','meeting','won','lost') then perform app_private.fail('validation','Неизвестный статус'); end if;
 select * into l from public.franchise_lead where id=p_id for update;
 if not found then perform app_private.fail('not-found','Заявка не найдена'); end if;
 update public.franchise_lead set status=p_status,note=nullif(left(trim(coalesce(p_note,'')),2000),''),
  pipeline_column=case when p_status='new' then null else pipeline_column end,updated_by=auth.uid(),updated_at=clock_timestamp() where id=p_id;
 perform app_private.audit('lead.update','franchise_lead',p_id,null,jsonb_build_object('status',jsonb_build_array(l.status,p_status)));
end $$;
insert into app_private.client_command(fn) values ('public.lead_move(uuid,text,timestamptz)'),('public.lead_save(jsonb,timestamptz,uuid)');
select app_private.apply_grants();
