# T45 — финальное окно после настоящего T44 key proof

Этот checklist действует только вместе с commit и SHA manifest из нового
EXECUTOR_TASK T45. Пакет разрешает локальную приёмку сразу, а серверные фазы —
только после actual T44 crypto PASS, отдельной CONFIRMED attestation и Root approval.
T44 PREPARED этого не заменяет. Recovery остаётся отдельной уже выданной T44:
новой попытки, check, ввода фразы или изменения старых guard этот пакет не разрешает.

Сайт/API остаются в maintenance. Подтверждённые T12/T14/T18/T19/T21/T22/T37/T39/
T40/T43 переиспользуются; свежесть копии и финальная дельта проверяются отдельно.
Последовательность: key proof → freeze/дельта/strict audit → закрытая приёмка →
один public switch/live checks. Два последних этапа этим пакетом не разрешены.

## A. Приёмка и ожидание фактического proof

1. Чистый checkout fast-forward до exact commit из EXECUTOR_TASK; проверить SHA
   `payloads/t45-release-window.json` и все `files`. Не reset/stash/clean и не
   менять checkout работающего процесса. Обычный fetch; при реальном failure
   сообщить точную ошибку, не начинать новые сетевые эксперименты.
2. ACCEPTED: commit, manifest SHA, local state и canonical VPS receipt paths.
   Локальные syntax/SHA проверки разрешены. До T44 PASS + attestation:
   `WAITING_T44_ACTUAL_PROOF`, без SSH/helper/Source/S3 действий T45. Не присылать
   повторные waiting-сообщения; сообщать только новое событие, вопрос или failure.
3. После фактических T44 PASS и CONFIRMED передать Root только безопасные result/
   attestation metadata и их SHA. Key, phrase, identity ciphertext и backup на Mac
   не читать/копировать. Root проверяет semantics и выдаёт exact approval bytes+SHA
   для `/root/bron-secrets/t45-release/owner-proof-approved.json`. Все поля заданы
   `t45-owner-proof.mjs`; approval имеет task T45/recoveryTask T44 и actual hashes.
   Исполнитель approval не сочиняет. Полная положительная byte-custody проверка
   настоящих исторических файлов выполняется на VPS, не подменяется fixtures.

## B. Один preflight и доставка

После A3 один strict SSH preflight по manifest.vps: exact host fingerprint,
Node22.23.5, pg8.23.1/lock/installed auditor/target backup manifest SHA,
healthy exact target container/image, только loopback15433, нет своего T45
процесса/guard/result. T40 capture/result/receipt/beforeimage/metadata SHA сверить
с `input_evidence`. Не печатать env, rendered config, Auth или business rows.
Исходные T41 failure guard/result и T44 proof проверять по pins, не менять.

Создать только новые T45 runtime/release directories root:root0700. Доставить
только manifest.deliveries: файлы root:root0600, regular/nlink1, O_EXCL/no-follow,
file+directory fsync и readback SHA. Отдельные T40 inverse/control/key-proof ещё
должны отсутствовать; их создаёт reviewed control helper. Не доставлять recovery
Python/marker и не заменять установленный T21 auditor. T41/T44 runtime неизменны.
Проверить все runtime SHA, Node syntax и relative import closure без запуска main.
Root approval сохранить O_EXCL/root600/fsync/readback по фактическому Root SHA.

Одна свежая HTTPS проверка: bronservis.ru, app.bronservis.ru, api.bronservis.ru —
TLS verified/HTTP503. Existing health JSON healthy=true, checked_at≤25min,
last_backup_utc≤70min. При stale/failure нет fence; чинить только фактический сбой
через отдельную разрешённую границу, не переустанавливать T18.

## C. CONTROL_READY и FINAL_READY

Использовать exact argv из manifest.commands, заменяя только обозначенные SHA
значениями из EXECUTOR_TASK и actual Root inputs. Логи private на VPS; capability
в Root/чат/Mac не передаётся. По SSH допускаются только operational metadata.

1. Один `prepare_control`: настоящий T44 byte proof/Root approval → durable
   independent proof → adoption исходного T40 context → exact inverse и control
   receipt. T40 action/manifest не переименовываются T45; summary имеет task T45
   и ownerRecoveryTask=T44. При BLOCKED остановить dependent ветку, без retry.
2. Передать Root safe CONTROL_READY summary/пять SQL SHA/receipt hashes. Root
   должен быть готов обслуживать все четыре nonce challenges до следующей фазы.
3. Один `prepare_final`: pinned target identity в tiny RR READ ONLY + ROLLBACK,
   без Auth/business rows; новый VPS-only capability TTL2h и immutable baseprepared.
   Ledger обязан оставаться T37.live VALID, used1/3, remaining2. Новая capability
   не сбрасывает бюджет. Это ещё не final audit и не Source freeze.

## D. Координаторский fence и WITNESS → DATA

