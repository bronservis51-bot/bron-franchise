# Публикация демо-стенда (GitHub Pages + Supabase Free)

Владелец: владелец продукта · Исполнитель: разработчик с доступом к аккаунтам
Решение по репозиторию (Q-01): **один публичный репозиторий**, публикация через GitHub Actions.

## 1 Аккаунты (владелец, один раз)
1. **GitHub:** аккаунт (бесплатный) → New repository → имя `bron-platform` → **Public** → без README.
2. **Supabase:** аккаунт (вход через GitHub удобен) → New project → регион ближе к пользователям (например, Central EU) → **Free** → задать надёжный пароль БД и сохранить его в менеджере паролей. Банковская карта не нужна.
3. В проекте Supabase: Authentication → Sign In / Providers → выключить **Allow new users to sign up**. Integrations → Cron → включить, если доступно.

## 2 Значения для настройки
| Значение | Где взять | Секрет? |
| --- | --- | --- |
| Project URL | Project Settings → Data API (или API) | нет |
| Publishable key (`sb_publishable_…`) | Project Settings → API Keys | нет |
| Secret key (`sb_secret_…`) | Project Settings → API Keys | **да** |
| Connection string (Session pooler) | кнопка Connect → Session pooler | **да** (содержит пароль БД) |

Секреты — только в файл `.env.local` на компьютере разработчика (он не попадает в git). Не отправлять в чаты и не вставлять в настройки GitHub.

## 3 База данных (разработчик)
`.env.local`:
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_APP_ENV=demo
DATABASE_URL=postgresql://postgres.<project>:<пароль>@<host>:5432/postgres
SUPABASE_SECRET_KEY=sb_secret_...
```
Затем: `npm run db:apply -- --seed` → `npm run seed:users` → `npm run db:apply -- --after-users`. Пароли демо-пользователей — в `local/demo-users.local.md`.
Без прямого подключения: `npm run sql:bundle`, выполнить `supabase/bundle.sql` в SQL Editor, затем `seed:users`, затем `bundle_after_users.sql`.

## 4 Публикация (разработчик)
1. GitHub → репозиторий → Settings → Secrets and variables → Actions → **Variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (публичные значения; секреты сюда не кладутся).
2. Settings → Pages → Source: **GitHub Actions**.
3. `git remote add origin https://github.com/<аккаунт>/bron-platform.git` → `git push -u origin main`.
4. Actions → workflow `pages` → после зелёного статуса сайт доступен по `https://<аккаунт>.github.io/bron-platform/`.

## Обновление
`npm test` → `npm run db:apply` (если есть новые миграции) → `git push`. Пользователи увидят «Доступна новая версия».

## Проверка
Чек-лист приёмки — [test-plan.md §4](../test-plan.md#4-приёмка-прототипа-cost-12). До зелёной публикации и прохождения чек-листа сборку не называем онлайн-прототипом (COST-20).

## Откат
Код: `git revert <коммит>` → `git push`. Миграции не откатываются автоматически; откат кода не откатывает данные (OPS-04).

## Запасной путь
`npm run deploy` публикует сборку с компьютера в ветку `gh-pages` (нужны `PAGES_REPO` и `VITE_BASE_PATH=/<репозиторий>/` в `.env.local`; Pages → Deploy from branch `gh-pages`).
