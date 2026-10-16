-- Синтетические демо-данные (до создания пользователей). Только для демо-проекта: реальных данных компании здесь нет.
-- Даты считаются от сегодняшнего дня, поэтому стенд всегда выглядит «живым».

insert into public.currency(code, name, minor_unit) values
  ('RUB', 'Российский рубль', 2), ('KZT', 'Казахстанский тенге', 2), ('TRY', 'Турецкая лира', 2);

insert into public.country(code, name, default_currency, default_timezone) values
  ('RU', 'Россия', 'RUB', 'Europe/Moscow'), ('KZ', 'Казахстан', 'KZT', 'Asia/Almaty'), ('TR', 'Турция', 'TRY', 'Europe/Istanbul');

insert into public.partner(code, name, country, currency, contact_name, contact_phone, contact_email, is_demo) values
  ('ALPHA', 'Виктор (Волгоград)', 'RU', 'RUB', 'Виктор Демо', '+7 900 000-00-01', 'alpha.owner@demo.example.com', true),
  ('BETA', 'Марсель (Караганда)', 'KZ', 'KZT', 'Марсель Демо', '+7 700 000-00-02', 'beta.owner@demo.example.com', true),
  ('GAMMA', 'Махмут (Стамбул)', 'TR', 'TRY', 'Mahmut Demo', '+90 500 000 00 03', 'gamma.owner@demo.example.com', true);

insert into public.location(code, name, partner_id, city, address, timezone, currency, opened_on, is_demo)
select v.code, v.name, p.id, v.city, v.address, v.tz, p.currency, (date_trunc('month', current_date) - v.age)::date, true
from (values
  ('ALPHA-1', 'Волгоград Европа', 'ALPHA', 'Волгоград', 'ТРЦ «Европа Сити Молл», остров 3', 'Europe/Volgograd', interval '2 years'),
  ('ALPHA-2', 'Волгоград Ворошиловский', 'ALPHA', 'Волгоград', 'ТРЦ «Ворошиловский», 1 этаж', 'Europe/Volgograd', interval '1 year'),
  ('ALPHA-3', 'Волжский', 'ALPHA', 'Волжский', 'ТРЦ «Волгамолл», 2 этаж', 'Europe/Volgograd', interval '2 months'),
  ('BETA-1', 'Караганда Сити Молл', 'BETA', 'Караганда', 'ТРЦ «City Mall», 1 этаж', 'Asia/Almaty', interval '1 year'),
  ('GAMMA-1', 'İstanbul Cevahir', 'GAMMA', 'Стамбул', 'Cevahir AVM, kat 2', 'Europe/Istanbul', interval '2 years')
) as v(code, name, partner, city, address, tz, age)
join public.partner p on p.code = v.partner;

-- Доступ: роль назначится сама, когда будет создан пользователь с этим email
insert into public.pending_assignment(email, role, partner_id) values
  ('fm@demo.example.com', 'franchise_manager', null),
  ('alpha.owner@demo.example.com', 'franchisee', (select id from public.partner where code = 'ALPHA')),
  ('beta.owner@demo.example.com', 'franchisee', (select id from public.partner where code = 'BETA')),
  ('gamma.owner@demo.example.com', 'franchisee', (select id from public.partner where code = 'GAMMA'));

-- Курсы к рублю (условные демо-значения)
insert into public.fx_rate(currency, day, rub_per_unit) values
  ('KZT', (current_date - 150), 0.165), ('TRY', (current_date - 150), 2.35),
  ('KZT', (current_date - 30), 0.162), ('TRY', (current_date - 30), 2.28);

------------------------------------------------------------------------------
-- Выручка: три полных месяца и текущий месяц до вчера. Суммы детерминированы (hashtext), выходные — выше.
------------------------------------------------------------------------------
insert into public.daily_revenue(location_id, partner_id, day, currency, cash_minor, card_minor)
select l.id, l.partner_id, d::date, l.currency,
  round(base * f * share_cash)::bigint * 100, round(base * f * (1 - share_cash))::bigint * 100
from public.location l
cross join lateral (select case l.code when 'ALPHA-1' then 17000 when 'ALPHA-2' then 12500 when 'ALPHA-3' then 8000
                                       when 'BETA-1' then 95000 else 2600 end as base) b
cross join lateral generate_series(greatest((date_trunc('month', current_date) - interval '3 months')::date, l.opened_on),
                                   current_date - 1, interval '1 day') d
