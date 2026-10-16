-- Демонстрационные данные, созданные через настоящие команды от имени синтетических пользователей.
-- Выполнять после scripts/seed-users.mjs. Каждая операция проходит те же проверки прав и правил, что и в интерфейсе.

create function pg_temp.act_as(p_email text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from public.app_user where email = p_email), 'role', 'authenticated')::text, false);
$$;
create function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from public.app_user where email = p_email $$;
create function pg_temp.loc(p_code text) returns uuid language sql as $$ select id from public.location where code = p_code $$;
create function pg_temp.partner(p_code text) returns uuid language sql as $$ select id from public.partner where code = p_code $$;
create function pg_temp.contract(p_code text) returns uuid language sql as $$
  select k.id from public.contract k join public.partner p on p.id = k.partner_id where p.code = p_code $$;
create function pg_temp.item(p_sku text) returns uuid language sql as $$ select id from public.catalog_item where sku = p_sku $$;

------------------------------------------------------------------------------
-- База знаний: статьи создаёт редактор, публикует руководитель компании (разделение обязанностей)
------------------------------------------------------------------------------
do $$
declare v jsonb; v_art uuid; v_rev uuid; r record;
begin
  for r in select * from (values
    ('standart-okleyki', 'okleyka-kachestvo', 'instruction', 'Стандарт оклейки смартфона', 'Пошаговая инструкция: подготовка, выбор лекала, нанесение и проверка качества', 'all', true, 'ru',
$md$## Когда применять

Инструкция обязательна для всех, кто выполняет оклейку гаджетов на точке: сотрудников собственных точек и партнёров.

## Подготовка рабочего места

1. Протрите стол и инструмент безворсовой салфеткой.
2. Проверьте, что нож плоттера острый: срез без «бахромы» на тестовом квадрате.
3. Подготовьте набор для подготовки поверхности (`KIT-CLN`) и ракель.

## Подготовка устройства

- Уточните у клиента модель **по настройкам устройства**, а не по коробке.
- Снимите чехол и старую плёнку, удалите остатки клея.
- Обезжирьте поверхность и удалите пыль липким листом.

## Нанесение

| Шаг | Что проверить |
| --- | --- |
| Выбор лекала | Код модели совпадает с устройством |
| Резка | Края ровные, отверстия камер вырезаны полностью |
| Нанесение | Плёнка выровнена по верхнему краю |
| Выгонка | Пузыри удалены ракелем от центра к краям |

## Проверка качества

Перед выдачей покажите клиенту края и вырезы камер. Мелкие пузыри до 1 мм уходят за 24–48 часов — предупредите клиента.

## Если что-то пошло не так

Если лекало отсутствует или не совпадает — создайте обращение категории «ПО и лекала» с фото устройства.$md$),
    ('kak-zakazat-plenku', 'zakaz-plenok', 'instruction', 'Как заказать плёнку и расходники', 'Корзина, кратность, оплата и отслеживание поставки', 'all', false, 'ru',
$md$## Где заказывать

Раздел **Каталог** показывает только ваш прайс-лист. Остаток на складе — ориентир со временем обновления: окончательно количество подтверждает склад.

## Единицы и кратность

- Рулоны, листы, метры и штуки — разные единицы, их нельзя заменять друг другом.
- Листы для часов заказываются кратно 10.
- Плёнка с дизайном — кратно 0,5 м.

## Оплата и передача на склад

Заказ партнёра передаётся на склад после подтверждения оплаты финансами по выписке. Скриншот оплаты можно приложить, но он не является подтверждением зачисления.

## Отслеживание

Статус «Ожидает передачи на склад» означает, что заказ сохранён и будет передан автоматически. Если отгрузили часть — остаток остаётся открытым.

## Приёмка

При получении укажите фактическое количество по каждой строке. Расхождение автоматически создаёт задачу снабжению.$md$),
    ('garantiya-45', 'garantii', 'regulation', 'Гарантия на оклейку гаджета: как оформить обращение', 'Срок гарантии берётся из политики направления; решение — по процессу, не автоматически', 'all', false, 'ru',
$md$## Срок гарантии

Срок гарантии хранится в настройках направления и может отличаться для гаджетов и мебели. В демонстрации для гаджетов указано тестовое значение.

## Что собрать

1. Дату услуги и точку.
2. Фото дефекта при хорошем освещении.
3. Описание: что произошло и когда клиент заметил.

## Как оформить

Создайте обращение категории «Качество и гарантия». Причину дефекта устанавливает специалист по согласованному процессу.$md$),
    ('reglament-otcheta', 'uchet-royalti', 'regulation', 'Регламент сдачи отчёта о выручке', 'Сроки, состав отчёта, исправления и оплата', 'all', true, 'ru',
$md$## Что сдаётся

Ежемесячный отчёт по каждой точке договора: выручка, возвраты и исключения. Если точка не работала — укажите ноль и причину.

## Сроки

Срок сдачи и оплаты указан в договоре и показан в карточке отчёта.

## После отправки

Отправленная редакция не меняется. Если финансы вернули отчёт на исправление, вы создаёте новую редакцию — старая сохраняется в истории.

## Оплата

Сообщите об оплате и приложите квитанцию. Долг уменьшится после того, как финансы подтвердят зачисление по выписке.$md$),
    ('motivatsiya-vnutrennyaya', 'rabota-s-partnerami', 'regulation', 'Мотивация менеджеров сопровождения (внутреннее)', 'Внутренний материал: доступен только сотрудникам компании', 'staff', false, 'ru',
$md$## Внутренний документ

Этот материал описывает принципы мотивации сотрудников сопровождения франшизы. Конкретные ставки и условия утверждаются руководителем и **не автоматизируются** в первой версии платформы.

## Принципы

- Показатели считаются по подтверждённым данным, а не по отчёту партнёра.
- Формула и состав команды фиксируются на период.$md$),
    ('plotter-lekala', 'lekala-oborudovanie', 'instruction', 'Плоттер и лекала: частые проблемы', 'Смещение реза, тупой нож, отсутствующее лекало', 'all', false, 'ru',
$md$## Плоттер режет со смещением

1. Проверьте, что плёнка ровно заведена в прижимные ролики.
2. Выполните калибровку по меткам.
3. Замените нож (`BLD-45`), если срез рваный.

## Лекала нет в библиотеке

Создайте обращение «ПО и лекала»: укажите точную модель и приложите фото устройства с линейкой. Лекало считается добавленным только после подтверждения специалиста.$md$)
  ) as t(slug, section, type, title, summary, audience, required, lang, body) loop
    perform pg_temp.act_as('editor@demo.example.com');
    v := public.article_create((select id from public.kb_section where slug = r.section), r.type, r.title, r.audience, null, r.slug, r.lang);
    v_art := (v ->> 'article_id')::uuid;
    perform public.article_save_draft(v_art, r.title, r.summary, r.body, null, 'Первая редакция');
    perform public.article_submit(v_art);
    perform pg_temp.act_as('fm@demo.example.com');
    perform public.article_update_meta(v_art, null, null, r.audience, null, pg_temp.uid('editor@demo.example.com'),
      array['демо'], current_date + 180, r.required);
    -- Обязательно только тем, кого касается: стандарт оклейки — кто оклеивает, регламент отчёта — франчайзи
    update public.article set ack_roles = case r.slug when 'standart-okleyki' then '{location_staff,partner_staff,location_manager,partner_owner}'::text[]
      when 'reglament-otcheta' then '{partner_owner}'::text[] end where id = v_art;
    select id into v_rev from public.article_revision where article_id = v_art and status = 'in_review';
    perform public.article_publish(v_rev, r.required, current_date + 180, 'Публикация демонстрационной базы');
  end loop;

  perform pg_temp.act_as('editor@demo.example.com');
  perform public.kb_bind((select id from public.article where slug = 'standart-okleyki'), 'ticket_category', 'quality_warranty');
  perform public.kb_bind((select id from public.article where slug = 'standart-okleyki'), 'workflow_step', 'training');
  perform public.kb_bind((select id from public.article where slug = 'garantiya-45'), 'ticket_category', 'quality_warranty');
  perform public.kb_bind((select id from public.article where slug = 'kak-zakazat-plenku'), 'ticket_category', 'film_delivery');
  perform public.kb_bind((select id from public.article where slug = 'reglament-otcheta'), 'ticket_category', 'reporting_royalty');
  perform public.kb_bind((select id from public.article where slug = 'reglament-otcheta'), 'workflow_step', 'reporting_setup');
  perform public.kb_bind((select id from public.article where slug = 'plotter-lekala'), 'ticket_category', 'equipment');
  perform public.kb_bind((select id from public.article where slug = 'plotter-lekala'), 'ticket_category', 'software_patterns');

  -- Статья-исходник в Drive (demo): режим drive_document и связь с файлом
  update public.article set source_mode = 'drive_document' where slug = 'plotter-lekala';
  insert into public.source_link(article_id, provider, external_id, external_version, sync_status, last_synced_at)
  select id, 'google_drive', 'demo-drive-file-0001', 'v1', 'synced', now() from public.article where slug = 'plotter-lekala';

  -- Черновик в работе у редактора
  v := public.article_create((select id from public.kb_section where slug = 'prodazhi'), 'faq', 'Ответы на частые вопросы клиентов', 'all', null, 'faq-klientov', 'ru');
  perform public.article_save_draft((v ->> 'article_id')::uuid, 'Ответы на частые вопросы клиентов', 'Черновик',
    '## Сколько держится плёнка?\n\nЧерновик ответа — требуется проверка эксперта.', null, null);
