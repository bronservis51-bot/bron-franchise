# T48 — продолжить T45 WITNESS со свежим Root-наблюдением

Source fence уже применён и COMMIT подтверждён. WITNESS v1 ACTIVE, три runtime
файла exact readback, GET403/BRON_SOURCE_FENCE_WITNESS_V1/TLS PASS. Target writes0;
shared budget1/3,remaining2. Владелец явно одобрил WITNESS→DATA→closure/SourcePause.

Ожидание этого одобрения превысило600s свежести старого Root source-fence input.
Старый input09d2… и prepared-context4141… остаются immutable. Их нельзя заменить,
сдвигать clock/mtime или пропускать freshness. T48 добавляет только новое фактическое
Root-наблюдение того же fence, сохраняя прежний drain boundary, contextbody, secret,
expiry и все обычные проверки. Это новая явная continuation-граница, не retry POST.

## 1. Приёмка и доставка

Exact commit/manifest SHA из EXECUTOR_TASK. Fast-forward чистого checkout,
проверить все files SHA и Node syntax. Strict SSH host key прежний. Доставить
только T48 launcher+manifest root:root0600, O_EXCL/no-follow/fsync/readback;
state `/root/bron-secrets/t48-witness-continuation` root:root0700.
Оригинальные T45/T44 файлы, guards и результаты не изменять. T45 verify-witness
ещё не запускался: witness-verify.guard/result/barrier/finalprepared/fenceinput
должны отсутствовать. Прежний prepare-witness не повторять.

## 2. Свежий Root proof — перед единственным запуском

Root заново исполняет **только** закреплённый verifyFencedSql и получает фактический
Source clock. Apply/drain/grants не повторяются. После успешной проверки Root
выдаёт exact canonical bytes+SHA нового input:

```text
/root/bron-secrets/t48-witness-continuation/source-fence-current-approved.json
```

Все поля совпадают с original source-fence-approved.json, кроме нового observedUtc.
Старый boundary не переносится на текущее время: это граница фактического drain.
Source остаётся fenced; target writes ещё0; текущий Root proof должен быть≤600s.
Исполнитель input не генерирует. Создать по Root bytes O_EXCL/root600/fsync/readback.

## 3. Один WITNESS verify через неизменённый T45 core

Один запуск, Node22.23.5:

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t48-witness-continuation.mjs --manifest /root/bron-secrets/t48-witness-continuation/manifest.json --sha256 <T48 manifest SHA> --current-fence-input-sha256 <CURRENT ROOT SHA>
```

Launcher проверяет T48/self и все прежние runtime SHA, реальный T44 proof,
CONTROL_READY/base/budget и original09/4141 byte bindings. Старый context проверяется
как сохранённый artifact, новый Root input — с настоящим Date.now. Допускается
изменить только observedUtc. Новая metadata-копия prepared-context хранится отдельно
в T48; contextbody SHA6c012…/capability920938…/expiry04:14:51.589Z неизменны.

Далее тот же production runWitnessVerification без fixture/clock override:
один GET purpose403 и один capability POST, только technical RR READ ONLY,
TLS negative/identity/fresh physical backend/rollback. Source Auth/business rows
не читаются, snapshot budget не расходуется, target writes запрещены. Capability
value читается только процессом на VPS, в отчёты/Mac не попадает.

T48 собственный guard/lineage честно фиксирует continuation. Для того же логического
T45 окна unchanged core создаёт ранее отсутствующие witness guard/result,
durable source-barrier.json, final-prepared.json и fence-input.json в T45. Это
реальные новые proof artifacts, а не изменение старых snapshot/guard/контекста.
При BLOCKED/UNKNOWN нет автоматического повторения или сброса state.

## 4. После PASS

Сразу передать Root actual status, fresh-input SHA, renewed metadata SHA, original
input/context SHA, HTTPS/counts/physical witness, barrier/finalprepared/fenceinput
SHA и **final fenceContext целиком**. Никаких Auth/business values или capability.
Root проверяет durable binding и разворачивает DATA v2 с actual barrier receipt;
только после Root DATA_READY запускается один прежний T45 run-final с4nonce ACK.
Два Source snapshot slots сохраняются и расходуются до POST. Source closure/Pause
только после strict final PASS. Maintenance до приёмки/live checks.

Canonical `/root/bron-secrets/t48-release-receipt.json`, mirror
`/tmp/bron-release-executor-20261113/T48-state.json`,0600/equal SHA. Свою общую
receipt atomic/fsync; guard/input/results immutable. Root/owner approvals уже
действуют; owner action не требуется. Не повторять crypto/restore/builds/monitoring
или предыдущие diagnostics; нет новых services/dependencies/TTL/budget.
