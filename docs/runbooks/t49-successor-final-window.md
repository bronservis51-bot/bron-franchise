# T49 — одно новое окно после доказанного late-delivery T45

Это не повтор T45. Старые final-run.guard/result/request/ACK остаются неизменными.
T45 завершился до Source frames/target writes. Его result SHA:
`7987d55b1323c1b4a64aeeac7e8b7050f500f9fc6cf778d973c1b9d0e3cd9aca`.
ACK был canonical/bound/SHA-correct, но записан expiry+94116ms. Новый guard/action/
before-image/ACK directory принадлежат T49; только один successor window разрешён.

## A. Безопасные prerequisites

1. Старый процесс завершён; только после этого fast-forward до task commit.
   Проверить T49 manifest SHA и все files. Доставить только deliveries root:root600
   regular/nlink1/O_EXCL/no-follow/fsync/readback; новый `/root/bron-secrets/t49-release`
   root700. T45 runtime22/manifest/proofs/guards не менять. AST/syntax, без broad tests.
2. Использовать handoff `release-worker-handoff-20261115.md`. Worker обязан иметь
   **SSH и авторизованный Supabase MCP в одном агенте** либо доказанный быстрый
   автоматический канал. Ручной relay между чатами непригоден. Нет MCP — STOP
   до окна; не использовать browser SQL/psql/Edge write bypass и не фабриковать ACK.
3. Read-only actual ledger: used1,max3,remaining2,uncertainfalse,T37.live VALID.
   Old result exact pinned SHA + UNCHANGED + recovery.sourceFrameAttempts0;
   old before-image отсутствует. Иначе STOP, Source закрыт; committed/unknown не скрывать.
4. DATA `bron-source-reader-920938e06472` v2 exact published code, existing cap/expiry
   unchanged. Current backup/status bounds valid (check≤25m,backup≤70m,healthytrue).
   До guard должно оставаться **>620s** до 07:14:51.589МСК: старт раньше07:04:31.
   При expiry/headroom failure STOP, не продлевать capability/не сбрасывать ledger.

## B. Одна readiness проба и настоящее MCP proof

После доставки/всего setup, непосредственно перед запуском, создать отдельный
`readiness.request.json` с fresh random nonce SHA и createdEpochMs, используя часы
VPS. Не использовать `fence-check-start.*`: это настоящие stage-файлы будущего окна.

Тот же быстрый worker выполняет на Source через Supabase MCP:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL statement_timeout='30000';
SET LOCAL lock_timeout='5000';
-- exact bytes payloads/worker-t45-verify-fenced.sql; SHA fe7da819...e6782
SELECT 'SOURCE_FENCE_CURRENTLY_VERIFIED' AS status,
 floor(extract(epoch FROM clock_timestamp())*1000000)::numeric::text AS source_checked_micros;
COMMIT;
```

SQL-файл вставить целиком вместо комментария; никогда не сокращать assertions.
Query result должен реально подтвердить status и clock. Мерить весь путь от
readiness request на VPS до ответа/записи на VPS, **≤30000ms**. При непрохождении
пробы новое окно не запускать. Эта technical read-only проба не расходует snapshot.

Создать `/root/bron-secrets/t49-release/coordinator-ready.json` O_EXCL/root600/fsync
и вычислить SHA точных bytes. Ровно поля:

```text
format=1; task=T49; actionId=T49.coordinator_ready; status=COORDINATOR_READY;
manifestSha256=<T49 manifest SHA>; sourceProject=vkkqffvmztpzgygzfxhq;
sourceBarrierActionId=T40.http_source_admission;
sourceBarrierReceiptSha256=0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6;
verifyFencedSqlSha256=fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782;
connector=Supabase MCP; workerId=<actual worker identity>;
mcpWorkerReady=true; sourceVerifyPassed=true; nonceSha256=<actual trial nonce SHA>;
createdEpochMs=<actual VPS trial start>; completedEpochMs=<actual response delivery>;
roundTripMs=completed-created (0..30000);
sourceCheckedMicros=<actual MCP Source clock>;
observedUtc=ISO UTC of completedEpochMs.
```

Проверка Source clock допускает ±5s. READY может быть не старше30s при запуске.
Это attestation настоящей операции, не разрешение поставить выдуманные true/clock.

## C. Один successor run

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t49-final-window.mjs --manifest /root/bron-secrets/t49-release/manifest.json --sha256 <T49 manifest SHA> --ready-input-sha256 <actual READY SHA>
```

Запустить nonblocking SSH session, немедленно читать safe stdout. Для каждого
COORDINATOR_FENCE_CHALLENGE (`start`,`before-target-write`,`before-final-audit`,`end`)
тот же worker СРАЗУ делает приведённый MCP verify+clock и пишет ACK непосредственно
на VPS, без копирования человеком между чатами. Canonical ACK protocol — handoff §6.
Все bindings из данного challenge; SHA exact sorted JSON+LF; O_EXCL/root600/fsync.
60s deadline и Source clock ±5s неизменны. При отказе сохранить exact safe code
`fence-failure-<stage>.json`; не повторять или менять часы/TTL.

Core/transport остаются прежними; task/manifest/before-image явно projected в T49,
новый before-image `/root/bron-secrets/t49-auth-before-c49a2026.json`.
Два POST занимают slots2/3 до отправки. Failed/unknown тоже расходуются. Только
source-newer updated_at-only UPDATE max1; иной diff — STOP без generic data import.
PASS: finalFreezeAudit=true, strictMismatchGroups=[], sourceUnchangedUnderFence=true,
targetRolesAndDatabaseUnchanged=true, известный targetWriteOutcome, ledger3/3.
COMMIT_UNKNOWN/любой BLOCKED — Source закрыт, no retry/inverse/reopen/reset.

## D. Автономное продолжение

После actual PASS worker-coordinator через MCP закрывает reader pinned tombstone,
проверяет code/readback/HTTPS410 и доступные metadata log counts; затем Source
Pause и provider-status readback. После Pause Source DB/REST не читать.
Это уже одобрено владельцем; approval сильной модели не требуется.

Далее по handoff по одной задаче: WB03 private web-only preview + legacy transition
→ одна личная essential-приёмка владельца → WB04 public switch/live checks.
Сильный дополнительный review после13:00МСК отложен; actual acceptance не отложена.
Новых секретов/сервисов/зависимостей/опциональных задач нет. Maintenance сохраняется
до successful private live checks и actual owner acceptance.

Canonical T49 `/root/bron-secrets/t49-release-receipt.json`, mirror
`/tmp/bron-release-executor-20261113/T49-state.json`,0600/equal SHA. Каждое действие/
count/UTC/inputSHA/outcome записывать; old T45 history immutable. Отчёты — facts,
current blocker/nextstep без процентов. Не ждать ответа этого чата после PASS.
