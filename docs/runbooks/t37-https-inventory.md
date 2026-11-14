# T37 — разрешённая live-сверка по Source HTTPS, новый pinned пакет

Владелец явно одобрил описанный в `owner-source-transport-approval.md` data-scope.
T37 исполняется только после свежего EXECUTOR_TASK с commit и SHA этого manifest.
Старый T36 capability истёк и не используется. T37 имеет ровно одну live-попытку;
общий неизменяемый журнал на VPS ограничивает весь выпуск тремя попытками
(T37.live, final_before, final_after), включая неудачные/неопределённые.
Создание нового capability бюджет не сбрасывает. T30 key proof не блокирует T37.

## Единый checklist: подготовка → передача координатору → одна сверка

1. Закрытые T38/T39 не повторять. Убедиться, что нет незавершённого своего процесса;
   чистый fast-forward ветки до точного commit EXECUTOR_TASK. Проверить SHA байтов
   manifest `docs/runbooks/payloads/t37-https.json` и всех `files`. Отправить
   ACCEPTED и продолжить без ACK. Проверить strict SSH fingerprint, Node22.23.5,
   `verify_only`, pg8.23.1 и прежний dependency-lock SHA из manifest runtime,
   T36 PASS resultSHA. Не показывать contents приватных файлов.
2. Доставить **только `deliveries`**, exclusive-create, directories root:root0700,
   files root:root0600. Если файл уже есть: проверить точный SHA/mode/owner/nlink,
   неизменный совпадающий файл переиспользовать; любой иной — BLOCKED, не заменять.
   Доставленные runtime modules не заменяют установленный T21 auditor.
   Сверить SHA/readback и syntax. Без installs, compose, сервисов, TCP/маршрутов.
3. Ровно один `commands.prepare`, подставив exact manifest SHA. Пакет создаёт
   permanent prepare.guard, общий grant descriptor, новый machine capability и
   prepared metadata на VPS. Обязателен нулевой прежний Auth-бюджет. Любой
   существующий guard/частичное состояние — BLOCKED, без удаления или повтора.
   **Не читать capability в терминал, argv/env, лог, clipboard или Mac.**
4. Отправить `EXECUTOR_READY T37 COMMIT=... MANIFEST_SHA=... CAPABILITY_SHA256=...
   EXPIRES_UTC=... FUNCTION_NAME=... OWNER_GRANT_SHA256=... BUDGET_USED=0`.
   Это hash-only metadata. **Остановить только зависимую --run фазу до сообщения
   координатора DEPLOYMENT_READY T37** с теми же hash/name/expiry. Это продолжение
   того же task, нового checkout/разрешения владельца не требуется. Самостоятельно
   не развёртывать reader. Не расходовать Auth-попытку на readiness/проверку сети.
5. Координатор проверяет точный SHA шаблонов, рендерит только public capSHA и
   абсолютный expiry, развёртывает новый hash-derived endpoint существующего
   Source project и получает исходники обратно для exact readback. `verify_jwt=false`
   относится только к mandatory-capability machine reader; продуктовые Auth/RLS,
   REST/JWT и shop-worker не меняются. GET без секрета обязан отказать до БД.
   После подтверждённого readback и GET координатор отправляет DEPLOYMENT_READY.
6. Получив DEPLOYMENT_READY, проверить соответствие prepared metadata и достаточный
   остаток TTL. Выполнить `commands.run` ровно один раз с прежним manifest SHA.
   Новый immutable live guard и общий durable budget claim записываются/fsync
   **до** настоящего POST. FAIL/timeout/неизвестный исход расходуют попытку;
   повтор, resume, fallback, новый capability в этом task запрещены.
7. Один raw64ASCII capability POST только по fixed verified HTTPS Source URL;
   no redirect, finite wall/size bounds. Source берёт полный прежний canonical
   snapshot и compact Auth в одном RR READ ONLY: UTC, pg_catalog, statement5s,
   idle10s. Весь ответ AES-GCM/HKDF шифруется в Source, plaintext/ciphertext
   остаются в RAM VPS. No raw profile/password/token values exported; Auth digest
   включает все иные поля, в том числе password-hash/token-related.
8. Один target snapshot теми же функциями, compact Auth из той же RR READ ONLY.
   Не записывать/печатать body, UUID, пользовательские timestamps/digests/DSN.
   На Mac передаётся только safe receipt, без encrypted envelope и working data.
   Обновлять updated_at, применять дельту, freeze/Pause или открывать API запрещено.
9. Завершить клиентов/helper; сохранить canonical safe receipt и log root0600,
   зеркалировать **только safe receipt** на Mac с одинаковыми bytes/SHA.
   Не ждать T30, не повторять build/restore/RLS/Telegram/schedule/staging.
   Координатор после отчёта закрывает reader tombstone и проверяет доступные
   агрегированные логи, не публикуя raw logs/capability. TTL — дополнительная защита.

## Точные acceptance checks

- Bundle, SSH/runtime/modes/input-evidence SHA PASS; T21 canonical auditor unchanged.
- Fresh prepared metadata bound current manifest SHA and approved grant SHA;
  cap remains VPS-only, two-hour absolute expiry, exact deployed source readback.
- Before source POST: permanent live guard and fixed shared budget reservation
  durable. At most one actual source POST/snapshot and one target snapshot.
- Все strict table/schema/sequence groups полны, прежний comparator сохранён;
  ошибок/пропусков как пустых групп нет. UUID/counts/Auth digests проверены в RAM.
- `STRICT_MATCH`: mismatch пуст и compact Auth согласован.
  `LIVE_AUTH_TIMESTAMP_ONLY`: единственный strict diff data:auth.users, те же
  cohorts ≤16, только source-newer updated_at, остальные поля совпали.
  Иной diff — LIVE_MISMATCH; неполный/технический отказ — BLOCKED.
  Всегда `finalFreezeAudit=false`, `applyAuthorized=false`.
- Source/target writes=0, freeze/preview/publication=0, Mac data transit=false.
  Соединения закрыты, свой процесс0. Все исходы/claims/изменённые пути отражены.
- Общий бюджет после T37: used=1 / remaining=2, если POST мог начаться;
  при отказе до claim used=0. Не выдавать uncertain outcome за отсутствие чтения.

## Отчёт и независимая owner-ветка

`EXECUTOR_REPORT T37`: BUNDLE; PREPARE; DEPLOYMENT_OBSERVED; BUDGET;
SOURCE_HTTPS; INVENTORY_COMPLETE; STRICT_MATCH; MISMATCH_GROUPS; TABLE/ROW_COUNTS;
AUTH_PLAN (только counts/имена столбцов/направление); WINDOWS; OWNER; CLEANUP;
RESULT/RECEIPT/LOG_SHA; NEXT_BLOCKER.

Canonical `/root/bron-secrets/t37-release-receipt.json`, local mirror
`/tmp/bron-release-executor-20261113/T37-state.json`, log
`/root/bron-secrets/t37-release.log`, mode0600. Include input/output SHA, commands
without secrets, timestamps/exit, guards/budget, all actual actions and paths.
T30: прочитать только безопасный result при его наличии; не читать identity,
не запускать --verify за владельца. Инструкция: `owner-phone-recovery-check.md`.
Maintenance сохраняется независимо от live PASS.
