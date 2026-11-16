# T40: technical metadata custody и маршрут аварийной консоли

T37 live inventory завершён:62tables/4020rows, только1 source-newer Auth updated_at.
Reader закрыт v2/HTTPS410, available-log scan PASS. Budgetused1/3; две оставшиеся
попытки нужны final before/after. T40 **не читает Auth/бизнес-строки**, не расходует
этот бюджет и не выполняет freeze. Его gate — Source technical before-image,
сохранённый на VPS с fsync/readback для будущего обратимого admission control.
Metadata не считать CONTROL_READY или подтверждением Source fence.

## A. Пакет и одна metadata-попытка

1. T37 процесс завершён, receipt закрыт. Только чистый fast-forward до commit
   EXECUTOR_TASK T40. Проверить exact manifest SHA и все `files`; отправить
   ACCEPTED, продолжить без ACK. Strict SSH fingerprint/Node22.23.5 из manifest.
2. Создать только directories для `deliveries` и credential_directory, root:root0700.
   Доставить только manifest/runtime6files, exclusive-create/root:root0600.
   Существующий файл переиспользовать лишь при точном SHA/owner/mode/nlink=1;
   иначе BLOCKED, не заменять/удалять. Проверить readback SHA и syntax всех MJS.
   Не копировать node_modules, не устанавливать зависимости или образы.
3. Preflight проверяет реальные T37 result/receipt SHA и immutable ledger:
   used1/remaining2/claimSHA, без consume/reset. T21 auditor, контейнеры/compose,
   source/target data и T30 key/backup files не трогать.
4. Один `commands.prepare` с exact SHA manifest последним аргументом. Новый
   machine secret64ASCIIhex создаётся только на VPS root600, TTL ровно2часа;
   permanent prepare.guard и prepared metadata fsync/readback. Секрет не читать
   в терминал, не помещать в argv/env/логи/clipboard и не передавать на Mac.
5. Отправить `EXECUTOR_READY T40 COMMIT=... MANIFEST_SHA=... CAPABILITY_SHA256=...
   EXPIRES_UTC=... FUNCTION_NAME=... PREPARED_SHA=... AUTH_BUDGET_USED=1`.
   До `DEPLOYMENT_READY T40` остановить только capture-фазу; выполнить независимую
   ветку B. Новый task/checkout/owner approval между этими фазами не требуется.
6. Координатор проверяет pins, рендерит source-admission-https template только
   public capSHA/expiry/actionID/manifestSHA; deploy нового mandatory-capability
   function в существующем проекте. `verify_jwt=false` только у этого own-auth
   reader; продуктовые Auth/RLS/REST/shop-worker не меняются. Получить все5files
   обратно, сравнить exact bytes, GET без секрета обязан403 до env/DB.
7. После matching DEPLOYMENT_READY выполнить `commands.capture` один раз с тем
   же manifest SHA. One-run capture.guard durable **до** одного POST. No retries,
   resume, TCP/reverse fallback, TTL extension или новый secret внутри T40.
8. Source выполняет только fixed catalog query, RR READ ONLY/UTC/pg_catalog,
   statement5s/idle10s, проверяет физический PID/identity и заканчивает ROLLBACK
   до шифрования. Full technical state шифруется в Source; HTTPS/AEAD/binding/
   expiry/querySHA/rollback проверяются на VPS. No client SQL/operations router.
9. Core+FS adapter сохраняют before-image и отдельный metadata receipt:
   root:root0600, regular/nonlink/nlink1, exclusive-create, fsyncfile+parent,
   actual readback SHA. Только METADATA_PREPARED. Key proof для этого не нужен.
   Inverse/control paths зарезервированы, **не создаются/не исполняются** T40.
