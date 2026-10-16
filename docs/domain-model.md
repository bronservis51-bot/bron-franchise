# Доменная модель

Физическая модель — SQL-миграции в [`supabase/migrations`](../supabase/migrations). Этот документ объясняет смысл, связи, ограничения, источники истины и модель доступа. Общие поля всех изменяемых сущностей: `id uuid`, `created_at`, `created_by`, `updated_at`, `revision int` (оптимистическая блокировка, ARCH-10).

## 1 Модули и владение данными

| Модуль | Таблицы (владеет и пишет только он) | Читает у других |
| --- | --- | --- |
| Identity and Access | `app_user`, `role`, `permission`, `role_permission`, `role_assignment` | `partner`, `location` |
| Organization | `operator`, `direction`, `country`, `currency`, `legal_entity`, `partner`, `location`, `location_ownership`, `business_calendar`, `holiday` | — |
| Workflows and Tasks | `workflow_template`, `workflow_template_version`, `workflow_instance`, `task`, `task_dependency`, `task_event` | Organization, Access |
| Franchise | `opening_project`, `opening_note`, `contract`, `contract_location`, `contract_policy_version` | Tasks (через команды), Organization |
| Support | `ticket`, `ticket_message`, `ticket_event`, `support_routing`, `sla_policy` | Organization, Knowledge (ссылка) |
| Procurement | `catalog_item`, `price_list`, `price_list_item`, `partner_price_list`, `stock_projection`, `order_kind_policy`, `sales_order`, `order_line`, `order_event`, `shipment`, `shipment_line` | Organization, Integrations (через outbox) |
| Royalties | `revenue_report`, `report_revision`, `report_line`, `import_batch`, `calculation`, `accrual`, `adjustment`, `payment`, `allocation`, `dispute`, `royalty_note` | Franchise (договор и политика) |
| Knowledge and Learning | `kb_section`, `article`, `article_revision`, `article_tag`, `ack_assignment`, `acknowledgement`, `kb_feedback`, `kb_search_log`, `source_link` | Access (аудитория) |
| Files | `file_asset`, `attachment_link`; Storage bucket `private-files` | Все (проверка области) |
| Notifications | `notification` | — |
| Integrations | `integration_connection`, `integration_mapping`, `outbox`, `inbox`, `sync_run`, `demo_external_doc` | Все (через контракты) |
| Analytics and Audit | `audit_event`, `command_log`; представления `v_*` | Все (только чтение) |

Правило ARCH-02 в прототипе: команды модуля (SQL-функции в файле миграции модуля) изменяют только таблицы своего модуля; межмодульные действия вызывают публичные функции другого модуля (например, Franchise вызывает `app_private.workflow_start`, а не вставляет строки в `task`). Проверяется тестом `architecture.test.ts` по тексту миграций.

## 2 Организация

| Сущность | Ключевые поля | Ограничения |
| --- | --- | --- |
| `operator` | name, sod_policy (`strict`/`allow_with_log`), default_locale | один в прототипе |
| `direction` | code (`gadgets`, `furniture`), name, warranty_days | гарантия — данные (45 дней — тестовое значение) |
| `country` | code ISO 3166, name, default_currency, default_timezone, default_locale | — |
| `currency` | code ISO 4217, minor_unit | деньги хранятся в минорных единицах |
| `legal_entity` | owner_kind (`operator`/`partner`), partner_id, name, country, tax_id | — |
| `partner` | code, name, country, direction, locale, status (`prospect`/`active`/`suspended`/`terminated`) | — |
| `location` | code, name, direction, country, city, address, timezone, currency, kind (`own`/`franchise`), partner_id (текущий владелец, null для собственных), status (`planned`/`opening`/`active`/`closed`), opened_on, closed_on | `kind = franchise ⇔ partner_id is not null` |
| `location_ownership` | location_id, partner_id, valid_from, valid_to | история владельцев; новый владелец не получает доступ к отчётам прошлых периодов (RLS: отчёт видит партнёр, которому он принадлежит, а не текущий владелец точки) |
| `business_calendar` | code, timezone, workdays int[], work_start, work_end | — |
| `holiday` | calendar_id, day | — |

## 3 Доступ

