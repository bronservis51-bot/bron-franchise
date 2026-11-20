-- Custom terms use the employee's partner currency and the existing tier engine.
-- The shift's existing pay_policy snapshot stays authoritative after opening.
alter table public.staff_member add column custom_pay jsonb;

create function app_private.staff_custom_pay_validate(p_policy jsonb) returns void
language plpgsql immutable set search_path = pg_catalog, app_private, pg_temp as $$
begin
  if p_policy is null then
    return;
  end if;
  if jsonb_typeof(p_policy) is distinct from 'object' then
    perform app_private.fail('validation', 'Проверьте индивидуальную схему оплаты', 'custom_pay');
  end if;
  if jsonb_typeof(p_policy->'name') is distinct from 'string'
    or length(p_policy->>'name') > 100 or p_policy->>'name' !~ '[^[:space:]]'
    or p_policy - array['name', 'floor_minor', 'tiers'] <> '{}'::jsonb then
    perform app_private.fail('validation', 'Проверьте название и поля индивидуальной схемы оплаты', 'custom_pay');
  end if;

  perform app_private.motivation_validate(p_policy);
  if exists (
    select 1 from jsonb_array_elements(p_policy->'tiers') as tier(value)
    where tier.value - array['from_minor', 'rate_bp', 'bonus_minor'] <> '{}'::jsonb
  ) then
    perform app_private.fail('validation', 'Проверьте поля ступеней индивидуальной схемы оплаты', 'custom_pay');
  end if;
end $$;

revoke execute on function app_private.staff_custom_pay_validate(jsonb) from public, anon, authenticated, service_role;

-- Native installations can have separate owners for existing and new functions.
do $acl$
declare
  trusted_owner name;
begin
  for trusted_owner in select rolname from pg_roles where rolname in ('postgres', 'supabase_admin') loop
    if not has_function_privilege(trusted_owner, 'app_private.staff_custom_pay_validate(jsonb)', 'EXECUTE') then
      execute format('grant execute on function app_private.staff_custom_pay_validate(jsonb) to %I', trusted_owner);
    end if;
    if not has_function_privilege(trusted_owner, 'app_private.motivation_validate(jsonb)', 'EXECUTE') then
      execute format('grant execute on function app_private.motivation_validate(jsonb) to %I', trusted_owner);
    end if;
  end loop;
end $acl$;

create or replace function app_private.staff_pay_policy(p_user uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  employee public.staff_member;
  policy jsonb;
  trainee_active boolean;
begin
  select * into employee from public.staff_member where user_id = p_user;
  trainee_active := employee.employee_kind = 'trainee' and p_day between employee.internship_from and employee.internship_until;

  if employee.use_partner_motivation or trainee_active then
    policy := coalesce((select m.policy from app_private.motivation_scheme m where m.partner_id = employee.partner_id),
      app_private.motivation_default((select p.currency from public.partner p where p.id = employee.partner_id)));
    if trainee_active then
      policy := jsonb_set(policy, '{floor_minor}', to_jsonb(employee.internship_floor_minor));
    end if;
    return policy;
  end if;

  return coalesce(employee.custom_pay,
    jsonb_build_object('mode', 'legacy', 'rate_bp', employee.rate_bp, 'fee_minor', employee.shift_fee_minor));
end $$;
