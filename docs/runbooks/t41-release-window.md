# T41 release window — DRAFT, NOT ISSUED

Это обзор подготовленного оператора, **не EXECUTOR_TASK и не разрешение запуска**.
T40 technical metadata custody завершён; endpoint закрытv2/readback/HTTPS410,
availablelogs2edge+4function без совпадений cap/private/body. Source остаётся
действующим writer; RF сайты/API maintenance. Auth budgetused1/3.

Для свежего EXECUTOR_TASK нужны фактические T30 crypto PASS, отдельная owner
attestation о независимой копии/втором устройстве и их SHA. Эти факты ещё не
получены. Их нельзя заменить taskboolean, серверным age identity, переданным
через Mac backup или успешным SSH того же Mac. До этого Source effects запрещены.

## Подготовленная последовательность в одном пакете

1. Fresh pinned T41 manifest/files/runtime preflight. T40 result/receipt/beforeimage/
   metadata receipt принимаются по exactSHA, без переписывания исходного контекста.
   Owner proof metadata проверяются FS adapter-ом по реальным сохранённым файлам.
2. `t41-control-ready.mjs --prepare-control`: создать durable independent proof,
   заново проверить T40 custody, записать exact inverse и CONTROL_READY. Это
   локальная подготовка; Source SQL ещё не исполняется. Old action/manifestT40
   сохранены; новая authorization T41 фиксируется отдельно.
3. `t41-final-window.mjs --prepare-final`: до freeze проверить actual target
   container/image/runtime/driver/lock/loopback и один tiny RR READ ONLY identity
   probe с ROLLBACK, без Auth/бизнес-строк. Затем свежий2h capability только VPS;
   immutable baseprepared связан с actual control/proof SHA. No budget reset.
4. Root независимо читает техническое Source metadata в RR READ ONLY, нормализует
   через validateAdmissionMetadata и строит тот же common plan. Все5 SQL SHA должны
   совпасть с actual CONTROL_READY. На фактическом Source заранее проверены RRRO
   MCP transaction, expected3 CONNECTgrantees, lookupcapabilities0/background0.
   Это preflight, не proof будущего fence; перед эффектом state rechecks обязательны.
5. Только после key/control/hash/backupfreshness/target gates Root применяет
   reviewed applySql/drainSql/verifyFencedSql через MCP. Общий advisory lock,
   exactoriginal/fenced ACL, роль lookup и provider SUPER boundary сохраняются.
   Записывается actual afterDrainBoundary (Sourceclock+ownerPIDs). До этого inverse
   должен быть durableVPS. Source Pause на этом этапе запрещена.
6. Root выдаёт SHA-bound source-fence-approved.json. `t41-bind-fence --prepare-witness`
   проверяет control/key/custody, составляет minimal PID/time context; private
   state/ACL/roles не выходят с VPS. Root deploy v1 WITNESS на свежемcap, exact
   executable readback и GET403 protocolcheck (type-only declarations не runtime).
7. `--verify-witness`: один secretless GET403 exact WITNESS-purpose до одного
   authenticated metadata POST, без Auth budget. Wrong/DATA purpose — stop доPOST.
   Fresh physical PID/start после drain, identity/RRRO/TLS/rollback проверяются;
   только затем durable source-barrier.json, final-prepared и fence-input.
8. Root проверяет binding SHA и durable WITNESS report, затем deploy v2 DATA с
   actual barrier receiptSHA в finalcontext. Порядок строгий: WITNESS → durable
   witness report → DATA; v2 никогда не разворачивать раньше. Root явно подтверждает
   fence-inputSHA. No sharedcap extension/rotation или skip witness.
9. `--run-final` один раз, wall≤480s. Core получает актуальные Root MCP ACK для
   start/before-target-write/before-final-audit/end. Каждый unique challenge≤60s,
   допустим clockskew±5s; Root реально выполняет тот же verifyFencedSql и получает
   Sourceclock для nonce. Executor передаёт exact canonicalACK+SHA на VPS, не
   генерирует ACK сам; новый taskID между этапами не нужен. Root приоритизирует ACK.
