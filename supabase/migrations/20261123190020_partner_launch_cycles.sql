-- The checklist is versioned independently of the franchisee's access and reports.
alter table public.partner
  add column launch_cycle integer not null default 0,
  add column launch_archived boolean not null default false;
alter table app_private.partner_launch_task
  add column cycle integer not null default 0,
  drop constraint partner_launch_task_pkey,
  add primary key (partner_id, cycle, task);

update public.partner p
set launch_archived = true
where p.status = 'terminated'
   or (not exists (
      select 1 from public.location l where l.partner_id = p.id and l.status = 'active'
    ) and exists (
      select 1 from public.location l where l.partner_id = p.id and l.status = 'closed'
        and (l.opened_on <= app_private.local_today(l.id)
          or app_private.point_has_recorded_activity(l.id, app_private.local_today(l.id)))
    ));

create function app_private.sync_partner_launch_status() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  if new.status = 'terminated' and old.status <> 'terminated' then
    new.launch_archived := true;
  elsif old.launch_archived and new.status = 'active' and (
    (new.preparation_stage is not null and new.preparation_stage is distinct from old.preparation_stage)
    or (old.status <> 'active'
      and not app_private.partner_launch_has_working_point(new.id)
      and (old.status = 'terminated'
        or exists (select 1 from public.location l where l.partner_id = new.id and l.status = 'active')))
  ) then
    new.launch_cycle := old.launch_cycle + 1;
    new.launch_archived := false;
    if new.preparation_stage is not distinct from old.preparation_stage then
      new.preparation_stage := 'opening_preparation';
    end if;
  end if;
  return new;
end $$;

create trigger partner_launch_status
  before update of status, preparation_stage on public.partner
  for each row execute function app_private.sync_partner_launch_status();

create function app_private.sync_point_launch_cycle() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare p public.partner; closed_working_point boolean; planned_point boolean;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status
     and new.opened_on is not distinct from old.opened_on then
    return new;
  end if;
  closed_working_point := tg_op = 'UPDATE' and old.status = 'active' and new.status = 'closed' and (
    old.opened_on <= app_private.local_today(old.id)
    or (old.opened_on is null and app_private.point_has_recorded_activity(old.id, app_private.local_today(old.id)))
  );
  planned_point := new.status = 'active' and (
    tg_op = 'INSERT' or old.status = 'closed' or new.opened_on > app_private.local_today(new.id)
  );
  if closed_working_point is not true and planned_point is not true then
    return new;
  end if;

  -- Point transitions for one franchisee cannot retire or start the same cycle twice.
  select * into p from public.partner where id = new.partner_id for update;
  if closed_working_point and not p.launch_archived
    and not app_private.partner_launch_has_working_point(p.id) then
    if p.status = 'active' and exists (
      select 1 from public.location l where l.partner_id = p.id and l.status = 'active'
    ) then
      update public.partner set launch_cycle = launch_cycle + 1,
        preparation_stage = 'opening_preparation', updated_at = now() where id = p.id;
    else
      update public.partner set launch_archived = true, updated_at = now() where id = p.id;
    end if;
  elsif planned_point and p.launch_archived and p.status = 'active' then
    update public.partner set launch_archived = false, launch_cycle = launch_cycle + 1,
      preparation_stage = 'opening_preparation', updated_at = now() where id = p.id;
  end if;
  return new;
end $$;

create trigger point_launch_cycle
  after insert or update of status, opened_on on public.location
  for each row execute function app_private.sync_point_launch_cycle();

