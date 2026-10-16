-- Синтетические демонстрационные данные (COST-20). Без реальных людей, договоров и бизнес-данных.
-- Порядок: миграции → этот файл → scripts/seed-users.mjs → seed_after_users.sql.

insert into public.operator(name, sod_policy, is_demo) values ('Бронь Сервис — демо', 'allow_with_log', true);

insert into public.direction(code, name, warranty_days, warranty_note) values
  ('gadgets', 'Защита гаджетов', 45, 'Тестовое значение: подтвердить у владельца'),
  ('furniture', 'Защита мебели', 365, 'Тестовое значение: подтвердить у владельца');

insert into public.business_calendar(code, name, timezone, workdays, work_start, work_end, is_test) values
  ('support-msk', 'Поддержка (демо), Москва', 'Europe/Moscow', '{1,2,3,4,5}', '09:00', '18:00', true),
  ('support-ist', 'Destek (demo), İstanbul', 'Europe/Istanbul', '{1,2,3,4,5}', '09:00', '18:00', true);

insert into public.partner(code, name, country, direction_id, locale, contact_name, contact_phone, is_demo)
select v.code, v.name, v.country, d.id, v.locale, v.contact, v.phone, true
from (values
  ('ALPHA', 'Партнёр Альфа (демо)', 'RU', 'ru', 'Контакт Альфа', '+7 900 000-00-01'),
  ('BETA', 'Партнёр Бета (демо)', 'KZ', 'ru', 'Контакт Бета', '+7 700 000-00-02'),
  ('GAMMA', 'Ortak Gama (demo)', 'TR', 'tr', 'Gama İletişim', '+90 500 000 00 03')
) as v(code, name, country, locale, contact, phone)
cross join public.direction d where d.code = 'gadgets';

insert into public.legal_entity(owner_kind, partner_id, name, country, tax_id)
values ('operator', null, 'ООО «Демо Оператор»', 'RU', '0000000000');
insert into public.legal_entity(owner_kind, partner_id, name, country, tax_id)
select 'partner', p.id, 'Юрлицо ' || p.name, p.country, null from public.partner p;

insert into public.location(code, name, kind, partner_id, direction_id, country, city, address, timezone, currency, status, opened_on, is_demo)
select v.code, v.name, v.kind, p.id, d.id, v.country, v.city, v.address, v.tz, v.cur, v.status, v.opened::date, true
from (values
  ('OWN-NORTH', 'Демо-ТЦ Север', 'own', null, 'RU', 'Москва', 'ТЦ «Север», 1 этаж, островок 12', 'Europe/Moscow', 'RUB', 'active', '2023-03-01'),
  ('OWN-SOUTH', 'Демо-ТЦ Юг', 'own', null, 'RU', 'Москва', 'ТЦ «Юг», 2 этаж', 'Europe/Moscow', 'RUB', 'active', '2022-06-15'),
  ('ALPHA-1', 'Альфа Центр (демо)', 'franchise', 'ALPHA', 'RU', 'Казань', 'ТЦ «Центр», островок 3', 'Europe/Moscow', 'RUB', 'active', '2024-02-10'),
  ('ALPHA-2', 'Альфа Парк (демо)', 'franchise', 'ALPHA', 'RU', 'Казань', 'ТРК «Парк», 1 этаж', 'Europe/Moscow', 'RUB', 'active', '2025-05-20'),
  ('ALPHA-3', 'Альфа Новая (демо, открытие)', 'franchise', 'ALPHA', 'RU', 'Набережные Челны', null, 'Europe/Moscow', 'RUB', 'opening', null),
  ('BETA-1', 'Бета Мега (демо)', 'franchise', 'BETA', 'KZ', 'Алматы', 'ТРЦ «Мега», 2 этаж', 'Asia/Almaty', 'KZT', 'active', '2024-09-01'),
  ('GAMMA-1', 'Gama AVM (demo)', 'franchise', 'GAMMA', 'TR', 'İstanbul', 'AVM, Kat 1', 'Europe/Istanbul', 'TRY', 'active', '2025-01-15')
) as v(code, name, kind, partner_code, country, city, address, tz, cur, status, opened)
cross join public.direction d
left join public.partner p on p.code = v.partner_code
where d.code = 'gadgets';

insert into public.location_ownership(location_id, partner_id, valid_from)
select id, partner_id, coalesce(opened_on, current_date) from public.location;