cross join lateral (select (0.75 + (abs(hashtext(l.code || d::date::text)) % 500) / 1000.0)
                           * case when extract(isodow from d) in (6, 7) then 1.3 else 1 end as f,
                           0.25 + (abs(hashtext(d::date::text || l.code || 'c')) % 20) / 100.0 as share_cash) x
-- Волгоград Европа не внесла выручку за последние 2 дня — так франчайзи и менеджер видят пропуски
where not (l.code = 'ALPHA-1' and d::date >= current_date - 2);

-- План на каждый месяц: средняя выручка точки × дни месяца, чуть выше факта прошлых месяцев
insert into public.revenue_plan(location_id, month, amount_minor)
select l.id, m::date,
  (round(b.base * 1.05 * extract(day from (m + interval '1 month - 1 day')) / 1000) * 1000)::bigint * 100
from public.location l
cross join lateral (select case l.code when 'ALPHA-1' then 17000 when 'ALPHA-2' then 12500 when 'ALPHA-3' then 8000
                                       when 'BETA-1' then 95000 else 2600 end as base) b
cross join lateral generate_series(date_trunc('month', current_date) - interval '3 months', date_trunc('month', current_date), interval '1 month') m
where m >= date_trunc('month', l.opened_on);

------------------------------------------------------------------------------
-- Роялти: Виктор оплатил всё, кроме прошлого месяца; Марсель — частично; у Махмута долг до начала учёта
------------------------------------------------------------------------------
insert into public.royalty_payment(partner_id, month, amount_minor, paid_on, note)
select g.partner_id, g.month, g.amount, (g.month + interval '1 month 4 days')::date, g.note
from (
  select p.id as partner_id, l.month,
    case when p.code = 'BETA' and l.month = (date_trunc('month', current_date) - interval '2 months')::date then l.accrued_minor / 2
         else l.accrued_minor end as amount,
    case when p.code = 'BETA' and l.month = (date_trunc('month', current_date) - interval '2 months')::date then 'Частичная оплата' end as note,
    p.code
  from public.partner p cross join lateral app_private.royalty_ledger(p.id) l
  where not l.is_open and l.accrued_minor > 0
    and l.month < (date_trunc('month', current_date) - interval '1 month')::date
) g;

insert into public.royalty_manual(partner_id, month, amount_minor, note)
select id, (date_trunc('month', current_date) - interval '5 months')::date, 1850000, 'Долг за период до начала учёта в приложении'
from public.partner where code = 'GAMMA';

------------------------------------------------------------------------------
-- База знаний: разделы, словарь синонимов, статьи
------------------------------------------------------------------------------
insert into public.kb_section(slug, title, sort, description) values
  ('nachalo', 'Начало работы', 10, 'Как пользоваться кабинетом и что важно знать в первую неделю'),
  ('prodazhi', 'Продажи и клиенты', 20, null),
  ('okleyka', 'Оклейка и качество', 30, null),
  ('garantii', 'Гарантии и жалобы', 40, null),
  ('oborudovanie', 'Лекала и оборудование', 50, null);

insert into public.kb_synonym(term, expands_to) values
  ('бронеплен', 'плёнка'), ('бронь', 'плёнка'), ('пузыр', 'выгонка'), ('отслоен', 'гарантия'),
  ('выкройк', 'лекало'), ('шаблон', 'лекало'), ('касс', 'выручка'), ('режет', 'плоттер нож');

