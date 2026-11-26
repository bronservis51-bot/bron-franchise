-- No deployment enables a shop or enrolls a partner. Workers are provisioned only
-- on the isolated test database, with EXECUTE on the two worker functions.
create table app_private.royalty_checkout_pilot (
  partner_id uuid primary key references public.partner(id)
);
create table app_private.royalty_checkout_attempt (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner(id),
  month date not null check (extract(day from month) = 1),
  amount_minor bigint not null check (amount_minor > 0),
  requested_by uuid not null references public.app_user(id),
  session_id uuid,
  status text not null default 'open' check (status in ('open','canceled','succeeded')),
  provider_id text unique,
  checkout_url text,
  first_dispatch_at timestamptz,
  lease uuid,
  lease_until timestamptz,
  next_check_at timestamptz not null default now()
);
create unique index royalty_checkout_open_month on app_private.royalty_checkout_attempt(partner_id,month)
  where status='open';
create index royalty_checkout_queue on app_private.royalty_checkout_attempt(next_check_at,id) where status='open';
alter table app_private.royalty_checkout_attempt enable row level security;
alter table app_private.royalty_checkout_pilot enable row level security;
revoke all on app_private.royalty_checkout_attempt, app_private.royalty_checkout_pilot from public, anon, authenticated, service_role;

create function app_private.royalty_checkout_owner(p_user uuid) returns uuid
language sql stable set search_path=pg_catalog,pg_temp as $$
  select case when count(distinct a.scope_id)=1 then (array_agg(a.scope_id))[1] end
  from public.role_assignment a join public.app_user u on u.id=a.user_id
  where a.user_id=p_user and u.status='active' and a.role='franchisee' and a.scope_type='partner' and a.revoked_at is null
$$;

-- The unleased quote is shared by the home card, command and worker. Rule 5.5
-- uses Moscow for billing and the established per-point calendar for reporting.
create function app_private.royalty_checkout_balance(p_partner uuid, p_user uuid, p_now timestamptz) returns jsonb
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare
  today date := (p_now at time zone 'Europe/Moscow')::date;
  start_date date := date_trunc('month',today)::date;
  period date := (start_date - interval '1 month')::date;
  p public.partner;
  missing jsonb;
  unfinished boolean;
  debt bigint;
  result jsonb;
begin
  select * into strict p from public.partner where id=p_partner;
  result := jsonb_build_object('state','none','month',period,'due_on',start_date+4,'currency',p.currency,
    'missing','[]'::jsonb,'amount_minor',null,'checkout_url',null,'overdue',false);
  if p.status <> 'active' or (not p.is_demo and exists (
    select 1 from public.app_user where id=p_user and is_demo
  )) then return result; end if;

  -- Do not reveal data or price a month under an unverified point/partner mapping.
  if not exists (select 1 from public.location where partner_id=p.id)
    or exists (select 1 from public.daily_revenue r join public.location l on l.id=r.location_id
      where r.day>=period and r.day<start_date and (r.partner_id=p.id or l.partner_id=p.id)
        and r.partner_id<>l.partner_id) then
    return result || jsonb_build_object('state','unavailable');
  end if;
  with calendars as materialized (
    select l.id, l.name, (p_now at time zone l.timezone)::date as local_day,
      app_private.location_month(l,period)->'missing_days' as days
    from public.location l where l.partner_id=p.id
  ), gaps as (
    select c.*, (select jsonb_agg(d order by d) from jsonb_array_elements_text(c.days) d
      where d::date<c.local_day) as completed_day_gaps
    from calendars c
  )
  select coalesce(jsonb_agg(jsonb_build_object('location_id',id,'location_name',name,'days',completed_day_gaps)
      order by name,id) filter (where completed_day_gaps is not null),'[]'::jsonb),
    bool_or(local_day<start_date and app_private.revenue_day_open(id,start_date-1))
    into missing,unfinished from gaps;
  if missing <> '[]'::jsonb then return result || jsonb_build_object('state','missing_revenue','missing',missing); end if;

  if p.currency <> 'RUB' or p.is_demo or not exists (
    select 1 from app_private.royalty_checkout_pilot where partner_id=p.id
  ) or not exists (select 1 from public.app_user where id=p_user and status='active' and not is_demo) then
    return result;
  end if;
  if unfinished or exists (select 1 from public.daily_revenue r where r.partner_id=p.id
    and r.day>=period and r.day<start_date and r.currency<>p.currency) then
    return result || jsonb_build_object('state','unavailable');
  end if;
  select case when not l.is_open then l.debt_minor end into debt
    from app_private.royalty_ledger(p.id) l where l.month=period;
  if found and debt is null then return result || jsonb_build_object('state','unavailable'); end if;
  -- The ledger enumerates only months with financial entries. A completed month
  -- without a row (for example, every day off) has no charge.
  debt := coalesce(debt,0);
  return result || jsonb_build_object('amount_minor',debt::text,'overdue',debt>0 and today>start_date+4,'state',
    case when debt<=0 then 'none' when today>start_date+4 then 'overdue' else 'payable' end);
exception when data_exception then
  return result || jsonb_build_object('state','unavailable');
end $$;

create function app_private.royalty_checkout_card(p_request boolean) returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare
  actor uuid := app_private.require_user();
  partner uuid := app_private.royalty_checkout_owner(actor);
  quote jsonb;
  attempt app_private.royalty_checkout_attempt;
  period date;
