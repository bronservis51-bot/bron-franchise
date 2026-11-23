alter table public.expense
  add column recurring boolean not null default false,
  add column carried_from uuid;
-- Keep the source identity even if the historical expense is removed.
create unique index expense_carry_source on public.expense(partner_id, month, carried_from) where carried_from is not null;

create function app_private.expense_month_lock(p_partner uuid, p_month date)
returns void language sql volatile set search_path = pg_catalog, pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('expense.repeat:' || p_partner::text || ':' || (p_month - date '2000-01-01')::text, 0))
$$;

create or replace function public.expense_save(p_id uuid, p_month date, p_location uuid, p_category text, p_amount bigint, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_month date := date_trunc('month', p_month)::date; v_id uuid;
begin
  if v_month is null or not isfinite(v_month) or v_month > app_private.current_month() then perform app_private.fail('validation', 'Нельзя внести расход за будущий месяц', 'month'); end if;
  if coalesce(trim(p_category), '') = '' then perform app_private.fail('validation', 'Выберите или напишите категорию', 'category'); end if;
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Сумма должна быть больше нуля', 'amount'); end if;
  if p_location is not null and not exists (select 1 from public.location where id = p_location and partner_id = v_partner) then
    perform app_private.fail('not-found', 'Точка не найдена', 'location');
  end if;
  perform app_private.expense_month_lock(v_partner, v_month);
  if p_id is null then
    insert into public.expense(partner_id, location_id, month, category, amount_minor, note, created_by)
    values (v_partner, p_location, v_month, left(trim(p_category), 60), p_amount, nullif(trim(p_note), ''), auth.uid()) returning id into v_id;
    perform app_private.audit('expense.add', 'expense', v_id, v_partner, jsonb_build_object('month', v_month, 'category', p_category, 'amount', p_amount));
  else
    update public.expense set location_id = p_location, month = v_month, category = left(trim(p_category), 60), amount_minor = p_amount,
      note = nullif(trim(p_note), ''), updated_at = now()
    where id = p_id and partner_id = v_partner returning id into v_id;
    if v_id is null then perform app_private.fail('not-found', 'Расход не найден'); end if;
    perform app_private.audit('expense.update', 'expense', v_id, v_partner, jsonb_build_object('month', v_month, 'category', p_category, 'amount', p_amount));
  end if;
  return v_id;
end $$;

create function app_private.expense_save_with_recurring(
  p_id uuid, p_month date, p_location uuid, p_category text, p_amount bigint, p_note text, p_recurring boolean
) returns uuid language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_id uuid;
begin
  if p_recurring is null then perform app_private.fail('validation', 'Укажите, является ли расход регулярным'); end if;
  v_id := public.expense_save(p_id, p_month, p_location, p_category, p_amount, p_note);
  update public.expense set recurring = p_recurring where id = v_id and recurring is distinct from p_recurring;
  if found then
    perform app_private.audit('expense.recurring', 'expense', v_id, app_private.expense_partner(),
      jsonb_build_object('recurring', p_recurring));
  end if;
  return v_id;
end $$;

create function app_private.expense_repeat_candidates(p_partner uuid, p_month date)
returns setof public.expense language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select e.* from public.expense e
  where e.partner_id = p_partner and e.month = (p_month - interval '1 month')::date and e.recurring
    and not exists (
      select from public.expense x where x.partner_id = p_partner and x.month = p_month
        and (x.carried_from = e.id or (x.carried_from is null and x.category = e.category
          and x.location_id is not distinct from e.location_id)))
$$;

create function public.expense_repeat_preview(p_month date)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_month date := date_trunc('month', p_month)::date;
begin
  if v_month is null or not isfinite(v_month) or v_month > app_private.current_month() then
    perform app_private.fail('validation', 'Выберите текущий или прошедший месяц', 'month');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', e.id, 'category', e.category, 'location_name', l.name, 'amount_minor', e.amount_minor::text,
    'updated_at', e.updated_at) order by e.category, l.name nulls first, e.id)
    from app_private.expense_repeat_candidates(v_partner, v_month) e left join public.location l on l.id = e.location_id), '[]'::jsonb);
end $$;

