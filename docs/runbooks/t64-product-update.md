# T64 — права сотрудников, рейтинг менеджера и телефон-логин

Production остаётся публичным, Source INACTIVE. T63 уже опубликован, 14 дней
выручки сверены. Эта задача не повторяет его миграции, импорт, backup/restore
или Telegram. Точные commit, outer manifest и архивные SHA закрепляет Root.

## Граница задачи

Только три новые SHA-проверенные миграции:

1. `20261116040000_staff_helper_execute.sql` — закрытый технический EXECUTE для
   прежнего доверенного владельца приложения; проверка фактических owners/ACL.
2. `20261116050000_rating_manager_only.sql` — рейтинг только сетевому менеджеру.
3. `20261116060000_phone_logins.sql` — возможности телефонного логина и его
   управляемого изменения, без массового переименования существующих аккаунтов.

Не назначать бизнес-роли, не угадывать точки/телефоны, не сбрасывать пароли, не
читать Auth/password/business rows через operator. Реальные пользовательские
операции — только через уже разрешённый UI и реальные данные. Не закрывать web
из-за активной роли или ожидания владельца. Роль активна до явного release.

## Подготовка

Проверить опубликованный T64 bundle по exact commit/outer manifest, отправить
ACCEPTED и продолжать весь checklist без нового ответа Root. Не делать
reset/stash/clean. Пока другой helper работает, его checkout не менять.
Этот пакет включает идентичную миграцию срочного T64A: если T64A ещё не начат,
не запускать его отдельно, выполнить полный T64. Если T64A уже работает — сначала
дождаться его результата. Если он уже COMMITTED с совпавшим checksum, T64
проверит ledger и пропустит 040000. Его receipt/before/after сохраняются;
повторять исправление либо его отдельную диагностику не требуется.

Готовый архив `docs/runbooks/payloads/t64-app-root.tar` собран из exact
`f38806ad8f8d8a2f5a82f6039f79906b7e2bf449`. Повторная сборка/установка
зависимостей не нужна. Pins находятся в двух JSON ниже и outer manifest.

Каталог `/root/bron-secrets/t64-product` root:root0700. Доставить оба T64 helper,
три новых SQL, `migration-manifest.json`, `publish-pin.json` и `app-root.tar`
root:root0600, O_EXCL/no-follow, fsync и SHA readback. Публикуемый архив содержит
только публичный клиент и release-manifest, не реальные данные/серверные ключи.

Использовать существующий strict SSH с прежним проверенным ED25519 fingerprint
`SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0`.
Новые SSH/owner login/MFA не требуются. Карта доставки относительно репозитория:

| Локальный файл | Имя в VPS-каталоге |
| --- | --- |
| `docs/runbooks/payloads/t64-target-update.py` | `t64-target-update.py` |
| `docs/runbooks/payloads/t64-static-publish.py` | `t64-static-publish.py` |
| `supabase/migrations/20261116040000_staff_helper_execute.sql` | то же имя |
| `supabase/migrations/20261116050000_rating_manager_only.sql` | то же имя |
| `supabase/migrations/20261116060000_phone_logins.sql` | то же имя |
| `docs/runbooks/payloads/t64-migration-manifest.json` | `migration-manifest.json` |
| `docs/runbooks/payloads/t64-publish-pin.json` | `publish-pin.json` |
| `docs/runbooks/payloads/t64-app-root.tar` | `app-root.tar` |

До исполнения AST-проверка обоих Python helper без импорта/вызова. Проверки
файлов, доставка и AST выполняются одним preflight; закрытые PASS не повторять.
Если точный destination уже существует, только SHA/mode/readback: совпавший
публичный payload можно переиспользовать; при несовпадении stop, не перезаписывать.
Если state/intent/receipt уже существует, helper не запускать снова — принять
существующий однозначный результат или сверить commit/ledger, как описано ниже.

Формат migration-manifest как T63, но `task=T64` и ровно три новых имени выше.
Publish-pin: `format=1`, `task=T64`, `sourceCommit`, `archiveSha256`,
`manifestSha256` и те же три migration{name,sha256}. Все значения Root заполняет
по фактической сборке. Не подставлять будущие или вымышленные SHA.

## 1. Один последовательный серверный запуск

```sh
python3 -I /root/bron-secrets/t64-product/t64-target-update.py --migrate --directory /root/bron-secrets/t64-product --manifest /root/bron-secrets/t64-product/migration-manifest.json
```

Внутри:

- Точный здоровый DB container/image и прежний T63 live manifest.
- Существующая backup-state/health свежесть; новых backup/restore нет.
- Только 9 функций/11 связей из системных каталогов до изменения. Сохраняется
  `catalog-before.json`, без личных записей.
- Три точных checksum T63 **проверяются**, но старые SQL не выполняются.
- Одна транзакция, advisory lock, новый SHA ledger, ровно три новые миграции.
  `NOTIFY pgrst, 'reload schema'` перед COMMIT доставляется после успешного COMMIT.
