# T51 — сохранить MCP result до разбора и доказать доставку

Maintenance сохраняется. T50 завершён BLOCKED_MCP_RESULT: prepare1, MCP call1,
complete0, snapshots0, target writes0. Его request/guard/local state сохранить;
не повторять T50 и не объявлять его PASS задним числом. Последний подтверждённый
fence=FENCED, свежий T50 fence=UNVERIFIED. Старые T45/T49 окна не запускать.

Цель T51 — закрыть конкретные дефекты decoding/сохранения результата и доставки.
Это технический каталоговый read-only gate; не повтор restore/Auth/RLS/builds/
backup/Telegram и не новый перенос данных. Существующие OAuth, SSH и runtime
используются без повторного login, permission bypass и смены security policy.

## A. Exact bundle и уже выполненная работа

Fast-forward чистого checkout до commit из EXECUTOR_TASK после выхода старого
worker; manifest SHA + все file pins. Сохранить прежний T50 safe state без
перезаписи; новая local state `/tmp/bron-release-executor-20261113/T51-state.json`.
Source ledger/capability/ключи/backup/старые receipts не читать и не менять.
OAuth и callable execute_sql уже подтверждены — их setup не повторять.

Decoder проверен локальными фикстурами, включая native `Ok`/`Err`, JSONRPC,
`structured_content`/`structuredContent`, content text и matching untrusted tags.
Ошибка, неоднозначность или лишние строки/поля никогда не преобразуются в PASS.
Офлайн тесты можно выполнять на Mac; только VPS helper моделирует Linux/root.
Бизнес/Auth значений/backup/секретов в фикстурах нет.

## B. Извлечь существующий ответ T50 — без Source call

Если exact worker session/rollout path известен из уже сохранённого launch result,
передать **этот один файл** scoped extractor:

```sh
python3 -I docs/runbooks/payloads/t51-recover-mcp.py \
  --session-file '<exact known T50 worker event file>' \
  --output '<private T51 directory>/t50-recorded-result.json'
```

Точные опции сверить с pinned `--help`. Не искать содержимое всех личных sessions,
не читать OAuth/keychain/token store, не resume AI и не запрашивать Source заново.
Extractor принимает только execute_sql/bron-release-source и exact query SHA
`0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15`.
Сохраняет только связанный результат O_EXCL0600/fsync + safe summary/hashes.
Это canonical recorded tool-result projection, **не утверждение byte-exact
provider transport capture**. Whole session/log не копировать/не выводить.

Если path неизвестен или нужного result нет, записать NOT_RECOVERED; не устраивать
поиск по истории и не тратить отдельный task на это. Если извлечён результат:

```sh
python3 -I docs/runbooks/payloads/mcp-fence-result.py --input '<T50 recorded result>'
```

Исторически декодированный success может объяснить причину T50, но не доказывает
текущий fence/readiness. Реальная provider-error о нарушении fence/identity — STOP
Source-ветки с safe кодом/schema/hashes; её нельзя лечить заменой parser или SQL.
Если обнаружена неизвестная wrapper shape, сохранить её и schema-only summary;
не угадывать результат и не запускать fresh proof до корректного offline decoder.
При provider failure разрешено разобрать уже сохранённый private ответ локально
и сообщить только SQLSTATE и точный известный HTTP_ADMISSION_* code из структурной
ошибки; не печатать весь error/SQL/log и не выводить причину из совпадения в prose.
Если такой код не установлен, сообщить PROVIDER_ERROR_UNCLASSIFIED + artifact SHA.

## C. Исправить доставку и запись до нового таймера

`Connection closed by UNKNOWN port 65535` в OpenSSH означает placeholder для
non-socket соединения, например ProxyCommand/stdio; это не фактический порт VPS.
Не менять provider/proxy settings и не перезапускать сервер по этой строке.

Использовать тот же approved native worker с workspace-write, normal network grant,
точным canonical receipt-parent через --add-dir и --approve-for-me. Не повторять
OAuth, не вводить full-access/never/bypass/ignore-rules. Если обычный permission
review отклоняет действие — сохранить отказ и STOP, не менять транспорт для обхода.

До Source query:

1. Existing strict SSH к root@152.228.115.115, прежний ED25519 fingerprint
   `SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0`. Не менять known_hosts,
   ProxyCommand/ProxyJump, port, identity или SSH security settings.
2. Одна безопасная SSH проверка `printf T51_SSH_READY`. Если снова transport failure,
   STOP **до prepare/Source query**; сохранить exit/elapsed/safe stderr code.
   Разрешено локально посмотреть существующий `ssh -G` в памяти и вывести только
   booleans proxyCommandConfigured/proxyJumpConfigured/controlPathConfigured,
   hostnameMatches/userMatches/port; значения ProxyCommand/identity не выводить.
3. Поднять временный stock OpenSSH ControlMaster только для прежнего strict target,
   с приватным ControlPath внутри T51 local directory, ControlPersist180. Это
   повторное использование SSH-соединения, без port forwards/listeners/services.
   Сохранить прежние SSH options; проверить `ssh -S <socket> -O check` и harmless
   printf через тот же socket. Если не готов — STOP до timer. После завершения
   закрыть только свой master через `-O exit`; чужие процессы не трогать.
