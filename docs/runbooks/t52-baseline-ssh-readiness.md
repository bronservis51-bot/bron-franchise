# T52 — readiness через уже рабочий обычный strict SSH

Релиз: maintenance, target writes0. Restore/Auth/RLS/artifacts/backup/monitoring
подтверждены; свежий fence/readiness пока UNVERIFIED. T51 завершён до prepare:
prepare0/MCP0/complete0; helper/manifest доставлены, но их timer больше не запускать.
Обычный SSH child прошёл с T51_SSH_READY; создание ControlMaster завершилось255.
Parent master тоже раньше работал, затем истёк его180s idle. Это не отказ VPS.

**Исправление пакета:** создание ControlMaster было необязательной оптимизацией,
ошибочно превращённой в gate. T52 использует ровно успешный baseline strict SSH
того же native worker. Лимиты, ACL/fence checks, actual clock, capture-before-decode,
snapshot budget и acceptance не ослабляются. Прежняя метрика≤30s — от создания
nonce на VPS до durable response там же; начальная SSH handshake precedes timer,
MCP/обработка и SSH handshake complete входят в него.
Дополнительная диагностика master/новые sockets/инфраструктура не нужны.

## A. Принять свежий пакет

После выхода T51 worker fast-forward чистого checkout до commit из EXECUTOR_TASK.
Проверить SHA manifest и каждого файла. Новая local state:
`/tmp/bron-release-executor-20261113/T52-state.json`, private directory `T52` рядом.
Точный canonical parent может быть `/private/tmp/...`; наследовать прежний
approved --add-dir именно этого parent, обычные --approve-for-me/workspace-write/
network permissions. Сохранить OAuth/CLI config, SSH proxy/jump/identity/host-key
и approval policy. Никакого нового OAuth, PAT, установки или обходных flags.

T50/T51 state/guards/helper/manifest не менять, не объявлять PASS и не повторять.
Не продолжать поиск личной истории: T50 recovery уже NOT_RECOVERED. Все старые
закрытые тесты/доставки/gates не повторять. Новые T52 helper/builder/collector —
namespace copies закреплённых T51, с прежними security/freshness predicates.
Offline fixture проверяет их совместную работу; это не production proof.

## B. Только необходимые prerequisites — до таймера

1. Native worker должен иметь реальный callable execute_sql для прежнего Source
   vkkqffvmztpzgygzfxhq и query schema. Настройка/consent уже готовы — не login.
2. Использовать **точный baseline strict SSH invocation**, который у child дал
   T51_SSH_READY. Не добавлять временные -M/-S/ControlPersist из T51. Если baseline
   сам использует ранее настроенные proxy/jump/auth, сохранить их. Не менять
   settings ради обхода review/seatbelt. Host root@152.228.115.115, прежний
   ED25519 `SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0`.
3. Один безвредный child SSH `printf T52_SSH_READY` и private local file probe:
   O_EXCL0600/fsync/readback, удалить только свой probe, existing receipts не трогать.
   Если падает — STOP до prepare/SQL, только safe exit/code/elapsed. Не создавать
   child или parent ControlMaster и не делать alternate-route retry.
4. Доставить лишь новые T52 helper+manifest по deliveries: root:root0600/nlink1,
   O_EXCL/no-follow/fsync/readback SHA и AST. Новую server state directory заранее
   не создавать. Старые T50/T51 server artifacts не читать заново/не сбрасывать.

## C. Один тёплый native worker и capture

Parent создаёт private T52 state с actual accepted commit/manifest SHA/path;
использует pinned `payloads/t52-worker-prompt.txt` без новых инструкций на запись.
Запуск с уже проверенными normal flags; до --prepare готовятся все файлы/команды:

```text
codex exec <existing approved workspace/network/receipt flags> --json - < private-prompt
    | python3 -I docs/runbooks/payloads/t52-recover-mcp.py
        --json-stream --output <private T52 dir>/fresh-recorded-result.json
```

Worker обязан лично иметь MCP и baseline SSH; parent доступ его не заменяет.
Collector сохраняет только один exact server/tool/query result, O_EXCL0600/fsync,
публикует ready-marker после readback и **drain до EOF**. Full events не писать
на диск/в чат. Query mismatch получает actual SHA без сохранения неподтверждённых
данных. Ошибка/ambiguity не превращается в success. Direct SSH не требует master.

## D. Единственная живая проба

Через тот же baseline strict SSH, stdout первого вызова и stdin второго — файлы/
subprocess bytes; не смешивать Python heredoc и JSON:

```sh
python3 -I /root/bron-secrets/t52-mcp-ready.py --prepare
```

Сохранить точные request bytes+LF O_EXCL0600 локально. Немедленно выполнить **один**
native MCP execute_sql с точными bytes `payloads/t50-verify-fenced.sql`, SHA
`0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15`.
Это прежняя полная техническая fence transaction; не Auth/business rows.
Collector автоматически сохраняет actual recorded reply и .ready.json.

```sh
python3 -I docs/runbooks/payloads/t52-mcp-response.py \
  --request '<T52 dir>/fresh-request.json' \
  --raw '<T52 dir>/fresh-recorded-result.json' \
  --output '<T52 dir>/response.json'
```

После успеха немедленно передать response.json через stdin baseline strict SSH:

```sh
python3 -I /root/bron-secrets/t52-mcp-ready.py --complete
```

MCP/decoder/fsync и SSH handshake complete входят в VPS wall+monotonic
roundTrip≤30000ms от создания nonce; prepare handshake проходит до его создания;
60s expiry и Source clock±5s неизменны. Ничего не повторять после начала пробы.
Если provider error — private artifact сохранить; в отчёт только safe code/schema/
SHA и точные SQLSTATE/HTTP_ADMISSION enum, если установлены структурно, без rawerror.
Нет artifact/неизвестныйshape/SSHfail/clockfail — BLOCKED без придуманного response.

## E. Receipt и следующий шаг

Native пишет только private native-worker-result.json; helper PASS provisional.
После EOF parent требует collector summary RECOVERED, matchingCalls1, no ambiguity,
actual helper exit0/statusPASS/codeT52_SAME_WORKER_MCP_PROVEN, roundTrip и monotonic
≤30000, result root:root0600/nlink1 и readback SHA. Capture sourceQueries0 означает
только отсутствие собственных запросов collector; task fresh MCP count обязан1.
Snapshots0, targetWrites0, T49Startedfalse, macDataTransitfalse.

Canonical `/root/bron-secrets/t52-release-receipt.json`, mirror
`/tmp/bron-release-executor-20261113/T52-state.json`,0600/equal SHA. Записать actual
commit/input pins/counts/timing/output SHA, baseline SSH outcome, raw artifact SHA,
safe failure либо PASS, maintenance и remaining gates. Source/target не менять.

T52 PASS разрешает подготовку свежего pinned финального окна, не запуск старых
T45/T49/истёкшей capability. Shared ledger max3/два DATA slots сохраняются; T52
его не читает/не меняет и snapshots не расходует. Остаток: финальная сверка/
допустимый max1 timestamp update → strict final PASS → reader closure/Source Pause
→ essential owner acceptance → public switch/live checks. Optional work отложено.
Владельцу новых действий сейчас не нужно. Parent executor остаётся активен.