- Сразу после COMMIT создаётся `migration-commit.json`; затем закрытый
  `catalog-after.json` и `migration-receipt.json`.

Ожидается `MIGRATIONS_COMMITTED` с `missingExecuteAfter=[]`. Если до изменения
не было false-ребра, не утверждать, что найдена причина отказа: записать
`aclGapObservedBefore=false`. Если разрыв уже исправлен T64A, переиспользовать
его before/after evidence; это ожидаемый skip, не новая неизвестная причина.
Реальный ранее упавший экран всё равно должен работать для своей роли.

`COMMITTED_POSTCHECK_BLOCKED` означает **схема уже применена**, а проверка после
COMMIT не прошла. Клиент не публиковать, helper не повторять. Если после intent
нет однозначного результата, одна read-only сверка трёх новых ledger записей
определяет COMMITTED/NOT_COMMITTED/UNKNOWN; состояние не сбрасывать.

Не выдавать PUBLIC/anon/authenticated дополнительные права ради устранения
ошибки, не менять owners/role flags из памяти. Патч прав делает только
закреплённая проверенная миграция в рамках указанных guards.

## 2. Сразу опубликовать готовый клиент после PASS

```sh
python3 -I /root/bron-secrets/t64-product/t64-static-publish.py --publish --directory /root/bron-secrets/t64-product --archive /root/bron-secrets/t64-product/app-root.tar --pin /root/bron-secrets/t64-product/publish-pin.json
```

Те же проверенные правила T63: точные archive/file hashes и три новых ledger
записи, root PWA scope, неизменные шесть backend IDs и production parent bind.
Один атомарный exchange app-каталога, старые assets сохранены для открытых PWA,
before-image `.app-before-t64-*` сохранён. Контейнеры/Caddy/Compose не меняются.

Ожидается APP_PUBLISHED. После — strict TLS app/version/manifest/SW 200 с новым
manifest; текущий ping и существующий health healthy/fresh. Не повторять ранее
закрытые migration/Auth/restore/Telegram gates.

При подтверждённом критическом дефекте нового клиента:

```sh
python3 -I /root/bron-secrets/t64-product/t64-static-publish.py --rollback --directory /root/bron-secrets/t64-product
```

Возвращается предыдущий публичный клиент, схема и данные не удаляются. Рейтинг
останется закрыт сервером для франчайзи даже на старом клиенте. При UNKNOWN
сначала сверить существующие manifest/result, не повторять команды вслепую.

## 3. Проверить конкретную пользу

- Сетевой менеджер: карточка франчайзи → сотрудники; франчайзи/управляющий:
  свои разрешённые сотрудники/точки; сотрудник: свой рабочий экран. При новом
  отказе — точный RPC/code и фактические роли/permission booleans, без JWT/UUID.
- Рейтинг: виден/доступен сетевому franchise_manager; отсутствует в меню
  франчайзи, прямой маршрут и RPC отклоняют его. Чужую роль не создавать ради QA.
- Телефон-логин: новый интерфейс виден менеджеру; после разрешённого явного
  изменения конкретного номера UID/пароль/роли/история сохраняются, старые
  сеансы завершаются. Телефон не придумывать; старые логины не переименовывать
  автоматически. Для UI-функции достаточно изолированных тестов до реальной
  потребности владельца в смене номера; фиктивные production-аккаунты запрещены.
- Телефон/PWA: штатное обновление без очистки storage/очереди. Реальный вход и
  настоящая смена подтверждаются отдельно, без фиктивной выручки и auto-close.

## Итог

Один safe receipt `/root/bron-secrets/t64-release-receipt.json` 0600 и идентичный
локальный mirror: task/commit/manifest, новые checksums, before/after ACL gaps,
фактический COMMIT, live manifest, backend invariants, live/UI acceptance или
PENDING, changed paths. Счётчики Source/PW reset/role assignment/actual phone
changes от operator =0. Учесть отдельно только реальное явно выполненное UI
действие, если оно было разрешено владельцем, не подменять его нулём.

Локальный mirror: `/private/tmp/bron-release-executor-20261113/T64-state.json`.
Формат отчёта: `T64_REPORT servingMode; migrationStatus/commitOutcome;
t64aReused; aclGapObservedBefore/missingExecuteAfter; staticStatus;
liveManifestSha256; backendIdsUnchanged; tls/app/ping/health;
staff/rating/phone/PWA acceptance=PASS|PENDING|BLOCKED; Sourcequeries=0;
passwordsReset=0; roleAssignmentsChanged=0; receiptPath/SHA; nextBlocker`.
При BLOCKED сообщать один точный code/этап и уже выполненные действия;
не возвращать исправленный публичный сайт в maintenance по условию роли.

Квитанция и чат не содержат телефонов, логинов/паролей, UUID, токенов или
финансовых строк. Закрытые реквизиты передаются только владельцу согласно
текущему T63 правилу active-only/законный закрытый листок, без reset.