| Сущность | Ключевые поля | Ограничения |
| --- | --- | --- |
| `app_user` | id = `auth.users.id`, full_name, email, locale, status (`active`/`suspended`/`offboarded`), is_demo | — |
| `role` | code, name, kind (`staff`/`partner`), allowed_scopes text[] | — |
| `permission` | code, description, is_financial | — |
| `role_permission` | role, permission | — |
| `role_assignment` | user_id, role, scope_type (`company`/`direction`/`partner`/`location`), scope_id, valid_from, valid_to, granted_by, revoked_at, revoke_reason, delegated_from | партнёрские роли — только `partner`/`location` области; `scope_type` из `role.allowed_scopes` |

### Роли и разрешения

| Роль | Область | Разрешения |
| --- | --- | --- |
| `founder` | company | все, кроме технических `integration.manage`; выручку точек читает и дозаполняет (`sales.read`, `sales.manage`), но смен не ведёт |
| `direction_head` | direction | org.read, task.*, opening.*, ticket.*, order.read, order.approve, catalog.read, royalty.read, kb.read, kb.edit, kb.publish, metrics.read, audit.read, sales.read |
| `franchise_manager` | partner (назначенные партнёры) или company | org.read, task.read, task.work, opening.read, opening.manage, ticket.*, order.read, catalog.read, royalty.read, kb.read, metrics.read, sales.read |
| `finance` | company | org.read, contract.read, contract.manage, royalty.read, royalty.review, royalty.publish, payment.confirm, payment.allocate, finance.internal, order.read, task.read, task.work, ticket.read, ticket.work, kb.read, metrics.read, export.run, sales.read (оплату заказов не подтверждает — решение владельца 13.10.2026) |
| `procurement` | company | org.read, catalog.read, catalog.manage, order.read, order.approve, order.manage, **order.payment.confirm** (подтверждает оплату заказа партнёра), task.read, task.work, ticket.read, ticket.work, kb.read, integration.operate |
| `warehouse` | company | catalog.read, order.read, order.fulfill, task.read, task.work, ticket.read, ticket.work, kb.read |
| `support_specialist`, `designer` | company | org.read, ticket.read, ticket.work, task.read, task.work, kb.read, kb.edit |
| `hr_admin` | company | org.read, access.manage, task.read, task.work, kb.read |
| `kb_editor` | company | kb.read, kb.edit, kb.publish, task.read, task.work |
| `location_manager` | location | org.read, task.read, task.work, ticket.create, ticket.read, order.create, order.read, catalog.read, kb.read, sales.enter, sales.manage |
| `location_staff` | location | task.read, task.work, ticket.create, ticket.read, kb.read, sales.enter |
| `partner_owner` | partner | org.read, contract.read, task.read, task.work, opening.read, ticket.create, ticket.read, catalog.read, order.create, order.read, royalty.read, royalty.report.submit, payment.report, kb.read, sales.enter, sales.manage — партнёр сам работает на точке: функции владельца, управляющего и сотрудника |
| `partner_staff` | partner или location | task.read, task.work, ticket.create, ticket.read, catalog.read, kb.read, sales.enter (своя выручка и свой процент; без финансов партнёра, AUTH-02) |
| `sysadmin` | company | org.read, org.manage, access.manage, integration.operate, integration.manage, audit.read, kb.read (без финансов) |

Разрешения и состав ролей — данные (таблица `role_permission`), а не код. Финансовые разрешения помечены `is_financial`.

### Правило проверки (AUTH-01)

`app_private.has_perm(perm, partner_id, location_id)` истинно, если у текущего пользователя (`auth.uid()`, статус `active`) есть действующее назначение (`valid_from ≤ now < valid_to`, не отозвано) роли с этим разрешением и область назначения покрывает объект:

- `company` — любой объект оператора;
- `direction` — объект точки этого направления или партнёра этого направления;
- `partner` — объект с этим `partner_id` (включая точки партнёра);
- `location` — объект с этим `location_id`.

Очередь роли: пользователь входит в очередь `queue_role` задачи, если у него есть действующее назначение этой роли, покрывающее область задачи. Поэтому отзыв назначения сразу выводит человека из очереди.

Назначение ролей (`assign_role`): назначающий имеет `access.manage` в области; назначает не себе; каждое разрешение назначаемой роли у него есть в той же области (запрет повышения).

## 4 Работа

