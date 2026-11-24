-- Templates are partner-local. Applying a version copies it into the existing dated terms.
-- Editing or archiving a template never rewrites an assignment or an accepted shift.
create table app_private.pay_scheme (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner(id) on delete cascade,
  policy jsonb not null,
  version int not null default 1,
  active boolean not null default true
);
create unique index pay_scheme_partner_name on app_private.pay_scheme(partner_id, lower(btrim(policy->>'name')));
alter table app_private.pay_scheme enable row level security;
revoke all on app_private.pay_scheme from public, anon, authenticated, service_role;

create function app_private.validate_fixed_scheme(p jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,app_private,pg_temp as $$
begin
  if p - array['name','mode','rate_bp','fee_minor'] <> '{}'::jsonb or p->>'mode' is distinct from 'legacy'
    or jsonb_typeof(p->'rate_bp') is distinct from 'number' or coalesce(p->>'rate_bp','') !~ '^[0-9]{1,5}$'
    or jsonb_typeof(p->'fee_minor') is distinct from 'number' or coalesce(p->>'fee_minor','') !~ '^[0-9]{1,11}$' then
    perform app_private.fail('validation','Проверьте ставку за выход и процент');
  end if;
  perform app_private.check_pay((p->>'rate_bp')::int,(p->>'fee_minor')::bigint);
end $$;

create or replace function app_private.staff_custom_pay_validate(p_policy jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,app_private,pg_temp as $$
begin
  if p_policy is null then return; end if;
  if jsonb_typeof(p_policy) is distinct from 'object' or jsonb_typeof(p_policy->'name') is distinct from 'string'
    or length(p_policy->>'name') > 100 or p_policy->>'name' !~ '[^[:space:]]' then
    perform app_private.fail('validation','Проверьте название схемы оплаты');
  end if;
  if p_policy ? 'mode' then
    perform app_private.validate_fixed_scheme(p_policy);
    return;
  end if;
  if p_policy - array['name','floor_minor','tiers'] <> '{}'::jsonb then
    perform app_private.fail('validation','Проверьте поля схемы оплаты');
  end if;
  perform app_private.motivation_validate(p_policy);
  if exists(select 1 from jsonb_array_elements(p_policy->'tiers') x where x-array['from_minor','rate_bp','bonus_minor'] <> '{}'::jsonb) then
    perform app_private.fail('validation','Проверьте поля ступеней');
  end if;
end $$;

create function public.pay_scheme_list(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.has_perm('staff.manage',p_partner) then perform app_private.require_perm('staff.pay_edit',p_partner); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'version',version,'policy',policy,'active',active)
    order by active desc, lower(policy->>'name'),id) from app_private.pay_scheme where partner_id=p_partner
      and (active or app_private.has_perm('team.manage',p_partner))), '[]'::jsonb);
end $$;

create function public.pay_scheme_save(p_partner uuid,p_scheme uuid,p_expected_version int,p_policy jsonb,p_active boolean) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare scheme uuid;
begin
  perform app_private.require_user(); perform app_private.require_perm('team.manage',p_partner);
  perform app_private.require_partner_operational(p_partner);
  if p_policy is null or p_active is null then perform app_private.fail('validation','Укажите схему оплаты'); end if;
  perform app_private.staff_custom_pay_validate(p_policy);
  if p_scheme is null then
    if p_expected_version is distinct from 0 then perform app_private.fail('version-conflict','Обновите список схем'); end if;
    insert into app_private.pay_scheme(partner_id,policy,active) values(p_partner,p_policy,p_active) returning id into scheme;
  else
    update app_private.pay_scheme set policy=p_policy,active=p_active,version=version+1
      where id=p_scheme and partner_id=p_partner and version=p_expected_version returning id into scheme;
    if not found then perform app_private.fail('version-conflict','Схема уже изменена. Откройте её заново'); end if;
  end if;
  perform app_private.audit('staff.pay_scheme','partner',p_partner,p_partner,jsonb_build_object('scheme',scheme,'active',p_active));
  return scheme;
exception when unique_violation then perform app_private.fail('validation','Схема с таким названием уже есть');
end $$;

create function app_private.pay_scheme_snapshot(p_partner uuid,p_scheme uuid,p_version int) returns jsonb
language plpgsql set search_path=pg_catalog,app_private,pg_temp as $$
declare s app_private.pay_scheme;
begin
  select * into s from app_private.pay_scheme where id=p_scheme and partner_id=p_partner for share;
  if not found then perform app_private.fail('not-found','Схема не найдена'); end if;
  if s.version is distinct from p_version then perform app_private.fail('version-conflict','Схема уже изменена. Выберите её заново'); end if;
  if not s.active then perform app_private.fail('validation','Схема находится в архиве'); end if;
  return s.policy;
end $$;

