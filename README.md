# Бронь Сервис — корпоративная платформа (прототип)

PWA, через которое сотрудники и партнёры франшизы ведут ежедневную работу: «Сегодня», задачи и очереди, открытие точек, поддержку, заказ расходников, отчётность и роялти, базу знаний и обучение. Прототип работает за 0 ₽: статический клиент на GitHub Pages и Supabase Free (Auth, PostgreSQL, Storage).

> **Демонстрационный стенд.** Только синтетические данные. Интеграции («МойСклад», Google Drive, CRM, банк) — явно помеченные demo-адаптеры. Ни один статус в прототипе не подтверждает реальную отгрузку или оплату.

## Документы

| Документ | Содержание |
| --- | --- |
| [docs/specification.md](docs/specification.md) | Уточнённые требования, найденные противоречия и изменения, трассировка |
| [docs/assumptions.md](docs/assumptions.md) | Проверенные факты, допущения, **вопросы владельцу** |
| [docs/processes.md](docs/processes.md) | Процессы, состояния, переходы, владельцы, резервы |
| [docs/domain-model.md](docs/domain-model.md) | Сущности, роли и разрешения, источники истины |
| [docs/architecture.md](docs/architecture.md), [docs/adr/](docs/adr) | Архитектура и решения |
| [docs/design-system.md](docs/design-system.md) | Интерфейс, компоненты, состояния, доступность |
| [docs/integrations.md](docs/integrations.md) | Контракт адаптеров, demo-режимы, что проверить до реальных подключений |
| [docs/delivery-plan.md](docs/delivery-plan.md) | Бюджет 0 ₽, что сделано, блокеры публикации, этапы |
| [docs/test-plan.md](docs/test-plan.md), [docs/runbooks/](docs/runbooks) | Проверки, приёмка, эксплуатация |

## Быстрый старт для разработки (без облака)

```bash
npm install
npm test                 # 91 проверка: права, деньги, процессы, контракт, восстановление (PGlite)
npm run local:backend    # локальный бэкенд разработки на :54321 (эмуляция Supabase поверх тех же миграций)
```

Во втором терминале — `.env.local` с `VITE_SUPABASE_URL=http://localhost:54321` и `VITE_SUPABASE_PUBLISHABLE_KEY=local-dev-publishable-key-0000`, затем `npm run dev`. Пароли демо-пользователей — в `local/demo-users.local.md` (не коммитится).

Локальный бэкенд — инструмент разработки и диагностики, а не замена демо-стенду (COST-04).

## Публикация демо-стенда

Пошагово: [docs/runbooks/deploy.md](docs/runbooks/deploy.md). Кратко: проект Supabase Free → `.env.local` → `npm run db:apply -- --seed` → `npm run seed:users` → `npm run db:apply -- --after-users` → `npm run deploy`.

## Команды

| Команда | Что делает |
| --- | --- |
| `npm test` / `npm run typecheck` / `npm run build` | Проверки, типы, сборка |
| `npm run gen:contract` | Обновить типизированный контракт команд из SQL после изменения миграций |
| `npm run db:apply [-- --seed] [-- --after-users]` | Применить миграции (и синтетические данные) к проекту Supabase |
| `npm run seed:users` | Создать демо-пользователей через Admin API (секретный ключ — только в `.env.local`) |
| `npm run sql:bundle` | SQL для ручного применения в SQL Editor |
| `npm run db:export` / `npm run db:restore -- <каталог> --confirm-wipe` | Резервная копия данных и файлов / восстановление |
| `npm run deploy` | Сборка и публикация на GitHub Pages |

## Безопасность

- В браузере и репозитории — только URL проекта и publishable key; секретный ключ, пароль БД и токены — только в `.env.local` администратора.
- RLS на всех таблицах; клиент не пишет в таблицы напрямую — только именованные команды с проверкой прав, области и переходов.
- Самостоятельная регистрация в Supabase Auth должна быть отключена.
- В публичный репозиторий не попадают реальные данные компании, внутренние документы и секреты (COST-20).

## Лицензии зависимостей

MIT / Apache-2.0 / ISC / MPL-2.0 (DOMPurify — MPL-2.0 или Apache-2.0). Платных компонентов нет.
