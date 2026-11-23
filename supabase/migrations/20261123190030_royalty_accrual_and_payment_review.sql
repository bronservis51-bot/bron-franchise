-- Preserve the ledger and its booked totals. Project the two kinds of manual entry separately.
create function app_private.royalty_manual_breakdown(p_partner uuid, p_month date, p_before date default null)
returns jsonb language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'correction_minor', coalesce(sum(r.amount_minor) filter (where r.kind = 'correction'), 0),
    'past_debt_minor', coalesce(sum(r.amount_minor) filter (where r.kind = 'past_debt'), 0))
  from public.royalty_manual r
  where r.partner_id = p_partner and (r.month = p_month or (p_month is null and r.month < p_before))
$$;

-- New targets cover the monthly accrual. Old clients still send the combined target.
create function app_private.royalty_apply_accrual(p_partner uuid, p_month date, p_target bigint, p_note text, p_accrual_only boolean)
returns jsonb language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  g record;
  v_manual bigint;
  v_delta bigint;
  v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if p_target is null or p_target < 0 then perform app_private.fail('validation', 'Укажите сумму начисления', 'amount'); end if;
  if v_month is null or not isfinite(v_month) or v_month > app_private.current_month() then
    perform app_private.fail('validation', 'Выберите текущий или прошедший месяц', 'month');
  end if;
  if coalesce(trim(p_note), '') = '' then perform app_private.fail('validation', 'Напишите причину исправления', 'note'); end if;

  perform pg_advisory_xact_lock(hashtextextended('royalty.accrual:' || p_partner::text || ':' || (v_month - date '2000-01-01')::text, 0));
  select * into g from app_private.royalty_ledger(p_partner) l where l.month = v_month;
  v_manual := case when p_accrual_only then
    (app_private.royalty_manual_breakdown(p_partner, v_month)->>'correction_minor')::bigint
    else coalesce(g.manual_minor, 0) end;
  v_delta := p_target - coalesce(g.accrued_minor, 0) - v_manual;
  if v_delta = 0 then return jsonb_build_object('id', null, 'delta_minor', 0); end if;

  insert into public.royalty_manual(partner_id, month, amount_minor, note, kind, created_by)
  values (p_partner, v_month, v_delta, trim(p_note), 'correction', auth.uid()) returning id into v_id;
  perform app_private.audit('royalty.correction', 'royalty_manual', v_id, p_partner,
    jsonb_build_object('month', v_month, 'target', p_target, 'delta', v_delta, 'accrual_only', p_accrual_only));
  return jsonb_build_object('id', v_id, 'delta_minor', v_delta);
end $$;

create or replace function public.royalty_set_accrual(p_partner uuid, p_month date, p_target bigint, p_note text)
returns jsonb language sql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
  select app_private.royalty_apply_accrual(p_partner, p_month, p_target, p_note, false)
$$;

create index royalty_payment_review on public.royalty_payment(partner_id, paid_on, amount_minor);

create function app_private.royalty_payment_reviewed(
  p_partner uuid, p_month date, p_amount bigint, p_paid_on date, p_note text, p_reviewed jsonb
) returns jsonb language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_matches jsonb; v_ids jsonb; v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Укажите сумму оплаты', 'amount'); end if;
  if p_month is null or not isfinite(p_month) then perform app_private.fail('validation', 'Укажите месяц, за который оплата', 'month'); end if;
  if p_paid_on is null or not isfinite(p_paid_on) or p_paid_on > current_date + 1 then
    perform app_private.fail('validation', 'Неверная дата оплаты', 'paid_on');
  end if;
  if p_reviewed is not null and jsonb_typeof(p_reviewed) <> 'array' then
    perform app_private.fail('validation', 'Проверьте похожие оплаты');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'royalty.payment:' || p_partner::text || ':' || (p_paid_on - date '2000-01-01')::text || ':' || p_amount::text, 0));

  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'note', r.note) order by r.month, r.id), '[]'::jsonb),
    coalesce(jsonb_agg(r.id), '[]'::jsonb) into v_matches, v_ids
  from public.royalty_payment r
  where r.partner_id = p_partner and r.paid_on = p_paid_on and r.amount_minor = p_amount;

  if v_ids <> '[]'::jsonb and not coalesce(v_ids @> p_reviewed and v_ids <@ p_reviewed, false) then
    return jsonb_build_object('matches', v_matches);
  end if;
  insert into public.royalty_payment(partner_id, month, amount_minor, paid_on, note, created_by)
  values (p_partner, date_trunc('month', p_month)::date, p_amount, p_paid_on, nullif(trim(p_note), ''), auth.uid()) returning id into v_id;
  perform app_private.audit('royalty.payment', 'royalty_payment', v_id, p_partner,
    jsonb_build_object('month', p_month, 'amount', p_amount, 'reviewed', v_ids));
  return jsonb_build_object('id', v_id);