| Сущность | Ключевые поля | Ограничения |
| --- | --- | --- |
| `workflow_template` | code, kind (`opening`), name, direction | — |
| `workflow_template_version` | template_id, version, status (`draft`/`published`/`retired`), definition jsonb | definition проверяется функцией валидации: этапы, шаги с уникальными ключами, зависимости ссылаются на существующие шаги без циклов |
| `workflow_instance` | template_version_id, subject_type, subject_id, status, anchors jsonb (даты-якоря) | снимок версии: шаги копируются в задачи при старте |
| `task` | number, kind, title, description, instance_id, step_key, stage, subject_type, subject_id, partner_id, location_id, queue_role, backup_role, assignee_id, status, priority, due_at, due_mode (`relative`/`manual`), due_anchor, due_offset_days, is_critical, requires_evidence, requires_review, partner_visible, side (`company`/`partner`), result, kb_article_id, dedupe_key | `unique(dedupe_key)`; `status` из словаря CORE-04 |
| `task_dependency` | task_id, depends_on | без циклов (проверка при создании) |
| `task_event` | task_id, actor_id, action, from_status, to_status, comment, at | только вставка |

## 5 Франшиза

| Сущность | Ключевые поля | Ограничения |
| --- | --- | --- |
| `contract` | number, partner_id, operator_legal_entity_id, partner_legal_entity_id, country, currency, valid_from, valid_to, status, is_test | — |
| `contract_location` | contract_id, location_id, valid_from, valid_to | точка принадлежит партнёру договора |
| `contract_policy_version` | contract_id, version, effective_from, rate_bp (базисные пункты: 700 = 7%), base_rule, rounding (`half_up`/`half_even`/`down`), report_due_day, payment_due_day, is_test, approved_by | `unique(contract_id, effective_from)`; изменение — только новой версией |
| `opening_project` | number, partner_id, location_id, contract_id, direction, country, city, format, address, budget_minor + currency, planned_open_on, actual_open_on, manager_id, owner_id, status, instance_id, crm_deal_ref | `unique(crm_deal_ref)` (через `integration_mapping` в проде) |
| `opening_note` | project_id, body, author | только сотрудники компании (OPEN-05) |

## 6 Поддержка

`ticket` (number, partner_id, location_id, category, queue_role, urgency `normal`/`high`/`stopped`, urgency_reason, subject, description, equipment_model, status, assignee_id, created_by, first_response_due, resolve_due, first_response_at, resolved_at, sla_paused_at, sla_paused_total, resolution_reason, kb_article_id, reopen_until) · `ticket_message` (ticket_id, author_id, body, internal, lang, translation, translation_kind `none`/`demo`) · `ticket_event` · `support_routing` (category → queue_role, backup_role, calendar) · `sla_policy` (queue_role, urgency, first_response_minutes, resolve_minutes).

## 7 Закупки

| Сущность | Ключевые поля | Ограничения |
| --- | --- | --- |
| `catalog_item` | sku, name, category, unit (`roll`/`sheet`/`meter`/`piece`/`cut`), pack_multiple, min_qty, active, source (`demo`/`moysklad`) | единицы не взаимозаменяемы |
| `price_list`, `price_list_item` | currency; item_id, price_minor, valid_from | цена — целое в минорных единицах |
| `partner_price_list` | partner_id, price_list_id, valid_from | собственные точки — прайс-лист по умолчанию оператора |
| `stock_projection` | item_id, warehouse, available_qty, source, refreshed_at | проекция; резерв подтверждает склад |
| `order_kind_policy` | kind, approval_threshold_minor, currency, payment_policy (`none`/`prepay`) | — |
| `sales_order` | number, kind, partner_id, location_id, status, approval_status, payment_status, transfer_status, currency, total_minor, delivery_address, contact, comment, submit_key, submitted_at, external_ref | `unique(created_by, submit_key)`; одна валюта на заказ |
| `order_line` | order_id, item_id, unit, price_minor, qty_ordered, qty_confirmed, qty_shipped, qty_received, qty_cancelled | `qty_received ≤ qty_shipped ≤ qty_confirmed ≤ qty_ordered` (CHECK) |
| `shipment`, `shipment_line` | carrier, tracking, eta_from, eta_to, status, external_event_id | — |

## 8 Роялти