4. Доставить только T51 VPS helper и manifest по deliveries O_EXCL/no-follow,
   root:root0600/nlink1/fsync/SHA readback; AST. Новую state directory не создавать
   заранее. Зафиксировать metadata-only SHA request/guard старого T50 и отсутствие/
   наличие complete/result, без content dump. Старые файлы не менять.

## D. Capture до decode, затем одна fresh proof

Raw reply не должен зависеть от того, сумела ли модель его понять. Запустить этот
native worker с `--json` и отдельным **заранее работающим scoped collector**:

```text
codex exec <same approved workspace/network/receipt flags> --json - < pinned-worker-prompt
    | python3 -I docs/runbooks/payloads/t51-recover-mcp.py
        --json-stream --output <private T51 directory>/fresh-recorded-result.json
```

Использовать pinned `payloads/t51-worker-prompt.txt`, дополнив private local state
из принятого envelope фактическими commit/manifest SHA и путём T51 directory.
Native worker исполняет только fresh proof, родитель выполняет recovery/setup и
проверяет final collector summary. Перед запуском сверить фактический CLI --help.
Prompt передать из private файла через stdin, полные events на диск не писать. Collector немедленно
fsync/readback сохраняет **единственный** соответствующий tool result до decoder,
затем **продолжает читать stdout до EOF**. Не завершать consumer после первого
result: это может оборвать writer/stdio relay. Второй совпавший MCP call — BLOCKED,
не перезаписывать первый artifact. Никаких raw events/results в чат.
Marker `<raw>.ready.json` содержит `resultSha256`, querySha256 и capture protocol;
после EOF `<raw>.summary.json` должен подтвердить RECOVERED/matchingCalls1.
`sourceQueries=0` в summary относится только к collector (он не вызывает сеть):
общий счётчик T51 обязан отдельно показать **один** fresh MCP transaction worker.

После всех setup подготовлен ровно один Source call и следующие действия worker:

1. Через готовый strict SSH ControlMaster выполнить:

```sh
python3 -I /root/bron-secrets/t51-mcp-ready.py --prepare
```

   Сохранить точные canonical technical request bytes +LF O_EXCL0600 локально;
   это nonce SHA/clock/context, не Auth/business rows. Таймер VPS уже запущен.
2. НЕМЕДЛЕННО один native MCP execute_sql с точными bytes прежнего
   `payloads/t50-verify-fenced.sql` SHA `0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15`.
   Полный transaction, без сокращений; source project vkkqffvmztpzgygzfxhq;
   schema текущего callable tool=query. Никаких иных SQL/повторов.
3. Collector сохраняет actual recorded reply автоматически. При отсутствии
   artifact/error worker сохраняет BLOCKED, не создаёт успешный response вручную.
4. Подготовленным локальным builder собрать response из captured artifact:

```sh
python3 -I docs/runbooks/payloads/t51-mcp-response.py \
  --request '<fresh request file>' --raw '<fresh recorded result>' \
  --output '<private T51 directory>/response.json'
```

5. Сразу передать **файл response через stdin** уже готового strict SSH master
   в `python3 -I /root/bron-secrets/t51-mcp-ready.py --complete`. Использовать
   subprocess input/file stdin; не смешивать heredoc с Python script stdin и JSON,
   не вставлять JSON через shell interpolation. После complete повторов нет.

Result/response readback проверяются тем же worker; clock/bindings/expiry60s,
Source skew±5s и end-to-end≤30s не ослаблены. Проба не использует capability и
не расходует общий snapshot ledger. T50 result не подставлять в fresh proof:
старый Source clock будет отклонён. Capture artifact до decode обязателен даже
если provider вернул ошибку — ошибка останется доказанной, не generic lost reply.

## E. Приёмка и продолжение

PASS только при native MCP success row, collector exactly one/no ambiguity,
VPS helper exit0/statusPASS/codeT51_SAME_WORKER_MCP_PROVEN, wall+monotonic≤30000,
result root:root0600/nlink1 + hashes/readback. Native worker пишет лишь
private native-worker-result.json/PROVISIONAL_HELPER_PASS; родитель после EOF
collector проверяет summary и только тогда создаёт final canonical receipt.
Source snapshotAttemptsUsed0,
targetWrites0, T49Startedfalse, macDataTransitfalse. Local /canonical receipt
SHA равны, обе0600; сохранить входные SHA, реальные timing/exit/call counts,
shape-only decoder result, actual T50 recovery outcome и старые T50 hashes.

Canonical `/root/bron-secrets/t51-release-receipt.json`; mirror
`/tmp/bron-release-executor-20261113/T51-state.json`. Raw technical artifact
остаётся private локально; в receipt только его SHA и schema/outcome. Старый
T50 safe mirror/guards и shared ledger сохраняются; ровно один новый prepare,
один fresh Source technical call, один complete; BLOCKED/UNKNOWN — без retry.

После PASS немедленно готовить fresh pinned финальное продолжение с тем же общим
max3/двумя оставшимися snapshots. Старые T45/T49/capability не продлевать/не запускать.
Релиз далее: финальная сверка/max1 допустимое timestamp update → strict final PASS
→ reader closure и Source pause → одна essential owner acceptance → public switch.
Новых owner secrets/optional tooling/monitor dispatch/продуктовых улучшений нет.
Каждый отчёт содержит общий статус: подтверждено, blocker, remaining, next step.
