-- 0002 Справочные данные, необходимые любой установке: валюты, страны, разрешения, роли.
-- Состав ролей — данные (ARCH-06): изменяется новой миграцией или будущим экраном настройки ролей.

insert into public.currency(code, name, minor_unit) values
  ('RUB', 'Российский рубль', 2),
  ('KZT', 'Казахстанский тенге', 2),
  ('TRY', 'Турецкая лира', 2);

insert into public.country(code, name, default_currency, default_timezone, default_locale) values
  ('RU', 'Россия', 'RUB', 'Europe/Moscow', 'ru'),
  ('KZ', 'Казахстан', 'KZT', 'Asia/Almaty', 'ru'),
  ('TR', 'Турция', 'TRY', 'Europe/Istanbul', 'tr');

insert into public.permission(code, description, is_financial) values
  ('org.read', 'Просмотр партнёров, точек и контактов', false),
  ('org.manage', 'Изменение реестра партнёров и точек', false),
  ('access.manage', 'Назначение и отзыв ролей', false),
  ('task.read', 'Просмотр задач', false),
  ('task.work', 'Выполнение задач', false),
  ('task.manage', 'Назначение, проверка, отмена и переоткрытие задач', false),
  ('opening.read', 'Просмотр проектов открытия', false),
  ('opening.manage', 'Ведение проектов открытия', false),
  ('opening.approve', 'Разрешение на открытие точки', false),
  ('ticket.create', 'Создание обращений', false),
  ('ticket.read', 'Просмотр обращений', false),
  ('ticket.work', 'Работа с обращениями в очереди', false),
  ('ticket.manage', 'Переназначение и эскалация обращений', false),
  ('catalog.read', 'Просмотр каталога', false),
  ('catalog.manage', 'Изменение каталога и прайс-листов', false),
  ('order.create', 'Создание заказов и заявок', false),
  ('order.read', 'Просмотр заказов', false),
  ('order.approve', 'Согласование заказов', false),
  ('order.manage', 'Отмена и исправление заказов', false),
  ('order.fulfill', 'Складские операции по заказу', false),
  ('contract.read', 'Просмотр договоров', true),
  ('contract.manage', 'Изменение договоров и расчётных политик', true),
  ('royalty.read', 'Просмотр отчётов и начислений', true),
  ('royalty.report.submit', 'Сдача отчёта о выручке', true),
  ('royalty.review', 'Проверка и утверждение отчётов', true),
  ('royalty.publish', 'Публикация начислений и закрытие периода', true),
  ('payment.report', 'Сообщение об оплате', true),
  ('payment.confirm', 'Регистрация и подтверждение оплат', true),
  ('payment.allocate', 'Распределение оплат', true),
  ('finance.internal', 'Внутренние финансовые заметки', true),
  ('export.run', 'Выгрузки данных', true),
  ('kb.read', 'Чтение базы знаний', false),
  ('kb.edit', 'Редактирование статей', false),
  ('kb.publish', 'Публикация статей', false),
  ('integration.operate', 'Наблюдение и восстановление обмена', false),
  ('integration.manage', 'Настройка подключений', false),
  ('audit.read', 'Журнал аудита', false),
  ('metrics.read', 'Управленческие показатели', false);

