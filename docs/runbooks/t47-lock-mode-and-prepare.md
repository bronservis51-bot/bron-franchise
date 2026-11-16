# T47 — только lock mode и одна дополнительная T45 prepare_final

T45 первая prepare_final invocation остановилась на target-preflight:
T45_FINAL_DRIVER_PIN. Exact pinned lock root:root/nlink1/SHA совпал, но mode0664
не прошёл проверку отсутствия group/world write. DB connection/probe не начаты;
prepare guard/capability/base/final-result отсутствуют. T46 и CONTROL_READY PASS.

Fresh EXECUTOR_TASK T47 отдельно разрешает исправление mode и **одну** дополнительную
invocation неизменённого T45 prepare_final. Это явное новое разрешение, не скрытый
retry старого пакета. Старый BLOCKED остаётся в истории. Физических prepare_final
invocations было1; после разрешённой новой максимум2; старый stage guard не claimed.
Source snapshot budget остаётся1/3, никаких его слотов T47 не расходует.

## Приёмка и mode repair

1. Fast-forward чистого checkout до exact task commit; сверить manifest SHA,
   все declared files и Python AST. Не reset/stash/clean. ACCEPTED с receipt paths.
2. **До запуска helper не обновлять старую canonical T45 receipt:** её exact SHA
   `65a61c2888b96ba9a8ae9870fcbb95c9edc624c3fc2cec2d4a25352fe2d82d37`
   является входом. T47 сохраняет её immutable private копию перед mode change.
   Новая T47 receipt и локальное состояние ведутся отдельно.
3. Strict SSH host key прежний. Доставить только T47 helper/manifest, root:root0600
   O_EXCL/no-follow/fsync/readback. Новый state `/root/bron-secrets/t47-lock-mode`
   root:root0700. T45 code/manifest/control/proof/Root approval не менять.
4. Один вызов:

```sh
/usr/bin/python3 -I /root/bron-secrets/t47-lock-mode.py --manifest /root/bron-secrets/t47-lock-mode/manifest.json --sha256 <EXACT T47 manifest SHA>
```

Helper проверяет отсутствующие final artifacts, exact immutable inputs и private
file metadata. Единственная внешняя мутация — `fchmod` закреплённого lock FD
**0664→0644**. O_NOFOLLOW; same dev/ino/owner/nlink/size/mtime/content SHA после
fsync/readback. Файл не переписывается/не заменяется; dependencies не устанавливаются.
Свой guard/result и копия прежней receipt остаются root600. Никаких SQL, сети,
ключей/S3/backup/Auth/business reads, сервисов или контейнерных операций.
При BLOCKED остановиться, сохранить state, не retry/reset/chmod вручную.

## Разрешённое продолжение после actual T47 PASS

Немедленно один дополнительный prepare_final с **прежними** T45 manifest/Root SHA:

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t45-runtime/docs/runbooks/payloads/t45-final-window.mjs --prepare-final --manifest /root/bron-secrets/t45-release/manifest.json --sha256 67b2bb6c7b72ef39bd66dbb2e008f177fb5b38ae9713e052ad8aee0aa5182ad8 --owner-proof-input-sha256 68b9789f062a5e3ad0d301afb251a5fb936f75712d6ffafddbd3fe6bda83a2a8
```

Не повторять CONTROL_READY, restore, builds, Telegram, schedule или лишний SQL
probe. Target metadata identity/ROLLBACK выполнит сам prepare_final впервые.
В отчёте честно считать old BLOCKED invocation1 + newly executed1; не выдавать
старый отказ за PASS. При новом BLOCKED/UNKNOWN остановиться без нового вызова.

После FINAL_READY сразу передать Root basePrepared/capability SHA, functionName,
expiry, control bindings, target-probe outcome и ledger1/3,remaining2.
Значение capability не передавать. Root уже независимо сверил5SQLSHA и готов к
4nonce challenges. Source SQL/freeze/deployment/ACK остаются за Root; далее
продолжается тот же T45. Перед actual Source effects backup freshness должна
соответствовать установленным bounds; не считать старый timestamp свежим.

Canonical T47 `/root/bron-secrets/t47-release-receipt.json`, mirror
`/tmp/bron-release-executor-20261113/T47-state.json`,0600/equal SHA. Указать
mode before/after, lockSHA, preserved old receipt SHA, actual invocation counts,
T47 result и T45 continuation. Старую сохранённую копию не менять. Maintenance
сохраняется; owner action не требуется. Далее финальная сверка, приёмка, публикация.