| Сущность | Ключевые поля | Ограничения |
| --- | --- | --- |
| `revenue_report` | contract_id, partner_id, period (первый день месяца), status, current_revision_id, partner_ref | `unique(contract_id, period)`; `unique(partner_id, partner_ref)` — номер партнёра уникален в его области (AT-16) |
| `report_revision` | report_id, rev_no, source (`manual`/`import`/`system`), verification_level (`reported`/`imported`/`verified`), comment, locked, submitted_at, submitted_by | заблокированная редакция не изменяется (триггер) |
| `report_line` | revision_id, location_id, currency, gross_minor, returns_minor, excluded_minor, base_minor (вычисляемое), zero_reason | `base = gross − returns − excluded ≥ 0` |
| `import_batch` | contract_id, period, file_hash, rows jsonb, errors jsonb, status | `unique(contract_id, period, file_hash)` — повтор не удваивает (AT-07) |
| `calculation` | report_revision_id, inputs jsonb (политики, сегменты, строки), base_minor, amount_minor, currency, created_by | неизменяема |
| `accrual` | contract_id, partner_id, period, kind (`royalty`), calculation_id, amount_minor, currency, due_on, status (`published`/`void`) | частичный уникальный индекс: одно `published` на `(contract_id, period, kind)` |
| `adjustment` | accrual_id, direction (`debit`/`credit`), amount_minor, reason, ref | — |
| `payment` | partner_id, contract_id, source (`partner_report`/`finance`/`bank_import`), external_ref, received_on, amount_minor, currency, status (`reported`/`confirmed`/`rejected`/`reversed`), reported_by, registered_by, confirmed_by | `unique(source, external_ref)` |
| `allocation` | payment_id, accrual_id, amount_minor, status (`active`/`reversed`), reversed_reason | сумма активных ≤ платёж и ≤ остаток начисления (функция под блокировкой); валюты совпадают |
| `dispute` | accrual_id, amount_minor, reason, status | спор не меняет сальдо |
| `royalty_note` | subject_type, subject_id, body | только `finance.internal` |

Представление `v_accrual_balance`: `outstanding = amount + Σdebit − Σcredit − Σactive allocations(confirmed payments)`; `overdue = outstanding > 0 and due_on < today`.

## 9 Знания

`kb_section` (parent_id, title, sort, direction) · `article` (slug, section_id, type, owner_id, direction_id, audience `all`/`staff`/`partner`, audience_roles text[], status, published_revision_id, review_due, required_ack, source_mode `native`/`drive_document`/`attachment`, export_status) · `article_revision` (rev_no, title, summary, body_format = `md-v1`, body, body_text, search tsvector, status, author_id, submitted_at, approved_by, published_at, requires_reack, change_note, source `editor`/`drive`) · `ack_assignment` (article_id, revision_id, user_id, due_on, `unique(revision_id, user_id)`) · `acknowledgement` (revision_id, user_id, at) · `source_link` (article_id, provider, external_id, external_version, checksum, sync_status, last_synced_at, error).

Опубликованная редакция неизменна (триггер). `article.published_revision_id` меняется только командой `article_publish`.

## 10 Файлы

`file_asset` (bucket, path, name, mime, size_bytes, checksum, scope_type, partner_id, location_id, uploaded_by) · `attachment_link` (file_id, entity_type, entity_id). Путь в Storage: `{partner_id|company}/{uuid}/{имя}`. Политика Storage разрешает чтение объекта, только если существует `file_asset` с этим путём и у пользователя есть разрешение на область файла.

## 11 Интеграции, уведомления, аудит

`integration_connection` (provider, mode `demo`/`live`, status, demo_behavior `success`/`fail`/`lost_response`, last_success_at) · `integration_mapping` (connection_id, entity_type, internal_id, external_id; уникальность по обеим сторонам) · `outbox` (topic, aggregate_type, aggregate_id, payload, dedupe_key unique, status, attempts, next_attempt_at, last_error) · `inbox` (source, event_id, payload, status; `unique(source, event_id)`) · `sync_run` · `demo_external_doc` (эмуляция документов внешней системы — только demo).
`notification` (user_id, kind, title, body, entity_type, entity_id, link, critical, dedupe_key, read_at; `unique(user_id, dedupe_key)`).
`audit_event` (at, actor_id, action, entity_type, entity_id, partner_id, diff jsonb, reason, correlation_id) — только вставка через функции; у `authenticated` нет UPDATE/DELETE.
`command_log` (actor_id, action, key, fingerprint, result jsonb) — идемпотентность команд (API-03): повтор ключа с тем же содержимым возвращает сохранённый результат, с другим — `idempotency-conflict`.

## 12 Источники истины