create function public.pay_scheme_apply(p_partner uuid,p_scheme uuid,p_scheme_version int,p_user uuid,
  p_effective_from date,p_expected_version int,p_internship_floor_minor bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare s public.staff_member; snapshot jsonb;
begin
  perform app_private.require_user();
  if p_user is null then perform app_private.require_perm('team.manage',p_partner);
  elsif not app_private.has_perm('staff.manage',p_partner) then perform app_private.require_perm('staff.pay_edit',p_partner);
  end if;
  perform app_private.require_partner_operational(p_partner);
  snapshot:=app_private.pay_scheme_snapshot(p_partner,p_scheme,p_scheme_version);
  if p_user is null then
    perform public.motivation_set(p_partner,snapshot || jsonb_build_object('effective_from',p_effective_from),p_expected_version);
  else
    perform pg_advisory_xact_lock(hashtextextended('team:'||p_user,0));
    select * into s from public.staff_member where user_id=p_user and partner_id=p_partner;
    perform public.staff_pay_save(p_partner,p_user,coalesce((snapshot->>'rate_bp')::int,s.rate_bp),
      coalesce((snapshot->>'fee_minor')::bigint,s.shift_fee_minor),false,snapshot,p_effective_from,p_expected_version,p_internship_floor_minor);
  end if;
end $$;

-- Profile creation and combined profile edits stay a single transaction, including catalogue version validation.
create function public.staff_profile_save_scheme(p_partner uuid,p_user uuid,p_full_name text,p_phone text,p_password text,
  p_locations uuid[],p_scheme uuid,p_scheme_version int,p_settings jsonb) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare snapshot jsonb; s public.staff_member;
begin
  perform app_private.require_user(); perform app_private.require_perm('staff.manage',p_partner);
  perform app_private.require_partner_operational(p_partner);
  snapshot:=app_private.pay_scheme_snapshot(p_partner,p_scheme,p_scheme_version);
  if p_user is not null then
    if coalesce(jsonb_typeof(p_settings->'expected_pay_revision'),'') <> 'number' then
      perform app_private.fail('version-conflict','Нужно обновить условия сотрудника');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('team:'||p_user,0));
    select * into s from public.staff_member where user_id=p_user and partner_id=p_partner;
  end if;
  return public.staff_profile_save_phone(p_user,p_partner,p_full_name,p_phone,p_password,p_locations,
    coalesce((snapshot->>'rate_bp')::int,s.rate_bp,0),coalesce((snapshot->>'fee_minor')::bigint,s.shift_fee_minor,0),
    false,coalesce(p_settings,'{}'::jsonb)||jsonb_build_object('custom_pay',snapshot));
end $$;

create or replace function public.motivation_set(p_partner uuid,p_policy jsonb,p_expected_version int) returns void
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v int; effective date; policy jsonb:=p_policy-'effective_from';
begin
  perform app_private.require_user(); perform app_private.require_perm('team.manage',p_partner);
  effective:=coalesce((p_policy->>'effective_from')::date,app_private.partner_pay_today(p_partner));
  if not isfinite(effective) then perform app_private.fail('validation','Проверьте дату начала оплаты'); end if;
  if policy ? 'name' then perform app_private.staff_custom_pay_validate(policy);
  elsif policy ? 'mode' then perform app_private.validate_fixed_scheme(policy);
  else perform app_private.motivation_validate(policy); end if;
  perform pg_advisory_xact_lock(hashtextextended('motivation:'||p_partner,0));
  select version into v from app_private.motivation_scheme where partner_id=p_partner;
  if p_expected_version is distinct from coalesce(v,0) then perform app_private.fail('version-conflict','Мотивация уже изменена. Обновите настройки'); end if;
  insert into app_private.motivation_scheme(partner_id,policy) values(p_partner,policy) on conflict(partner_id)
    do update set policy=excluded.policy,version=motivation_scheme.version+1,updated_at=now();
  insert into app_private.team_pay_version(partner_id,effective_from,policy) values(p_partner,effective,policy)
    on conflict(partner_id,effective_from) do update set policy=excluded.policy;
  perform app_private.audit('staff.motivation','partner',p_partner,p_partner,policy||jsonb_build_object('effective_from',effective));
exception when invalid_datetime_format or datetime_field_overflow then
  perform app_private.fail('validation','Проверьте дату начала оплаты');
end $$;

create or replace function app_private.record_employee_pay() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare fields jsonb;
  effective date;
begin
  -- Old fixed-pay commands write native amounts without a catalogue snapshot.
  -- A manual change detaches the old name so these native amounts remain authoritative.
  if not new.use_partner_motivation and new.custom_pay->>'mode'='legacy' and
    ((new.custom_pay->>'rate_bp')::int is distinct from new.rate_bp or
     (new.custom_pay->>'fee_minor')::bigint is distinct from new.shift_fee_minor) then
    new.custom_pay:=null;
  end if;
  fields:=app_private.employee_pay_fields(new);
  if tg_op='INSERT' then
    effective:=coalesce(new.pay_effective_from,'-infinity'::date);
  else
    if fields=app_private.employee_pay_fields(old) and new.pay_effective_from is not distinct from old.pay_effective_from then return new; end if;
    effective:=coalesce(new.pending_pay_effective_from,
      case when new.employee_kind='trainee' and (old.employee_kind is distinct from new.employee_kind
        or old.internship_from is distinct from new.internship_from) then new.internship_from end,
      app_private.local_today(new.location_ids[1]));
    new.pay_revision:=old.pay_revision+1;
  end if;
  new.pay_effective_from:=case when isfinite(effective) then effective end;
  insert into app_private.employee_pay_version(employee_id,effective_from,terms) values(new.user_id,effective,fields)
    on conflict(employee_id,effective_from) do update set terms=excluded.terms;
  return new;
