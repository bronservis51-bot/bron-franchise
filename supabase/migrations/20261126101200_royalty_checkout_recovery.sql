-- A successful settlement and its corresponding private receipt are permanent.
-- Manual payment reversals continue through the manager's existing command.
create function app_private.royalty_guard_provider_payment() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if exists (select 1 from app_private.royalty_checkout_attempt where id=old.id and status='succeeded') then
    perform app_private.fail('validation','Оплата подтверждена ЮKassa. Её нельзя отменить через журнал ручных оплат.');
  end if;
  return old;
end $$;
revoke all on function app_private.royalty_guard_provider_payment() from public,anon,authenticated,service_role;
create trigger royalty_guard_provider_payment before delete on public.royalty_payment
for each row execute function app_private.royalty_guard_provider_payment();

-- This UUID is a lookup hint, not an established provider identity. Only the
-- observing worker can promote it to provider_id after verification by GET.
alter table app_private.royalty_checkout_attempt add column recovery_provider_id uuid;

create function app_private.royalty_checkout_recover(p_id uuid,p_candidate uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  update app_private.royalty_checkout_attempt set recovery_provider_id=p_candidate,
    next_check_at=now(),lease=null,lease_until=null
  where id=p_id and p_candidate is not null and status='open' and provider_id is null
    and first_dispatch_at<=now()-interval '23 hours' and (lease_until is null or lease_until<=now());
  return found;
end $$;
revoke all on function app_private.royalty_checkout_recover(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function app_private.royalty_checkout_work(p_limit integer)
returns table(id uuid, lease uuid, month date, amount_minor bigint, provider_id text)
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a app_private.royalty_checkout_attempt;
  quote jsonb;
begin
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'invalid-limit'; end if;
  for a in select t.* from app_private.royalty_checkout_attempt t
      where t.status='open' and t.next_check_at<=now() and (t.lease_until is null or t.lease_until<=now())
        and (t.provider_id is not null or t.recovery_provider_id is not null or t.first_dispatch_at is null or t.first_dispatch_at>now()-interval '23 hours')
      order by t.next_check_at,t.id limit p_limit for update skip locked loop
    if a.provider_id is null and a.recovery_provider_id is null then
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
      returning t.id,t.lease,t.month,t.amount_minor,coalesce(t.provider_id,t.recovery_provider_id::text) into id,lease,month,amount_minor,provider_id;
    return next;
  end loop;
end $$;

create or replace function app_private.royalty_checkout_observe(p_id uuid,p_lease uuid,p_provider_id text,p_status text,p_checkout_url text,p_paid_on date)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a app_private.royalty_checkout_attempt;
begin
  select * into a from app_private.royalty_checkout_attempt where id=p_id and lease=p_lease
    and status='open' and lease_until>clock_timestamp() for update;
  if not found then return false; end if;
  if p_provider_id is null or length(btrim(p_provider_id)) not between 1 and 128
    or (a.provider_id is not null and a.provider_id<>p_provider_id)
    or (a.recovery_provider_id is not null and a.recovery_provider_id::text<>p_provider_id)
    or p_status is null or p_status not in ('pending','succeeded','canceled')
    or (p_status='succeeded')<>(p_paid_on is not null)
    or (p_paid_on is not null and not isfinite(p_paid_on))
    or (p_checkout_url is not null and (p_status<>'pending' or p_checkout_url !~ '^https://(yoomoney\.ru|yookassa\.ru)/[^[:space:]]+$')) then
    raise exception 'invalid-observation';
  end if;

  update app_private.royalty_checkout_attempt set provider_id=p_provider_id,recovery_provider_id=null,
    status=case when p_status='pending' then 'open' else p_status end,
    checkout_url=case when p_status='pending' then coalesce(p_checkout_url,a.checkout_url) end,
    lease=null,lease_until=null,next_check_at=now()+interval '30 seconds' where id=a.id;
  if p_status='succeeded' then
    insert into public.royalty_payment(id,partner_id,month,amount_minor,paid_on,note)
    values (a.id,a.partner_id,a.month,a.amount_minor,p_paid_on,'ЮKassa · '||p_provider_id);
  end if;
  return true;
end $$;
