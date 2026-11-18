-- A manual lead's original creation command stays identifiable after edits or deletion.
-- Store only a fingerprint in the existing private, backed-up receipt table.
create unique index operation_receipt_lead_create_id on app_private.operation_receipt (operation_id)
  where command = 'lead_create';

create or replace function public.lead_save(p_lead jsonb,p_expected_updated_at timestamptz default null,p_operation uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare
 v_actor uuid := app_private.require_user();
 v_id uuid := nullif(p_lead->>'id','')::uuid; l public.franchise_lead; v_new boolean := v_id is null;
 v_name text := trim(coalesce(p_lead->>'name','')); v_ig text := nullif(trim(p_lead->>'instagram'),'');
 v_phone text := trim(coalesce(p_lead->>'phone','')); v_city text := trim(coalesce(p_lead->>'city',''));
 v_note text := nullif(trim(coalesce(p_lead->>'note','')),''); v_col text := coalesce(p_lead->>'column','000'); v_status text; v_pipeline text;
 v_fingerprint text; v_original_fingerprint text;
begin
 perform app_private.require_perm('org.manage');
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
   v_fingerprint:=encode(extensions.digest(convert_to(jsonb_build_array(v_id,v_name,v_ig,v_phone,v_city,v_note,v_status,v_pipeline)::text,'UTF8'),'sha256'),'hex');
   perform pg_advisory_xact_lock(hashtextextended(v_id::text,0));
   select * into l from public.franchise_lead where id=v_id for update;
   select payload->>'fingerprint' into v_original_fingerprint from app_private.operation_receipt
     where command='lead_create' and operation_id=v_id;
   if found then
     if v_original_fingerprint is distinct from v_fingerprint then
       perform app_private.fail('idempotency-conflict','Этот ключ уже использован для другой заявки');
     end if;
     if l.id is null then perform app_private.fail('not-found','Заявка больше не существует'); end if;
     return app_private.lead_json(v_id);
   end if;
   if l.id is not null then
     -- Before receipts, only an exact match to the current row can be confirmed. Do not infer its original payload.
     if l.name is distinct from v_name or l.instagram is distinct from v_ig or l.phone is distinct from v_phone or l.city is distinct from v_city
        or l.note is distinct from v_note or l.status is distinct from v_status or l.pipeline_column is distinct from v_pipeline then
       perform app_private.fail('idempotency-conflict','Этот ключ уже использован для другой заявки');
     end if;
     return app_private.lead_json(v_id);
   end if;
   if exists (select 1 from public.audit_event where entity_type='franchise_lead' and entity_id=v_id and action='lead.create') then
     perform app_private.fail('not-found','Заявка больше не существует');
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
   insert into app_private.operation_receipt(user_id,operation_id,command,payload)
   values(v_actor,v_id,'lead_create',jsonb_build_object('fingerprint',v_fingerprint))
   on conflict(user_id,operation_id) do nothing;
   if not found then perform app_private.fail('idempotency-conflict','Этот ключ уже использован для другой операции'); end if;
   insert into public.franchise_lead(id,name,instagram,phone,phone_digits,city,contact_via,score,tier,status,pipeline_column,note,source,updated_by)
   values(v_id,v_name,v_ig,v_phone,regexp_replace(v_phone,'\D','','g'),v_city,case when v_ig is not null then 'instagram' when v_phone<>'' then 'call' else 'other' end,0,'cold',v_status,v_pipeline,v_note,'manual',v_actor);
 else
   update public.franchise_lead set name=v_name,instagram=v_ig,phone=v_phone,phone_digits=regexp_replace(v_phone,'\D','','g'),city=v_city,note=v_note,status=v_status,
     pipeline_column=case when v_col ~ '^[01]{3}$' or v_col='auto' then v_pipeline else pipeline_column end,
     updated_by=v_actor,updated_at=clock_timestamp() where id=v_id;
 end if;
 perform app_private.audit(case when v_new then 'lead.create' else 'lead.edit' end,'franchise_lead',v_id,null,jsonb_build_object('column',v_col));
 return app_private.lead_json(v_id);
exception when unique_violation then perform app_private.fail('validation','Заявка с этим Instagram уже есть','name');
end $$;
