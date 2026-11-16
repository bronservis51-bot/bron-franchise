# T55 — исправленный decoder, новый automatic relay proof

T54 завершён BLOCKED без повторов: prepare1, actual Source MCP1, complete0,
snapshots0,targetWrites0. В фактическом ответе Source-проверка успешна
15.11.2026 в09:47:43.923МСК. Raw reply Root-private SHA
2a45a63f6cd796e1c49b78eb97782da3e8850b9580ca5dc05ec0f2cffbb88c4c.
Полная readiness T54 не доказана: ошибочный parser считал inline-ссылки на тег
дополнительными boundaries. Исправление проверено именно на этом сохранённом
ответе offline, без Source query; public regression fixture использует synthetic
clock/tag. Допускается только одна настоящая anchored-пара + exact success row.
Это дефект coordinator/decoder, не ошибка исполнения или Source.

T55 сохраняет прежние права/путь/30s/60s/clock и новый task namespace. T54
request/claim/guard/raw/error/client-result и branch не трогать, не продолжать
старое окно и не подставлять его clock. Новая Source API metadata call максимум1;
working-data snapshot budget max3/два оставшихся DATA slots не меняется.

Поддержанный ранее владельцем путь automatic≤30s теперь соединяет **существующие**
parent SSH+GitHub и Cloud Supabase MCP+GitHub. Оба выполняются внутри своих уже
разрешённых sandbox. Native Codex/SQLite/новые права не нужны. Никаких новых PAT,
сервисов, keys, config, proxy или changes approval. GitHub — прежний repository;
отдельная временная control branch, не main и не publisher.

## A. Pins и подготовка без таймера

После завершения T52 worker fast-forward чистого checkout до EXECUTOR_TASK commit;
manifest SHA + каждый file pin. Новая T55 local private directory рядом с прежними
receipts,0700/current uid; T55-state.json0600. Старые T50/T51/T52 evidence не менять,
не копировать helper guards и не читать историю/OAuth/keychain/DB credentials.

Доставить только T55 VPS helper и manifest по deliveries: O_EXCL/no-follow,
root:root0600/nlink1/fsync/SHA readback+AST. Не создавать серверный T55 state dir
заранее. Root создаёт control branch `ops/t55-ack-relay-20261115` на опубликованном
пакете; request/response paths должны отсутствовать. Не изменять workflows/main,
не dispatch мониторинг. Technical commits используют [skip ci].

В private T55 dir сохранить ssh-options.json0600/O_EXCL/fsync:

```json
{"argv":["ssh","-o","StrictHostKeyChecking=yes","root@152.228.115.115"]}
```

Это формат, не команда на замену настроек: использовать **точный прежний рабочий
baseline argv**, включая existing proxy/jump/auth options, заканчивающийся target.
Никаких новых -M/-S/ControlMaster или alternate route. Прежний ED25519 fingerprint
`SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0`. Если options содержат private
control-plane значения, весь argv не выводить/не отправлять в GitHub/чат.

Исполнителю выполнить только preflight клиента:

```sh
python3 -I docs/runbooks/payloads/t55-relay-client.py \
  --manifest docs/runbooks/payloads/t55-relay-readiness.json \
  --sha256 '<T55 manifest SHA>' \
  --ssh-options-json '<private T55 dir>/ssh-options.json' \
  --directory '<private T55 dir>' --preflight
```

Он проверит branch, оба404, strict SSH fixed printf и сохранит private
client-preflight.json. Ни prepare, ни SQL, ни guard proof не создаются.
После фактического T55_CLIENT_READY_NO_PREPARE сообщить pins/state path и counts0.
Пока нет **T55_BROKER_ARMED**, --run не выполнять. Это единственный setup checkpoint
между чатами; после него Root/клиент обмениваются metadata автоматически.

## B. Cloud broker — только существующий Supabase MCP

Root перед стартом сверяет опубликованный manifest/все pins и доступность tools.
Использует /workspace/artifacts/t55-relay0700 (создаётся ровно один раз; не reset).
Trusted orchestration `t55-cloud-broker.js` вызывается через functions.exec:

```text
runT55CloudBroker({tools, notify, yieldControl:yield_control,
  manifestSha256:<actual>, jobDirectory:'/workspace/artifacts/t55-relay'})
```