10. Два Source Data POST расходуют fixed ledger slots2/3 **до** запроса. Каждый —
    same RR fullstrictsnapshot+≤16Auth, encrypted→VPSRAM. Только source-newer
    updated_at-only difference может пройти guardedserializableUPDATE с exact
    durable beforeimage и guardedrowcount1. No other-field/business/schema/sequence
    diff is ignored. Final Source unchanged +fullTargetstrict match обязательны.
11. COMMIT UNKNOWN/timeout/lostACK держит Source закрытым; no autoretry/inverse/
    reopen. При nonAuthdelta narrowpath останавливается, не расширяет data grant.
    Reopen после target writes не заменяется DNS reversal; требуется reconciliation.
12. После actual final PASS Root закрывает DATA endpointv3/readback/GET410,
    проверяет availablelogs и только затем Source Pause+providerstatus readback.
    Source после Pause не читается. Два finalAuthattempts исчерпаны честно.

## Preview, приёмка и публикация — gates не сокращаются

После finalPASS+SourcePause+freshbackup только web получает IP-gated preview:
existing5file Compose chain + compose.preview.override.yml LAST; Caddy2.11.8
cached validation; `up -d --no-deps --pull never web`. Перед/после сравнить6backend
containerIDs/Compose service models в RAMVPS, не выводя env; DB остаётсяloopback,
networkinternal=true. Проверить67staticfiles по ранее принятым manifests T39,
не собирать/копировать пакеты заново. Public visitor должен получать503.

Preview IP остаётся закрытой VPS config; телефон владельца должен находиться в
разрешённой сети. По SSHpeer нельзя молча объявить phoneaccessPASS: actualphone
TLS/HTTP проверяется владельцем. Подготовленный allowlist не должен быть пустым.
Владелец проверяет свой пароль через UI, реальный телефон/старую PWA, drafts/queue,
сохранение старого ввода и основные роли/разделы. Fakelead/finance/seed запрещены;
реальные записи только по фактическому намерению пользователя. Новая Authсессия
после finalaudit — ожидаемая targetзапись, её нельзя сбрасывать старым beforeimage.

Public switch только после этой приёмки. Последний override production применяется
только к web, backend/container/network модель сохраняется. Pair targetpublic
VITE_SUPABASE_URL/key перед одним PR12/Pages transition; exacthead+CI+diffreview
не заменяются historicalPRbaseSHA. APP_URL→RF после opening; мониторинг остаётся
true. Oldlanding во второмрепозитории требует отдельной legacyPages публикации;
один app workflow его не публикует. Verifyactualnew/oldURLs/config/APIdelivery,
PWAqueue/originbridge и отсутствиеsourcewrites. Retainrollbackpackages/receipts.

После verifiedpublicrelease закрыть только идентифицированные migration-only
MacSourceTunnel/launchd/caffeinate jobs по их exactreceipt/process identity;
не killall и не останавливать рабочий stack. Targetbackup/watchdog/Telegram и
аварийный доступ должны работать при выключенном Mac. Произвольный cleanup
backup/ageidentity/beforeimages не разрешён.

## Что уже проверено offline

Control phase12tests; bindphase17tests +independentreview; finalrunner13tests;
finalcore13/transport13/ACK15 tests +reviews; SourceWitness20 +Deno check;
Sourcefinal predataWitness15 +Deno check. NativePG17.12/Node22.23.5/pg8.23.1
finalcore повторно прошёл50actual context checks на двух isolatedtmpfs fixtures,
оба контейнера удалены. Nativeproof включает µs/largeprecision, sameRR capture,
guardedUPDATE/ROLLBACK, lostCOMMIT, source/role/db drift. Он **не** доказывает actual
production rootcustody/Sourcefence/HTTPS-route/phoneacceptance — это servergates.