-- Назначения применяются триггером при создании пользователя скриптом seed-users (app_metadata.demo_seed = true).
insert into public.pending_assignment(email, role, scope_type, scope_code) values
  ('founder@demo.example.com', 'founder', 'company', null),
  ('fm@demo.example.com', 'franchise_manager', 'partner', 'ALPHA'),
  ('fm@demo.example.com', 'franchise_manager', 'partner', 'BETA'),
  ('fm@demo.example.com', 'franchise_manager', 'partner', 'GAMMA'),
  ('finance1@demo.example.com', 'finance', 'company', null),
  ('supply@demo.example.com', 'procurement', 'company', null),
  ('tech@demo.example.com', 'support_specialist', 'company', null),
  ('designer@demo.example.com', 'designer', 'company', null),
  ('hr@demo.example.com', 'hr_admin', 'company', null),
  ('editor@demo.example.com', 'kb_editor', 'company', null),
  ('sysadmin@demo.example.com', 'sysadmin', 'company', null),
  ('manager.north@demo.example.com', 'location_manager', 'location', 'OWN-NORTH'),
  ('staff.north@demo.example.com', 'location_staff', 'location', 'OWN-NORTH'),
  ('alpha.owner@demo.example.com', 'partner_owner', 'partner', 'ALPHA'),
  ('alpha.staff@demo.example.com', 'partner_staff', 'location', 'ALPHA-1'),
  ('beta.owner@demo.example.com', 'partner_owner', 'partner', 'BETA'),
  ('gamma.owner@demo.example.com', 'partner_owner', 'partner', 'GAMMA');

------------------------------------------------------------------------------
-- Шаблон открытия (A-13): 8 этапов раздела 6.1, интервалы стабилизации — предложение
------------------------------------------------------------------------------
insert into public.workflow_template(code, kind, name, direction_id)
select 'opening-standard', 'opening', 'Открытие франшизной точки (базовый)', id from public.direction where code = 'gadgets';

