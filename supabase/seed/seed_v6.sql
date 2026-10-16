-- Демо-данные v6 (14.10.2026): воронка франчайзи в CRM. Идемпотентно (по номеру телефона).
do $$
declare fm uuid := (select id from public.app_user where email = 'fm@demo.example.com'); r record; v_id uuid;
begin
  if fm is null or exists (select 1 from public.crm_lead where is_demo) then return; end if;
  for r in select * from (values
    ('Олег Смирнов', null, '+7 912 555-01-01', 'RU', 'Екатеринбург', 'site', 'new', null, null, 'Первый звонок: познакомиться и узнать город', 0, 0, 1),
    ('Айгерим Нурланова', null, '+7 701 555-02-02', 'KZ', 'Астана', 'social', 'new', null, null, 'Перезвонить — просила после 18:00', -1, 1, 2),
    ('Денис Ковалёв', 'ИП Ковалёв', '+7 917 555-03-03', 'RU', 'Самара', 'referral', 'contacted', 3000000000, 1, 'Отправить презентацию и финмодель', 0, 2, 5),
    ('Мурат Ахметов', null, '+7 705 555-04-04', 'KZ', 'Шымкент', 'exhibition', 'contacted', 2500000000, 2, 'Созвон: ответить на вопросы по окупаемости', 1, 3, 4),
    ('Светлана Орлова', 'ООО «Орлова и партнёры»', '+7 927 555-05-05', 'RU', 'Уфа', 'site', 'meeting', 4000000000, 2, 'Встреча в офисе: показать точку в работе', 2, 6, 9),
    ('Emre Yılmaz', null, '+90 532 555 06 06', 'TR', 'Ankara', 'ads', 'meeting', 3500000000, 1, 'Видеозвонок с переводчиком', -2, 4, 7),
    ('Игорь Петренко', null, '+7 903 555-07-07', 'RU', 'Краснодар', 'call', 'negotiation', 5000000000, 3, 'Согласовать скидку на стартовый комплект', 0, 8, 12),
    ('Наталья Ким', 'ИП Ким', '+7 913 555-08-08', 'RU', 'Новосибирск', 'referral', 'contract', 3000000000, 1, 'Подписать договор — юрист проверяет', 3, 10, 15),
    ('Руслан Гарипов', null, '+7 937 555-09-09', 'RU', 'Казань', 'site', 'lost', 2000000000, 1, null, null, 0, 20),
    ('Тимур Алиев', null, '+7 928 555-10-10', 'RU', 'Ростов-на-Дону', 'social', 'new', null, null, null, null, 0, 1)
  ) v(name, company, phone, country, city, source, stage, invest, points, next_action, next_days, touches, age) loop
    insert into public.crm_lead(number, name, company, phone, country, city, source, stage, investment_minor, points_planned, owner_id,
      next_action, next_action_at, lost_reason, stage_changed_at, last_touch_at, created_by, created_at, is_demo)
    values (app_private.next_number('ЛД'), r.name, r.company, r.phone, r.country, r.city, r.source, r.stage, r.invest, r.points, fm,
      r.next_action, case when r.next_days is null then null else date_trunc('day', now()) + make_interval(days => r.next_days) + interval '11 hours' end,
      case when r.stage = 'lost' then 'Не хватает бюджета, вернуться через полгода' end,
      now() - make_interval(days => greatest(r.age - 2, 0)), case when r.touches > 0 then now() - interval '1 day' end, fm, now() - make_interval(days => r.age), true)
    returning id into v_id;
    insert into public.crm_activity(lead_id, kind, body, actor_id, at) values (v_id, 'created', 'Заявка: ' || r.source, fm, now() - make_interval(days => r.age));
    if r.touches >= 1 then insert into public.crm_activity(lead_id, kind, body, actor_id, at) values (v_id, 'call', 'Познакомились, интересуется франшизой, есть помещение на примете', fm, now() - make_interval(days => greatest(r.age - 1, 0))); end if;
    if r.touches >= 3 then insert into public.crm_activity(lead_id, kind, body, actor_id, at) values (v_id, 'message', 'Отправил презентацию и расчёт окупаемости', fm, now() - make_interval(days => greatest(r.age - 3, 0))); end if;
    if r.touches >= 6 then insert into public.crm_activity(lead_id, kind, body, actor_id, at) values (v_id, 'meeting', 'Встреча прошла хорошо, хочет 2 точки в ТЦ', fm, now() - make_interval(days => greatest(r.age - 6, 0))); end if;
  end loop;
end $$;