end $$;

-- Keep legacy transport retries safe. A legacy UI must update to review a matching payment.
create or replace function public.royalty_payment_add(p_partner uuid, p_month date, p_amount bigint, p_paid_on date, p_note text default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare result jsonb;
begin
  result := app_private.royalty_payment_reviewed(p_partner, p_month, p_amount, p_paid_on, p_note, null);
  if result ? 'matches' then
    perform app_private.fail('validation', 'Есть похожая оплата. Обновите приложение и проверьте запись перед добавлением.');
  end if;
  return (result->>'id')::uuid;
end $$;

revoke execute on function app_private.royalty_manual_breakdown(uuid,date,date),
  app_private.royalty_apply_accrual(uuid,date,bigint,text,boolean),
  app_private.royalty_payment_reviewed(uuid,date,bigint,date,text,jsonb) from public, anon, authenticated;
grant execute on function app_private.royalty_manual_breakdown(uuid,date,date),
  app_private.royalty_apply_accrual(uuid,date,bigint,text,boolean),
  app_private.royalty_payment_reviewed(uuid,date,bigint,date,text,jsonb) to postgres;
do $private_finance_grant$
begin
  if exists (select from pg_roles where rolname = 'supabase_admin') then
    grant execute on function app_private.royalty_manual_breakdown(uuid,date,date),
  app_private.royalty_apply_accrual(uuid,date,bigint,text,boolean),
  app_private.royalty_payment_reviewed(uuid,date,bigint,date,text,jsonb) to supabase_admin;
  end if;
end
$private_finance_grant$;


create or replace function public.royalty_partner(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare p public.partner;
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  select * into p from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  return jsonb_build_object(
    'partner_id', p.id, 'partner_name', p.name, 'currency', p.currency,
    'rate_bp', app_private.rate_bp(p.id, app_private.current_month()),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(p.id, g.month) order by g.month desc) from app_private.royalty_ledger(p.id) g), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on,
        'note', r.note, 'created_at', r.created_at) order by r.paid_on desc, r.created_at desc)
      from public.royalty_payment r where r.partner_id = p.id), '[]'::jsonb),
    'manual', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note,
        'created_at', r.created_at) order by r.month desc)
      from public.royalty_manual r where r.partner_id = p.id), '[]'::jsonb),
    'rates', coalesce((select jsonb_agg(jsonb_build_object('effective_from', r.effective_from, 'rate_bp', r.rate_bp) order by r.effective_from desc)
      from public.royalty_rate r where r.partner_id = p.id), '[]'::jsonb));
end $$;

