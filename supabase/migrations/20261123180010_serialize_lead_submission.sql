-- Сериализуем одновременные анкеты с одним телефоном до проверки повторов.
create or replace function public.lead_submit(p_lead jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, app_private, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p_lead->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p_lead->>'phone', '')), 30);
  v_digits text := regexp_replace(coalesce(p_lead->>'phone', ''), '\D', '', 'g');
  v_city text := left(trim(coalesce(p_lead->>'city', '')), 80);
  v_budget text := p_lead->>'budget';
  v_timing text := p_lead->>'timing';
  v_manage text := p_lead->>'manage';
  v_experience text := p_lead->>'experience';
  v_place text := p_lead->>'place';
  v_score smallint;
begin
  -- Ловушка для ботов: скрытое поле, которое человек не видит и не заполняет
  if coalesce(p_lead->>'website', '') <> '' then return jsonb_build_object('ok', true); end if;
  if length(v_name) < 1 or length(v_city) < 2 or length(v_digits) not between 10 and 15 then
    perform app_private.fail('validation', 'Проверьте имя, город и телефон');
  end if;
  if coalesce(v_budget, '') not in ('full', 'partial', 'none') or coalesce(v_timing, '') not in ('month', 'quarter', 'half', 'research')
     or coalesce(v_manage, '') not in ('self', 'manager', 'undecided') or coalesce(v_experience, '') not in ('business', 'some', 'none')
     or coalesce(v_place, '') not in ('has', 'options', 'help')
     or coalesce(p_lead->>'contact_via', '') not in ('whatsapp', 'telegram', 'call') then
    perform app_private.fail('validation', 'Ответьте на все вопросы анкеты');
  end if;
  -- Повторная отправка того же телефона за 10 минут — не дублируем
  perform pg_advisory_xact_lock(hashtextextended('lead-submit:' || v_digits, 0));
  if exists (select 1 from public.franchise_lead where phone_digits = v_digits and created_at > now() - interval '10 minutes') then
    return jsonb_build_object('ok', true);
  end if;
  -- Защита от заливки мусором: не больше 200 заявок в сутки
  if (select count(*) from public.franchise_lead where created_at > now() - interval '1 day') >= 200 then
    perform app_private.fail('rate-limited', 'Слишком много заявок. Напишите нам в WhatsApp');
  end if;
  v_score := app_private.lead_score(v_budget, v_timing, v_manage, v_experience, v_place);
  insert into public.franchise_lead(name, phone, phone_digits, contact_via, city, budget, timing, manage, experience, place,
    comment, source, score, tier)
  values (v_name, v_phone, v_digits, p_lead->>'contact_via', v_city, v_budget, v_timing, v_manage, v_experience, v_place,
    nullif(left(trim(coalesce(p_lead->>'comment', '')), 1000), ''), nullif(left(coalesce(p_lead->>'source', ''), 300), ''),
    v_score, app_private.lead_tier(v_score, v_budget));
  return jsonb_build_object('ok', true);
end $$;