insert into public.workflow_template_version(template_id, version, status, published_at, change_note, definition)
select id, 1, 'published', now(), 'Базовый шаблон по разделу 6.1 спецификации (демо)', $json${
  "stages": [
    {"key": "contract", "title": "Вход и договор"},
    {"key": "location", "title": "Локация"},
    {"key": "equipment", "title": "Комплектация"},
    {"key": "people", "title": "Люди"},
    {"key": "systems", "title": "Системы и стандарты"},
    {"key": "readiness", "title": "Готовность"},
    {"key": "opening", "title": "Открытие"},
    {"key": "stabilization", "title": "Стабилизация"}
  ],
  "steps": [
    {"key": "partner_details", "stage": "contract", "title": "Передать реквизиты юрлица и контакты", "queue_role": "partner_owner", "backup_role": "franchise_manager", "due": {"anchor": "start", "offset_days": 3}},
    {"key": "contract_signed", "stage": "contract", "title": "Прикрепить подписанный договор", "description": "Скан договора со всеми приложениями", "queue_role": "franchise_manager", "backup_role": "franchise_manager", "critical": true, "requires_evidence": true, "depends_on": ["partner_details"], "due": {"anchor": "start", "offset_days": 10}},
    {"key": "contract_payment", "stage": "contract", "title": "Подтвердить платежи, предусмотренные договором", "description": "По выписке, не по скриншоту", "queue_role": "finance", "critical": true, "depends_on": ["contract_signed"], "due": {"anchor": "start", "offset_days": 14}},
    {"key": "location_photos", "stage": "location", "title": "Загрузить фото, план и размеры места", "queue_role": "partner_owner", "backup_role": "franchise_manager", "requires_evidence": true, "due": {"anchor": "start", "offset_days": 7}},
    {"key": "location_approved", "stage": "location", "title": "Согласовать место: электричество, связь, доступ", "queue_role": "franchise_manager", "backup_role": "franchise_manager", "critical": true, "depends_on": ["location_photos"], "due": {"anchor": "planned_open", "offset_days": -30}},
    {"key": "kit_order", "stage": "equipment", "title": "Сформировать заказ стартового комплекта", "queue_role": "procurement", "critical": true, "depends_on": ["contract_payment"], "due": {"anchor": "planned_open", "offset_days": -25}},
    {"key": "kit_shipped", "stage": "equipment", "title": "Отгрузить комплект и передать трек", "queue_role": "warehouse", "backup_role": "procurement", "critical": true, "depends_on": ["kit_order"], "due": {"anchor": "planned_open", "offset_days": -14}},
    {"key": "kit_received", "stage": "equipment", "title": "Принять комплект и проверить комплектность", "queue_role": "partner_owner", "backup_role": "franchise_manager", "critical": true, "requires_evidence": true, "depends_on": ["kit_shipped"], "due": {"anchor": "planned_open", "offset_days": -7}},
    {"key": "accounts", "stage": "people", "title": "Создать аккаунты и назначения сотрудников партнёра", "queue_role": "hr_admin", "depends_on": ["contract_signed"], "due": {"anchor": "planned_open", "offset_days": -14}},
    {"key": "training", "stage": "people", "title": "Пройти обязательное обучение по оклейке", "queue_role": "partner_owner", "backup_role": "franchise_manager", "critical": true, "depends_on": ["accounts"], "kb_article": "standart-okleyki", "due": {"anchor": "planned_open", "offset_days": -5}},
    {"key": "patterns", "stage": "systems", "title": "Настроить лекала и плоттер", "queue_role": "designer", "backup_role": "support_specialist", "depends_on": ["kit_shipped"], "due": {"anchor": "planned_open", "offset_days": -7}},
    {"key": "reporting_setup", "stage": "systems", "title": "Проверить настройку отчётности о выручке", "queue_role": "finance", "depends_on": ["contract_signed"], "kb_article": "reglament-otcheta", "due": {"anchor": "planned_open", "offset_days": -7}},
    {"key": "readiness_checklist", "stage": "readiness", "title": "Чек-лист готовности с фото точки", "queue_role": "partner_owner", "backup_role": "franchise_manager", "critical": true, "requires_evidence": true, "depends_on": ["kit_received", "training", "patterns", "location_approved"], "due": {"anchor": "planned_open", "offset_days": -2}},
    {"key": "opening_permit", "stage": "readiness", "title": "Выдать разрешение на открытие", "queue_role": "franchise_manager", "gate": true, "depends_on": ["readiness_checklist"], "due": {"anchor": "planned_open", "offset_days": -1}},
    {"key": "opening_fact", "kind": "opening_fact", "stage": "opening", "title": "Зафиксировать открытие и первую продажу", "queue_role": "franchise_manager", "depends_on": ["opening_permit"], "due": {"anchor": "planned_open", "offset_days": 0}},
    {"key": "stab_7", "stage": "stabilization", "title": "Контроль через 7 дней: продажи, расходники, проблемы", "queue_role": "franchise_manager", "depends_on": ["opening_fact"], "due": {"anchor": "actual_open", "offset_days": 7}},
    {"key": "stab_14", "stage": "stabilization", "title": "Контроль через 14 дней: качество работы и знания", "queue_role": "franchise_manager", "depends_on": ["stab_7"], "due": {"anchor": "actual_open", "offset_days": 14}},
    {"key": "stab_30", "stage": "stabilization", "title": "Контроль через 30 дней и план развития", "queue_role": "franchise_manager", "depends_on": ["stab_14"], "due": {"anchor": "actual_open", "offset_days": 30}}
  ]
}$json$::jsonb from public.workflow_template where code = 'opening-standard';

------------------------------------------------------------------------------
-- Поддержка: маршрутизация и SLA (тестовые значения, Q-10)
------------------------------------------------------------------------------
insert into public.support_routing(category, title, queue_role, backup_role, calendar_id, required_fields, kb_section_hint)
select v.category, v.title, v.queue_role, v.backup_role, c.id, v.req::text[], v.hint
from (values
  ('film_delivery', 'Плёнка и доставка', 'procurement', 'franchise_manager', '{}', 'zakaz-plenok'),
  ('equipment', 'Оборудование', 'support_specialist', 'franchise_manager', '{equipment_model}', 'lekala-oborudovanie'),
  ('software_patterns', 'ПО и лекала', 'designer', 'support_specialist', '{equipment_model}', 'lekala-oborudovanie'),
  ('quality_warranty', 'Качество и гарантия', 'support_specialist', 'franchise_manager', '{}', 'garantii'),
  ('reporting_royalty', 'Отчётность и роялти', 'finance', 'franchise_manager', '{}', 'uchet-royalti'),
  ('marketing', 'Маркетинг', 'franchise_manager', 'franchise_manager', '{}', 'marketing'),
  ('training', 'Обучение', 'franchise_manager', 'hr_admin', '{}', 'hr-obuchenie'),
  ('other', 'Другое', 'franchise_manager', 'franchise_manager', '{}', null)
) as v(category, title, queue_role, backup_role, req, hint)
cross join public.business_calendar c where c.code = 'support-msk';