create or replace function public.royalty_my() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid; v_partners uuid[]; p public.partner; v_cur date := app_private.current_month(); v_open record; v_elapsed int; v_days int;
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into v_partners
    from app_private.active_assignments() a where a.role = 'franchisee' and a.scope_id is not null;
  if v_partners is null then perform app_private.fail('forbidden', 'Роялти видит франчайзи'); end if;
  if cardinality(v_partners) > 1 then perform app_private.fail('validation', 'К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  v_partner := v_partners[1];
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select * into v_open from app_private.royalty_ledger(v_partner) g where g.month = v_cur;
  v_days := extract(day from (v_cur + interval '1 month - 1 day'))::int;
  v_elapsed := greatest(1, extract(day from (now() at time zone 'Europe/Moscow'))::int - 1);
  return jsonb_build_object(
    'partner_id', p.id, 'partner_name', p.name, 'currency', p.currency,
    'rate_bp', app_private.rate_bp(p.id, v_cur),
    'debt_minor', (select coalesce(sum(debt_minor), 0) from app_private.royalty_ledger(v_partner) g where not g.is_open),
    'live', jsonb_build_object('month', v_cur,
      'revenue_minor', coalesce(v_open.revenue_minor, 0), 'accrued_minor', coalesce(v_open.accrued_minor, 0),
      -- прогноз на конец месяца по темпу прошедших дней
      'projected_accrual_minor', round(coalesce(v_open.accrued_minor, 0)::numeric / v_elapsed * v_days)::bigint,
      'paid_minor', coalesce(v_open.paid_minor, 0)),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(v_partner, g.month) order by g.month desc) from app_private.royalty_ledger(v_partner) g), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on, 'note', r.note)
      order by r.paid_on desc) from public.royalty_payment r where r.partner_id = v_partner), '[]'::jsonb));
end $$;

create or replace function public.royalty_summary(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date; v_rows jsonb; v_cur date := app_private.current_month();
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  select coalesce(jsonb_agg(row_data order by row_data ->> 'partner_name'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'partner_id', p.id, 'partner_name', p.name, 'status', p.status, 'country', p.country, 'currency', p.currency,
      'rate_bp', app_private.rate_bp(p.id, coalesce(v_month, v_cur)),
      'revenue_minor', coalesce(sum(g.revenue_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'accrued_minor', coalesce(sum(g.accrued_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'manual_minor', coalesce(sum(g.manual_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'paid_minor', coalesce(sum(g.paid_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'debt_minor', coalesce(sum(case when v_month is null and not g.is_open then g.debt_minor
                                       when g.month = v_month then g.accrued_minor + g.manual_minor - g.paid_minor end), 0),
      'is_open', v_month is not null and v_month >= v_cur,
      'current_revenue_minor', coalesce(sum(g.revenue_minor) filter (where g.month = v_cur), 0),
      'current_accrual_minor', coalesce(sum(g.accrued_minor) filter (where g.month = v_cur), 0),
      'debt_months', coalesce(jsonb_agg(jsonb_build_object('month', g.month, 'debt_minor', g.debt_minor) order by g.month)
                      filter (where g.debt_minor > 0 and not g.is_open), '[]'::jsonb),
      'last_payment_on', (select max(paid_on) from public.royalty_payment r where r.partner_id = p.id),
      'fx_rub', app_private.fx_rub(p.currency, current_date)
    ) || app_private.royalty_manual_breakdown(p.id, v_month, v_cur) as row_data
    from public.partner p
    left join lateral app_private.royalty_ledger(p.id) g on true
    group by p.id
  ) t;
  return jsonb_build_object(
    'month', v_month, 'current_month', v_cur, 'rows', v_rows,
    'totals', (select coalesce(jsonb_agg(jsonb_build_object('currency', c, 'accrued_minor', a, 'paid_minor', pd, 'debt_minor', d) order by c), '[]'::jsonb)
      from (select x ->> 'currency' c, sum((x ->> 'accrued_minor')::bigint + (x ->> 'manual_minor')::bigint) a, sum((x ->> 'paid_minor')::bigint) pd,
                   sum((x ->> 'debt_minor')::bigint) d
            from jsonb_array_elements(v_rows) x group by 1) s),
    'debt_rub_minor', (select case
      when bool_or((x ->> 'debt_minor')::numeric <> 0 and (x ->> 'fx_rub') is null) then null
      else round(sum(case when (x ->> 'debt_minor')::numeric = 0 then 0
        else (x ->> 'debt_minor')::numeric * (x ->> 'fx_rub')::numeric end))
      end from jsonb_array_elements(v_rows) x));
end $$;
