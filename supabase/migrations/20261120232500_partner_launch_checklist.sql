-- A completion is separate from the partner's manually selected preparation stage.
create table app_private.partner_launch_task (
  partner_id uuid not null references public.partner(id),
  task text not null check (task in (
    'location_requirements', 'location_options', 'location_review',
    'island_brief', 'island_design', 'purchase_list', 'launch_learning'
  )),
  completed_by uuid not null references public.app_user(id),
  completed_at timestamptz not null default now(),
  primary key (partner_id, task)
);

alter table app_private.partner_launch_task enable row level security;
revoke all on app_private.partner_launch_task from public, anon, authenticated;

create function app_private.partner_launch_actor(p_partner uuid) returns uuid
language plpgsql stable set search_path = public, app_private, pg_temp as $$
declare actor uuid := app_private.require_user();
begin
  if p_partner is null or not exists (
    select 1 from app_private.active_assignments() a
    where (a.role = 'franchise_manager' and a.scope_type = 'company')
       or (a.role = 'franchisee' and a.scope_type = 'partner' and a.scope_id = p_partner)
  ) then
    perform app_private.fail('not-found', 'Проект франчайзи не найден');
  end if;
  return actor;
end $$;

create function app_private.partner_launch_view(p_partner uuid, p_stage text) returns jsonb
language sql stable set search_path = public, app_private, pg_temp as $$
  select case when p_stage is not null then jsonb_build_object(
    'stage', p_stage,
    'completed_task_ids', coalesce((
      select jsonb_agg(t.task order by t.task) from app_private.partner_launch_task t where t.partner_id = p_partner
    ), '[]'::jsonb)
  ) end
$$;

-- An active point can be created before opening. An opening date already reached
-- or recorded operations distinguishes working points without changing the stage.
create function app_private.partner_launch_has_working_point(p_partner uuid) returns boolean
language sql stable set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from public.location l where l.partner_id = p_partner and l.status = 'active' and (
      l.opened_on <= (now() at time zone l.timezone)::date
      or exists (select 1 from public.daily_revenue r where r.location_id = l.id and r.day <= (now() at time zone l.timezone)::date)
      or exists (select 1 from public.work_shift w where w.partner_id = p_partner and w.location_id = l.id
        and w.day <= (now() at time zone l.timezone)::date)
    )
  )
$$;

create function public.partner_launch_get(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_stage text;
begin
  perform app_private.partner_launch_actor(p_partner);
  select p.preparation_stage into v_stage from public.partner p where p.id = p_partner;
  if not found then perform app_private.fail('not-found', 'Проект франчайзи не найден'); end if;
  if v_stage is not null and app_private.partner_launch_has_working_point(p_partner) then return null; end if;
  return app_private.partner_launch_view(p_partner, v_stage);
end $$;

create function public.partner_launch_task_set(p_partner uuid, p_task text, p_completed boolean) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare
  actor uuid := app_private.partner_launch_actor(p_partner);
  v_stage text;
  valid_task boolean;
begin
  -- Serializes check/uncheck with partner stage changes and other checklist edits.
  select p.preparation_stage into v_stage from public.partner p where p.id = p_partner for update;
  if not found then perform app_private.fail('not-found', 'Проект франчайзи не найден'); end if;
  if v_stage is null or app_private.partner_launch_has_working_point(p_partner) then
    perform app_private.fail('validation', 'Подготовка к открытию недоступна для этого франчайзи');
  end if;
  valid_task := p_task = 'launch_learning'
    or (v_stage in ('contract_signed', 'location_search') and p_task in ('location_requirements', 'location_options', 'location_review'))
    or (v_stage = 'opening_preparation' and p_task in ('island_brief', 'island_design', 'purchase_list'));
  if valid_task is not true or p_completed is null then
    perform app_private.fail('validation', 'Задача недоступна на текущем этапе подготовки', 'task');
  end if;

  if p_completed then
    insert into app_private.partner_launch_task(partner_id, task, completed_by) values (p_partner, p_task, actor)
    on conflict (partner_id, task) do nothing;
  else
    delete from app_private.partner_launch_task where partner_id = p_partner and task = p_task;
  end if;
  if found then
    perform app_private.audit('partner.launch_task', 'partner', p_partner, p_partner,
      jsonb_build_object('task', p_task, 'completed', p_completed, 'stage', v_stage));
  end if;
  return app_private.partner_launch_view(p_partner, v_stage);
end $$;

insert into app_private.client_command(fn) values
  ('public.partner_launch_get(uuid)'), ('public.partner_launch_task_set(uuid,text,boolean)');
revoke execute on function public.partner_launch_get(uuid), public.partner_launch_task_set(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.partner_launch_get(uuid), public.partner_launch_task_set(uuid,text,boolean) to authenticated;
revoke execute on function app_private.partner_launch_actor(uuid), app_private.partner_launch_view(uuid,text),
  app_private.partner_launch_has_working_point(uuid) from public, anon, authenticated;
