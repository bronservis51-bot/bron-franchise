# ADR-0001 Стек прототипа

Статус: принято · 12.10.2026

## Контекст
Раздел 25 требует прототип за 0 ₽ на GitHub Pages + Supabase Free; ARCH-01 задаёт целевой модульный монолит на TypeScript. Нужен стек, который работает сейчас и не требует переписывания при переходе.

## Решение
- Клиент: TypeScript, React 19, Vite 8, React Router (hash-маршруты), TanStack Query для серверного состояния, i18next (RU/TR), vite-plugin-pwa (Workbox), idb для IndexedDB, markdown-it + DOMPurify для статей, lucide-react — иконки.
- Backend прототипа: Supabase Auth, PostgreSQL (RLS + команды-функции), Storage.
- Проверки: Vitest; PGlite для SQL-тестов; TypeScript strict.
- Без UI-китов: собственная небольшая дизайн-система на CSS-переменных (меньше зависимостей, полный контроль доступности).

Все зависимости — MIT/Apache-2.0/ISC/MPL-2.0 (проверено в npm registry 12.10.2026). Платных компонентов нет.

## Последствия
- Бизнес-правила прототипа написаны на PL/pgSQL; их перенос на TypeScript — постепенный (architecture.md §3).
- Отказ от UI-кита увеличивает объём CSS, но убирает зависимость от сторонней темы.