Не запускать Node CLI вместо tools-оркестратора. File eval только после проверки
SHA; actual fixed SQL загружается из pinned t50-verify-fenced.sql. Broker создаёт
private prepared artifact и сообщает T55_BROKER_ARMED, затем polling GitHub2s;
ожидание≤8min с notify/yield каждые15s. Root не завершает awaited loop до outcome.
Если broker не стартовал/потерян — не начинать VPS nonce.

## C. Один run после BROKER_ARMED — без ручного relay

С теми же pinned inputs исполнитель запускает клиент **один раз**:

```sh
python3 -I docs/runbooks/payloads/t55-relay-client.py \
  --manifest docs/runbooks/payloads/t55-relay-readiness.json \
  --sha256 '<T55 manifest SHA>' \
  --ssh-options-json '<private T55 dir>/ssh-options.json' \
  --directory '<private T55 dir>' --run
```

Путь полностью автоматический:

1. Client O_EXCL guard → VPS helper --prepare один раз → canonical technical
   request+nonceSHA+VPS clock, private local file.
2. Contents API O_EXCL PUT request envelope, без overwrite SHA. Public branch
   содержит **только** format/task/protocol/manifest/request SHA + проверенный
   request: nonce SHA, clock, project/barrier/query hashes. Никаких raw nonce,
   capability, ключей, backup/ciphertext, Auth/business rows или password digests.
3. Cloud broker проверяет request context/SHA/age и fsync claim **до** одного
   настоящего execute_sql через уже подключённый Supabase MCP. Query — полные
   bytes t50-verify-fenced.sql SHA0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15.
   Он читает только технические каталоги и возвращает status/clock.
4. Raw MCP reply/error сохраняется Root-private **до decoding**, не публикуется.
   Strict decoder получает ровно success row и настоящий source_checked_micros.
   Только при success broker публикует canonical T55 response с
   workerId=cloud-supabase-mcp-github-relay. Успех не сочиняется, ошибок/SQL/лога
   или provider secret values в GitHub нет. Approval rejection не обходить.
5. Client polling2s, проверка request/response bindings и clock → response FILE
   stdin baseline strict SSH в helper --complete один раз. VPS проверяет private
   files, Source skew±5s, nonce/deadline и actual wall+monotonic≤30s от создания
   nonce до durable response. Initial prepare handshake precedes timer.

Никаких manual chat ACK, SQL из браузера, native CLI, retry, alternate routes,
расширения60s/30s или fake timestamps. Query broker максимум1; клиент сам Source
не вызывает. Shared ledger/capability/data snapshots не используются.

## D. Результат и продолжение

PASS требует actual helper exit0/statusPASS/codeT55_AUTOMATIC_MCP_RELAY_PROVEN,
sourceVerifyPassed=true, wall+monotonic≤30000, snapshots0/targetWrites0/
T49Startedfalse/macDataTransitfalse; совпадающие request/response SHA и durable
readback. Root broker должен отдельно подтвердить actual MCP call1 + сохранённый
raw artifact SHA. Preflight/файлы/отправленный GitHub response сами не PASS.

Parent проверяет currentRoot-owned600/nlink1 helper result и создаёт canonical
`/root/bron-secrets/t55-release-receipt.json` с top-level taskT55/statusPASS только
при полном успехе; matching local T55-state.json0600/equal SHA. В отчёт actual
helper-result SHA + canonical receipt SHA, real timings, source status/current
fence, phase/counts, input/output SHA и main blocker. Request/response публичные
technical metadata; private SSH options/полный MCP reply в отчёт не включать.

BLOCKED/UNKNOWN: сохранить guards/errors/outcomes без повторов; Source закрыт,
target не трогать, maintenance. Root удерживает точную причину tool rejection;
во время сна владельца не просить новый unlock/consent. Независимые локальные
части финального пакета можно готовить. Остаток: fresh final reconciliation/max1
timestamp update/strict audit → reader closure/Source Pause → actual owner
phone/password/PWA/queue acceptance → public switch/live checks. Последняя
личная приёмка остаётся обязательной; optional tooling/legal/SLA/cleanup отложено.