| Данные | Источник истины | Направление записи | Конфликт |
| --- | --- | --- | --- |
| Пользователи, назначения | PWA | PWA | — |
| Партнёры, точки, проекты открытия | PWA | PWA → CRM (ссылка) | CRM не меняет точку |
| Номенклатура, остатки, резервы | «МойСклад» | МойСклад → PWA (проекция) | PWA не пишет остатки |
| Заказ (намерение, согласование) | PWA | PWA → МойСклад | после передачи количества подтверждает склад |
| Отгрузка, фактические количества | «МойСклад» | МойСклад → PWA | событие с большим временем/версией побеждает, повтор игнорируется |
| Зачисление денег | Банк / финсистема | Банк → PWA | PWA только подтверждает по источнику |
| Начисления роялти | PWA (после согласования с финансами) | PWA → бухгалтерия (выгрузка) | — |
| Статьи native | PWA | PWA → Drive (копия) | правка копии не меняет статью |
| Статьи drive_document | Drive (исходник) → PWA (кандидат) | Drive → PWA | публикация только после согласования |


## Выручка смен и процент сотрудника (13.10.2026)

| Сущность | Поля | Правила |
| --- | --- | --- |
| `commission_policy` | partner_id?, location_id?, rate_bp, effective_from, note, is_test | Ставка в базисных пунктах (1200 = 12%). Приоритет: точка → партнёр → компания (обе пустые) → 0. Ставки в демо — тестовые |
| `daily_sale` | location_id, partner_id, day, employee_id, currency, revenue_minor, returns_minor, services_count, comment, source (`self`/`manager`), entered_by, revision | Одна запись на точку, день и сотрудника; возвраты ≤ выручки; валюта точки; деньги — целые минорные единицы |
| `daily_sale_event` | sale_id, actor_id, action, detail, at | История: кто внёс, кто исправил или удалил и почему |

Заработок = round((выручка − возвраты) × ставка / 10000) — считается на сервере и показывается сотруднику как предварительный. Месяц закрывается для правок, когда по договору точки отправлен отчёт о выручке (`revenue_report` не в `draft`/`needs_correction`).

## Вторая итерация (13.10.2026): роли, смены, прозрачность, поставки, карта

- Роли: `partner_owner` — «Франчайзи», `partner_staff`/`location_staff` — «Менеджер продаж». Руководителя направления, склада и второго финансиста в демо нет: очереди `direction_head`/`warehouse` получает `founder` (`queue_members`), отгрузку ведёт `procurement` (`order.fulfill`), вторую финансовую подпись ставит `founder`.
- `commission_policy.employee_id` — персональный процент менеджера на точке. Приоритет: сотрудник на точке → точка → партнёр → компания (базовый 20 %). Задаёт `sales.manage` (франчайзи, управляющий) командой `commission_set`.
- `work_shift` (точка, сотрудник, день, opened_at, closed_at, status, sale_id): «Начать смену» → «Закрыть смену» (`shift_open`/`shift_close`/`shift_cancel`).
- `daily_sale.card_minor` — часть выручки по карте (сверяется с эквайрингом); `reduced_by_manager` — франчайзи уменьшил смену, внесённую сотрудником (только с причиной, сотрудник уведомляется). Фото кассового отчёта — `attachment_link(entity_type = 'daily_sale')`.
- `report_sales_check` — при отправке отчёта роялти фиксируется сверка «в отчёте ↔ по сменам» по каждой точке; при занижении > 1 % — уведомление финансам и менеджеру франшизы.
- `catalog_item.published_at` (новинка), `phones_per_unit` (сколько телефонов оклеивается единицей — для сверки «плёнка ↔ услуги»); `stock_incoming` (ожидаемые поступления), `stock_subscription` («Сообщить о поступлении»); триггер на `stock_projection` уведомляет подписчиков, когда остаток стал положительным.
- `location.lat/lng`, `city_geo` — координаты для карты сети; `network_map()` — сводка по всем точкам для руководства.

## Третья итерация (14.10.2026)

- **Руководитель компании** — только просмотр: org/contract/royalty/order/catalog/opening/ticket/task/kb/sales `.read`, `metrics.read`, `audit.read`, `finance.internal`, `export.run`, `access.manage` (настройка доступа и шаблона открытия). Согласований, проверок отчётов и подписей нет.
- Разрешение на открытие и публикацию статей — `franchise_manager` (`opening.approve`, `kb.publish`). Очереди упразднённых ролей: руководитель направления → менеджер франшизы, склад → снабжение.
- Один финансист: `operator.sod_policy = allow_with_log` — собственные финансовые операции разрешены и записываются в аудит (`sod_override`); статьи по-прежнему публикует не автор.
- `location_note` — заметки к точке (`internal` — только для сотрудников компании, `remind_on` — напоминание автору в «Нужно сделать»).
