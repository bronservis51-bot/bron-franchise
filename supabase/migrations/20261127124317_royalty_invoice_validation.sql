-- Use the franchisee name from the partner card. A contact person can be
-- different from the franchisee. Reject quotes below the provider's minimum.
create or replace function app_private.royalty_checkout_work(p_limit integer,p_invoice boolean)
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
    if p_invoice and a.amount_minor<100 and a.first_dispatch_at is null and a.provider_id is null then
      -- A partner can be switched to invoices after the original click.
      update app_private.royalty_checkout_attempt set status='canceled' where royalty_checkout_attempt.id=a.id;
      continue;
    end if;
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
        (select p.name from public.partner p where p.id=t.partner_id)
        else t.invoice_name end
      where t.id=a.id
      returning t.id,t.lease,t.month,t.amount_minor,
        coalesce(t.provider_id,(case when p_invoice then 'in-' else '' end)||t.recovery_provider_id::text),
        t.invoice_name,t.first_dispatch_at
      into id,lease,month,amount_minor,provider_id,invoice_name,first_dispatch_at;
    return next;
  end loop;
end $$;

-- Workers receive access to their own queue entry point.
create function app_private.royalty_invoice_checkout_work(p_limit integer)
returns table(id uuid, lease uuid, month date, amount_minor bigint, provider_id text,
  invoice_name text, first_dispatch_at timestamptz)
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select w.id,w.lease,w.month,w.amount_minor,w.provider_id,w.invoice_name,w.first_dispatch_at
  from app_private.royalty_checkout_work(p_limit,true) w
$$;
revoke all on function app_private.royalty_invoice_checkout_work(integer) from public,anon,authenticated,service_role;

create or replace function app_private.royalty_checkout_card(p_request boolean,p_month date,p_amount_minor bigint) returns jsonb
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
  period := (quote->>'month')::date;
  if p_request and (p_month is distinct from period or p_amount_minor is null or p_amount_minor<=0
    or quote->>'currency' is distinct from 'RUB' or quote->>'state' not in ('payable','overdue')
    or p_amount_minor is distinct from (quote->>'amount_minor')::bigint) then
    perform app_private.fail('version-conflict','Сумма или месяц оплаты изменились. Обновите карточку роялти.');
  end if;
  if quote->>'amount_minor' is null then return quote; end if;
  select * into attempt from app_private.royalty_checkout_attempt where partner_id=partner and month=period and status='open';
  if found then
    if attempt.checkout_url is not null and attempt.amount_minor=(quote->>'amount_minor')::bigint then
      return quote || jsonb_build_object('checkout_url',attempt.checkout_url);
    end if;
    return quote || jsonb_build_object('state','checking');
  end if;
  if p_request and quote->>'state' in ('overdue','payable') then
    if p_amount_minor<100 and exists (
      select 1 from app_private.royalty_checkout_pilot where partner_id=partner and use_invoice
    ) then perform app_private.fail('validation','Счёт ЮKassa можно выставить на сумму от 1 ₽.'); end if;
    insert into app_private.royalty_checkout_attempt(partner_id,month,amount_minor,requested_by,session_id)
    values (partner,period,(quote->>'amount_minor')::bigint,actor,
      (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid);
    return quote || jsonb_build_object('state','checking');
  end if;
  return quote;
end $$;

