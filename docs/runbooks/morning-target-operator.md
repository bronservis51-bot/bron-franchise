# Утренняя проверка целевой площадки

Только self-hosted target. Source INACTIVE, повторный перенос закрыт. Рабочий
сайт остаётся публичным независимо от активности исполнителя. Этот helper не
перезапускает контейнеры, не публикует клиент, не меняет пароли и не создаёт
тестовые записи. Запуск на VPS root, после внешней проверки pinned bundle SHA.

## Входы

Каталог `/root/bron-secrets/t63-morning` — root:root 0700, файлы root:root 0600,
без ссылок. `morning-target-operator.py` — SHA из опубликованного task manifest.
Не передавать полную среду, Docker Environment, Auth-таблицы или backup-артефакты.

Необязательный `input.json` содержит только уже предоставленные владельцем
имена для сопоставления, например форму `{ "subjects": [{"key": "revenue_owner",
"name": "имя из закрытого поручения"}] }`. Имена и значения выручки не входят
в публичный git/task log. Сопоставление точное после нормализации регистра и
пробелов. Ноль/несколько соответствий не разрешают угадывать нужную точку.

## Одна объединённая read-only проверка

```sh
python3 -I /root/bron-secrets/t63-morning/morning-target-operator.py --inventory --directory /root/bron-secrets/t63-morning --private-input /root/bron-secrets/t63-morning/input.json
```

Сверяется точный healthy контейнер/image. Одна REPEATABLE READ READ ONLY
транзакция читает только прикладные профили, назначения, сотрудников, партнёров
и точки; завершается ROLLBACK. SQL не читает Auth users/passwords/tokens/sessions.
Сопоставления выполняются в памяти из того же снимка без дополнительных запросов.

Закрытые результаты: `account-inventory.json`, `owner-logins.txt` и
`inventory-receipt.json`. В чат только `INVENTORY_SAVED`, количества и пути/SHA.
В TXT прямо написано, что пароли из хешей не извлекаются и не сбрасывались.
Нельзя назвать этот файл полным списком паролей. Передавать его лично владельцу
по разрешённому закрытому каналу; не прикреплять к issue/commit/log. Нельзя
автоматически назначать существующему сотруднику роль/ставку по совпадению имени.

## Только новые проверенные миграции

`migration-manifest.json` имеет вид:

```json
{"format":1,"task":"T63","migrations":[
 {"name":"20261116010000_daily_payroll.sql","sha256":"64 hex from pinned payload"},
 {"name":"20261116020000_staff_scopes.sql","sha256":"64 hex from pinned payload"},
 {"name":"20261116030000_partner_preparation.sql","sha256":"64 hex from pinned payload"}
]}
```

Эти три SQL лежат рядом с manifest. Их порядок фиксирован; дополнительные SQL,
seed/reset и изменение старых миграций не допускаются. Перед запуском соответствие
SHA подтверждается task-пакетом и helper. Читается только существующая freshness
backup-state и heartbeat (копия не создаётся, restore не повторяется): успешная
проверенная копия не старше 4200 секунд, healthy heartbeat не старше 1800 секунд.

```sh
python3 -I /root/bron-secrets/t63-morning/morning-target-operator.py --migrate --directory /root/bron-secrets/t63-morning --manifest /root/bron-secrets/t63-morning/migration-manifest.json
```

Один advisory lock и одна транзакция охватывают все три миграции и их записи
`app_private.schema_migration`. Совпавший уже применённый checksum пропускается,
несовпавший блокирует всё. SQL-ошибка до COMMIT откатывает транзакцию; клиент не
публикуется. Успех: `MIGRATIONS_COMMITTED`, закрытая квитанция и три checksum.

`migration-intent.json` пишется до SQL; при ошибке/обрыве после него исход нельзя
считать UNCHANGED. Не перезапускать helper: одна read-only проверка ledger точных
трёх имён определяет COMMITTED/NOT_COMMITTED/UNKNOWN, после чего координатор
определяет продолжение. Нельзя автоматически откатывать схему/данные SQL из
памяти. Предыдущий клиент остаётся рабочим при обратно совместимых миграциях;
публикация нового клиента — следующий упорядоченный шаг того же task-пакета.

## Что не покрыто

Этот helper не импортирует выручку, не задаёт trainee/manager настройки реальным
людям, не восстанавливает неизвестные пароли и не проверяет реальные логины.
Для этих действий нужны точные выбранные UUID, конфликт-проверка и отдельные
разрешённые шаги task-пакета. Переход пользователя в production и его реальные
рабочие операции завершают приёмку; локальный тест не доказывает публикацию.

## Публикация клиента без перезапуска web

`morning-static-publish.py` использует уже действующий read-only parent bind
`bron/site:/srv:ro`. Входы — закрытый `app-root.tar` и `publish-pin.json`:

```json
{"format":1,"task":"T63","sourceCommit":"40 hex product commit",
 "archiveSha256":"64 hex archive SHA","manifestSha256":"64 hex release-manifest SHA",
 "migrations":[
  {"name":"20261116010000_daily_payroll.sql","sha256":"64 hex"},
  {"name":"20261116020000_staff_scopes.sql","sha256":"64 hex"},
  {"name":"20261116030000_partner_preparation.sql","sha256":"64 hex"}
 ]}
```

Архив содержит root-relative пути без `./`, внутренний `release-manifest.json`
и ровно его перечисленные файлы. Отдельные directory entries допустимы только
для родителей этих файлов. Manifest: format1, sourceCommit, base`/`, apiOrigin,
files[{file,bytes,sha256}]. Пакет не содержит персональных данных/секретов.

```sh
python3 -I /root/bron-secrets/t63-morning/morning-static-publish.py --publish --directory /root/bron-secrets/t63-morning --archive /root/bron-secrets/t63-morning/app-root.tar --pin /root/bron-secrets/t63-morning/publish-pin.json
```

Сначала проверяются архив/файлы/политика PWA, применённые три checksum в ledger,
шесть неизменённых backend IDs и production parent bind. Новая директория
создаётся рядом с `app`, старые assets сохраняются для открытых вкладок/PWA;
совпадение asset-пути с разными байтами блокирует публикацию. Старый HTML/SW не
копируется. `renameat2(RENAME_EXCHANGE)` меняет app атомарно без service/Caddy/
Compose изменений. Старый app сохраняется в точном beforeImage из закрытого
`publish-result.json`. При post-switch проверке/ошибке сохранения результата
helper пытается немедленно вернуть прежний app. `PUBLISH_COMMIT_UNKNOWN` требует
проверки фактического manifest, без повторного запуска.

После APP_PUBLISHED обязательны обычные TLS GET `/`, `/app-version.json`,
`/manifest.webmanifest`, `/sw.js`, затем проверка нового входа/назначенной области
и реальной операции. `httpsChecks=PENDING` не равен принятому выпуску. Если
выявлена критическая неисправность нового клиента, точный статический rollback:

```sh
python3 -I /root/bron-secrets/t63-morning/morning-static-publish.py --rollback --directory /root/bron-secrets/t63-morning
```

Rollback меняет местами только проверенные app/beforeImage, не откатывает
миграции, данные или Source. Production остаётся публичным; новая версия
сохраняется в beforeImage как кандидат для разбора. Операцию не повторять.