10. Закрыть helper/HTTP/FS adapter, записать все действия и исходы в safe receipt.
    Передавать на Mac только safe receipt с одинаковыми bytes/SHA. Frame/ciphertext,
    state/ACL/roles/backend list остаются на VPS. OwnerPids не выводятся runner-ом.
    При отказе — finite phase/code/remoteStage/custodyPhase, без raw exception/body.
    Координатор после отчёта закрывает metadata endpoint и проверяет availablelogs.

## B. AdminVPS: одна независимая read-only ветка

В существующем поддерживаемом browser session проверить путь от официального
`https://my.adminvps.ru/` к услуге386078 / IP152.228.115.115 и кнопке управления/
консоли/VNC. Цель — точные названия кнопок/домены и понятный phone handoff, не
проверка ключа за владельца. Максимум один navigation path, без повторных логинов.

- Если текущий аккаунт уже авторизован, открыть только карточку этой услуги и
  доступный штатный console route; не раскрывать сохранённые passwords/credentials.
- Не передавать signed URLs, query tokens, clipboard credentials или экран с
  секретами. В отчёт только домен, точные button labels и этап отказа.
- Login/MFA/unknown Linux password — owner-only, STOP только этой ветки. Не менять
  пароли/MFA/сессии, не reboot/reset/reinstall, не заказывать услугу/поддержку и не
  отправлять сообщений. Если browser capability отсутствует — точная ошибка,
  без обхода неподдерживаемой visibility/переиспользования токенов.
- «Неразрешенный» на пустой странице не равен неверному ключу, отсутствию root
  или недоступности VPS. Root уже запросил у владельца домен/этап ошибки и факт
  наличия независимой age-копии; не дублировать вопросы или hidden input.
- T30 owner-only команда остаётся прежней; выполнять её может только владелец с
  телефона, после нормальной root-консоли и наличия независимой копии ключа.
  Готовый T30 JSON при появлении разрешено проверить только как safe metadata;
  identity/backup не читать, --verify за владельца не запускать.

## Приёмка и финальный отчёт

- Exact bundle/Node/SSH/rootmodes/T37 input pins PASS.
- Один prepare, один metadata POST после coordinator deploy/readback, no retries.
- Protocol/project/destination/action/manifest/querySHA/expiry/TLS/negativeTLS/
  RRRO/deadlines/PID/rollback и fixed metadata allowlist проверены.
- Actual Source backend labels проверены координатором заранее: `client backend`,
  `pg_cron launcher`, `pg_net 0.20.4 worker`; validator regression это покрывает.
- Before-image + metadata receipt durable/readback PASS; private bytes никогда
  не выходили с VPS. METADATA_PREPARED=true; controlReady/sourceBarrierPass=false.
- Auth-ledger неизменен1→1, осталось2; Source/target writes=0; no key/backupreads,
  freeze/Pause/preview/Pages/publication=0. Maintenance сохраняется.
- Browser ветка записывает actual supported route или точный BLOCKED без
  утверждения, что личный second-device/key gate уже пройден.

Canonical `/root/bron-secrets/t40-release-receipt.json`, mirror
`/tmp/bron-release-executor-20261113/T40-state.json`, log
`/root/bron-secrets/t40-metadata-custody/capture.log`; mode0600. Receipt включает
все executed actions, input/output SHA, timestamps/exit/guards, safe counts/paths,
cleanup и обе независимые ветки. Meta before-image не зеркалировать.

`EXECUTOR_REPORT T40`: BUNDLE; PREPARE; DEPLOYMENT_OBSERVED; METADATA_CUSTODY;
AUTH_BUDGET_BEFORE_AFTER; SOURCE_EFFECTS; OWNER_CONSOLE_ROUTE; T30_OWNER;
CLEANUP; RESULT/RECEIPT/LOG_SHA; NEXT_BLOCKER. Не ждать owner gate для отчёта.
Дальнейший Source control/final task должен явно принять pinned T40 artifacts и
их контекст или подготовить новый перед действием; не переименовывать/переписывать
before-image/receipt и не считать их current fence proof автоматически.