end $$;

create or replace function app_private.staff_pay_policy(p_user uuid,p_day date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare partner uuid; terms jsonb; team jsonb; trainee boolean;
begin
  select partner_id into partner from public.staff_member where user_id=p_user;
  select v.terms into terms from app_private.employee_pay_version v where employee_id=p_user and effective_from<=p_day
    order by effective_from desc limit 1;
  trainee:=terms->>'kind'='trainee' and p_day between (terms->>'start')::date and (terms->>'end')::date;
  if terms is null or (terms->>'partner')::boolean or trainee then
    team:=app_private.team_pay_on(partner,p_day);
    if trainee then
      return jsonb_set(team,case when team->>'mode'='legacy' then '{fee_minor}'::text[] else '{floor_minor}'::text[] end,terms->'floor');
    end if;
    return team;
  end if;
  return coalesce(nullif(terms->'custom','null'::jsonb),
    jsonb_build_object('mode','legacy','rate_bp',terms->'rate_bp','fee_minor',terms->'fee_minor'));
end $$;


-- Read today's employee mode and amounts from the same effective version.
-- The native member columns describe the last edit, which may start in the future.
create or replace function app_private.staff_pay_details(s public.staff_member) returns jsonb
language sql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
  with clock as (select app_private.local_today(s.location_ids[1]) as today),
  effective as (
    select v.terms from app_private.employee_pay_version v,clock
    where v.employee_id=s.user_id and v.effective_from<=today order by v.effective_from desc limit 1
  )
  select jsonb_build_object('rate_bp',s.rate_bp,'shift_fee_minor',s.shift_fee_minor,
    'custom_pay',s.custom_pay,'use_partner_motivation',s.use_partner_motivation,
    'pay_revision',s.pay_revision,'pay_effective_from',s.pay_effective_from,'internship_from',s.internship_from,
    'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,
    'pay_current_common',coalesce((e.terms->>'partner')::boolean,true) or
      coalesce(e.terms->>'kind'='trainee' and today between (e.terms->>'start')::date and (e.terms->>'end')::date,false),
    'pay_current_trainee_floor',case when e.terms->>'kind'='trainee' and today between (e.terms->>'start')::date and (e.terms->>'end')::date then e.terms->'floor' end,
    'pay_policy',app_private.staff_pay_policy(s.user_id,today),
    'pay_scheduled',coalesce((select jsonb_agg(jsonb_build_object('effective_from',v.effective_from,
      'common',(v.terms->>'partner')::boolean,
      'name',case when (v.terms->>'partner')::boolean then app_private.team_pay_on(s.partner_id,v.effective_from)->>'name' else v.terms->'custom'->>'name' end,
      'label',case when (v.terms->>'partner')::boolean then 'Общая схема' when v.terms->'custom'->>'name' is not null then v.terms->'custom'->>'name' else 'Фикс + процент' end)
      order by v.effective_from) from app_private.employee_pay_version v where v.employee_id=s.user_id and v.effective_from>today),'[]'::jsonb))
  from clock left join effective e on true
$$;

revoke all on function app_private.validate_fixed_scheme(jsonb), app_private.pay_scheme_snapshot(uuid,uuid,int),
  public.pay_scheme_list(uuid),public.pay_scheme_save(uuid,uuid,int,jsonb,boolean),
  public.pay_scheme_apply(uuid,uuid,int,uuid,date,int,bigint),public.staff_profile_save_scheme(uuid,uuid,text,text,text,uuid[],uuid,int,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.pay_scheme_list(uuid),public.pay_scheme_save(uuid,uuid,int,jsonb,boolean),
  public.pay_scheme_apply(uuid,uuid,int,uuid,date,int,bigint),public.staff_profile_save_scheme(uuid,uuid,text,text,text,uuid[],uuid,int,jsonb)
  to authenticated;
insert into app_private.client_command(fn) values ('public.pay_scheme_list(uuid)'),('public.pay_scheme_save(uuid,uuid,int,jsonb,boolean)'),
  ('public.pay_scheme_apply(uuid,uuid,int,uuid,date,int,bigint)'),('public.staff_profile_save_scheme(uuid,uuid,text,text,text,uuid[],uuid,int,jsonb)');
do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres','supabase_admin') loop
    execute format('grant execute on function app_private.validate_fixed_scheme(jsonb), app_private.pay_scheme_snapshot(uuid,uuid,int) to %I',trusted);
    execute format('grant select,insert,update on app_private.pay_scheme to %I',trusted);
    execute format('create policy %I on app_private.pay_scheme to %I using (true) with check (true)','trusted_writer_'||trusted,trusted);
  end loop;
end $acl$;
