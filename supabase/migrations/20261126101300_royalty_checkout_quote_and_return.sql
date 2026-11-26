-- Bind consent to the exact month and amount the owner saw. Existing no-arg
-- clients must refresh before they can submit a payment.
delete from app_private.client_command where fn='public.royalty_checkout_request()'::regprocedure;
drop function public.royalty_checkout_request();

create function app_private.royalty_checkout_card(p_request boolean,p_month date,p_amount_minor bigint) returns jsonb
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
    insert into app_private.royalty_checkout_attempt(partner_id,month,amount_minor,requested_by,session_id)
    values (partner,period,(quote->>'amount_minor')::bigint,actor,
      (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid);
    return quote || jsonb_build_object('state','checking');
  end if;
  return quote;
end $$;

create or replace function public.royalty_home_status() returns jsonb
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select app_private.royalty_checkout_card(false,null,null)
$$;
create function public.royalty_checkout_request(p_month date,p_amount_minor bigint) returns jsonb
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select app_private.royalty_checkout_card(true,p_month,p_amount_minor)
$$;

drop function app_private.royalty_checkout_card(boolean);

-- A return URL identifies an attempt but cannot authorize it. Consult the
-- verified receipt, not the current month's quote or any query-string status.
create function public.royalty_checkout_return_status(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare
  actor uuid := app_private.require_user();
  partner uuid := app_private.royalty_checkout_owner(actor);
  attempt app_private.royalty_checkout_attempt;
  state text;
begin
  select a.* into attempt from app_private.royalty_checkout_attempt a
    where a.id=p_attempt and a.partner_id=partner
      and exists (select 1 from public.app_user u where u.id=actor and not u.is_demo);
  state := case attempt.status when 'open' then 'checking' when 'succeeded' then 'paid'
    when 'canceled' then 'canceled' else 'unavailable' end;
  return jsonb_build_object('state',state,'month',attempt.month,'amount_minor',attempt.amount_minor::text,'currency','RUB');
end $$;

revoke all on function app_private.royalty_checkout_card(boolean,date,bigint),
  public.royalty_checkout_request(date,bigint),public.royalty_checkout_return_status(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.royalty_checkout_request(date,bigint),public.royalty_checkout_return_status(uuid)
  to authenticated;
insert into app_private.client_command(fn) values
  ('public.royalty_checkout_request(date,bigint)'),('public.royalty_checkout_return_status(uuid)');
