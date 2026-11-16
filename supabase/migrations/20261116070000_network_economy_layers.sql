-- Separate management-company expenses from franchisee operating expenses and payroll.
-- Network managers receive partner-level aggregates only; no employee-level payroll rows.

create table app_private.network_expense (
  id uuid primary key default gen_random_uuid(),
  month date not null check (month = date_trunc('month', month)::date),
  category text not null check (length(trim(category)) between 1 and 60),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 100000000000),
  note text check (length(note) <= 500),
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on app_private.network_expense(month, category);
alter table app_private.network_expense enable row level security;
revoke all on app_private.network_expense from public, anon, authenticated;

create function public.manager_economy(p_month date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v_month date := date_trunc('month',p_month)::date;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return jsonb_build_object(
    'month',v_month,
    'company_expenses',coalesce((select jsonb_agg(jsonb_build_object(
      'id',e.id,'category',e.category,'amount_minor',e.amount_minor,'note',e.note,'created_at',e.created_at
    ) order by e.category,e.created_at,e.id) from app_private.network_expense e where e.month=v_month),'[]'::jsonb),
    'company_expense_totals',coalesce((select jsonb_agg(jsonb_build_object('category',x.category,'amount_minor',x.amount_minor)
      order by x.category) from (select category,sum(amount_minor)::bigint amount_minor
        from app_private.network_expense where month=v_month group by category) x),'[]'::jsonb),
    'partners',coalesce((select jsonb_agg(jsonb_build_object(
      'partner_id',p.id,'partner_name',p.name,'currency',p.currency,
      'payroll_minor',coalesce(w.payroll_minor,0),'closed_shifts',coalesce(w.closed_shifts,0),
      'expenses_minor',coalesce(x.expenses_minor,0),
      'expense_categories',coalesce(x.categories,'[]'::jsonb)
    ) order by p.name) from public.partner p
      left join lateral (
        select sum(s.earned_minor)::bigint payroll_minor,count(*)::int closed_shifts
        from public.work_shift s where s.partner_id=p.id and s.status='closed'
          and s.day>=v_month and s.day<(v_month+interval '1 month')::date
      ) w on true
      left join lateral (
        select sum(e.category_total)::bigint expenses_minor,
          jsonb_agg(jsonb_build_object('category',e.category,'amount_minor',e.category_total) order by e.category) categories
        from (select category,sum(amount_minor)::bigint category_total
          from public.expense where partner_id=p.id and month=v_month group by category) e
      ) x on true where p.status='active'),'[]'::jsonb)
  );
end $$;

create function public.manager_company_expense_save(p_id uuid,p_month date,p_category text,p_amount bigint,p_note text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v_actor uuid:=app_private.require_user(); v_month date:=date_trunc('month',p_month)::date; v_id uuid;
begin
  perform app_private.require_perm('org.manage');
  if v_month is null or v_month>app_private.current_month() then perform app_private.fail('validation','Нельзя внести расход за будущий месяц','month'); end if;
  if coalesce(length(trim(p_category)),0) not between 1 and 60 then perform app_private.fail('validation','Укажите статью расхода','category'); end if;
  if coalesce(p_amount,0)<=0 or p_amount>100000000000 then perform app_private.fail('validation','Сумма должна быть больше нуля','amount'); end if;
  if length(coalesce(p_note,''))>500 then perform app_private.fail('validation','Комментарий слишком длинный','note'); end if;
  if p_id is null then
    insert into app_private.network_expense(month,category,amount_minor,note,created_by)
      values(v_month,left(trim(p_category),60),p_amount,nullif(trim(p_note),''),v_actor) returning id into v_id;
    perform app_private.audit('network_expense.add','network_expense',v_id,null,
      jsonb_build_object('month',v_month,'category',p_category,'amount',p_amount));
  else
    update app_private.network_expense set month=v_month,category=left(trim(p_category),60),amount_minor=p_amount,
      note=nullif(trim(p_note),''),updated_at=now() where id=p_id returning id into v_id;
    if v_id is null then perform app_private.fail('not-found','Расход не найден'); end if;
    perform app_private.audit('network_expense.update','network_expense',v_id,null,
      jsonb_build_object('month',v_month,'category',p_category,'amount',p_amount));
  end if;
  return v_id;
end $$;

create function public.manager_company_expense_delete(p_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare e app_private.network_expense;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  select * into e from app_private.network_expense where id=p_id;
  if not found then perform app_private.fail('not-found','Расход не найден'); end if;
  delete from app_private.network_expense where id=p_id;
  perform app_private.audit('network_expense.delete','network_expense',p_id,null,
    jsonb_build_object('month',e.month,'category',e.category,'amount',e.amount_minor));
end $$;

-- Make inserts safe to retry after a lost response.
create or replace function public.financial_operation(p_command text,p_args jsonb,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid := app_private.require_user(); old app_private.operation_receipt; answer jsonb;
begin
  if p_operation is null then perform app_private.fail('validation','Не указан ключ операции'); end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into old from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if old.command<>p_command or old.payload<>p_args then perform app_private.fail('idempotency-conflict','Повтор операции с другими суммами'); end if;
    return old.result;
  end if;
  case p_command
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

insert into app_private.client_command(fn) values
  ('public.manager_economy(date)'),
  ('public.manager_company_expense_save(uuid,date,text,bigint,text)'),
  ('public.manager_company_expense_delete(uuid)');
select app_private.apply_grants();
