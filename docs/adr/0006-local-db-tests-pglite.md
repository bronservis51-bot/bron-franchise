# ADR-0006 Локальные проверки БД на PGlite

Статус: принято

## Контекст
Docker и Supabase CLI на машине разработки отсутствуют; тесты на общем демо-проекте ломают демонстрацию (OPS-04 требует разделения сред).

## Решение
Тесты запускают PGlite (PostgreSQL в WebAssembly, Apache-2.0) в процессе Vitest. Файл `supabase/tests-shim/00_supabase_shim.sql` создаёт роли `anon`, `authenticated`, `service_role`, схему `auth` с `auth.users` и `auth.uid()` (из `request.jwt.claims`, как в Supabase) и упрощённую схему `storage`. Затем применяются те же миграции и seed, что и в Supabase. Тест переключает пользователя через `set role authenticated` + `set request.jwt.claims`.

## Последствия
- Проверяются RLS, grants, команды и инварианты без облака.
- PGlite — PostgreSQL 18, Supabase — 15/17: в миграциях не используются возможности новее PostgreSQL 15.
- Поведение PostgREST и Storage API тестируется вручную по чек-листу на демо-проекте.