do $$
declare r record; v_art uuid; v_rev uuid;
begin
  for r in select * from (values
    ('kak-vnosit-vyruchku', 'nachalo', 'instruction', 'Как вносить выручку за день', 'Каждый вечер — итог дня по точке: наличные и карта', true,
$md$## Когда вносить

Каждый день после закрытия точки. Если точка не работала — внесите **0** и напишите причину в комментарии.

## Как внести

1. На главном экране нажмите **«Внести выручку за сегодня»**.
2. Введите сумму наличными и сумму по карте. Итог посчитается сам.
3. Нажмите **«Сохранить»**.

Если точек несколько, сначала выберите точку вверху экрана.

## Если ошиблись

Нажмите на день в списке ниже и исправьте сумму. Текущий месяц можно править в любой день, прошлый — до 5-го числа. Позже — через менеджера по франшизе.

## План

План на месяц ставит менеджер по франшизе. На главном экране видно, сколько уже выполнено и сколько нужно в день, чтобы выйти на план.$md$),
    ('standart-okleyki', 'okleyka', 'instruction', 'Стандарт оклейки смартфона', 'Подготовка, выбор лекала, нанесение и проверка качества', true,
$md$## Подготовка рабочего места

1. Протрите стол и инструмент безворсовой салфеткой.
2. Проверьте, что нож плоттера острый: срез без «бахромы» на тестовом квадрате.
3. Подготовьте набор для очистки поверхности и ракель.

## Подготовка устройства

- Уточните у клиента модель **по настройкам устройства**, а не по коробке.
- Снимите чехол и старую плёнку, удалите остатки клея.
- Обезжирьте поверхность и удалите пыль липким листом.

## Нанесение

| Шаг | Что проверить |
| --- | --- |
| Выбор лекала | Модель совпадает с устройством |
| Резка | Края ровные, вырезы камер полные |
| Нанесение | Плёнка выровнена по верхнему краю |
| Выгонка | Пузыри удалены ракелем от центра к краям |

## Проверка качества

Перед выдачей покажите клиенту края и вырезы камер. Мелкие пузыри до 1 мм уходят за 24–48 часов — предупредите клиента.$md$),
    ('garantiya', 'garantii', 'regulation', 'Гарантия на оклейку: что делать при жалобе', 'Что собрать и как ответить клиенту', false,
$md$## Что собрать

1. Дату услуги и точку.
2. Фото дефекта при хорошем освещении.
3. Описание: что произошло и когда клиент заметил.

## Как ответить клиенту

Поблагодарите, что обратился, и не спорьте о причине на месте. Если дефект очевиден (отслоение края, пузырь больше 1 мм через 2 дня) — переклейте бесплатно.

## Если случай спорный

Отправьте фото и описание менеджеру по франшизе. Решение — в течение рабочего дня.$md$),
    ('plotter-lekala', 'oborudovanie', 'instruction', 'Плоттер и лекала: частые проблемы', 'Смещение реза, тупой нож, нет лекала', false,
$md$## Плоттер режет со смещением

1. Проверьте, что плёнка ровно заведена в прижимные ролики.
2. Выполните калибровку по меткам.
3. Замените нож, если срез рваный.

## Лекала нет в библиотеке

Сообщите менеджеру по франшизе точную модель и приложите фото устройства с линейкой. До появления лекала предложите клиенту универсальную плёнку.$md$),
    ('obshchenie-s-klientom', 'prodazhi', 'article', 'Как предлагать оклейку клиенту', 'Три вопроса, которые помогают продать', false,
$md$## Начните с вопроса

Спросите, как клиент пользуется телефоном: носит ли без чехла, роняет ли, работает ли на улице. Это подскажет, какая плёнка нужна.

## Покажите разницу

Дайте подержать образец матовой и глянцевой плёнки. Клиент выбирает быстрее, когда видит и трогает.

## Назовите срок

Скажите, сколько займёт оклейка (обычно 10–15 минут), и предложите подождать на точке.$md$),
    ('faq-klientov', 'prodazhi', 'faq', 'Ответы на частые вопросы клиентов', 'Сколько держится плёнка, можно ли снять, есть ли гарантия', false,
$md$## Сколько держится плёнка?

При аккуратном использовании — от года. Края служат дольше, если не снимать чехол каждый день.

## Можно ли снять плёнку?

Да, без следов. Повторно ту же плёнку не наклеить.

## Есть ли гарантия?

Да. Если плёнка отошла по краю или появились пузыри — приходите, переклеим.$md$)
  ) as t(slug, section, type, title, summary, required, body) loop
    insert into public.article(slug, section_id, type, required_ack, tags)
    values (r.slug, (select id from public.kb_section where slug = r.section), r.type, r.required, '{демо}') returning id into v_art;
    insert into public.article_revision(article_id, rev_no, title, summary, body, status, published_at, change_note)
    values (v_art, 1, r.title, r.summary, r.body, 'published', now() - interval '3 days', 'Первая публикация') returning id into v_rev;
    update public.article set status = 'published', published_revision_id = v_rev,
      ack_rev_no = case when r.required then 1 end, ack_since = case when r.required then now() - interval '3 days' end
    where id = v_art;
  end loop;

  -- Черновик в работе у менеджера
  insert into public.article(slug, section_id, type) values ('novinki-plenok', (select id from public.kb_section where slug = 'okleyka'), 'article')
  returning id into v_art;
  insert into public.article_revision(article_id, rev_no, title, summary, body)
  values (v_art, 1, 'Новые плёнки этого сезона', 'Черновик', '## Что нового

Черновик — допишите перед публикацией.');
end $$;