end $$;

------------------------------------------------------------------------------
-- Открытие точки: проект по шаблону и событие CRM (demo)
------------------------------------------------------------------------------
do $$
declare v_project uuid; v_task uuid;
begin
  perform pg_temp.act_as('fm@demo.example.com');
  v_project := public.opening_create(pg_temp.partner('ALPHA'), pg_temp.loc('ALPHA-3'), null, null, null, 'Островок 2×2 м',
    current_date + 24, pg_temp.contract('ALPHA'), null);
  perform public.opening_add_note(v_project, 'Внутренне: партнёр просил скидку на стартовый комплект — не обещали.');

  perform pg_temp.act_as('alpha.owner@demo.example.com');
  select id into v_task from public.task where subject_id = v_project and step_key = 'partner_details';
  perform public.task_take(v_task);
  perform public.task_complete(v_task, 'Реквизиты и контакты отправлены в карточке');

  perform pg_temp.act_as('fm@demo.example.com');
  select id into v_task from public.task where subject_id = v_project and step_key = 'contract_signed';
  perform public.task_take(v_task);
  perform public.task_transition(v_task, 'waiting_external', 'Ждём скан подписанного договора от партнёра');

  -- Повтор события CRM с тем же ID сделки не создаёт второй проект (OPEN-01)
  perform public.demo_crm_deal_won(pg_temp.partner('BETA'), 'DEMO-DEAL-1042', 'Бета Новая (демо)', 'Астана', current_date + 45);
  perform public.demo_crm_deal_won(pg_temp.partner('BETA'), 'DEMO-DEAL-1042', 'Бета Новая (демо)', 'Астана', current_date + 45);
