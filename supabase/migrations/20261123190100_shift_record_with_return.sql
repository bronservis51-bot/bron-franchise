create function public.shift_record_with_return(
  p_cash bigint, p_card bigint, p_return bigint, p_operation uuid, p_comment text,
  p_location uuid, p_day date, p_shift uuid, p_expected_revision bigint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  previous public.work_shift;
  saved public.work_shift;
  receipt app_private.operation_receipt;
  payload jsonb;
  result jsonb;
  shift_id uuid;
begin
  if p_operation is null or p_return is null or p_return not between 0 and 100000000000 then
    perform app_private.fail('validation', 'Проверьте сумму возврата', 'return');
  end if;
  if p_shift is null then
    if p_location is null or p_day is null or p_expected_revision is not null or p_reason is not null then
      perform app_private.fail('validation', 'Укажите дату и точку смены');
    end if;
  elsif p_expected_revision is null or p_location is not null or p_day is not null then
    perform app_private.fail('validation', 'Откройте смену заново');
  end if;

  if p_reason is null then
    perform app_private.my_staff();
  else
    select * into previous from public.work_shift where id = p_shift;
    if not found or not app_private.has_perm('staff.manage', previous.partner_id)
      or not app_private.has_perm('revenue.enter', previous.partner_id)
      or not app_private.can_manage_user(previous.employee_id)
      or not app_private.staff_location_scope(previous.location_id) then
      perform app_private.fail('forbidden', 'Исправление доступно руководителю этой точки');
    end if;
  end if;

  payload := jsonb_build_object('location', p_location, 'day', p_day, 'shift', p_shift, 'cash', p_cash,
    'card', p_card, 'return', p_return, 'expected_revision', p_expected_revision, 'comment', p_comment, 'reason', p_reason);
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_operation::text, 0));
  select * into receipt from app_private.operation_receipt where user_id = actor and operation_id = p_operation;
  if found then
    if receipt.command <> 'shift_record_with_return' or receipt.payload <> payload then
      perform app_private.fail('idempotency-conflict', 'Операция содержит другие данные');
    end if;
    return receipt.result;
  end if;

  -- Reuse the same ownership, date, revision and pay rules. The nested command
  -- runs in this transaction; its private retry key is independent of the caller's key.
  if p_shift is null then
    result := public.shift_submit(p_location, p_day, p_cash, p_card, gen_random_uuid(), p_comment);
  elsif p_reason is null then
    result := public.shift_close_versioned(p_shift, p_cash, p_card, p_expected_revision, gen_random_uuid(), p_comment);
  else
    result := public.staff_shift_correct(p_shift, p_cash, p_card, p_expected_revision, p_reason, gen_random_uuid());
  end if;
  shift_id := coalesce(p_shift, (result->'shift'->>'id')::uuid);
  select * into strict saved from public.work_shift where id = shift_id for update;
  if saved.return_minor <> p_return then
    perform app_private.audit('shift.return', 'work_shift', saved.id, saved.partner_id,
      jsonb_build_object('before_minor', saved.return_minor, 'after_minor', p_return, 'location', saved.location_id, 'day', saved.day),
      nullif(btrim(p_reason), ''));
    update public.work_shift set return_minor = p_return where id = shift_id returning * into saved;
  end if;
  if p_reason is null then
    result := result || jsonb_build_object('shift', to_jsonb(saved));
  else
    result := result || jsonb_build_object('revision', saved.revision, 'shift',
      jsonb_build_object('id', saved.id, 'return_minor', saved.return_minor, 'earned_minor', saved.earned_minor, 'revision', saved.revision));
  end if;
  insert into app_private.operation_receipt(user_id, operation_id, command, payload, result)
    values (actor, p_operation, 'shift_record_with_return', payload, result);
  return result;
end $$;

revoke execute on function public.shift_record_with_return(bigint,bigint,bigint,uuid,text,uuid,date,uuid,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function public.shift_record_with_return(bigint,bigint,bigint,uuid,text,uuid,date,uuid,bigint,text) to authenticated;
insert into app_private.client_command(fn)
  values ('public.shift_record_with_return(bigint,bigint,bigint,uuid,text,uuid,date,uuid,bigint,text)');