insert into public.sla_policy(queue_role, urgency, first_response_minutes, resolve_minutes, is_test) values
  (null, 'normal', 240, 1440, true),
  (null, 'high', 60, 480, true),
  (null, 'stopped', 15, 240, true);

insert into public.demo_translation(source, target_lang, translated) values
  ('Plotter kesmiyor, bıçağı değiştirdik ama sorun devam ediyor.', 'ru', 'Плоттер не режет, мы поменяли нож, но проблема осталась.'),
  ('Здравствуйте! Пришлите, пожалуйста, видео работы плоттера и фото ножа.', 'tr', 'Merhaba! Lütfen plotterin çalışma videosunu ve bıçağın fotoğrafını gönderin.');

------------------------------------------------------------------------------
-- Каталог и цены (демо-проекция «МойСклад»)
------------------------------------------------------------------------------
insert into public.catalog_item(sku, name, category, description, unit, pack_multiple, min_qty, lead_time_days, direction_id, source)
select v.sku, v.name, v.cat, v.descr, v.unit, v.mult, v.minq, v.lead, d.id, 'demo'
from (values
  ('PU-GL-300', 'Плёнка полиуретановая глянцевая, рулон 300 мм × 15 м', 'Плёнка', 'Основная плёнка для смартфонов и планшетов', 'roll', 1, 1, 20),
  ('PU-MT-300', 'Плёнка полиуретановая матовая, рулон 300 мм × 15 м', 'Плёнка', 'Матовое покрытие, снижает отпечатки', 'roll', 1, 1, 20),
  ('PU-PR-300', 'Плёнка антишпион, рулон 300 мм × 10 м', 'Плёнка', 'Ограничивает угол обзора', 'roll', 1, 1, 20),
  ('PU-WT-SH', 'Плёнка для часов, лист A5', 'Плёнка', 'Листы для смарт-часов', 'sheet', 10, 10, 20),
  ('PU-DS-M', 'Плёнка с индивидуальным дизайном, метр', 'Плёнка', 'Печать по макету клиента', 'meter', 0.5, 1, 25),
  ('BLD-45', 'Нож плоттера 45°', 'Инструмент', 'Сменный нож для режущего плоттера', 'piece', 1, 2, 7),
  ('KIT-CLN', 'Набор для подготовки поверхности', 'Расходники', 'Салфетки, раствор, ракель', 'pack', 1, 5, 7),
  ('SQG-PRO', 'Ракель профессиональный', 'Инструмент', 'Для выгонки пузырей', 'piece', 1, 1, 7)
) as v(sku, name, cat, descr, unit, mult, minq, lead)
cross join public.direction d where d.code = 'gadgets';

insert into public.price_list(code, name, currency) values
  ('PL-RU', 'Партнёры РФ (демо)', 'RUB'), ('PL-KZ', 'Партнёры Казахстан (демо)', 'KZT'),
  ('PL-TR', 'Ortaklar Türkiye (demo)', 'TRY'), ('PL-OWN', 'Собственные точки, внутренняя цена (демо)', 'RUB');

insert into public.price_list_item(price_list_id, item_id, price_minor, valid_from)
select pl.id, i.id, round(v.price * case pl.code when 'PL-KZ' then 5.5 when 'PL-TR' then 0.4 when 'PL-OWN' then 0.85 else 1 end)::bigint, date '2024-01-01'
from (values ('PU-GL-300', 1250000), ('PU-MT-300', 1350000), ('PU-PR-300', 1600000), ('PU-WT-SH', 18000), ('PU-DS-M', 90000),
             ('BLD-45', 120000), ('KIT-CLN', 75000), ('SQG-PRO', 45000)) as v(sku, price)
join public.catalog_item i on i.sku = v.sku
cross join public.price_list pl;
-- в PL-RU цена PU-GL-300 = 12 500,00 ₽; KZT ×5.5, TRY ×0.4, внутренняя ×0.85 (тестовые значения)