end $$;

------------------------------------------------------------------------------
-- Роялти: история трёх периодов (тестовые договоры, синтетические суммы)
------------------------------------------------------------------------------
do $$
declare p1 date := (date_trunc('month', now()) - interval '1 month')::date;
  p2 date := (date_trunc('month', now()) - interval '2 month')::date;
  p3 date := (date_trunc('month', now()) - interval '3 month')::date;
  r public.revenue_report; v jsonb; v_pay uuid; v_acc uuid;
begin
  -- ALPHA, период p3: полный цикл, оплачен полностью
  perform pg_temp.act_as('alpha.owner@demo.example.com');
  r := public.report_save_draft(pg_temp.contract('ALPHA'), p3, jsonb_build_array(
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-1'), 'gross_minor', 50000000, 'returns_minor', 0),
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-2'), 'gross_minor', 32000000, 'returns_minor', 500000),
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-3'), 'gross_minor', 0, 'zero_reason', 'Точка ещё не открыта')), 'Отчёт за ' || to_char(p3, 'MM.YYYY'), 'A-' || to_char(p3, 'YYYYMM'));
  perform public.report_submit(r.id, 'seed-submit-a3');
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.report_take_review(r.id);
  perform public.report_approve(r.id, null, 'reported', 'Сверено с прошлым периодом');
  perform pg_temp.act_as('finance1@demo.example.com');
  v := public.accrual_publish(r.id, 'seed-publish-a3'); v_acc := (v ->> 'accrual_id')::uuid;
  perform public.period_close(r.id);
  perform pg_temp.act_as('alpha.owner@demo.example.com');
  v := public.payment_report(pg_temp.contract('ALPHA'), 5705000, 'RUB', p3 + 45, 'П/п 118', 'Оплата роялти', 'seed-payrep-a3'); v_pay := (v ->> 'payment_id')::uuid;
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.payment_register(pg_temp.partner('ALPHA'), pg_temp.contract('ALPHA'), 5705000, 'RUB', p3 + 45, 'BANK-DEMO-0001', v_pay, 'seed-payreg-a3');
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.payment_confirm(v_pay);
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.allocation_create(v_pay, v_acc, 5705000, 'seed-alloc-a3');

  -- ALPHA, период p2: оплачен частично → задолженность после срока
  perform pg_temp.act_as('alpha.owner@demo.example.com');
  r := public.report_save_draft(pg_temp.contract('ALPHA'), p2, jsonb_build_array(
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-1'), 'gross_minor', 46000000, 'returns_minor', 0),
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-2'), 'gross_minor', 28000000, 'returns_minor', 0),
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-3'), 'gross_minor', 0, 'zero_reason', 'Точка ещё не открыта')), null, 'A-' || to_char(p2, 'YYYYMM'));
  perform public.report_submit(r.id, 'seed-submit-a2');
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.report_take_review(r.id);
  perform public.report_approve(r.id, null, 'reported', null);
  perform pg_temp.act_as('finance1@demo.example.com');
  v := public.accrual_publish(r.id, 'seed-publish-a2'); v_acc := (v ->> 'accrual_id')::uuid;
  perform public.period_close(r.id);
  perform pg_temp.act_as('finance1@demo.example.com');
  v := public.payment_register(pg_temp.partner('ALPHA'), pg_temp.contract('ALPHA'), 3000000, 'RUB', p2 + 40, 'BANK-DEMO-0002', null, 'seed-payreg-a2');
  v_pay := (v ->> 'payment_id')::uuid;
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.payment_confirm(v_pay);
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.allocation_create(v_pay, v_acc, 3000000, 'seed-alloc-a2');

  -- ALPHA, период p1: отправлен, ждёт проверки финансами
  perform pg_temp.act_as('alpha.owner@demo.example.com');
  r := public.report_save_draft(pg_temp.contract('ALPHA'), p1, jsonb_build_array(
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-1'), 'gross_minor', 52500000, 'returns_minor', 1200000),
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-2'), 'gross_minor', 30100000, 'returns_minor', 0, 'excluded_minor', 600000),
    jsonb_build_object('location_id', pg_temp.loc('ALPHA-3'), 'gross_minor', 0, 'zero_reason', 'Точка ещё не открыта')), null, 'A-' || to_char(p1, 'YYYYMM'));
  perform public.report_submit(r.id, 'seed-submit-a1');
  -- партнёр сообщил об оплате, но зачисление не подтверждено (AT-18)
  perform public.payment_report(pg_temp.contract('ALPHA'), 2180000, 'RUB', current_date - 2, 'П/п 131', 'Доплата за ' || to_char(p2, 'MM.YYYY'), 'seed-payrep-a2b');

  -- BETA, период p2: оплачен с переплатой → аванс
  perform pg_temp.act_as('beta.owner@demo.example.com');
  r := public.report_save_draft(pg_temp.contract('BETA'), p2, jsonb_build_array(
    jsonb_build_object('location_id', pg_temp.loc('BETA-1'), 'gross_minor', 2400000000, 'returns_minor', 10000000)), null, 'B-' || to_char(p2, 'YYYYMM'));
  perform public.report_submit(r.id, 'seed-submit-b2');
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.report_take_review(r.id);
  perform public.report_approve(r.id, null, 'reported', null);
  perform pg_temp.act_as('finance1@demo.example.com');
  v := public.accrual_publish(r.id, 'seed-publish-b2'); v_acc := (v ->> 'accrual_id')::uuid;
  perform public.period_close(r.id);
  perform pg_temp.act_as('finance1@demo.example.com');
  v := public.payment_register(pg_temp.partner('BETA'), pg_temp.contract('BETA'), 170000000, 'KZT', p2 + 44, 'BANK-DEMO-0003', null, 'seed-payreg-b2');
  v_pay := (v ->> 'payment_id')::uuid;
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.payment_confirm(v_pay);
  perform pg_temp.act_as('finance1@demo.example.com');
  perform public.allocation_create(v_pay, v_acc, (select outstanding_minor from public.v_accrual_balance where accrual_id = v_acc), 'seed-alloc-b2');

  -- GAMMA, период p1: в периоде сменилась ставка — утверждение потребует разбивки базы
  perform pg_temp.act_as('gamma.owner@demo.example.com');
  r := public.report_save_draft(pg_temp.contract('GAMMA'), p1, jsonb_build_array(
    jsonb_build_object('location_id', pg_temp.loc('GAMMA-1'), 'gross_minor', 8000000, 'returns_minor', 150000)), 'Aylık rapor', 'G-' || to_char(p1, 'YYYYMM'));
  perform public.report_submit(r.id, 'seed-submit-g1');
end $$;

------------------------------------------------------------------------------
-- Заказы: ожидает оплаты, частично отгружен, заявка на согласовании, сбой передачи
------------------------------------------------------------------------------
do $$
declare o public.sales_order; v jsonb;
begin
  -- 1. Партнёр ALPHA: ждёт подтверждения оплаты финансами
  perform pg_temp.act_as('alpha.owner@demo.example.com');
  o := public.cart_open(pg_temp.loc('ALPHA-1'));
  perform public.cart_set_line(o.id, pg_temp.item('PU-GL-300'), 4);
  perform public.cart_set_line(o.id, pg_temp.item('KIT-CLN'), 5);
  perform public.cart_update(o.id, 'Казань, ТЦ «Центр», островок 3', 'Владелец Альфа Демо, +7 900 000-00-01', 'Доставка до 12:00');
  perform public.order_submit(o.id, 'seed-order-a1');

  -- 2. Партнёр ALPHA: оплачен, передан на склад, отгружен частично (AT-06)
  o := public.cart_open(pg_temp.loc('ALPHA-2'));
  perform public.cart_set_line(o.id, pg_temp.item('PU-MT-300'), 4);
  perform public.cart_set_line(o.id, pg_temp.item('BLD-45'), 2);
  perform public.order_submit(o.id, 'seed-order-a2');
  perform pg_temp.act_as('supply@demo.example.com');
  perform public.order_payment_confirm(o.id, 'Выписка BANK-DEMO-0101');
  perform pg_temp.act_as('supply@demo.example.com');
  perform public.run_integration_jobs();
  perform public.demo_warehouse_event(o.id, 'order.accepted', 'full', 'seed-ms-accept-a2');
  perform public.demo_warehouse_event(o.id, 'shipment.created', 'partial', 'seed-ms-ship-a2');
  perform public.demo_warehouse_event(o.id, 'shipment.created', 'partial', 'seed-ms-ship-a2'); -- повтор webhook: дубль игнорируется

  -- 3. Собственная точка: заявка выше порога ждёт согласования снабжением
  perform pg_temp.act_as('manager.north@demo.example.com');
  o := public.cart_open(pg_temp.loc('OWN-NORTH'));
  perform public.cart_set_line(o.id, pg_temp.item('PU-GL-300'), 3);
  perform public.cart_set_line(o.id, pg_temp.item('PU-WT-SH'), 20);
  perform public.order_submit(o.id, 'seed-order-n1');

  -- 4. Партнёр BETA: оплачен, но склад недоступен — передача с ошибкой и автоматическим повтором
  perform pg_temp.act_as('beta.owner@demo.example.com');
  o := public.cart_open(pg_temp.loc('BETA-1'));
  perform public.cart_set_line(o.id, pg_temp.item('PU-PR-300'), 2);
  perform public.order_submit(o.id, 'seed-order-b1');
  perform pg_temp.act_as('supply@demo.example.com');
  perform public.integration_set_demo_behavior('moysklad', 'fail');
  perform pg_temp.act_as('supply@demo.example.com');
  perform public.order_payment_confirm(o.id, 'Выписка BANK-DEMO-0102');
  perform pg_temp.act_as('supply@demo.example.com');
  perform public.run_integration_jobs();
  perform public.integration_set_demo_behavior('moysklad', 'success');

  -- 5. Черновик корзины партнёра GAMMA
  perform pg_temp.act_as('gamma.owner@demo.example.com');
  o := public.cart_open(pg_temp.loc('GAMMA-1'));
  perform public.cart_set_line(o.id, pg_temp.item('PU-GL-300'), 2);
end $$;

------------------------------------------------------------------------------
-- Обращения в поддержку
------------------------------------------------------------------------------
do $$
declare t public.ticket;
begin
  perform pg_temp.act_as('alpha.staff@demo.example.com');
  t := public.ticket_create(pg_temp.loc('ALPHA-1'), 'equipment', 'high', 'Режем вручную, очередь клиентов',
    'Плоттер режет со смещением', 'После замены рулона рез смещается на 2–3 мм вправо. Калибровку делали.', 'Демо-плоттер X1', '{}'::jsonb, 'seed-t1');
  perform pg_temp.act_as('tech@demo.example.com');
  perform public.ticket_take(t.id);
  perform public.ticket_reply(t.id, 'Здравствуйте! Проверьте прижимные ролики по инструкции «Плоттер и лекала» и пришлите видео реза.', false, 'ru');
  perform public.ticket_reply(t.id, 'Похоже на износ ролика, держим на контроле.', true, 'ru');
  perform public.ticket_set_status(t.id, 'waiting_partner', 'Ждём видео реза от точки');

  perform pg_temp.act_as('gamma.owner@demo.example.com');
  t := public.ticket_create(pg_temp.loc('GAMMA-1'), 'software_patterns', 'normal', null, 'Plotter kesmiyor',
    'Plotter kesmiyor, bıçağı değiştirdik ama sorun devam ediyor.', 'Demo plotter', '{}'::jsonb, 'seed-t2');

  perform pg_temp.act_as('manager.north@demo.example.com');
  t := public.ticket_create(pg_temp.loc('OWN-NORTH'), 'film_delivery', 'normal', null, 'Не хватит матовой плёнки до поставки',
    'Осталось 2 рулона матовой, расход 1 рулон в 3 дня.', null, '{}'::jsonb, 'seed-t3');
  perform pg_temp.act_as('supply@demo.example.com');
  perform public.ticket_take(t.id);
  perform public.ticket_reply(t.id, 'Перебросим 2 рулона с Юга, заявку оформите через каталог.', false, 'ru');
  perform public.ticket_resolve(t.id, 'Перераспределили остаток между собственными точками', (select id from public.article where slug = 'kak-zakazat-plenku'));

  perform pg_temp.act_as('staff.north@demo.example.com');
  t := public.ticket_create(pg_temp.loc('OWN-NORTH'), 'quality_warranty', 'normal', null, 'Клиент: отслоение края через 20 дней',
    'Клиент вернулся с отслоением нижнего края на смартфоне. Услуга оказана 20 дней назад.', null, '{}'::jsonb, 'seed-t4');
end $$;

------------------------------------------------------------------------------
-- Фоновая обработка: экспорт статей, таймеры (напоминания, SLA)
------------------------------------------------------------------------------
do $$
begin
  perform pg_temp.act_as('supply@demo.example.com');
  perform public.run_integration_jobs();
end $$;

select set_config('request.jwt.claims', '', false);