insert into public.role(code, name, kind, allowed_scopes, description) values
  ('founder', 'Основатель и руководитель', 'staff', '{company}', 'Исключения, решения, показатели'),
  ('direction_head', 'Руководитель направления', 'staff', '{company,direction}', 'Процессы и команда направления'),
  ('franchise_manager', 'Менеджер франшизы', 'staff', '{company,partner}', 'Открытия, сопровождение, отчёты'),
  ('finance', 'Финансы', 'staff', '{company}', 'Проверка отчётов, начисления, оплаты'),
  ('procurement', 'Снабжение', 'staff', '{company}', 'Заказы, согласования, пополнение'),
  ('warehouse', 'Склад', 'staff', '{company}', 'Сборка, отгрузка, расхождения'),
  ('support_specialist', 'Технический специалист', 'staff', '{company}', 'Оборудование и качество'),
  ('designer', 'Дизайнер лекал', 'staff', '{company}', 'Лекала и ПО'),
  ('hr_admin', 'HR и администратор', 'staff', '{company}', 'Назначения и обучение'),
  ('kb_editor', 'Редактор базы знаний', 'staff', '{company}', 'Статьи и публикация'),
  ('location_manager', 'Управляющий точкой', 'staff', '{location}', 'Смена, задачи, заявки'),
  ('location_staff', 'Сотрудник точки', 'staff', '{location}', 'Чек-листы, инструкции, обращения'),
  ('partner_owner', 'Владелец партнёра', 'partner', '{partner}', 'Точки, закупки, отчёты, роялти'),
  ('partner_staff', 'Сотрудник партнёра', 'partner', '{partner,location}', 'Инструкции, задачи, обращения'),
  ('sysadmin', 'Системный администратор', 'staff', '{company}', 'Конфигурация, доступ, интеграции');

insert into public.role_permission(role, permission)
select 'founder', code from public.permission where code not in ('integration.manage')
union all select 'direction_head', unnest('{org.read,task.read,task.work,task.manage,opening.read,opening.manage,opening.approve,ticket.create,ticket.read,ticket.work,ticket.manage,order.read,order.approve,catalog.read,royalty.read,kb.read,kb.edit,kb.publish,metrics.read,audit.read}'::text[])
union all select 'franchise_manager', unnest('{org.read,task.read,task.work,opening.read,opening.manage,ticket.create,ticket.read,ticket.work,ticket.manage,order.read,catalog.read,royalty.read,kb.read,metrics.read}'::text[])
union all select 'finance', unnest('{org.read,contract.read,contract.manage,royalty.read,royalty.review,royalty.publish,payment.confirm,payment.allocate,finance.internal,order.read,task.read,task.work,ticket.read,ticket.work,kb.read,metrics.read,export.run}'::text[])
union all select 'procurement', unnest('{org.read,catalog.read,catalog.manage,order.read,order.approve,order.manage,task.read,task.work,ticket.read,ticket.work,kb.read,integration.operate}'::text[])
union all select 'warehouse', unnest('{catalog.read,order.read,order.fulfill,task.read,task.work,ticket.read,ticket.work,kb.read}'::text[])
union all select 'support_specialist', unnest('{org.read,ticket.read,ticket.work,task.read,task.work,kb.read,kb.edit}'::text[])
union all select 'designer', unnest('{org.read,ticket.read,ticket.work,task.read,task.work,kb.read,kb.edit}'::text[])
union all select 'hr_admin', unnest('{org.read,access.manage,task.read,task.work,ticket.create,ticket.read,catalog.read,kb.read}'::text[])
union all select 'kb_editor', unnest('{kb.read,kb.edit,kb.publish,task.read,task.work}'::text[])
union all select 'location_manager', unnest('{org.read,task.read,task.work,ticket.create,ticket.read,order.create,order.read,catalog.read,kb.read}'::text[])
union all select 'location_staff', unnest('{task.read,task.work,ticket.create,ticket.read,kb.read}'::text[])
union all select 'partner_owner', unnest('{org.read,contract.read,task.read,task.work,opening.read,ticket.create,ticket.read,catalog.read,order.create,order.read,royalty.read,royalty.report.submit,payment.report,kb.read}'::text[])
union all select 'partner_staff', unnest('{task.read,task.work,ticket.create,ticket.read,catalog.read,kb.read}'::text[])
union all select 'sysadmin', unnest('{org.read,org.manage,access.manage,integration.operate,integration.manage,audit.read,kb.read}'::text[]);

insert into public.integration_connection(provider, title, mode) values
  ('moysklad', '«МойСклад» — склад и номенклатура', 'demo'),
  ('google_drive', 'Google Drive — копии и исходники знаний', 'demo'),
  ('crm', 'CRM — сделки и запуски', 'demo'),
  ('bank', 'Банк / финансовая система — зачисления', 'demo');
