-- Read repeat candidates after concurrent readers of the same destination have committed.
create or replace function public.expense_repeat(p_month date) returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_month date := date_trunc('month', p_month)::date; n int;
begin
  if v_month is null or v_month > app_private.current_month() then perform app_private.fail('validation', 'Нельзя внести расход за будущий месяц', 'month'); end if;
  perform pg_advisory_xact_lock(hashtextextended('expense.repeat:' || v_partner::text || ':' || v_month::text, 0));
  insert into public.expense(partner_id, location_id, month, category, amount_minor, note, created_by)
  select e.partner_id, e.location_id, v_month, e.category, e.amount_minor, e.note, auth.uid()
  from public.expense e
  where e.partner_id = v_partner and e.month = (v_month - interval '1 month')::date
    and not exists (select 1 from public.expense x where x.partner_id = v_partner and x.month = v_month
      and x.category = e.category and x.location_id is not distinct from e.location_id);
  get diagnostics n = row_count;
  if n > 0 then perform app_private.audit('expense.repeat', 'partner', v_partner, v_partner, jsonb_build_object('month', v_month, 'count', n)); end if;
  return n;
end $$;

-- Only the operation that removed the row records a deletion.
create or replace function public.manager_company_expense_delete(p_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare e app_private.network_expense;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  delete from app_private.network_expense where id=p_id returning * into e;
  if not found then perform app_private.fail('not-found','Расход не найден'); end if;
  perform app_private.audit('network_expense.delete','network_expense',p_id,null,
    jsonb_build_object('month',e.month,'category',e.category,'amount',e.amount_minor));
end $$;