insert into public.partner_price_list(partner_id, price_list_id, valid_from)
select p.id, pl.id, date '2024-01-01' from public.partner p join public.price_list pl
  on pl.code = case p.code when 'ALPHA' then 'PL-RU' when 'BETA' then 'PL-KZ' when 'GAMMA' then 'PL-TR' end;

insert into public.order_kind_policy(kind, title, approval_threshold_minor, threshold_currency, payment_policy, default_price_list_id, is_test)
select 'partner_order', 'Коммерческий заказ партнёра', null, null, 'prepay', null, true
union all
select 'supply_request', 'Заявка собственной точки на снабжение', 3000000, 'RUB', 'none', id, true from public.price_list where code = 'PL-OWN';

insert into public.stock_projection(item_id, warehouse, available_qty, source, refreshed_at)
select i.id, 'Основной склад (демо)', v.qty, 'demo', now() - interval '25 minutes'
from (values ('PU-GL-300', 42), ('PU-MT-300', 18), ('PU-PR-300', 3), ('PU-WT-SH', 400), ('PU-DS-M', 0), ('BLD-45', 60), ('KIT-CLN', 35), ('SQG-PRO', 25)) v(sku, qty)
join public.catalog_item i on i.sku = v.sku;

------------------------------------------------------------------------------
-- Тестовые договоры и расчётные политики (ROY-02: только для демонстрации)
------------------------------------------------------------------------------
insert into public.contract(number, partner_id, operator_entity_id, partner_entity_id, country, currency, timezone, valid_from, status, is_test)
select 'ТЕСТ-' || p.code || '-2024', p.id,
  (select id from public.legal_entity where owner_kind = 'operator' limit 1),
  (select id from public.legal_entity where partner_id = p.id limit 1),
  p.country, c.default_currency, c.default_timezone, date '2024-01-01', 'active', true
from public.partner p join public.country c on c.code = p.country;

insert into public.contract_location(contract_id, location_id, valid_from)
select k.id, l.id, date '2024-01-01' from public.contract k join public.location l on l.partner_id = k.partner_id;

insert into public.contract_policy_version(contract_id, version, effective_from, rate_bp, rounding, report_due_day, payment_due_day, note, is_test)
select id, 1, date '2024-01-01', 700, 'half_up', 5, 15, 'Тестовая политика: 7% от базы (пример ROY-02)', true from public.contract;

-- Для партнёра GAMMA ставка меняется в середине прошлого месяца — демонстрация обязательной разбивки базы (ROY-01a)
insert into public.contract_policy_version(contract_id, version, effective_from, rate_bp, rounding, report_due_day, payment_due_day, note, is_test)
select k.id, 2, (date_trunc('month', now()) - interval '1 month' + interval '14 days')::date, 650, 'half_up', 5, 15,
  'Тестовое изменение ставки с середины месяца', true
from public.contract k join public.partner p on p.id = k.partner_id where p.code = 'GAMMA';

------------------------------------------------------------------------------
-- База знаний: разделы (KB-01) и словарь терминов
------------------------------------------------------------------------------
insert into public.kb_section(slug, title, sort, description) values
  ('nachalo-raboty', 'Начало работы', 10, 'С чего начать новому сотруднику и партнёру'),
  ('otkrytie-tochki', 'Открытие точки', 20, null),
  ('prodazhi', 'Продажи', 30, null),
  ('okleyka-kachestvo', 'Оклейка и качество', 40, null),
  ('garantii', 'Гарантии и жалобы', 50, null),
  ('lekala-oborudovanie', 'Лекала и оборудование', 60, null),
  ('zakaz-plenok', 'Заказ плёнок и снабжение', 70, null),
  ('uchet-royalti', 'Учёт и роялти', 80, null),
  ('upravlenie-tochkoy', 'Управление точкой', 90, null),
  ('marketing', 'Маркетинг', 100, null),
  ('rabota-s-partnerami', 'Работа с партнёрами', 110, 'Внутренние материалы компании'),
  ('hr-obuchenie', 'HR и обучение', 120, null);

insert into public.kb_synonym(term, expands_to) values
  ('бронеплен', 'плёнка'), ('бронь', 'плёнка'), ('пузыр', 'выгонка'), ('отслоен', 'гарантия'),
  ('выкройк', 'лекало'), ('шаблон', 'лекало'), ('роялти', 'отчёт выручка'), ('режет', 'плоттер нож');