create function app_private.expense_repeat_checked(p_month date, p_rows jsonb)
returns integer language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_month date := date_trunc('month', p_month)::date; n int;
begin
  if v_month is null or not isfinite(v_month) or v_month > app_private.current_month() then
    perform app_private.fail('validation', 'Выберите текущий или прошедший месяц', 'month');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    perform app_private.fail('validation', 'Выберите регулярные расходы');
  end if;
  if jsonb_array_length(p_rows) = 0 or exists (
    select from jsonb_array_elements(p_rows) x
    where coalesce(x->>'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(x->>'amount', '') !~ '^[0-9]{1,19}$'
      or coalesce(x->>'updated_at', '') = ''
      or case when coalesce(x->>'amount', '') ~ '^[0-9]{1,19}$' then (x->>'amount')::numeric not between 1 and 9223372036854775807 else false end
  ) then perform app_private.fail('validation', 'Проверьте выбранные расходы и их суммы'); end if;

  perform app_private.expense_month_lock(v_partner, v_month);
  perform 1 from public.expense e where e.partner_id = v_partner and e.month = (v_month - interval '1 month')::date
    and e.id in (select (x->>'id')::uuid from jsonb_array_elements(p_rows) x) order by e.id for share;

  insert into public.expense(partner_id, location_id, month, category, amount_minor, note, created_by, recurring, carried_from)
  select e.partner_id, e.location_id, v_month, e.category, (input->>'amount')::bigint, e.note, auth.uid(), true, e.id
  from app_private.expense_repeat_candidates(v_partner, v_month) e
  join (select distinct on ((x->>'id')::uuid) x as input from jsonb_array_elements(p_rows) x order by (x->>'id')::uuid) requested
    on e.id = (input->>'id')::uuid and e.updated_at = (input->>'updated_at')::timestamptz;
  get diagnostics n = row_count;
  if n <> jsonb_array_length(p_rows) then
    perform app_private.fail('version-conflict', 'Список расходов изменился. Откройте перенос заново и проверьте суммы');
  end if;

  perform app_private.audit('expense.repeat', 'partner', v_partner, v_partner, jsonb_build_object('month', v_month, 'count', n));
  return n;
end $$;

-- Old one-click clients cannot bypass the required review.
create or replace function public.expense_repeat(p_month date) returns int
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.expense_partner();
  perform app_private.fail('validation', 'Обновите приложение, чтобы проверить и перенести регулярные расходы');
  return 0;
end $$;

insert into app_private.client_command(fn) values ('public.expense_repeat_preview(date)');
revoke execute on function public.expense_repeat_preview(date) from public, anon;
grant execute on function public.expense_repeat_preview(date) to authenticated;

revoke execute on function app_private.expense_month_lock(uuid,date),
  app_private.expense_save_with_recurring(uuid,date,uuid,text,bigint,text,boolean),
  app_private.expense_repeat_candidates(uuid,date), app_private.expense_repeat_checked(date,jsonb) from public, anon, authenticated;
grant execute on function app_private.expense_month_lock(uuid,date),
  app_private.expense_save_with_recurring(uuid,date,uuid,text,bigint,text,boolean),
  app_private.expense_repeat_candidates(uuid,date), app_private.expense_repeat_checked(date,jsonb) to postgres;
do $private_finance_grant$
begin
  if exists (select from pg_roles where rolname = 'supabase_admin') then
    grant execute on function app_private.expense_month_lock(uuid,date),
  app_private.expense_save_with_recurring(uuid,date,uuid,text,bigint,text,boolean),
  app_private.expense_repeat_candidates(uuid,date), app_private.expense_repeat_checked(date,jsonb) to supabase_admin;
  end if;
end
$private_finance_grant$;


create or replace function public.finance_my(p_month date, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid; v_partners uuid[]; p public.partner; v_month date := date_trunc('month', p_month)::date; v_locs uuid[]; v_all uuid[]; m date;
  v_months jsonb := '[]'::jsonb;
  v_include_common boolean := p_location is null;
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into v_partners
    from app_private.active_assignments() a where a.role = 'franchisee' and a.scope_id is not null;
  if v_partners is null then perform app_private.fail('forbidden', 'Финансы видит франчайзи'); end if;
  if cardinality(v_partners) > 1 then perform app_private.fail('validation', 'К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  v_partner := v_partners[1];
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select coalesce(array_agg(id order by name), '{}'::uuid[]) into v_all from public.location where partner_id = v_partner;
  if p_location is not null and not (p_location = any(v_all)) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_locs := case when v_include_common then v_all else array[p_location] end;
  for m in select generate_series(v_month - interval '5 months', v_month, interval '1 month')::date loop
    v_months := v_months || jsonb_build_array(app_private.fin_month(v_partner, v_locs, m, v_include_common));
  end loop;
  return jsonb_build_object(
    'partner_name', p.name, 'partner_status', p.status, 'currency', p.currency, 'month', v_month, 'location_id', p_location,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status) order by name)
      from public.location where partner_id = v_partner), '[]'::jsonb),
    'current', app_private.fin_month(v_partner, v_locs, v_month, v_include_common),
    'months', v_months,
    'by_location', case when v_include_common then coalesce((select jsonb_agg(app_private.fin_month(v_partner, array[l.id], v_month, false)
        || jsonb_build_object('location_id', l.id, 'location_name', l.name) order by l.name)
      from public.location l where l.partner_id = v_partner), '[]'::jsonb) end,
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id, 'full_name', u.full_name, 'shifts', x.n, 'revenue_minor', x.t, 'earned_minor', x.e)
        order by x.e desc)
      from (select employee_id, (count(*) filter (where counts_as_exit))::int n, sum(total_minor)::bigint t, sum(earned_minor)::bigint e from public.work_shift
            where location_id = any(v_locs) and status = 'closed' and day >= v_month and day < v_month + interval '1 month' group by employee_id) x
      join public.app_user u on u.id = x.employee_id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'month', e.month, 'location_id', e.location_id, 'location_name', l.name,
        'category', e.category, 'amount_minor', e.amount_minor, 'note', e.note, 'recurring', e.recurring) order by e.category, l.name nulls first)
      from app_private.expense_rows(v_partner, v_locs, v_month, v_include_common) e left join public.location l on l.id = e.location_id), '[]'::jsonb),
    'expense_categories', coalesce((select jsonb_agg(c order by n desc, c) from (
        select category c, count(*) n from public.expense where partner_id = v_partner group by category) t), '[]'::jsonb),
    'prev_expenses_count', (select count(*) from public.expense where partner_id = v_partner and recurring and month = (v_month - interval '1 month')::date),
    'royalty', case when v_include_common then public.royalty_my() end);
end $$;
