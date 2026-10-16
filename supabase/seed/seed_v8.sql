-- Демо-данные v8 (14.10.2026): клиенты и продажи на точках (CRM продаж). Синтетические имена и номера. Идемпотентно.
do $$
declare
  names text[] := array['Алексей','Мария','Иван','Ольга','Дмитрий','Анна','Сергей','Елена','Никита','Юлия','Артур','Камила','Рустам','Ксения','Павел','Диана','Максим','Алина','Тимур','Вера'];
  models text[] := array['iPhone 15 Pro','iPhone 14','iPhone 13','Samsung S24','Samsung A54','Xiaomi 14','Redmi Note 13','iPhone 16','Honor 200','Pixel 8'];
  svc text[] := array['back','screen','full','camera','back','screen','full','back'];
  r record; i int; j int; v_client uuid; v_sale uuid; v_day date; v_svc text; v_price bigint; v_digits text; v_pay text; v_mult numeric;
begin
  if exists (select 1 from public.pos_sale limit 1) then return; end if;
  for r in select l.id as loc, l.partner_id, l.currency, l.timezone, u.id as emp, v.n_clients, v.prefix, v.mult
    from (values ('ALPHA-1', 'alpha.staff@demo.example.com', 40, '7917', 1.0), ('OWN-NORTH', 'staff.north@demo.example.com', 35, '7926', 1.1),
                 ('BETA-1', 'beta.owner@demo.example.com', 30, '7701', 5.5)) v(code, email, n_clients, prefix, mult)
    join public.location l on l.code = v.code join public.app_user u on u.email = v.email
  loop
    for i in 1..r.n_clients loop
      v_digits := r.prefix || lpad((1000000 + i * 7919 % 9000000)::text, 7, '0');
      insert into public.pos_client(partner_id, phone, phone_digits, name, first_location_id, created_by)
      values (r.partner_id, '+' || v_digits, v_digits, names[1 + (i * 7) % array_length(names, 1)], r.loc, r.emp)
      on conflict do nothing returning id into v_client;
      if v_client is null then continue; end if;
      -- 1–3 визита: часть давно (их пора вернуть), часть недавно
      for j in 1..(1 + i % 3) loop
        v_day := (now() at time zone r.timezone)::date - (case when i % 5 = 0 then 160 + i * 3 else (i * 11 + j * 37) % 120 end) - (j - 1) * 40;
        v_svc := svc[1 + (i + j) % array_length(svc, 1)];
        v_price := (case v_svc when 'full' then 150000 when 'screen' then 79000 when 'camera' then 39000 else 99000 end * r.mult)::bigint;
        v_pay := case when (i + j) % 3 = 0 then 'cash' else 'card' end;
        insert into public.pos_sale(location_id, partner_id, employee_id, client_id, sold_at, day, currency, total_minor, payment, card_minor, warranty_until)
        values (r.loc, r.partner_id, r.emp, v_client, (v_day + time '12:00') at time zone r.timezone + make_interval(mins => (i * 37) % 420), v_day, r.currency,
          v_price, v_pay, case when v_pay = 'card' then v_price else 0 end, v_day + 45)
        returning id into v_sale;
        insert into public.pos_sale_line(sale_id, service, device, qty, price_minor) values (v_sale, v_svc, models[1 + (i * 3 + j) % array_length(models, 1)], 1, v_price);
        update public.pos_client set visits = visits + 1, total_minor = total_minor + v_price,
          last_visit_at = greatest(coalesce(last_visit_at, '-infinity'), (v_day + time '12:00') at time zone r.timezone) where id = v_client;
      end loop;
    end loop;
  end loop;
end $$;
