# T39: разместить публичную статику, сохранив maintenance

Это необходимая подготовка filesystem для будущего preview, а не его включение.
T14 уже проверил сборки в `/opt/bron/stage/release-e487ec8/`; T39 переносит только
app-root/landing-root в назначение `bron/site/app`/`bron/site/landing`.
Active web монтирует ТОЛЬКО `bron/site/status` → `/srv/status`, поэтому новые
поддеревья не доступны контейнеру. Эта изоляция проверяется до и после копии.
T37 owner approval остаётся pending; этот пакет её не заменяет.

## 1. Приёмка пакета

- Только чистый fast-forward до commit EXECUTOR_TASK T39; не менять checkout
  работающего процесса, не reset/stash/clean. SHA точных bytes manifest и всех
  `files` должен совпасть. Отправить ACCEPTED и продолжить без ACK.
- Strict SSH ED25519 fingerprint/host из manifest. Доставить только два
  `deliveries` exclusive-create root:root0600. Старые файлы не заменять.
- Проверить server helper SHA и синтаксис через AST/compile без запуска main.
  Используется только уже установленный Python3 stdlib; без install/build.

## 2. Один запуск helper

Команда `command` из manifest, последний аргумент — точный manifest SHA из
EXECUTOR_TASK. Guard/result новые private root0600 и immutable.

До любых app/landing writes helper обязан проверить:

- root/Linux/тот же VPS и собственный pin/private paths;
- exact7 container IDs T33, web project/working_dir/ordered5Compose labels;
- Caddy bind у web — существующий maintenance file, соответствующий pinnedSHA;
  web НЕ монтирует весь site/app/landing, только status read-only;
- существующий maintenance override SHA совпадает; env/renderedCompose/secret
  values не читать и не печатать, Config.Env не запрашивать;
- HTTPS GET `/` для3канонических доменов даёт503, strictCA+canonicalHost/SNI,
  pinned152.228.115.115, без redirects/body output;
- оба source manifest совпадают по pinned SHA/sourceCommit/base/API/count,
  все перечисленные regular файлы имеют ожидаемые bytes/SHA. Ни один symlink,
  hardlink/special path, traversal, `.git`/dotenv не принимается;
- если destination существует: только точное полное совпадение означает REUSED;
  другое содержимое — BLOCKED до начала копирования любого из двух пакетов.

## 3. Разрешённые эффекты

Создать только отсутствующие `bron/site/app` и/или `bron/site/landing` и их
manifest-listed public files плюс release-manifest.json, files0644/dirs0755.
Никаких links, overwrite/delete существующего дерева, source package changes,
active Caddy/Compose writes, container create/restart/reload или preview apply.

Повторная SHA-проверка после копии проверяет новое назначение; это не повтор
сборки/restore или всех5T14пакетов. Все source artifacts остаются на VPS.
При copy failure сохранить BLOCKED + partial created paths/phase/code; не чистить чужое,
не ремонтировать и не повторять consumed attempt. Деревья остаются inert;
будущий activation package обязан принять только полное проверенное назначение.

`bron/site/status` не изменять. Watchdog законно обновляет healthJSON во время
задачи: изменение его bytes/mtime не является ошибкой T39 и не поводом остановить
watchdog/backup timer. Никакие backup/ключ/ownersecret файлы не читать.

## 4. Postcheck и отчёт

Снова exactIDs/mount/Caddy/override invariants, оба назначения по manifest,
HTTPS503 для3hosts. Нет source/target DB connections и source/Auth rows,
сервисных изменений, preview/publication; рабочие данные/копии не уходят на Mac.
Если всё уже точно на месте — package state REUSED и changedPaths=[], без перекопии.

Canonical VPS receipt `/root/bron-secrets/t39-release-receipt.json`, local mirror
`/tmp/bron-release-executor-20261113/T39-state.json`, VPS log
`/root/bron-secrets/t39-stage-static.log`, root0600/local0600. Результат helper
`/root/bron-secrets/t39-stage-static.result.json`; guard
`/root/bron-secrets/t39-stage-static.guard`. Receipt фиксирует pins, action counters,
до/после status, created paths, exit/phase/code, hashes и cleanup. Mirror safe bytes/SHA
совпадают; нельзя переносить сам app package, manifest contents, env или private data.

`EXECUTOR_REPORT T39`: BUNDLE; MAINTENANCE_PRE; APP_STAGE; LANDING_STAGE;
SOURCE_ARTIFACTS_UNCHANGED; ACTIVE_CONFIG/CONTAINERS_UNCHANGED; MAINTENANCE_POST;
STATUS_SUBTREE_UNTOUCHED; CHANGED_PATHS; CLEANUP; RESULT/RECEIPT/LOG_SHA; NEXT_BLOCKER.

STAGED_INERT или REUSED не означает preview-ready/release-ready и не отменяет
owner-key/source freeze/final audit/личную приёмку. Готовые T12/T14/T18/T19/T21/T22/
T36 подтверждения переиспользуются, новые app build/DB checks не запускаются.
Бюджет15минут; failure останавливает зависимую ветку, но финальный отчёт обязателен.
