# Изолированная репетиция восстановления

Только российская цель, после сохранения закрытой SQL/Auth-копии с проверенными
контрольными суммами по [backup-restore.md](backup-restore.md). Полнота всех
компонентов и независимого хранения проверяется отдельно. Этот порядок не переключает клиентов
и не даёт разрешения менять источник. Сохраняются UUID, хеши паролей, права,
финансы, файлы и исходные признаки активности расписаний.

## Конфигурация до первого старта

Помести [compose.restore.override.yml](../../deploy/timeweb/compose.restore.override.yml)
в `docker/bron/` закреплённого checkout. Он применяется **последним**:

```sh
docker compose --env-file .env \
  -f docker-compose.yml -f bron/compose.override.yml \
  -f bron/compose.restore.override.yml config --quiet
```

Настоящий `.env` закрыт; полный `config` с подставленными секретами в отчёт не
выводить. Compose должен поддерживать `!override` (не ниже 2.24.4).
Проверить итоговую модель безопасным валидатором: единственный опубликованный
порт — DB `127.0.0.1:15433`; source-канал использует другой порт, `15432`.
Gateway, Studio, Supavisor и Caddy не публикуют портов; сеть `default` — internal.
Проверить фактические listener и Docker port bindings до загрузки данных.

С первого старта действуют `cron.launch_active_jobs=off` и `pg_net.batch_size=0`.
Первый сохраняет `cron.job.active`, но запрещает запуск заданий. Второй оставляет
worker загруженным, однако pg_net 0.20.4 использует `LIMIT 0` для извлечения
запросов и очистки ответов: очередь не дренируется даже ошибками сети.
Preload/Supautils не удалять; `pg_net.database_name` не переназначать.
Изоляция сети — дополнительная защита, а не замена этих настроек.

## Сначала DB и версии расширений

Сначала запусти только DB:

```sh
docker compose --env-file .env \
  -f docker-compose.yml -f bron/compose.override.yml \
  -f bron/compose.restore.override.yml up -d db
```

Нативный PostgreSQL-клиент получает target-доступ из закрытого service/pgpass,
не из argv. До дальнейшего init/импорта выполнить:

```sql
SELECT name, setting, source, context, min_val, pending_restart
FROM pg_settings
WHERE name IN ('cron.launch_active_jobs', 'pg_net.batch_size');
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT name, version, installed FROM pg_available_extension_versions
WHERE name IN ('pg_net', 'pg_cron', 'supabase_vault') ORDER BY name, version;
```

Ожидаются `off` / `0`, `source = command line`, минимум batch_size `0` и
`pending_restart = false`. В источнике pg_net 0.20.4, pg_cron 1.6.4 и Vault 0.3.1.
Каталог сборки PG 17.11.0.019 включает также Vault 0.3.2, но он не доказывает
наличие всех версий в готовом образе. На пустой изолированной цели проверить
доступность и возможность явного `VERSION '0.3.1'`. Если фактически установлен
0.3.2, остановить дальнейший импорт: разобрать совместимость/проверенную логическую
reencryption и явно оформить отклонение. Не менять образ или отключать аудит молча.

## Инициализация managed-схем

После проверки расширений запусти только этот список, без Caddy/gateway/Studio/functions:

```sh
docker compose --env-file .env \
  -f docker-compose.yml -f bron/compose.override.yml \
  -f bron/compose.restore.override.yml up -d db auth rest imgproxy storage
```

После завершения миграций Auth/Storage и проверки их здоровья останови клиентов
БД для импорта; оставь DB работающей:

```sh
docker compose --env-file .env \
  -f docker-compose.yml -f bron/compose.override.yml \
  -f bron/compose.restore.override.yml stop auth storage rest imgproxy
```

Проверить `auth.schema_migrations`, `storage.migrations` и реальные
таблицы/колонки/типы, constraints и grants против архива источника. Одного
максимального migration ID мало.

## Импорт и сверка

1. Roles → прикладная schema → data по официальной процедуре, с
   `ON_ERROR_STOP`, одной транзакцией и `session_replication_role=replica` на
   время COPY. Никаких seed/reset; неизвестные COPY/колонки не удалять ради успеха.
   Не применять полный raw managed-schema архив поверх готовых Auth/Storage.
2. Вернуть пользовательский `on_auth_user_created` на `auth.users`, после
   появления `app_private.on_auth_user_created()`; при импорте данных он не
   должен создавать дубликаты профилей. Вернуть Storage policies
   `partner_docs_read`, `partner_docs_insert`, `partner_docs_delete` и
   **`valid_auth_session` как RESTRICTIVE / ALL / authenticated**. Сверить точные
   условия, grants и RLS с архивом, а не создавать приближённые правила.
3. Проверить значения и хеш очереди pg_net до/после репетиции, все исходные
   `cron.job.active`, UUID/хеши Auth, деньги по валютам и файлы. До пробных входов
   выполнить строгий `migration:check`; source-транспорт Node должен сохранять
   canonical TLS, target loopback-доступ задаётся отдельно. Успех этого инструмента
   не подтверждает байты файлов, Vault и Auth/SMTP-конфигурацию.
4. Проверить расшифровку Vault и восстановление независимой S3-копии. Затем на
   **цели** отозвать перенесённые sessions/refresh tokens и проверять входы/права
   по [критериям релиза](../release-gates.md). Источник не отзывать. После пробных
   записей нужна чистая финальная копия либо проверенный перенос всей дельты.

Дальнейшие сервисы, публикация и снятие freeze — отдельный этап после сверки.
Перед рабочим стартом явно разобрать отложенную очередь, вернуть проверенную
конфигурацию и запускать только согласованные задания; выключенный
`bron-shop-worker` не включать автоматически. Этот restore override нельзя
просто убрать до готовности к внешним действиям.

## Проверенные первоисточники

- [pg_net v0.20.4 worker/GUC](https://github.com/supabase/pg_net/blob/v0.20.4/src/worker.c),
  [SQL извлечения/очистки](https://github.com/supabase/pg_net/blob/v0.20.4/src/core.c).
- [Postgres 17.11.0.019 Dockerfile](https://github.com/supabase/postgres/blob/17.11.0.019/Dockerfile-17)
  и [версии расширений](https://github.com/supabase/postgres/blob/17.11.0.019/nix/ext/versions.json);
  [entrypoint](https://github.com/docker-library/postgres/blob/6edb0a8c/docker-entrypoint.sh)
  передаёт startup-аргументы также временному init-серверу.
- [Auth v2.197.0 migrations](https://github.com/supabase/auth/tree/v2.197.0/migrations),
  [Storage v1.89.12 migrations](https://github.com/supabase/storage/tree/v1.89.12/migrations/tenant),
  [официальный restore](https://supabase.com/docs/guides/self-hosting/restore-from-platform),
  [pg_cron](https://github.com/citusdata/pg_cron).

Проверка исходников не заменяет запуск. Compose merge, init, значения GUC,
схема, импорт и восстановление на самом VPS подтверждаются отдельными результатами.
