-- Retry checked financial writes with the same operation receipt.
create or replace function public.financial_operation(p_command text,p_args jsonb,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid := app_private.require_user(); old app_private.operation_receipt; answer jsonb;
begin
  if p_operation is null then perform app_private.fail('validation','Не указан ключ операции'); end if;
  if p_command in ('royalty_payment_reviewed', 'royalty_set_accrual_only') then
    perform app_private.royalty_partner_check((p_args->>'p_partner')::uuid);
  elsif p_command in ('expense_save_with_recurring', 'expense_repeat_checked') then
    perform app_private.expense_partner();
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>p_command or old.payload<>p_args then perform app_private.fail('idempotency-conflict','Повтор операции с другими суммами'); end if;
    return old.result;
  end if;
  case p_command
    when 'royalty_payment_reviewed' then answer:=app_private.royalty_payment_reviewed((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,(p_args->>'p_paid_on')::date,p_args->>'p_note',p_args->'p_reviewed');
    when 'royalty_set_accrual_only' then answer:=app_private.royalty_apply_accrual((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_target')::bigint,p_args->>'p_note',true);
    when 'expense_save_with_recurring' then answer:=to_jsonb(app_private.expense_save_with_recurring((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,(p_args->>'p_location')::uuid,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note',(p_args->>'p_recurring')::boolean));
    when 'expense_repeat_checked' then answer:=to_jsonb(app_private.expense_repeat_checked((p_args->>'p_month')::date,p_args->'p_rows'));
    when 'royalty_payment_add' then answer:=to_jsonb(public.royalty_payment_add((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,(p_args->>'p_paid_on')::date,p_args->>'p_note'));
    when 'royalty_manual_add' then answer:=to_jsonb(public.royalty_manual_add((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    when 'royalty_set_accrual' then answer:=public.royalty_set_accrual((p_args->>'p_partner')::uuid,(p_args->>'p_month')::date,(p_args->>'p_target')::bigint,p_args->>'p_note');
    when 'expense_save' then answer:=to_jsonb(public.expense_save((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,(p_args->>'p_location')::uuid,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    when 'manager_company_expense_save' then answer:=to_jsonb(public.manager_company_expense_save((p_args->>'p_id')::uuid,(p_args->>'p_month')::date,p_args->>'p_category',(p_args->>'p_amount')::bigint,p_args->>'p_note'));
    else perform app_private.fail('validation','Неизвестная финансовая операция');
  end case;
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,p_command,p_args,answer);
  return answer;
end $$;
