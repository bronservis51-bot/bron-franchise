# Публикация (GitHub Pages + Supabase Free)

Репозиторий: `bronservis51-bot/bron-franchise` (публичный), сайт: `https://bronservis51-bot.github.io/bron-franchise/`.

## 1. Supabase (один раз)
1. New project → Free → сохранить пароль базы.
2. Authentication → Sign In / Providers → выключить **Allow new users to sign up**.

## 2. Значения для настройки
| Значение | Где взять | Секрет? |
| --- | --- | --- |
| Project URL | кнопка Connect или Project Settings → Data API | нет |
| Publishable key (`sb_publishable_…`) | Project Settings → API Keys | нет |
| Secret key (`sb_secret_…`) | Project Settings → API Keys | **да** |
| Connection string (Session pooler) | Connect → Session pooler | **да** (в строке пароль базы) |

Секреты хранятся только в `.env.local` на компьютере. Этот файл не попадает в git. Не пересылайте его в чаты и не вставляйте в настройки GitHub.

## 3. База данных
`.env.local`:
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
DATABASE_URL=postgresql://postgres.<project>:<пароль>@<host>:5432/postgres
VITE_DEMO_QUICK_PASSWORD=<общий демо-пароль, необязательно>
VITE_BASE_PATH=/
VITE_APP_ENV=demo
```
Затем по порядку: `npm run db:apply -- --seed` → `npm run seed:users` → `npm run db:apply -- --after-users`.

## 4. Сайт
1. GitHub → Settings → Secrets and variables → Actions → **Variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; для кнопок быстрого входа по ролям — ещё `VITE_DEMO_QUICK_PASSWORD`. Это публичные значения, секреты сюда не кладутся.
2. Settings → Pages → Source: **GitHub Actions**.
3. Каждый `git push` в `main` проверяет и публикует сайт (workflow `pages`).

## Обновление
`npm test` → `npm run db:apply` (если появились новые миграции) → `git push`. Пользователи увидят новую версию при следующем открытии.

## Пересоздать демо-базу с нуля
Только для демо-проекта: все данные удалятся. `npm run db:reset-demo -- --confirm-wipe` удаляет таблицы и функции приложения и демо-пользователей. Скрипт откажется работать, если в базе есть настоящие пользователи. Затем пройдите шаг 3 заново.
