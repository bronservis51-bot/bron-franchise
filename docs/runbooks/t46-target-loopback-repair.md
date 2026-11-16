# T46 — восстановить прежний target loopback, затем продолжить T45

Пакет действует только с exact commit и manifest SHA нового EXECUTOR_TASK T46.
T44 PASS/CONFIRMED и Root owner approval T45 уже приняты; повторять их не нужно.
T45 остановился до delivery/control/final guard: DB healthy, но host listener15433
отсутствует. В loaded units и семи проверенных systemd-каталогах definitions не
найдены. Исторический checkpoint подтверждает прежние socket units, но их имена
не сохранились. Причина исчезновения не установлена и не исследуется перед релизом.

Это **новые временные определения двух units**, а не запуск найденного старого.
Они восстанавливают тот же endpoint штатной ОС: без установки пакетов, нового
контейнера/сети, backend/Docker restart, изменения данных или внешнего доступа.
Сайт/API остаются в maintenance. После PASS тот же T45 продолжается автоматически.

## 1. Приёмка и доставка

- Fast-forward чистого checkout до task commit; проверить manifest SHA и все
  `files`, Python AST-only syntax. Не reset/stash/clean и не менять checkout
  работающего процесса. ACCEPTED содержит commit/manifest SHA и receipt paths.
- Strict SSH host key прежний. Доставить только helper и manifest из deliveries:
  root:root0600 regular/nlink1, O_EXCL/no-follow, fsync/readback SHA. Новый private
  state `/root/bron-secrets/t46-loopback-repair` root:root0700.
- Не доставлять/изменять T44/T45 files, guards, results и owner approval. PASS
  остальных preflight не переоткрывать. Не запускать новый поиск units.

## 2. Ровно один repair run

Исполнитель один раз:

```sh
/usr/bin/python3 -I /root/bron-secrets/t46-loopback-repair.py --run --manifest /root/bron-secrets/t46-loopback-repair/manifest.json --sha256 <EXACT T46 manifest SHA>
```

Helper до effects проверяет root/Linux/isolated/self/manifest pins, отсутствие
собственных units/guard/result и listener15433, наличие root-owned штатного proxy.
Без установки/замены бинарников. Выбирает actual IPv4 закреплённого healthy
`supabase-db` из `supabase_default`; Docker inspect только с selected metadata,
без env/паролей. Container ID/image обязаны совпасть с manifest. Перед изменением
сохраняет safe снимок шести backend IDs и планируемых units/hashes в новом guard.

Только два runtime файла, O_EXCL/root-owned/fsync/readback:

```text
/run/systemd/system/bron-t46-target-loopback.socket
/run/systemd/system/bron-t46-target-loopback.service
```

Socket слушает **только** `127.0.0.1:15433`, Accept=no. Service — установленный
`systemd-socket-proxyd` к actual verified DB IPv4:5432, User=nobody/Group=nogroup,
NoNewPrivileges=yes. Нет shell/ExecStartPre/Post/Restart/new dependencies.
После одного daemon-reload — один start **socket**, без enable/restart/backend
команд. Files находятся в `/run`, постоянные OS/services и Compose не меняются.

При PASS: фактический единственный loopback listener и active socket; та же
healthy DB/container/image и прежние шесть backend IDs. Никаких SQL запросов,
чтения Auth/business/backup/key/credentials или S3/Source вызовов. Проверка SQL
идентичности уже предусмотрена T45 prepare_final, отдельный probe не добавляется.

## 3. Outcome, остановка и продолжение

- Guard до effects; one run/one start. Timeout/неопределённый start не повторять:
  safe status readback фиксируется как наблюдение, не как второй запуск.
- При BLOCKED/UNKNOWN сохранить свой guard/result/созданные units. Не чинить,
  не reset/retry, не удалять файлы и не применять автоматический rollback.
- Ручной обратный ход при необходимости закрывает только эти собственные units
  после совпадения их SHA; удаление runtime files/daemon-reload требует точного
  дальнейшего разрешения. DB/Source состояние такой откат не изменяет.
- После **actual PASS** записать matching safe receipt и немедленно продолжить
  уже принятый T45 B→C по его прежним pins/Root approval, без нового task ID или
  ожидания координаторского согласования. Нужные immutable input SHA проверяет
  сам T45. Дальше CONTROL_READY/FINAL_READY → Root fence/witness/DATA/final audit.
- Этот repair не разрешает Source SQL, target writes, snapshot/recovery retry,
  preview, Pages/public switch, package installs, network/Docker/DB changes.

Canonical `/root/bron-secrets/t46-release-receipt.json`; mirror
`/tmp/bron-release-executor-20261113/T46-state.json`,0600/equal SHA. Собственную
общую receipt обновлять atomic/fsync; guard/result immutable. В safe отчёт:
BUNDLE, REPAIR_STATUS, TARGET_CONTAINER_IMAGE, TARGET_ROUTE, UNIT_PATHS_SHA,
START_ATTEMPTS, START_OUTCOME, LOOPBACK_ONLY, BACKEND_IDS_UNCHANGED,
SOURCE_TARGET_DATA_READ_WRITE_COUNTS, CHANGED_PATHS, RECEIPT_SHA, T45_CONTINUATION.
Секретов и полных Docker/env/journal dumps нет. Owner action не требуется.
