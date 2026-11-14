# T37: одна полная live-сверка и Auth-план по HTTPS, без записей

**PREPARED / BLOCKED_OWNER_APPROVAL. Это ещё не выданный EXECUTOR_TASK.**
14.11 автоматическая проверка отклонила deployment нового reader: требуется
явное разрешение владельца на точный приватный payload и VPS-получатель.
Функция не развёрнута. До разрешения, deployment/readback/prime координатора
и нового pinned EXECUTOR_TASK T37 ничего из execution checklist не запускать.

Запрашиваемый payload: полные counts/SHA-256 прежних strict audit groups,
sequence state и максимум16 compact Auth records (UUID, updated_at, epoch micros,
SHA-256 остальных полей строки). Точный вход per-user SHA-256 — UTF8 представление
`(to_jsonb(auth.users row) - 'updated_at')::text`: исключается только updated_at,
поэтому digest зависит в том числе от полей с парольными хешами и токенами,
если они присутствуют в строке. Это credential-derived приватное значение,
а не обезличенная/несекретная статистика; данный scope явно включён в запрос
разрешения владельца. Исходные password/token/profile fields не передаются.
Весь ответ AES-GCM encrypted; единственный получатель — RAM VPS152.228.115.115.
Secret остаётся VPS; Mac получает только safe aggregate отчёт. Новый endpoint
закрыт mandatory private256bit capability и absolute expiry05:19:57.052Z.

T36 подтвердил реальный HTTPS→managedDB без Mac: wrong capability403,
wrong DB hostname rejected,512KiB synthetic/actual RR READ ONLY/rollback PASS.
В доступных журналах всех трёх запросов T36 и boot event нет capability/dummy/body
fields. Тестовый endpoint закрыт tombstone v2; его не вызывать повторно.
T37 использует новую закреплённую функцию и существующий VPS-only secret T36.
Нового READY, ввода секрета или продления TTL нет.

## Порядок исполнения

1. До checkout проверить отсутствие своего работающего T36/T37 процесса и взять
   закрытый T36 итог из прежней квитанции. Только чистый fast-forward до commit
   из EXECUTOR_TASK T37; проверить точные bytes/SHA manifest и всех `files`.
   Отправить ACCEPTED и продолжить без ACK.
2. Strict SSH fingerprint, Node22.23.5, manifest `verify_only` и T36 resultSHA.
   Доставить только manifest `deliveries` exclusive-create. Новые directories
   root:root0700, files0600. Не менять установленный T21 auditor a530…,
   node_modules, старые payloads, compose и рабочие сервисы. Никаких installs.
3. Проверить SHA/syntax доставленного helper; runtime module hashes сверяются
   manifest. Источник — только фиксированный HTTPS endpoint из manifest;
   PostgreSQL-клиент источника, TCP-пробы, reverse15432 и fallback запрещены.
4. Ровно один запуск команды из manifest с его SHA последним аргументом.
   Helper проверяет существующие prepared metadata/capability/неизменный expiry,
   root600/privacy/runtime и целевой DB identity/isolation, создаёт immutable
   one-run guard. До истечения должен оставаться полный разрешённый run budget;
   при недостатке времени BLOCKED, без rotation/extension/нового секрета.
5. Один настоящий POST, только raw64ASCII capability в body; TLS verified,
   no redirects, finite wall/size bounds. Root заранее deploy/readback/403-prime
   новой функции проверил. Не повторять запрос при любом отказе.
6. Source Edge в одном RR READ ONLY snapshot вычисляет все прежние strict
   table/schema/sequence groups и exact compact Auth capture до COMMIT той же
   транзакции. SQL, URL и таблицы клиент не передаёт. В HTTP возвращается только
   AES-GCM encrypted envelope; HKDF зависит от secret, не от публичного hash.
   Дешифровать только в RAM VPS. Не записывать/печатать HTTP body, hashes/UUIDs,
   timestamps пользователей, парольные fingerprints или decrypted object.
7. Снять один target snapshot теми же audit/fingerprint функциями и compact Auth
   в той же RR READ ONLY транзакции. Сопоставить все strict groups и Auth-план.
   Реальные данные/backup/даже encrypted envelope не пересылаются на Mac.
8. Не исправлять updated_at. Вывести безопасные counts, mismatch object names,
   имена отличающихся столбцов/направление времени, source/target окна и cleanup.
   Любой неожиданный diff сохраняет блокировку, не исключается из comparator.

## Приёмка

- Все pins/private modes/runtime и T36 prior PASS; канонический T21 auditor unchanged.
- Один source POST/snapshot и один target snapshot; реальные TLS/roles/RO/UTC,
  deadlines, bounds и тот же полный canonical audit, без hash-of-hashes.
- Сравнены все enumerated table/schema/sequence groups. Снимки полные; ни одна
  ошибочная/пропущенная группа не трактуется как пустая.
- Компактные Auth rows взяты из того же snapshot, <=16, UUIDs/digests валидны;
  source/target counts, missing counts, changed counts, other-fields/direction
  проверены. Source newer updated_at не означает уже разрешённый UPDATE.
- `STRICT_MATCH` только при пустом mismatch и согласованном Auth-плане.
  `LIVE_AUTH_TIMESTAMP_ONLY` только при единственном data:auth.users mismatch,
  matching cohorts и source-newer-only timestamp changes. Иные diff — LIVE_MISMATCH,
  технический отказ/неполный снимок — BLOCKED. Это live inventory,
  `finalFreezeAudit=false`, `applyAuthorized=false` при любом результате.
- Клиенты закрыты, соединения/own helper закончены; private result/state/log/receipt
  mode0600. Ошибки только finite code/phase и безопасные progress fields.

## Независимая ветка и отчёт

T30: только existence/root metadata уже ожидаемого owner-result и ранее полученная
личная attestation. Не читать key/identity, не запускать --verify за владельца,
не просить повторный ввод. OWNER_PENDING не задерживает отчёт T37.
T12/T14/T18/T19/T21/T22 PASS переиспользовать; builds/restore/RLS/Telegram/schedule
не повторять. Текущую свежесть backup проверять отдельно перед final window.

Canonical `/root/bron-secrets/t37-release-receipt.json`, local mirror
`/tmp/bron-release-executor-20261113/T37-state.json`, log
`/root/bron-secrets/t37-release.log`, mode0600; mirror совпадает по bytes/SHA.
Квитанция перечисляет все реально выполненные actions/guard/input SHA/output SHA,
времена/exit/status, безопасные counts/windows, changed paths и cleanup.
После отчёта координатор закрывает временный reader и проверяет доступные логи
только агрегированными counts. Не выводить raw logs или секретные HTTP fields.

`EXECUTOR_REPORT T37`: BUNDLE; SOURCE_HTTPS; INVENTORY_COMPLETE; STRICT_MATCH;
MISMATCH_GROUPS; TABLE/ROW_COUNTS; AUTH_PLAN; WINDOWS; OWNER; CLEANUP;
RESULT/RECEIPT/LOG_SHA; NEXT_BLOCKER.

Maintenance остаётся. Source/target DML/DDL/freeze/Pause/preview/publication,
новые secrets/сервисы/покупки, изменения сети/мониторинга запрещены.
