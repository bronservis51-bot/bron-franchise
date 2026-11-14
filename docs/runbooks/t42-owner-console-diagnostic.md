# T42: локализация ошибки телефонного wrapper T41

Это вспомогательный диагностический пакет к T41. Исходные T41 manifest, wrapper,
crypto/workflow, marker и остальные доставленные файлы не меняются. Приложение и
API остаются в maintenance. Owner recovery, S3 и Source effects не выполняются
диагностикой; чтение identity/backup/credentials запрещено.

Причина выдачи: phone `check` вернул `OWNER_CONSOLE_CHECK_FAILED` до успешного
exec workflow. Сообщение само по себе не определяет причину. Возможные места:
метаданные public файлов, native TTY ioctl, второй crypto console guard или exec.
Обычные wrapper-тесты подменяли crypto guard; реальная двухступенчатая связка
требует диагностики на фактическом TTY. Нельзя исправлять это принудительным PASS.

## 1. Получение и pins

Принять только commit и manifest SHA из EXECUTOR_TASK T42. Чистый checkout
fast-forward, без stash/reset/clean. Проверить все `files` SHA. T41 SHA сохраняется:
`54c34e5abdf553fb36194aeca7f81251f1859af832b8406a48fe1520c4ae0321`;
его original54 code pins не меняются. Для доставки кода допустим проверенный
Git bundle от T41 a6b4c8d через браузер, SHA bundle берётся из сообщения Root.
Транспортную ветку не checkout/merge. Новые DNS/сетевые пробы не нужны.

ACCEPTED: task/commit/manifest SHA/local state/canonical receipt. T41 остаётся
активным на owner-check checkpoint; T42 не заменяет и не повторяет его preflight.

## 2. Одна безопасная SSH-проверка public файлов

Strict SSH fingerprint остаётся прежним. Создать только свой каталог
`/root/bron-secrets/t42-console-diagnostic` root:root0700; новые script/manifest
root:root0600, regular/nlink1, no symlinks, O_EXCL, fsync и SHA readback. Script:
`/root/bron-secrets/t42-owner-console-diagnostic.py`.
Синтаксис проверить через AST, без import исполнения. Никаких dependency installs.

Проверяемые входы T41 — **объекты диагностики**, а не повод остановиться до неё.
Не требовать их совпадения в отдельном preflight: отсутствующий marker/другой
file SHA должен попасть в безопасный диагностический результат. Перед запуском
проверяются собственные T42 pins, путь/режим и SHA нового script.

Ровно один запуск по SSH:

```sh
/usr/bin/python3 -I /root/bron-secrets/t42-owner-console-diagnostic.py --inspect-files
```

Этот режим проверяет только шесть фиксированных public code/metadata файлов.
Он не вызывает исходный console guard, не импортирует crypto и не запускает
workflow. SSH/PTY признаки в этом режиме ожидаемы. Сохранить safe stdout в
собственный `inspect-result.json` root600. Показать Root result и SHA без raw
traceback/message/locals или содержимого прочитанных файлов.

Если `status=INSPECTION_COMPLETE` и `code=T42_PUBLIC_FILES_MATCH` не получены, зависимая телефонная диагностика останавливается;
сообщить конкретные code/phase/fileId/exceptionClass/errno/inventory и ждать
решения Root. Исходные T41 файлы, permissions и marker не исправлять под T42.

## 3. Один телефонный запуск только после успешной проверки файлов

Владелец лично, в уже открытой физической root-консоли телефона:

```sh
python3 -I /root/bron-secrets/t42-owner-console-diagnostic.py --diagnose
```

Не перенаправлять и не pipe/tee stdin/stdout/stderr: это изменит проверяемый TTY.
Script сам сохраняет только safe result в `phone-result.json` внутри своего
каталога с O_EXCL/root600/fsync/readback; секретов и ввода фразы у него нет.
Он компилирует SHA-проверенный original wrapper как non-main и вызывает только
`verify_and_guard('check')`. `main`, `execve`, workflow и recovery не вызываются.

Executor один раз читает только этот safe JSON по SSH; передаёт Root целиком
вместе с SHA. No raw traceback, str(error), arbitrary frame paths или locals.
Сохраняются конечные class/errno/fixed causeCode, whitelist file/function IDs и
строки, metadata TTY/foreground. Непринятый TTY остаётся BLOCKED.

## 4. Разрешённое продолжение

Если результат содержит `status=CHECK_PATH_COMPLETE_NO_EXEC` и
`code=T42_WRAPPER_CHECK_PATH_PASSED`, владелец может один раз
повторить **исходный pinned T41 check**. Это metadata-only повтор после новой
диагностики, не recovery retry. T42 не объявляет READY за исходный check.

При actual T41 `READY` продолжить ранее одобренный T41 `recover → attest` без
нового разрешения. При любом другом исходе передать Root конкретный safe результат
и остановить зависимые действия. Даже успешная проверка guard не является crypto/key proof.
Никаких T41 helper edits, raw T30 verifier, DMG, Source/S3 или публикации под T42.

## 5. Квитанция

Canonical `/root/bron-secrets/t42-release-receipt.json`, local mirror
`/tmp/bron-release-executor-20261113/T42-state.json`; root/local0600 и равные SHA.
Фиксировать фактические действия и входные SHA, count запуска каждого режима,
выход/phase/cause и пути safe результатов. Отдельно T41 remains active.
Не ставить recovery/owner custody/freeze PASS на основании диагностики.
