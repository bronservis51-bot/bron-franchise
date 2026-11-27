-- Direct test payments retain the original entry point and keep ownership of
-- work already dispatched before this migration.
alter table app_private.royalty_checkout_pilot add column use_invoice boolean not null default false;
alter table app_private.royalty_checkout_attempt add column invoice_name text;

create function app_private.royalty_checkout_work(p_limit integer,p_invoice boolean)
returns table(id uuid, lease uuid, month date, amount_minor bigint, provider_id text,
  invoice_name text, first_dispatch_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a app_private.royalty_checkout_attempt;
  quote jsonb;
begin
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'invalid-limit'; end if;
  if p_invoice is null then raise exception 'invalid-checkout-mode'; end if;
  for a in select t.* from app_private.royalty_checkout_attempt t
      left join app_private.royalty_checkout_pilot pilot on pilot.partner_id=t.partner_id
      where t.status='open' and t.next_check_at<=now() and (t.lease_until is null or t.lease_until<=now())
        and p_invoice=case
          when t.first_dispatch_at is not null or t.provider_id is not null or t.recovery_provider_id is not null
            then t.invoice_name is not null
          else coalesce(pilot.use_invoice,false) end
        and (t.provider_id is not null or t.recovery_provider_id is not null or t.first_dispatch_at is null or t.first_dispatch_at>now()-interval '23 hours')
      order by t.next_check_at,t.id limit p_limit for update of t skip locked loop
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
      first_dispatch_at=coalesce(t.first_dispatch_at,now()),
      -- Keep the same name and expiry after an uncertain create request.
      invoice_name=case when p_invoice and t.invoice_name is null then
        (select coalesce(nullif(btrim(p.contact_name),''),p.name) from public.partner p where p.id=t.partner_id)
        else t.invoice_name end
      where t.id=a.id
      returning t.id,t.lease,t.month,t.amount_minor,
        coalesce(t.provider_id,(case when p_invoice then 'in-' else '' end)||t.recovery_provider_id::text),
        t.invoice_name,t.first_dispatch_at
      into id,lease,month,amount_minor,provider_id,invoice_name,first_dispatch_at;
    return next;
  end loop;
end $$;

revoke all on function app_private.royalty_checkout_work(integer,boolean) from public,anon,authenticated,service_role;

create or replace function app_private.royalty_checkout_work(p_limit integer)
returns table(id uuid, lease uuid, month date, amount_minor bigint, provider_id text)
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select w.id,w.lease,w.month,w.amount_minor,w.provider_id
  from app_private.royalty_checkout_work(p_limit,false) w
$$;

create or replace function app_private.royalty_checkout_observe(p_id uuid,p_lease uuid,p_provider_id text,p_status text,p_checkout_url text,p_paid_on date)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a app_private.royalty_checkout_attempt;
begin
  select * into a from app_private.royalty_checkout_attempt where id=p_id and lease=p_lease
    and status='open' and lease_until>clock_timestamp() for update;
  if not found then return false; end if;
  if p_provider_id is null or length(btrim(p_provider_id)) not between 1 and 128
    or (a.provider_id is not null and a.provider_id<>p_provider_id)
    or (a.invoice_name is not null and p_provider_id !~* '^in-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (a.recovery_provider_id is not null
      and (case when a.invoice_name is not null then 'in-' else '' end)||a.recovery_provider_id::text<>p_provider_id)
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
