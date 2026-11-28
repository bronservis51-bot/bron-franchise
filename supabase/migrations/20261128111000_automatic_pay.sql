-- An automatic scheme remains dated employee terms. Its accepted shift snapshot
-- contains the ladders, while the confirmed point/day contains the calculation basis.
-- Keep the complete cash and roster snapshot outside the employee-readable
-- work_shift table. Employees still see their own finalized wages there.
create table app_private.automatic_pay_basis (
  employee_id uuid not null references public.app_user(id),
  location_id uuid not null references public.location(id),
  day date not null,
  total_minor bigint not null check (total_minor >= 0),
  staff_count smallint not null check (staff_count between 1 and 3),
  roster_hash text not null,
  primary key (location_id, day, employee_id),
  foreign key (employee_id,location_id,day) references public.work_shift(employee_id,location_id,day)
    on delete cascade deferrable initially deferred
);
alter table app_private.automatic_pay_basis enable row level security;
revoke all on app_private.automatic_pay_basis from public,anon,authenticated,service_role;

create or replace function app_private.staff_custom_pay_validate(p_policy jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,app_private,pg_temp as $$
declare config jsonb:=p_policy->'automatic'; staffing jsonb; band jsonb;
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
  if p_policy - array['name','floor_minor','tiers','automatic'] <> '{}'::jsonb then
    perform app_private.fail('validation','Проверьте поля схемы оплаты');
  end if;
  perform app_private.motivation_validate(p_policy);
  if exists(select 1 from jsonb_array_elements(p_policy->'tiers') x where x-array['from_minor','rate_bp','bonus_minor'] <> '{}'::jsonb) then
    perform app_private.fail('validation','Проверьте поля ступеней');
  end if;
  if config is null then return; end if;
  if jsonb_typeof(config) is distinct from 'object' or config-array['location_id','currency','staffing','source'] <> '{}'::jsonb
     or config->>'currency' is distinct from 'RUB'
     or coalesce(config->>'source','') not in ('','history','starter')
     or coalesce(config->>'location_id','') !~ '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' then
    perform app_private.fail('validation','Проверьте точку и валюту автоматической схемы');
  end if;
  staffing:=config->'staffing';
  if jsonb_typeof(staffing) is distinct from 'object' or staffing-array['2','3'] <> '{}'::jsonb then
    perform app_private.fail('validation','Проверьте настройки расчёта на двух и трёх сотрудников');
  end if;
  for band in select value from jsonb_each(staffing) loop
    perform app_private.motivation_validate(jsonb_build_object('floor_minor',p_policy->'floor_minor','tiers',band));
    if exists(select 1 from jsonb_array_elements(band) x where x-array['from_minor','rate_bp','bonus_minor'] <> '{}'::jsonb) then
      perform app_private.fail('validation','Проверьте поля ступеней');
    end if;
  end loop;
end $$;

-- Same-currency proposal calibrated against the point's accepted retail revenue.
-- The three ladders are previewed before the employee is enrolled.
create function public.automatic_pay_preview(p_location uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare l public.location; month_start date; sample bigint[]; thresholds double precision[]; tiers jsonb:='[]';
  staffing jsonb:='{}'; lower_bound bigint:=0; i int; source text;
  starter_bounds bigint[]:=array[0,600000,800000,1100000,1400000,1700000,2100000]::bigint[];
  rates integer[]:=array[1400,1500,1700,1800,1800,1900,2000];
  bonuses bigint[]:=array[0,0,0,0,20000,20000,30000]::bigint[];
begin
  perform app_private.require_user();
  select * into l from public.location where id=p_location;
  if not found then perform app_private.fail('not-found','Точка не найдена'); end if;
  if not app_private.has_perm('team.manage',l.partner_id)
    and not (app_private.has_perm('staff.pay_edit',l.partner_id) and app_private.staff_location_scope(l.id)) then
    perform app_private.fail('forbidden','Нет права менять условия оплаты точки');
  end if;
  if l.currency <> 'RUB' then return jsonb_build_object('currency',l.currency,'sample_days',0,'policy',null); end if;
  month_start:=date_trunc('month',app_private.local_today(l.id))::date;
  select array_agg(d.total order by d.total) into sample
  from (
    select sum(r.total_minor)::bigint total
    from public.daily_revenue r
    where r.location_id=l.id and r.currency=l.currency
      and r.day >= (month_start-interval '3 months')::date and r.day<month_start
      and app_private.revenue_day_open(l.id,r.day)
      and not exists(select 1 from app_private.revenue_day_off off_day where off_day.location_id=l.id and off_day.day=r.day)
    group by r.day
  ) d;
  source:=case when coalesce(cardinality(sample),0)>=60 and coalesce(sample[cardinality(sample)],0)>0
    then 'history' else 'starter' end;
  thresholds:=array[0.17,0.36,0.62,0.75,0.87,0.95]::double precision[];
  for i in 1..7 loop
    if source='starter' then
      lower_bound:=starter_bounds[i];
    elsif i>1 then
      lower_bound:=greatest(lower_bound+50000,
        round(sample[ceil(thresholds[i-1]*cardinality(sample))::int]::numeric/50000)::bigint*50000);
    end if;
    if lower_bound>99999999999 then
      return jsonb_build_object('currency',l.currency,'sample_days',cardinality(sample),'policy',null);
    end if;
    tiers:=tiers||jsonb_build_array(jsonb_build_object('from_minor',lower_bound,'rate_bp',rates[i],'bonus_minor',bonuses[i]));
  end loop;
  select jsonb_object_agg(n::text,t) into staffing from (
      select n,jsonb_agg(jsonb_build_object('from_minor',v[1]*100,'rate_bp',v[2],'bonus_minor',v[3]*100) order by v[1]) t
      from (values
        (2,array[0,600,0]),(2,array[35000,700,0]),(2,array[45000,800,0]),(2,array[55000,900,0]),
        (2,array[65000,1000,200]),(2,array[75000,1000,300]),(2,array[85000,1100,400]),
        (3,array[0,500,0]),(3,array[50000,550,0]),(3,array[60000,650,0]),(3,array[68000,650,200]),
        (3,array[75000,700,300]),(3,array[82000,700,500]),(3,array[90000,750,600])
      ) steps(n,v)
      group by n
  ) bands;
  return jsonb_build_object('currency',l.currency,'sample_days',coalesce(cardinality(sample),0),'policy',jsonb_build_object(
    'name','Автоматический расчёт','floor_minor',
    coalesce((app_private.motivation_default(l.currency)->>'floor_minor')::bigint,0),'tiers',tiers,
    'automatic',jsonb_build_object('location_id',l.id,'currency',l.currency,'staffing',staffing,'source',source)));
end $$;

create function app_private.automatic_pay_for_staff(p_policy jsonb,p_staff_count integer) returns jsonb
language sql immutable strict set search_path=pg_catalog,pg_temp as $$
  select case when p_staff_count=1 then p_policy
    when p_policy->'automatic'->'staffing' ? p_staff_count::text
      then jsonb_set(p_policy,'{tiers}',p_policy->'automatic'->'staffing'->p_staff_count::text)
  end
$$;

create function app_private.automatic_pay_is_configured(p_policy jsonb,p_location uuid,p_currency text,p_staff_count integer) returns boolean
language sql immutable strict set search_path=pg_catalog,app_private,pg_temp as $$
  select p_policy->'automatic'->>'location_id' is not distinct from p_location::text
    and p_policy->'automatic'->>'currency' is not distinct from p_currency
    and app_private.automatic_pay_for_staff(p_policy,p_staff_count) is not null
$$;

create or replace function app_private.shift_motivation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare claimed_point uuid; basis bigint; policy jsonb; declared bigint; staff_count integer; solo_shift uuid;
begin
  if tg_op='INSERT' then
    new.pay_policy:=app_private.staff_pay_policy(new.employee_id,new.day);
  else
    new.pay_policy:=old.pay_policy;
    if old.status='closed' then
      new.counts_as_exit:=old.counts_as_exit;
      if (new.cash_minor,new.card_minor) is not distinct from (old.cash_minor,old.card_minor)
        and not coalesce(old.pay_policy ? 'automatic',false) then
        new.earned_minor:=old.earned_minor;
        new.rate_bp:=old.rate_bp;
        new.shift_fee_minor:=old.shift_fee_minor;
        return new;
      end if;
    end if;
  end if;
  if new.status<>'closed' then return new; end if;
  if tg_op='INSERT' or old.status<>'closed' then
    -- INSERT ... ON CONFLICT returns the winner, including when concurrent
    -- reports arrived through different point or supervisor entry points.
    insert into app_private.employee_daily_exit as e(employee_id,day,location_id) values(new.employee_id,new.day,new.location_id)
      on conflict(employee_id,day) do update set location_id=e.location_id
      returning location_id into claimed_point;
    new.counts_as_exit:=claimed_point=new.location_id;
    if not new.counts_as_exit then
      if new.pay_policy is null then
        new.pay_policy:=jsonb_build_object('mode','legacy','rate_bp',coalesce(new.rate_bp,0),'fee_minor',0);
      else new.pay_policy:=app_private.pay_without_exit(new.pay_policy); end if;
    end if;
  end if;
  basis:=new.cash_minor+new.card_minor;
  policy:=new.pay_policy;
  if policy ? 'automatic' then
    -- The only unattended confirmation is today's sole assigned cashier at
    -- this point, using a single complete shift or a reconciled day declaration.
    if (tg_op='INSERT' or old.status<>'closed') and policy->'automatic'->>'location_id'=new.location_id::text
       and new.day=app_private.local_today(new.location_id)
       and (select array_agg(s.user_id) from public.staff_member s where s.partner_id=new.partner_id
          and s.active and new.location_id=any(s.location_ids)) = array[new.employee_id]
       and not exists(select 1 from public.work_shift w where w.location_id=new.location_id
          and w.day=new.day and w.employee_id<>new.employee_id) then
      select reported_total_minor into declared from public.daily_revenue r
      where r.location_id=new.location_id and r.day=new.day and r.employee_id is null;
      if declared is not null or not found then
        select id into solo_shift from public.work_shift where location_id=new.location_id
          and day=new.day and employee_id=new.employee_id;
        insert into app_private.automatic_pay_basis(employee_id,location_id,day,total_minor,staff_count,roster_hash)
          values(new.employee_id,new.location_id,new.day,greatest(basis,declared),1,md5(coalesce(solo_shift,new.id)::text))
          on conflict(location_id,day,employee_id) do nothing;
      end if;
    end if;
    select b.total_minor,b.staff_count into basis,staff_count
      from app_private.automatic_pay_basis b
      where b.location_id=new.location_id and b.day=new.day and b.employee_id=new.employee_id;
    policy:=app_private.automatic_pay_for_staff(policy,staff_count);
    if basis is null or policy is null then
      new.earned_minor:=null;
      new.rate_bp:=null;
      new.shift_fee_minor:=null;
      return new;
    end if;
  end if;
  if new.pay_policy->>'mode'='legacy' then
    new.rate_bp:=(new.pay_policy->>'rate_bp')::integer;
    new.shift_fee_minor:=(new.pay_policy->>'fee_minor')::bigint;
    new.earned_minor:=app_private.shift_pay(new.cash_minor+new.card_minor,new.rate_bp,new.shift_fee_minor);
  elsif new.pay_policy is not null then
    new.earned_minor:=app_private.motivation_pay(basis,policy);
    select (x->>'rate_bp')::int into new.rate_bp from jsonb_array_elements(policy->'tiers') x
      where (x->>'from_minor')::bigint<=basis order by (x->>'from_minor')::bigint desc limit 1;
    new.shift_fee_minor:=(new.pay_policy->>'floor_minor')::bigint;
  end if;
  return new;
end $$;

create function public.automatic_pay_days(p_partner uuid,p_month date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare m date:=date_trunc('month',p_month)::date; result jsonb;
begin
  perform app_private.require_user();
  perform app_private.require_perm('team.manage',p_partner);
  if m is null or not isfinite(m) then perform app_private.fail('validation','Выберите месяц'); end if;
  with points as (
    select distinct w.location_id,w.day
    from public.work_shift w
    where w.partner_id=p_partner and w.day>=m and w.day<(m+interval '1 month')::date
      and w.status='closed' and w.pay_policy ? 'automatic'
  )
  select coalesce(jsonb_agg(jsonb_build_object('location_id',p.location_id,'location_name',l.name,'day',p.day,
    'currency',l.currency,'total_minor',turnover.total,'version',app_private.revenue_day_version(l.id,p.day),
    'people',attendees.people,'blocked',stats.has_open,'unconfigured',attendees.unsupported,
    'previously_confirmed',attendees.previously_confirmed,'confirmable',attendees.confirmable)
    order by p.day desc,l.name), '[]') into result
  from points p join public.location l on l.id=p.location_id
  cross join lateral (
    select sum(r.total_minor)::bigint total
    from public.daily_revenue r where r.location_id=l.id and r.day=p.day and r.currency=l.currency
  ) turnover
  cross join lateral (
    select count(*) filter(where x.status='closed')::int n,
      bool_or(x.status='open') has_open,
      md5(string_agg(x.id::text,',' order by x.id) filter(where x.status='closed')) roster_hash
    from public.work_shift x where x.location_id=l.id and x.day=p.day
  ) stats
  cross join lateral (
    select jsonb_agg(jsonb_build_object('id',w.employee_id,'name',u.full_name,'automatic',config.automatic)
        order by u.full_name,w.employee_id) people,
      bool_or(b.total_minor is not null) previously_confirmed,
      bool_or(config.automatic and not config.configured) unsupported,
      bool_or(config.automatic and config.pending) pending,
      bool_or(config.automatic and config.configured and config.pending) confirmable
    from public.work_shift w join public.app_user u on u.id=w.employee_id
    left join app_private.automatic_pay_basis b on b.location_id=w.location_id and b.day=w.day and b.employee_id=w.employee_id
    cross join lateral (
      select coalesce(w.pay_policy ? 'automatic',false) automatic,
        app_private.automatic_pay_is_configured(w.pay_policy,l.id,l.currency,stats.n) configured,
        b.total_minor is distinct from turnover.total or b.roster_hash is distinct from stats.roster_hash pending
    ) config
    where w.location_id=l.id and w.day=p.day and w.status='closed'
  ) attendees
  where attendees.pending;
  return result;
end $$;

create function public.automatic_pay_confirm(p_location uuid,p_day date,p_expected_version text,p_expected_staff uuid[],p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare l public.location; full_total bigint; roster uuid[]; roster_shifts uuid[]; expected uuid[]; updated int;
  confirmed_hash text; changed_staff uuid[]; current_earnings jsonb; new_earnings jsonb;
begin
  perform app_private.require_user();
  select * into l from public.location where id=p_location;
  if not found then perform app_private.fail('not-found','Точка не найдена'); end if;
  perform app_private.require_perm('team.manage',l.partner_id);
  l:=app_private.revenue_location(p_location,'revenue.enter');
  perform app_private.require_partner_operational(l.partner_id);
  if p_day is null or not isfinite(p_day) or p_day>app_private.local_today(l.id)
     or not app_private.revenue_day_open(l.id,p_day) or length(btrim(coalesce(p_reason,''))) not between 3 and 1000 then
    perform app_private.fail('validation','Проверьте рабочую дату и укажите причину подтверждения');
  end if;
  perform app_private.revenue_day_lock(l.id,p_day);
  if p_expected_version is distinct from app_private.revenue_day_version(l.id,p_day) then
    perform app_private.fail('version-conflict','Касса изменилась. Проверьте новый итог перед подтверждением');
  end if;
  select array_agg(w.employee_id order by w.employee_id),array_agg(w.id order by w.id) into roster,roster_shifts
    from public.work_shift w where w.location_id=l.id and w.day=p_day and w.status='closed';
  select array_agg(x order by x) into expected from unnest(p_expected_staff) x;
  if expected is distinct from roster then
    perform app_private.fail('version-conflict','Состав смен изменился. Проверьте список сотрудников');
  end if;
  if coalesce(cardinality(roster),0) not between 1 and 3 or exists(
    select 1 from public.work_shift w where w.location_id=l.id and w.day=p_day and w.status='open') then
    perform app_private.fail('validation','Закройте все смены и проверьте, что для состава есть настроенная схема');
  end if;
  select sum(r.total_minor)::bigint into full_total from public.daily_revenue r
    where r.location_id=l.id and r.day=p_day and r.currency=l.currency;
  if full_total is null then perform app_private.fail('validation','Сначала внесите кассу за день'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('shift',w.id,'earned_minor',w.earned_minor) order by w.id),'[]') into current_earnings
    from public.work_shift w where w.location_id=l.id and w.day=p_day and w.status='closed' and w.pay_policy ? 'automatic';
  confirmed_hash:=md5(array_to_string(roster_shifts,','));
  with changed as (
    insert into app_private.automatic_pay_basis as b(employee_id,location_id,day,total_minor,staff_count,roster_hash)
      select w.employee_id,l.id,p_day,full_total,cardinality(roster),confirmed_hash
      from public.work_shift w where w.location_id=l.id and w.day=p_day and w.status='closed' and w.pay_policy ? 'automatic'
        and app_private.automatic_pay_is_configured(w.pay_policy,l.id,l.currency,cardinality(roster))
      on conflict(location_id,day,employee_id) do update set total_minor=excluded.total_minor,
        staff_count=excluded.staff_count,roster_hash=excluded.roster_hash
        where b.total_minor is distinct from excluded.total_minor or b.roster_hash is distinct from excluded.roster_hash
      returning employee_id
  )
  select array_agg(employee_id) into changed_staff from changed;

  -- Updating the shift reruns its calculation with its own unchanged policy.
  update public.work_shift w set earned_minor=w.earned_minor
    where w.location_id=l.id and w.day=p_day and w.employee_id=any(changed_staff) and w.status='closed';
  get diagnostics updated=row_count;
  if updated>0 then
    select jsonb_agg(jsonb_build_object('shift',w.id,'earned_minor',w.earned_minor) order by w.id) into new_earnings
      from public.work_shift w where w.location_id=l.id and w.day=p_day and w.status='closed' and w.pay_policy ? 'automatic';
    perform app_private.audit('staff.pay_day_confirm','location',l.id,l.partner_id,
      jsonb_build_object('day',p_day,'total_minor',full_total,'currency',l.currency,'staff_ids',roster,
        'prior_earnings',current_earnings,'new_earnings',new_earnings),btrim(p_reason));
  end if;
  return jsonb_build_object('updated',updated,'total_minor',full_total);
end $$;

revoke all on function app_private.automatic_pay_for_staff(jsonb,integer),
  app_private.automatic_pay_is_configured(jsonb,uuid,text,integer),
  public.automatic_pay_preview(uuid), public.automatic_pay_days(uuid,date),
  public.automatic_pay_confirm(uuid,date,text,uuid[],text)
  from public,anon,authenticated,service_role;
-- The existing shift trigger can retain a different trusted owner from this migration.
grant select, insert, update on app_private.automatic_pay_basis to postgres;
grant execute on function app_private.automatic_pay_for_staff(jsonb,integer),
  app_private.automatic_pay_is_configured(jsonb,uuid,text,integer) to postgres;
do $automatic_pay_internal_acl$
begin
  if exists (select from pg_roles where rolname = 'supabase_admin') then
    grant select, insert, update on app_private.automatic_pay_basis to supabase_admin;
    grant execute on function app_private.automatic_pay_for_staff(jsonb,integer),
      app_private.automatic_pay_is_configured(jsonb,uuid,text,integer) to supabase_admin;
  end if;
end
$automatic_pay_internal_acl$;
grant execute on function public.automatic_pay_preview(uuid), public.automatic_pay_days(uuid,date),
  public.automatic_pay_confirm(uuid,date,text,uuid[],text) to authenticated;
insert into app_private.client_command(fn) values ('public.automatic_pay_preview(uuid)'),
  ('public.automatic_pay_days(uuid,date)'), ('public.automatic_pay_confirm(uuid,date,text,uuid[],text)');