-- The first launch continues to use the existing preparation state. When the
-- commercial form merely repeats the old stage during a resumed launch, keep
-- the stage selected by the transition. An explicit stage change still wins.
create or replace function public.partner_save_preparation(p_id uuid, p_name text, p_country text,
  p_contact_name text, p_contact_phone text, p_contact_email text, p_status text,
  p_preparation_stage text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  v_id uuid;
  p_before public.partner;
  p_after public.partner;
  v_stage text := nullif(trim(p_preparation_stage), '');
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if v_stage is not null and v_stage not in ('contract_signed', 'location_search', 'opening_preparation') then
    perform app_private.fail('validation', 'Выберите этап подготовки', 'preparation_stage');
  end if;
  if p_id is not null then
    select * into p_before from public.partner where id = p_id for update;
  end if;
  v_id := public.partner_save(p_id, p_name, p_country, p_contact_name, p_contact_phone, p_contact_email, p_status);
  select * into p_after from public.partner where id = v_id;
  if p_before.launch_cycle is distinct from p_after.launch_cycle and v_stage is not distinct from p_before.preparation_stage then
    v_stage := p_after.preparation_stage;
  end if;
  update public.partner set preparation_stage = v_stage where id = v_id;
  if p_before.preparation_stage is distinct from v_stage then
    perform app_private.audit('partner.preparation_change', 'partner', v_id, v_id,
      jsonb_build_object('before', p_before.preparation_stage, 'after', v_stage));
  end if;
  return v_id;
end $$;

create or replace function app_private.partner_launch_view(p_partner uuid, p_stage text) returns jsonb
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  select case when p_stage is not null then jsonb_build_object(
    'stage', p_stage,
    'completed_task_ids', coalesce((
      select jsonb_agg(t.task order by t.task) from app_private.partner_launch_task t
      where t.partner_id = p.id and t.cycle = p.launch_cycle
    ), '[]'::jsonb)
  ) || case when p.launch_cycle > 0 then jsonb_build_object('cycle', p.launch_cycle) else '{}'::jsonb end end
  from public.partner p where p.id = p_partner
$$;

create or replace function public.partner_launch_get(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare p public.partner;
begin
  perform app_private.partner_launch_actor(p_partner);
  select * into p from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Проект франчайзи не найден'); end if;
  if p.status <> 'active' or p.launch_archived or app_private.partner_launch_has_working_point(p_partner) then return null; end if;
  return app_private.partner_launch_view(p_partner, p.preparation_stage);
end $$;

create function public.partner_launch_task_set_checked(p_partner uuid, p_task text, p_completed boolean, p_cycle integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.partner_launch_actor(p_partner);
  p public.partner;
  valid_task boolean;
begin
  select * into p from public.partner where id = p_partner for update;
  if not found then perform app_private.fail('not-found', 'Проект франчайзи не найден'); end if;
  if p.status <> 'active' or p.launch_archived or p.preparation_stage is null
    or app_private.partner_launch_has_working_point(p_partner) then
    perform app_private.fail('validation', 'Подготовка к открытию недоступна для этого франчайзи');
  end if;
  if p_cycle is distinct from p.launch_cycle then
    perform app_private.fail('version-conflict', 'Чек-лист открытия обновился. Сверьте задачи и повторите действие');
  end if;
  valid_task := p_task = 'launch_learning'
    or (p.preparation_stage in ('contract_signed', 'location_search') and p_task in ('location_requirements', 'location_options', 'location_review'))
    or (p.preparation_stage = 'opening_preparation' and p_task in ('island_brief', 'island_design', 'purchase_list'));
  if valid_task is not true or p_completed is null then
    perform app_private.fail('validation', 'Задача недоступна на текущем этапе подготовки', 'task');
  end if;

  if p_completed then
    insert into app_private.partner_launch_task(partner_id, cycle, task, completed_by) values (p_partner, p.launch_cycle, p_task, actor)
    on conflict (partner_id, cycle, task) do nothing;
  else
    delete from app_private.partner_launch_task where partner_id = p_partner and cycle = p.launch_cycle and task = p_task;
  end if;
  if found then
    perform app_private.audit('partner.launch_task', 'partner', p_partner, p_partner,
      jsonb_build_object('task', p_task, 'completed', p_completed, 'stage', p.preparation_stage, 'cycle', p.launch_cycle));
  end if;
  return app_private.partner_launch_view(p_partner, p.preparation_stage);
end $$;

-- A stale client from before cycles may still edit the first launch.
create or replace function public.partner_launch_task_set(p_partner uuid, p_task text, p_completed boolean) returns jsonb
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select public.partner_launch_task_set_checked(p_partner, p_task, p_completed, 0)
$$;

revoke all on function app_private.sync_partner_launch_status(), app_private.sync_point_launch_cycle(),
  public.partner_launch_task_set_checked(uuid,text,boolean,integer) from public, anon, authenticated, service_role;
grant execute on function public.partner_launch_task_set_checked(uuid,text,boolean,integer) to authenticated;
insert into app_private.client_command(fn) values ('public.partner_launch_task_set_checked(uuid,text,boolean,integer)');

-- Existing functions retain their owners when replaced on a native database.
do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres', 'supabase_admin') loop
    execute format('grant execute on function public.partner_launch_task_set_checked(uuid,text,boolean,integer),
      app_private.partner_launch_actor(uuid), app_private.partner_launch_view(uuid,text),
      app_private.partner_launch_has_working_point(uuid) to %I', trusted);
    execute format('grant select, insert, delete on app_private.partner_launch_task to %I', trusted);
  end loop;
end $acl$;