begin
  if partner is null then perform app_private.fail('forbidden','Нужен доступ владельца к одному франчайзи'); end if;
  if p_request then perform pg_advisory_xact_lock(hashtextextended('royalty-checkout:'||partner,0)); end if;
  quote := app_private.royalty_checkout_balance(partner,actor,now());
  if quote->>'amount_minor' is null then return quote; end if;
  period := (quote->>'month')::date;
  select * into attempt from app_private.royalty_checkout_attempt where partner_id=partner and month=period and status='open';
  if found then
    if attempt.checkout_url is not null and attempt.amount_minor=(quote->>'amount_minor')::bigint then
      return quote || jsonb_build_object('checkout_url',attempt.checkout_url);
    end if;
    return quote || jsonb_build_object('state','checking');
  end if;
  if p_request and quote->>'state' in ('overdue','payable') then
    insert into app_private.royalty_checkout_attempt(partner_id,month,amount_minor,requested_by,session_id)
    values (partner,period,(quote->>'amount_minor')::bigint,actor,
      (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid);
    return quote || jsonb_build_object('state','checking');
  end if;
  return quote;
end $$;

create function public.royalty_home_status() returns jsonb
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select app_private.royalty_checkout_card(false)
$$;
create function public.royalty_checkout_request() returns jsonb
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select app_private.royalty_checkout_card(true)
$$;

create function app_private.royalty_checkout_work(p_limit integer)
returns table(id uuid, lease uuid, month date, amount_minor bigint, provider_id text)
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a app_private.royalty_checkout_attempt;
  quote jsonb;
begin
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'invalid-limit'; end if;
  for a in select t.* from app_private.royalty_checkout_attempt t
      where t.status='open' and t.next_check_at<=now() and (t.lease_until is null or t.lease_until<=now())
        and (t.provider_id is not null or t.first_dispatch_at is null or t.first_dispatch_at>now()-interval '23 hours')
      order by t.next_check_at,t.id limit p_limit for update skip locked loop
    if a.provider_id is null then
      quote := null;
      if app_private.royalty_checkout_owner(a.requested_by)=a.partner_id and
        (a.session_id is null or exists(select 1 from auth.sessions s where s.id=a.session_id and s.user_id=a.requested_by)) then
        quote := app_private.royalty_checkout_balance(a.partner_id,a.requested_by,now());
      end if;
      if (quote->>'state' in ('overdue','payable') and (quote->>'month')::date=a.month
        and (quote->>'amount_minor')::bigint=a.amount_minor) is not true then
        -- After possible transmission, only a confirmed terminal provider status
        -- can release this month. A changed balance must not cause a new create.
        update app_private.royalty_checkout_attempt set
          status=case when a.first_dispatch_at is null then 'canceled' else 'open' end,
          next_check_at=now()+interval '1 minute' where royalty_checkout_attempt.id=a.id;
        continue;
      end if;
    end if;
    update app_private.royalty_checkout_attempt t set lease=gen_random_uuid(),lease_until=now()+interval '90 seconds',
      first_dispatch_at=coalesce(t.first_dispatch_at,now()) where t.id=a.id
      returning t.id,t.lease,t.month,t.amount_minor,t.provider_id into id,lease,month,amount_minor,provider_id;
    return next;
  end loop;
end $$;

create function app_private.royalty_checkout_observe(p_id uuid,p_lease uuid,p_provider_id text,p_status text,p_checkout_url text,p_paid_on date)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a app_private.royalty_checkout_attempt;
begin
  select * into a from app_private.royalty_checkout_attempt where id=p_id and lease=p_lease
    and status='open' and lease_until>clock_timestamp() for update;
  if not found then return false; end if;
  if p_provider_id is null or length(btrim(p_provider_id)) not between 1 and 128
    or (a.provider_id is not null and a.provider_id<>p_provider_id)
    or p_status is null or p_status not in ('pending','succeeded','canceled')
    or (p_status='succeeded')<>(p_paid_on is not null)
    or (p_paid_on is not null and not isfinite(p_paid_on))
    or (p_checkout_url is not null and (p_status<>'pending' or p_checkout_url !~ '^https://(yoomoney\.ru|yookassa\.ru)/[^[:space:]]+$')) then
    raise exception 'invalid-observation';
  end if;

  update app_private.royalty_checkout_attempt set provider_id=p_provider_id,
    status=case when p_status='pending' then 'open' else p_status end,
    checkout_url=case when p_status='pending' then coalesce(p_checkout_url,a.checkout_url) end,
    lease=null,lease_until=null,next_check_at=now()+interval '30 seconds' where id=a.id;
  if p_status='succeeded' then
    insert into public.royalty_payment(id,partner_id,month,amount_minor,paid_on,note)
    values (a.id,a.partner_id,a.month,a.amount_minor,p_paid_on,'ЮKassa · '||p_provider_id);
  end if;
  return true;
end $$;

revoke all on function app_private.royalty_checkout_owner(uuid),app_private.royalty_checkout_balance(uuid,uuid,timestamptz),
  app_private.royalty_checkout_card(boolean),app_private.royalty_checkout_work(integer),
  app_private.royalty_checkout_observe(uuid,uuid,text,text,text,date),public.royalty_home_status(),public.royalty_checkout_request()
  from public, anon, authenticated, service_role;
grant execute on function public.royalty_home_status(),public.royalty_checkout_request() to authenticated;
insert into app_private.client_command(fn) values ('public.royalty_home_status()'),('public.royalty_checkout_request()');
