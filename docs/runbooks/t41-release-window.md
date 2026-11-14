# T41 — owner recovery, fence и финальная HTTPS-сверка

Авторитетный checklist для нового EXECUTOR_TASK T41. Сам файл без опубликованного
commit и SHA `payloads/t41-release-window.json` не разрешает исполнение.
RF сайт/API остаются в maintenance; source до фактического fence — единственный writer.
Подтверждены T12 Auth/RLS, T14 сборки, T18 backup/status, T19 Telegram, T21 restore,
T22 schedule, T37 live inventory и T39 inert staging. Их не повторять.
T37: только1 source-newer Auth updated_at; это не финальная сверка. Бюджет1/3,
две попытки сохранены для final; failed/uncertain POST также расходует слот.

## A. Scope и принятие

- Использовать только commit и manifest SHA из нового EXECUTOR_TASK. Fast-forward
  чистого checkout; не stash/reset/clean и не менять checkout работающего процесса.
  Сверить все `files` SHA до отправки на VPS. ACCEPTED содержит commit/manifest SHA,
  local state path и canonical VPS receipt path.
- Разрешены локальные проверки SHA/синтаксиса. **Все серверные фазы, включая
  --check, ждут фактического PHONE_ROOT_READY**: владелец лично открыл root-консоль
  с телефона. Fresh task и approval не заменяют этот факт. Если root-консоль
  недоступна, state=BLOCKED_OWNER_CONSOLE; сохранять maintenance, не менять сеть,
  аккаунты/пароли/сервер и не использовать T30/DMG/reverse15432.
- Точное исключение записано в `t41-owner-recovery-approval.md`; одобренное предложение
  immutable. Ввод новой фразы — только владельцем через скрытый физический TTY
  телефона. Executor не открывает identity, credentials, ciphertext или backup;
  это делает только утверждённый server helper в разрешённой фазе.
- В T41 нет preview, Pages merge, public switch, нового сервиса или изменений
  мониторинга. После final PASS требуется отдельная приёмка/публикация. Source
  SQL/fence выполняет только координатор через connected MCP; executor SQL
  не исполняет. После любого BLOCKED не чинить код, не повторять guard и не
  расширять scope; независимые безопасные части только если прямо перечислены.

## B. Один preflight и доставка после PHONE_ROOT_READY

1. Strict SSH host key: manifest.vps. Без сканирования/accept-new подмен.
2. Один preflight: exact Node22.23.5, runtime/dependency lock/installed auditor SHA
   из manifest; существующие loopback15433/healthy target container+image; нет
   собственного активного T41 процесса/guard/result. Не читать rendered env или
   Auth/business rows. Старые T37/T40 receipts/result/beforeimage/metadata проверяются
   только по pinned SHA, без печати содержимого и без переписывания.
3. Доставить только `deliveries`: code, manifest и короткий owner launcher.
   Новый runtime/state — root:root0700; файлы root:root0600, regular/nlink1,
   no symlinks, O_EXCL, file+directory fsync/readback SHA. Не перезаписывать.
   Один и тот же parent manifest byte-for-byte идёт в оба manifest path.
   Удобный launcher получает marker `approved-manifest.sha256`: exact64lowerhex+LF
   SHA из EXECUTOR_TASK, root600/exclusive/fsynced; marker не включается в hash
   самого manifest. Его содержимое публичное, не secret.
4. Сверить удалённые SHA с manifest; AST/syntax only, без запуска secret helper
   по SSH. Повторный код/архивный backup не нужен. Установленный T21 auditor
   не заменяется; private T41 audit clone — отдельный pinned runtime.
5. Один HTTPS maintenance/status check: все3доменa TLS verify/HTTP503;
   health JSON healthy=true, checked_at≤25min и last_backup_utc≤70min.
   Сохранить только safe status/ages. Если stale/BLOCKED, не делать fence;
   диагностировать actual failure вместо переустановки T18.

## C. Личный owner recovery — прежде любых Source effects

Передать владельцу `t41-owner-phone-handoff.md` после доставки/сверки кода.
Он лично выполняет короткий launcher check → recover → attest. Executor команды
не запускает и не вводит фразу. Raw identity остаётся на VPS. Helper делает один
unique conditional PUT и bounded GET scrypt ciphertext напрямую в existing S3;
проверяет **скачанный** cipher на exact T12 roles backup, без original identity
при verify. Ни raw key, ни фраза, ни backup на Mac/телефон не скачиваются.