Source SQL исполняет только Root через connected MCP. Executor SQL не выполняет.
Root независимо получает свежие technical metadata RR READ ONLY и строит тот же
plan; пять SQL SHA должны совпасть с CONTROL_READY. До effects durable inverse и
key/control/backup freshness обязательны. Root применяет reviewed apply/drain/
verifyFenced SQL под прежним advisory lock, exact ACL и provider SUPER boundary.
Фиксирует actual Source clock/owner PID boundary. Pause пока запрещена.

Root выдаёт exact canonical source-fence-approved.json + SHA. Executor сохраняет
новый файл O_EXCL, выполняет один `prepare_witness`. Root разворачивает WITNESS v1
по VPS prepared capability SHA/expiry и exact source hashes/readback. Один GET403
проверяет purpose перед одним metadata POST; `verify_witness` проверяет fresh
backend/PID/start после drain, TLS/RRRO/identity/rollback и записывает durable
barrier/finalprepared/fence-input. Witness не расходует Auth snapshot budget.
Wrong purpose/BLOCKED — STOP до DATA. Root принимает actual witness evidence,
только затем разворачивает DATA v2 с actual barrier receipt SHA и явно подтверждает
fence-input SHA. Нельзя поменять порядок, продлить/подменить capability или skip witness.

## E. Одно финальное окно

После явного Root DATA_READY/fence-input approval один `run_final`, wall≤480s.
Исполнитель немедленно передаёт каждый `COORDINATOR_FENCE_CHALLENGE` Root:
start, before-target-write, before-final-audit, end. Root приоритетно выполняет
тот же verifyFencedSql на Source для данного nonce, получает Source clock и
выдаёт exact canonical ACK+SHA. Executor пишет envelope O_EXCL в exact ackPath
из challenge. Самостоятельные ACK/синтетический clock запрещены. Challenge≤60s,
clock skew±5s; существующие freshness/nonce/stage bindings не ослабляются.

Два DATA POST занимают slots2/3 ДО запроса; failed/uncertain тоже расходуются.
Каждый — одна RR READ ONLY полная strict snapshot плюс ≤16 approved Auth metadata,
шифрованная напрямую Source→VPS RAM. UUID/updated_at/другие-field digests не
печатаются. Mac data transit=false. Разрешён только уже подготовленный случай:
source-newer updated_at-only, guarded serializable UPDATE максимум1 и durable
µs before-image. Другие Auth/business/schema/sequence различия не игнорируются:
узкий путь BLOCKED, Root планирует необходимую законную дельту отдельным scope.
Это не разрешение generic data export/import и не обещание, что иной дельты нет.

PASS требует Source unchanged, full Target strict match, все Root ACK и известный
COMMIT outcome. При COMMIT UNKNOWN/timeout/lost ACK Source держать закрытым:
нет retry, inverse/reopen или объявления FAIL_NO_WRITE. Сохранять честный outcome
даже если позднее не записалась квитанция. После target writes DNS reversal не
является откатом: нужна reconciliation, а не два независимых writer.

После actual PASS Root tombstone DATA v3/readback/GET410 и проверяет available
logs. Только затем Root Source Pause + provider status readback. После Pause
Source не читать. В том же T45 сообщить closure/pause; новый task ID не нужен.

## F. Квитанции, stop и следующий этап

Canonical `/root/bron-secrets/t45-release-receipt.json`; mirror
`/tmp/bron-release-executor-20261113/T45-state.json`;0600/equal SHA. Свою общую
receipt можно atomic replace/fsync; guards/proofs/inputs/results immutable O_EXCL.
Записывать actual actions/UTC/input SHA/counts/exit/outcome/paths. Старые receipts
не редактировать. Cleanup только собственных helpers/connections; не killall,
не удалять guards/backup/keys и не трогать рабочие backend containers.

На PASS автоматически продолжать разрешённые шаги без нового task ID; ждать
только actual T44 proof, exact Root approval/deployment/ACK. BLOCKED не разрешает
ремонт/повтор. При ожидании owner можно завершить локальную metadata-подготовку;
никакой обязательной серверной фазы до A3 нет. Исполнитель остаётся активен.

Final schema: BUNDLE, T44_CRYPTO, T44_ATTESTATION, OWNER_APPROVED_INPUT_SHA,
CONTROL_READY, FINAL_READY, SOURCE_FENCE, WITNESS, FINAL_AUDIT,
TARGET_WRITE_OUTCOME, AUTH_BUDGET_BEFORE_AFTER, ENDPOINT_CLOSURE, SOURCE_PAUSE,
MAINTENANCE, CLEANUP, CHANGED_PATHS, RECEIPT_SHA, NEXT_BLOCKER.

После T45 только отдельный пакет: web-only IP-gated preview и старые Pages
transition static, парольный UI/реальный phone/PWA/drafts/queue/form acceptance;
потом один public switch/live intake/write/monitor routing/rollback readiness.
Никаких seed/fake leads/финансовых записей. Уже собранные/staged packages reuse.
GitHub visibility, legal docs (owner deferred), SLA, МойСклад, product enhancements
и optional cleanup/hardening остаются после запуска. Не добавлять сервисы,
monitoring/dispatch и owner шаги без обязательного gate.
