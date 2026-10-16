-- Демо-данные v7 (14.10.2026): раздел «Должностные инструкции» и ОБРАЗЕЦ инструкции менеджера продаж (заменяется текстом владельца).
insert into public.kb_section(slug, title, sort, description)
values ('dolzhnosti', 'Должностные инструкции', 5, 'Обязанности, права, показатели и распорядок по каждой должности')
on conflict (slug) do nothing;

create or replace function pg_temp.act_as(p_email text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', (select id from public.app_user where email = p_email), 'role', 'authenticated')::text, false);
$$;

do $$
declare v jsonb; v_art uuid; v_rev uuid;
begin
  if exists (select 1 from public.article where slug = 'dolzhnost-menedzher-prodazh') or not exists (select 1 from public.app_user where email = 'editor@demo.example.com') then return; end if;
  perform pg_temp.act_as('editor@demo.example.com');
  v := public.article_create((select id from public.kb_section where slug = 'dolzhnosti'), 'job_description', 'Менеджер продаж', 'all', null, 'dolzhnost-menedzher-prodazh', 'ru');
  v_art := (v ->> 'article_id')::uuid;
  perform public.article_save_draft(v_art, 'Менеджер продаж', 'ОБРАЗЕЦ: замените текстом своей должностной инструкции', $md$> **Образец.** Структура, по которой удобно оформить инструкцию. Пришлите свой текст — заменим.

## Для чего должность
Продавать и качественно выполнять оклейку на точке, чтобы клиент ушёл довольным и вернулся.

## Подчиняется
Управляющему точкой или франчайзи.

## Распорядок смены
1. Открыть точку, нажать **«Начать смену»** в приложении.
2. Проверить остатки плёнки; если заканчивается — сообщить управляющему.
3. В течение дня — консультации, продажи, оклейка по стандарту.
4. Закрыть смену в приложении: выручка, из неё по карте, число оклеек, фото кассового отчёта.

## Обязанности
- Работать по «Стандарту оклейки».
- Вносить выручку каждую смену.
- Сообщать о браке и поломках через «Поддержку».

## Права
- Получать процент от выручки по ставке точки.
- Запрашивать инструкции и обучение.

## Показатели
- Выручка за смену и за месяц.
- Число оклеек, доля возвратов.
- Смены без пропусков в отчёте.
$md$, null, 'Образец');
  perform public.kb_bind(v_art, 'role', 'partner_staff');
  perform public.kb_bind(v_art, 'role', 'location_staff');
  perform public.article_submit(v_art);
  perform pg_temp.act_as('fm@demo.example.com');
  perform public.article_update_meta(v_art, null, null, 'all', null, (select id from public.app_user where email = 'editor@demo.example.com'), array['должность'], current_date + 365, true);
  select id into v_rev from public.article_revision where article_id = v_art and status = 'in_review';
  perform public.article_publish(v_rev, true, current_date + 365, 'Образец должностной инструкции');
end $$;
select set_config('request.jwt.claims', '', false);
