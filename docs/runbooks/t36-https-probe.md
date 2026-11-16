# T36: закрытый HTTPS dummy probe, без рабочих данных

Это один пакет с двумя фазами и явной передачей координатору. T35 CLOSED/BLOCKED:
settings HTTPS200/610 bytes, OpenAPI401. Это доказывает передачу HTTPS, но не доступ
к БД. Рабочие права REST не менять и T35/TCP/MTU не повторять.

## 1. Preflight и подготовка исполнителем

- Только чистый fast-forward `ops/russia-migration-20261110` до commit из сообщения
  EXECUTOR_TASK. Проверить SHA точных байтов `payloads/t36-https.json`, все `files`.
  Checkout работающего процесса не менять. Отправить ACCEPTED и продолжить без ACK.
- Strict SSH fingerprint из manifest; проверить exact Node22.23.5. Доставить ТОЛЬКО
  два `deliveries`, exclusive-create, root:root0600. Не заменять старые helpers.
  На VPS проверить SHA и `node --check`. Не устанавливать зависимости/образы.
- Убедиться, что нет своего активного T36 helper. Helper сам проверяет root700,
  свой SHA/runtime/VPS и SHA закрытого T35 result. Не выводить его полный файл.
- Один `--prepare`: команда `commands.prepare`, последний аргумент — SHA этого
  manifest из сообщения координатора. Он создаёт root600 capability64ASCIIhex,
  hash-only prepared metadata и prepare.guard, fsync. Старое состояние не удалять.
- Сразу отправить `EXECUTOR_READY T36 COMMIT=<pin> MANIFEST_SHA=<sha>
  CAPABILITY_SHA256=<sha> EXPIRES_UTC=<iso> FUNCTION_NAME=<derived>`. Разрешены только
  эти безопасные metadata. Секрет/его файл не читать в терминал, не копировать на
  Mac, не включать в argv/env/логи. Затем запустить `--probe` без ожидания ACK.

## 2. Развёртывание координатором

После READY координатор проверяет hash/expiry/name, отсутствие такого function
slug, SHA шаблона `source-https-probe/index.ts`. Заменяет ровно два placeholders
на hash и абсолютный expiry (не на token), deploy через существующий Supabase
connector в том же проекте. `verify_jwt=false` относится только к НОВОЙ временной
функции: она сама проверяет private256bit capability до env/DNS/DB. Настройки JWT,
Auth, REST и существующий shop-worker не менять. Получить код обратно и сверить.
Не развёртывать полный reader, произвольный SQL или endpoint с рабочими rows.

## 3. Probe исполнителем — продолжение того же пакета

- `commands.probe` использует тот же manifest SHA. Readiness — максимум24 GET за
  120s, ожидается403 и точный protocol marker. Это проверка запуска функции,
  не чтение БД. При WAIT_COORDINATOR нет final guard/result; сообщить WAIT, продолжить
  независимую ветку владельца. После явного DEPLOYED координатора разрешено ровно
  одно возобновление `--probe` в T36 с теми же prepared/token/expiry. Всего максимум
  два readiness окна, без новой capability и без продления expiry.
- После readiness helper делает один POST с неверной capability (обязан403),
  затем exclusive probe.guard и ровно один POST с настоящей. Общий бюджет POST35s;
  secret-body и JSON ответа существуют только в RAM VPS. Нет HTTP redirects,
  TLS отключения, дополнительных headers/API keys, fallback или повторов.
- Для PASS: HTTPS200; protocol/project/expiry match; реально отклонён неверный
  DB hostname; правильные CA/hostname приняты; database/role/session/owner postgres;
  REPEATABLE READ READ ONLY, statement5s/idle10s; ровно524288 символов x; rollback
  завершён. Идентификатор backend и времена разрешены, полный dummy/body — нет.
- Любой BLOCKED — сохранить безопасные phase/code/status/bytes, закрыть зависимую
  ветку без ремонта/повтора. Не называть config/TLS/transport ошибку потерей данных.
- После PASS координатор отдельно проверяет логи нового endpoint за точное окно:
  только агрегированные counts утечки capability (сопоставление SHA найденных64hex)
  и dummy-body. До этого нельзя передавать рабочие данные. Никакого чтения raw logs
  в чат. Платформа сама публикует временный endpoint; TTL закрывает доступ через2h.
  Координатор закрывает функцию tombstone после проверки/при отказе либо фиксирует
  точный следующий срок закрытия. Этот пакет не разрешает реальный source reader.

## 4. Независимая ветка и квитанция

T30 личная проверка владельца остаётся отдельной: только existence/root metadata
уже ожидаемого результата и ранее полученная attestation. Не запрашивать секрет,
не выполнять --verify за владельца. OWNER_PENDING не задерживает READY/финальный отчёт.

Canonical `/root/bron-secrets/t36-release-receipt.json`, local mirror
`/tmp/bron-release-executor-20261113/T36-state.json`, log
`/root/bron-secrets/t36-release.log`, все0600. У receipt одинаковые байты/SHA;
только безопасные fields. Записывать каждую выполненную фазу и consumed guards,
wait/poll counts, input/output SHA, timestamps, exit/status, changed paths и cleanup.
Никогда не включать capability/filebody/DSN/env/full responses.

Финальный `EXECUTOR_REPORT T36`: BUNDLE; PREPARE; DEPLOYMENT_OBSERVED;
WRONG_CAPABILITY; HTTPS_DATABASE_DUMMY; RUN_COUNTS; OWNER; CLEANUP;
RESULT/RECEIPT/LOG_SHA; NEXT_BLOCKER. FAIL и WAIT не превращать в PASS.
Сайт/API сохраняют maintenance; freeze, source/target DML/DDL, Pause, preview,
публикация, Telegram/schedule changes, Mac data/backup transit запрещены.