Acceptance этой фазы: actual result status=PASS/method=BRON_OWNER_KEY_ESCROW_V1,
parent manifest SHA точный, conditionalPut=true/putAttempts=1/getAttempts=1,
downloadedCipherShaVerified=true, backupProbe.decryptionVerified+zstdVerified=true,
originalIdentityReadForVerification=false/plaintextRecoveredIdentityStored=false;
затем отдельная result-SHA-bound owner attestation CONFIRMED о независимой фразе,
AdminVPS/root и Timeweb phone access. Failure/uncertain attempt не повторять.
T30 PASS не создаётся. Передать координатору только safe result/attestation и SHA;
не ciphertext и не key. Guard/put-intent/download-proof/result остаются на VPS.

Координатор проверяет actual evidence и выдаёт exact bytes+SHA для
`/root/bron-secrets/t41-release/owner-proof-approved.json`. Туда входят parent,
result, attestation, whole backup manifest и actual roles cipher SHA,
escrow cipher SHA и canonical independent-proof SHA. Будущие SHA не подставляются
в parent manifest. Executor сохраняет полученные bytes O_EXCL/root600/fsync,
проверяет SHA и продолжает **тот же T41**, без нового task ID. Самостоятельно
конструировать Root approval или заменять proof taskboolean запрещено.

## D. Подготовленная последовательность в том же пакете

Во всех CLI parent SHA берётся из EXECUTOR_TASK, owner-input SHA — из actual Root
сообщения после C. Фиксированный Node и runtime paths заданы manifest.commands.
Команды исполняются с закрытым stdout/log на VPS; в чат только safe fields.

1. Fresh pinned T41 manifest/files/runtime preflight. T40 result/receipt/beforeimage/
   metadata receipt принимаются по exactSHA, без переписывания исходного контекста.
   Owner escrow proof metadata проверяются FS adapter-ом по реальным сохранённым файлам; --owner-proof-input-sha256 обязателен для control/bind/final.
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

## E. После T41: приёмка и публикация — пока не разрешены этим пакетом

Следующий отдельный operational пакет после finalPASS+SourcePause+freshbackup разрешит только web IP-gated preview:
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

## F. Квитанция и handoff

Canonical safe receipt: `/root/bron-secrets/t41-release-receipt.json`, mirror
`/tmp/bron-release-executor-20261113/T41-state.json`; оба0600, SHA одинаковый.
Обновления state разрешены atomic replace/fsync только своей квитанции; phase
proof/guard/result/input — immutable O_EXCL. Не менять state работающего T40/T37.
В квитанции каждая фактически выполненная action, start/end UTC, входные SHA,
exit/status, one-run consumption и пути. Исполнитель после каждого PASS продолжает
разрешённый checklist; ждёт только конкретного owner/Root checkpoint, без нового ID.

Final report: BUNDLE, PHONE_CONSOLE, OWNER_CRYPTO, OWNER_ATTESTATION,
OWNER_APPROVED_INPUT_SHA, CONTROL_READY, FINAL_READY, SOURCE_FENCE,
WITNESS, FINAL_AUDIT, TARGET_WRITE_OUTCOME, AUTH_BUDGET_BEFORE_AFTER,
ENDPOINT_CLOSURE, SOURCE_PAUSE, MAINTENANCE, CLEANUP, CHANGED_PATHS,
RECEIPT_SHA, NEXT_BLOCKER. UNKNOWN не превращать в FAIL_NO_WRITE; записать факт
COMMIT outcome. Не объявлять release-ready: owner acceptance/publication открыты.
В процессе --run-final немедленно передавать 4 ACK challenges координатору;
не откладывать до финального отчёта. Challenge≤60s; auth POST не повторять.

## G. Что уже проверено offline

Control phase12tests; bindphase19tests +independentreview; finalrunner13tests;
finalcore13/transport13/ACK15 tests +reviews; SourceWitness20 +Deno check;
Sourcefinal predataWitness15 +Deno check. NativePG17.12/Node22.23.5/pg8.23.1
finalcore повторно прошёл50actual context checks на двух isolatedtmpfs fixtures,
оба контейнера удалены. Nativeproof включает µs/largeprecision, sameRR capture,
guardedUPDATE/ROLLBACK, lostCOMMIT, source/role/db drift. Он **не** доказывает actual
production rootcustody/Sourcefence/HTTPS-route/phoneacceptance — это servergates.

Новый ESCROW flow:49 Python tests (crypto14, workflow21, launcher14) PASS;
Node22 suites суммарно153 (включая resolver15, FS18 и bind19). Typecheck PASS.
Native age1.1.1 подтверждён на synthetic key после удаления raw identity;
реальные S3/owner phone/key ещё не проверены. При ревью исправлена возможность
загрузки старого .pyc: компилируются именно SHA-проверенные source bytes.
