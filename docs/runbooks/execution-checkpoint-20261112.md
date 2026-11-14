# Продолжение исполнения 12.11.2026

Дополнение к `chat-continuation-20261112.md`, не новый план миграции.
Рабочее переключение **не выполнено**. Источник не менялся, seed/reset не запускались.

## T31 закрыл диагностику малого ответа; T32 — один host-only эксперимент — 14.11.2026

T31 принят на25e869b после восстановления доставки: Mac git fetch не разрешал
github.com. Координатор подтвердил remote и актуальный DNS; одно per-command
http.curloptResolve с sslVerify=true позволило получить тот же pinned commit.
System DNS/hosts не менялись, packet scope/one-run не сбрасывались.

Actual selected source IPv4=34.215.156.231, CA/SNI/callback сохранены. Connect1268ms,
BEGIN205, serverDeadline202,idleDeadline201,identity204,synthetic128=204ms PASS;
synthetic512=PG_QUERY_READ_TIMEOUT8002ms. Большие и multirow stages NOT_RUN.
TCP: mss/rcvmss/advmss1448,rto6656,bytes_received4716,bytes_sent2824,
bytes_acked2459,segs_out22,segs_in16,unacked1. Это наблюдение потери/ожидания
ответа, не установленная причина PMTU или ошибка SQL.

Условие T31 требовало512PASS до route experiment, поэтому он честно NOT_RUN:
host route UNCHANGED, exact/32count0, before-image отсутствует. Auth NOT_RUN0/1.
T31 завершён BLOCKED_NETWORK, повторять его helper/guard не разрешается.
Root result `/root/bron-secrets/t31-source-network-result.json`, SHA
`a4fa63fc4c269781c3c7062b9ba32cc67ef6174e09b4571ef104f32fcab7be99`;
canonical receipt SHA
`c29b3a2d9aa2801b90fee85a87154ac5f9a583bd842f6a672c10ac14da5fed59`.
Node процессов0; kernel FIN-WAIT-1 без PID не считать живым helper и не удалять
посторонние sockets. Личная ветка ключа T30 по-прежнему OWNER_ACTION_PENDING.

T32 отдельно разрешает ОДИН ранее НЕ исполнявшийся host-only MSS/MTU эксперимент
на том же peer по exact pinned T31 evidence (128PASS/512timeout). Новую baseline
не повторять. До эффекта — private fsynced before-image/exact inverse; прежние
маршруты/default/firewall/TLS не менять. Далее один fresh TCP/dummy sequence;
не помогло — exact remove/readback; только полный PASS разрешает Auth continuation.
Ни source freeze, ни target writes, ни preview/publication этим не разрешаются.

## T30 Auth BLOCKED; schedule доказан; T31 проверяет передачу — 14.11.2026

T30 принят/исполнен на16f38cc. Connect, BEGIN RO, server deadline, timezone и
identity PASS; compact Auth SELECT снова client timeout20.009s, target read не
достигнут. Попытка1/1, без fallback/записи. Receipt
`/root/bron-secrets/t30-release-receipt.json`, SHA
`7dbc5cbae788e0340c8498badf836dd3c4e0337e78c3ff2e186f88845f8b7904`.
T29 receipt SHA получен:
`bc32f26c6b6ac23ed86712762b72c046b50d4da92d3da8b9994fccae9a2a248c`.
Owner key helper доставлен, OWNER_ACTION_PENDING; его личная ветка T30 продолжается
без нового secret prompt и не удерживает подготовку независимого сетевого пакета.

Через независимый source SQL-путь координатор подтвердил: именно T30 SELECT уже
завершён, backend idle in transaction / ClientRead, без XID. Проверка типов locks
показала только16relation AccessShareLock и штатный virtualxid ExclusiveLock;
последний не является блокировкой записи таблицы. Строго идентифицированный наш
read-only backend завершён, pg_terminate_backend=true; рабочих данных не меняли.
Frontend close сам по себе не доказал server cleanup. Следующие probes используют
transaction-local idle timeout10s; текущий source freeze по-прежнему НЕ выполнен.

T22 schedule gate ЗАКРЫТ независимым readback: настоящий event=schedule run
[43533210497](https://github.com/bronservis51-bot/bron-franchise/actions/runs/43533210497),
точный main9815f74,14.11 00:17:42–00:17:50Z, success; public-services job success,
notify ожидаемо skipped. Причина предшествующей задержки API не установлена.
Cron/dispatch/variables/secrets не менялись; новый Telegram alert не нужен.

T31 — ограниченная синтетическая диагностика без Auth/business rows: один
canonical DNS IPv4, прежний CA/SNI/password callback, ответы128/512,8x64,1024,
4096,1MiB. При малых PASS и большом timeout разрешён ОДИН временный эксперимент
mtu1280/advmss1200 только отсутствующим ранее /32 к тому же peer; before-image
и exact inverse fsync ДО add. Default route/firewall/существующие маршруты не
меняются. Не помогло — exact remove/readback; помогло — временный маршрут явно
учтён до завершения миграции. PMTU пока ГИПОТЕЗА, а не установленная причина.
Только после полного dummy PASS — один Auth continuation на ТОМ ЖЕ IP, без Mac.

Параллельная подготовка завершила native proof transport-neutral atomic source
fence и exact full snapshot transport, а также guarded timestamp final-window core.
Это пока код, не gates: production fence, новые target writes и public/preview
не разрешаются ни подготовкой, ни T31. T12/T14/T18/T19/T21 PASS сохраняются.

## T29 закрыт; T30 — компактный Auth и личная проверка ключа — 14.11.2026

T29 отчёт получен: COMPLETE_WITH_BLOCKED_AUTH. Прямой source6543 дошёл до
read-only запроса Auth, затем PG_QUERY_READ_TIMEOUT; разрешённый запуск израсходован.
Fallback через Mac не выполнялся. VPS key --check READY и preview inputs PASS,
но ни независимое владение ключом, ни аварийный вход с другого устройства этим
не доказаны. Canonical receipt `/root/bron-secrets/t29-release-receipt.json`;
полный SHA нужно вернуть в T30, содержимое с секретами не публиковать.

Координатор через подключённый Supabase только чтением увидел собственный backend
диагностики idle in transaction / ClientRead после завершённого Auth SELECT.
Auth:16 строк, примерно19KB ответа. Это не доказательство медленного SQL: сервер
ждал клиента. Узко ограниченная попытка завершения именно этого backend не нашла
совпадения и никого не завершила; последующее чтение подтвердило его отсутствие.
Точная причина сбоя response path ещё не установлена; новых source writes нет.

T30 — один МАТЕРИАЛЬНО изменённый compact-запуск, не повтор T29: сервер отдаёт
точный timestamp в микросекундах и SHA256 canonical JSON ВСЕХ остальных полей.
UUID/timestamps/digests остаются только в RAM VPS; наружу — counts и timings.
7 unit + real PG17.12/pg8.23.1 native PASS доказывают эквивалентность сравнения,
но не закрывают production route. Только прямой VPS→6543, максимум один запуск,
никаких timestamp writes, full inventory, freeze, preview или публикации.

Независимая ветка T30 разрешает ЛИЧНЫЙ ввод владельца через телефон/второе
устройство в AdminVPS web console: `bash /root/bron-secrets/t30-owner-verify.sh`.
Wrapper проверяет старый helper и immutable T21 manifest; ключ только getpass,
decrypt→zstd-test на VPS, safe result root0600. На Mac нет ни key input, ни
ciphertext/plaintext. PASS crypto отдельно от подтверждения владельцем независимой
копии и личного second-device login. Если копии нет — OWNER_COPY_ABSENT, не читать
серверный identity ради формального PASS. Owner pending не задерживает Auth/отчёт.

Restore T21, Auth/RLS T12, пять пакетов T14, backup/status T18 и видимое Telegram
сообщение T19 переиспользуются. Schedule нового main остаётся отдельным PENDING.
Финальные freeze/delta/full audit и личная PWA-приёмка/публикация не выполнены.
Параллельно готовятся транспорт точной полной сверки и проверяемый обратимый
source fence; подготовка не является разрешением применить их в T30.

## T29 подготовлен: узкая Auth-диагностика и VPS-only key readiness — 14.11.2026

Владелец требует краткий сквозной статус в каждом сообщении: этап/подтверждено/
остаток/блокер/следующий шаг, без искусственных процентов. Правило закреплено AGENTS.
Среда координатора ready; startup error нет. T29 ещё НЕ выдавался/не исполнялся.

Новая явная граница владельца: не копировать roles.sql.zst.age или любые backup
данные на Mac без отдельного согласия. Такой copy был только в черновике T29;
не выполнялся. Выбран безопасный путь без запроса этого согласия: ciphertext
остаётся на VPS, helper --check на VPS, будущий независимый ключ вводится лично
в скрытый TTY через телефонную AdminVPS-консоль. Не читается серверный private key,
ключ/plaintext не пишутся в файлы или логи. T29 не разрешает --verify/owner prompt.

T28 реально использовал старый TLS reverse через Mac; его PASS сохраняется как
историческое доказательство. T29 данные через этот путь НЕ читает: только
canonical source6543 напрямую с VPS, прежние CA/SNI/password callback. При отказе
Auth BLOCKED, без Mac fallback; ключ/preview-metadata ветки продолжаются.

Auth helper6unit + nativePG17.12/realpg8.23.1 capture PASS: точные микросекунды
BigInt, остальные поля canonical PGJSONtext, missing/null/target-newer отдельные
counts, без UUID/парольных хешей/значений в output. No apply/finalFreezeAudit=false.
Key helper8unit + realage1.1.1/zstd synthetic correct/wrong-key PASS; реальный
owner custody proof не заменён синтетикой. Production admission core/runner
подготовлены отдельно и не входят в разрешённые эффекты T29.

Проверен путь публикации: appPages=workflow/main-only environment, landing=legacy/main;
существующий pages.yml всегда собирает. Минимум всего выпуска — после DB gates
один штатный publication build при закреплённом PR12 merge, вместо нового publisher.
Продуктовые src/public/vite/package/index inputs после e487ec не менялись; build
публикации имеет новую provenance/run и не выдается за прежние T14 file SHA.
Старая PWA требует transition static на прежнем origin ДО личной приёмки, пока
RF API IP-gated. Это должно быть явно включено в будущий пакет; T29 публикации нет.

## T28 завершён: канал PASS, осталась одна Auth-метка — 14.11.2026

T28 принят с commit4f13111 и canonical receipt
`/root/bron-secrets/t28-release-receipt.json`; mirror
`/tmp/bron-release-executor-20261113/T28-state.json`, оба0600/SHA-identical.
T26 SUPERSEDED_NO_EXECUTION_EVIDENCE, T27 SUPERSEDED_INTO_T28. Checkout/pins PASS.

Один управляемый restart source tunnel PASS, listener только127.0.0.1:15432.
Actual PG transport: connect5664ms, BEGIN523, server-deadline482, identity429,
1KiB448,1MiB1898,ROLLBACK637. Туннель оставлен для миграции, не новая постоянная
зависимость российского приложения. Вспомогательный SSHdummy упал на quoting
SyntaxError и не повторялся; actual PG bulk PASS закрывает нужный transport gate.

Inventory один exit0:62tables/4020rows с обеих сторон; только data:auth.users,
16/16users,1matchedrow отличается updated_at, missing rows0. Source window
22:34:24.228–22:35:19.411Z,target22:35:19.411–22:35:20.801Z. Это LIVE, не freeze.
Не исправлять timestamp ради промежуточного PASS: источник ещё принимает запись.
T29 установит направление и lossless равенство остальных Auth fields только чтением.

Backup status healthy=true, свежесть в пределах, TLS verified; HTTP503 для этого
maintenance endpoint ожидаем и не является backup failure. Ticket482050 недоступен
без owner session; не блокирует уже исправленный канал. Mac ghapi недоступен;
coordinator passive query всё ещё видит старый schedule43485875805, не новый T22.
Owner handoff T28 подготовлен: независимый key-proof требует code review;
второе устройство/AdminVPS/MFA требует владельца; phone/PWA ждёт private preview.

T21 full restore/T12 AuthRLS/T14 artifacts/T18 installation/T19 delivery REUSED.
Остались source admission+последняя дельта+final audit+Pause, подготовленная личная
приёмка/независимый ключ/аварийный доступ, затем public switch. Source/target writes0.
Production admission runner готовится отдельно; T29 не разрешает freeze/применение.

## T26 не подтверждён как запущенный; T28 снимает зависимость очереди — 14.11.2026

Исполнитель принял T27 в очередь, checkout не менял. По его read-only проверке
нет T26 receipt/process под /root/bron-secrets и локального T26 receipt.
Это не completion: coordinator не имеет права подтвердить исполнение T26.
Потерянная передача привела к ожиданию квитанции неподтверждённого старта.

Новый T28 явно поглощает ожидающие T26/T27 после проверки state/guards/logs/PID.
При отсутствии всех следов — SUPERSEDED_NO_EXECUTION_EVIDENCE, не PASS. При RUNNING
наблюдать старый процесс; при UNKNOWN сверить эффект, не повторять. Общий бюджет
restart/inventory остаётся один по aliases T26/T28. Прежние helpers/native proof
не меняются, новая функциональность/повторное восстановление не добавляются.

T28 canonical receipt `/root/bron-secrets/t28-release-receipt.json`, root0600;
локальное зеркало `/tmp/bron-release-executor-20261113/T28-state.json`,0600.
Исполнитель отправляет ACCEPTED и продолжает без ожидания ответного разрешения.
Никаких source/target writes, freeze, Pause, preview или публикации T28 не разрешает.

## Решение владельца: закрепить разбор и работать по Парето — 14.11.2026

Владелец запросил сохранить причины задержки и ускорить путь к полностью
работающему сайту, сохраняя качество. AGENTS/rollout-plan/local-access-handoff
закрепляют gate-first порядок, переиспользование PASS, очередь пакетов без
прерывания T26, укрупнение handoff и одну подготовленную личную приёмку.
Lessons фиксирует ошибки координатора, типы driver, network deadlines и пределы
исследованного server-side SHA fallback. Новые сервисы/изменения продукта не внесены.

T26 уже выдан на commit4fb62d0; итоговый EXECUTOR_REPORT пока НЕ получен.
Не повторять его actions и не менять checkout работающего процесса.
Следующая независимая ветка — подготовленный owner handoff; freeze/delta/final
strict/preview будут единым будущим пакетом после реальных prerequisites.

Координатор через Supabase get_project сейчас подтвердил source ACTIVE_HEALTHY.
Pause/restore tools доступны, но НЕ вызваны. Это снимает прежнее предположение
об обязательном owner browser login для общей Pause; эффект/право mutation ещё
не тестировались. Pause только после подтверждённого source fence и final audit.
Последняя пассивная проверка GitHub по-прежнему видит только schedule43485875805
на pre-PR14 main d61105e; T22 остаётся PENDING_OBSERVATION, не выдаётся за PASS.

## T25 маршруты BLOCKED; T26 — однократный ремонт временного канала — 14.11.2026

T25 один запуск exit2/25s, 00:18:05–00:18:30 МСК. Canonical session FAIL5007ms
SOURCE_ROUTE_FAILED; canonical transaction FAIL10002ms; existing reverse FAIL10001ms.
Ни один путь не прошёл общий10s probe; full inventory НЕ запускался.
Стадия отказа внутри connect/queries/bulk в T25 ещё неизвестна. Это не доказывает
отказ TLS или отсутствие сетевого доступа, поскольку deadline охватывал всё.
Helper/state/log/receipt сохранены root0600; cleanup PASS, source/target writes0.
T25 повторять нельзя. Дедлайн13ноября пропущен, релиз НЕ выполнен.

T26 подготовлен, ещё НЕ исполнен: прочитать существующий AdminVPS ticket482050
параллельно; проверить Mac→source TCP и Mac→VPS1MiB dummy без DB-secret;
один раз stop/start только выделенного ~/.ssh/bron-source-tunnel после проверки
отсутствия audit/freeze и границ wrapper. Не менять его код/SSH keys/прочие tunnels.
Затем отдельные deadlines connect/BEGIN/identity/small/bulk/rollback.1MiB bulk
должен занять<=10s отдельно от connect. При PASS один inventory; при FAIL
точная безопасная стадия, full inventory NOT_RUN. Секреты остаются только VPS.
Если уже полученный ответ провайдера и VPS TCP probe подтвердили открытие5432,
допустим --direct-session с тем же verified TLS/callback без изменения config-файлов.

Manifest `payloads/t26-sha256.json`.12 focused tests и native PG17.12/pg8.23.1
seven-stage/1MiB probe PASS, container удалён; это не PASS реального канала.
Freeze/admission draft не входит в пакет и не активируется. T21 restore/T19
delivery/T14 builds сохраняют PASS; новых scheduled runs T22 пока не наблюдалось.
Source freeze/final delta/audit/приёмка/publication остаются отдельными gates.

## T24: точный source timeout; T25 проверяет маршрут до полного чтения — 13.11.2026

T24 bundle/runtime/SSH PASS. Один запуск 225s/exit2, 23:36:46–23:40:31 МСК.
Безопасный failure context: source-readonly-snapshot, PG_QUERY_READ_TIMEOUT,
public.daily_revenue table_rows, ordinal43, elapsed60003ms. Inventory/diff ещё нет.
Source/target writes0, процесс/соединения закрыты, cleanup PASS; root-only receipt
`/root/bron-secrets/t24-delta-inventory-receipt.json` и одноимённый log сохранены.
Сами 225s не доказывают медленную БД: client deadline не отменяет backend query,
а очередной rollback мог дополнительно ждать. T24 повторять нельзя.

Координатор выполнил ТОЧНУЮ augmented projection + ORDER BY/LIMIT на настоящем
source через Supabase MCP в READ ONLY с SET LOCAL statement_timeout=8000.
Получены только агрегаты:2975 rows, value_bytes1828780, field_bytes1971596.
Запрос прошёл; текущих audit sessions/блокировщиков нет. Это не измерение VPS wire.
Отсутствующие FK indexes/RLS performance advisories не объясняют этот full scan;
schema/index changes для устранения данного отказа не выполнялись.

T25 подготовлен, НЕ исполнен: один bounded probe канонического source TLS
через5432,6543, затем существующий reverse15432. Каждый путь максимум10s,
реальный READ ONLY/identity и1MiB dummy-response; вывод только status/bytes/time.
Полный inventory разрешён только после PASS пути. Секрет/CA callback прежний,
защищённые файлы и factory не меняются.6543 только для read-only транзакции,
не для freeze/control. В audit BEGIN теперь SET LOCAL statement_timeout=30000;
при client timeout собственный stream закрывается, новый rollback не зависает.
Native PG17.12/real pg8.23.1 PASS,12 focused tests PASS, fixture удалён.
Manifest `payloads/t25-sha256.json`; source-freeze/публикация не разрешены.

T21 restore и T19 owner-confirmed delivery сохраняют PASS. T22 новый schedule
ещё PENDING_OBSERVATION. Оставшиеся freeze/final audit/телефон не позволяют
достоверно обещать public release до полуночи по Москве; проверки не ослабляются.

## T23 BLOCKED; T24 исправляет driver coverage и безопасную диагностику — 13.11.2026

T23 bundle/pins/SSH/preflight PASS; один readonly запуск exit2 на
source-readonly-snapshot с DELTA_FAILED. Inventory/strictMatch/diff ещё не получены.
Source/target writes=0, процессы и соединения завершены, cleanup PASS.
Закрытые VPS helper/state/log/receipt сохранены, локальный receipt
`/tmp/bron-release-executor-20261113/T23-state.json`. Повтор T23 запрещён.
Причина этого конкретного source-отказа пока UNKNOWN; token/пароль не обвиняем.

Независимо воспроизведён другой дефект: array_agg(attname) даёт name[];
pg8.23.1 получает строку, в отличие от psql→JSON bridge. Это ломало последующий
PK-diff, но не объясняет прежний этап отказа. T24 явно приводит attname::text,
проверяет массив и сообщает только fixed error class/SQLSTATE, side, query ordinal,
operation/object и elapsedMs. Исходный SQL, error message/detail/hint/stack не выводятся.
Первый failed query context сохраняется после rollback.

Native PG17.12 через настоящий pg8.23.1 wire protocol PASS:11 synthetic tables,
NOSUPER source role/READ ONLY REPEATABLE READ, exact обычный auditor capture,
PK/multiset diff без потери точности, настоящий code-less query timeout и redaction;
fixture удалён. Focused ops7 PASS. Manifest `payloads/t24-sha256.json`.
T24 ещё НЕ исполнен; он только читает и не меняет runtime auditor или данные.

T21 full cold restore PASS и T19 owner-confirmed Telegram delivery переиспользуются.
T22 новый schedule пока PENDING_OBSERVATION; наблюдение не тормозит T24.
Обратимое закрытие новых source-соединений и дренирование старых изучается отдельно;
никакой freeze, ACL mutation, перенос или preview до отдельного пакета не разрешён.

## T22 завершён; T23 только readonly-инвентаризация дельты — 13.11.2026

T22 bundle/PR head/base/diff/CI PASS. PR14 squash merged в main
`9815f74d055f746f419bb103b8459f03738c73e6` в 19:00:08 UTC (22:00:08 МСК).
Cron `2-59/5 * * * *` прочитан обратно, 12 тиков/час сохранены.
PR CI43484294098 и post-merge push43487999015 SUCCESS; Pages не публиковался.
Variables/secrets/client settings/VPS не менялись. Local receipt
`/tmp/bron-release-executor-20261113/T22-state.json`, mode0600.
Настоящий schedule43485875805 на прежнем main d61105e был успешным, но не
подтверждает новый cron. Новая ревизия остаётся PENDING_OBSERVATION; это не
блокирует readonly T23. Не dispatch/toggle/change cron повторно.

T23 подготовлен, ещё НЕ исполнен: один ограниченный проход через исправленный
обычный auditor, отдельные READ ONLY REPEATABLE READ snapshots source/target.
Только counts/имена столбцов/sequence equality, без строк, UUID, хешей и секретов.
Exit0 означает завершённую инвентаризацию, strictMatch=false честно отражает
дельту, а finalFreezeAudit всегда false. Это не snapshot одновременной остановки.
Native PG17.12:11 synthetic tables, exact unchanged auditor capture, UUID composite
PK, adjacent bigint, 20-place numeric, microsecond timestamps, duplicate-aware
multiset и redaction PASS; container удалён. Focused ops tests5 PASS.
Manifest `payloads/t23-sha256.json` задаёт один readonly запуск и runtime pins.
Не повторять T21 restore, T14 builds, T18 install или T19 Telegram input/message.
Freeze, перенос дельты, private acceptance и public switch ещё не выполнены.

## T21: полное восстановление PASS; следующий T22 только для расписания — 13.11.2026

RESTORE_GATE PASS: ровно один запуск11.513s/exit0, STRICT_MISMATCH_GROUPS=[];
все семь postchecks и aggregate passed=true. Native globals/preloads, builtin
plpgsql exact/no DROP, database metadata/ACL/labels/role settings совпали;
T11_TARGET_RESTORE_PASS получен. Container/socket/process cleanup PASS.
Canonical runtime auditor атомарно заменён на
`a5306390fa06db03665caaaa988cadf472f17c349538712f03fa31f794d6bdea` root0600,
beforeimage `/root/bron-secrets/t21-migration-audit-before.mjs`.
Закрытые receipt/log: `/root/bron-secrets/t21-restore-5684c16-receipt.json` и
`/root/bron-secrets/t21-restore-5684c16.log`, root0600. Повторять эту репетицию не нужно.
Права БД, входной manifest, encrypted artifacts и source не менялись.

Schedule остаётся PENDING_OBSERVATION. Отдельный cron-only PR14 OPEN с head
`9115bdc0a0a0ec695d073006a91cb018c1d08d88`, base main
`d61105e0d90213bec22492de278c8125c3b2b886`, CI43484294098 SUCCESS.
Единственный diff: availability.yml `*/5` → `2-59/5`, те же12тиков/час,
никаких изменений frontend/variables/secrets/permissions. Main ещё не менялся.
T22 получает собственный manifest/authorization; до него merge/cron mutation
не разрешены. Успех — настоящий schedule event после merge, не manual dispatch.
Два–три тика наблюдаются параллельно дальнейшему preflight, без повторных toggles.

Остались фактическая дельта, подтверждённая остановка всех путей source-записи,
финальный строгий audit исправленным auditor, закрытая приёмка и public switch.
Независимые ключи/аварийный доступ и реальный телефон/PWA остаются в обязательной
приёмке. Готовые T12/T14/T18/T19/T21 результаты переиспользуются.

## T20: точный sequence ACL diff; T21 исправляет тип объекта в аудиторе — 13.11.2026

Один controlled restore exit2/12s: 63/63 relations, отсутствующих объектов нет.
Только app_private.procurement_event_id_seq и procurement_request_number_seq
различались по relacl: 3 canonical source edges против 1 restored, по 2 removed.
Все семь readonly postchecks PASS: global roles, extension metadata, Vault logical,
Storage tree, primary data/roles/database unchanged. Cleanup PASS; лог/receipt
`/root/bron-secrets/t20-restore-08254d9.log` и
`/root/bron-secrets/t20-restore-08254d9-receipt.json`, root0600. Никаких ACL-правок
и повторов T20 не было.

Причина доказана native PG17.12: canonicalAcl передавал acldefault uppercase `S`
для sequence, но это код FOREIGN SERVER (default owner USAGE, один edge).
Корректный sequence code — lowercase `s` (SELECT/UPDATE/USAGE, три edges).
Source явный default ACL и restored NULL имеют одинаковые реальные права;
pg_dump законно сохраняет default как NULL. Native identity/serial roundtrip,
реальные GRANT/REVOKE/empty ACL и lowercase normalization PASS. Auditor меняется
на один символ; c.relkind='S' остаётся прежним, ни одно поле не исключается.
Новая копия/supplement или изменения реальных прав не нужны.

Regression tests сначала RED на старом коде; после исправления focused13/13,
полный DB suite158 и ops27 PASS. Helper repinned к новому auditor SHA. T21 должен
атомарно заменить только canonical runtime auditor с beforeimage и выполнить
одну новую проверку копии. До её результата restore gate остаётся FAIL.
Исходный manifest/зашифрованные артефакты/S3 policy не менять.

Schedule новой main не наблюдался к 21:26 МСК. Active/default main и большие
пропуски до PR13 подтверждены; причина merge-registration не установлена.
Готовится отдельное предложение сместить пяти-минутные тики вне начала часа;
активное расписание T20/T21 не меняют. Любое изменение требует отдельного T22
с собственным manifest; manual/synthetic event не считается schedule.

## T19 закрыт; уточнение протокола без повторного исполнения — 13.11.2026

Один разрешённый cold restore завершился FAIL на строгой сверке:
только `schema:relations`. Builtin plpgsql exact/dropExecuted=false, native globals,
preloads и database metadata/ACL/labels/role settings PASS. Temporary container,
socket и Node process удалены. Остальные postchecks после strict throw ещё не
считаются подтверждёнными. Лог хранит лишь группу hash mismatch; per-object diff
не сохранён, уничтоженная временная БД не доступна для дальнейшего чтения.
Следующий distinct package нужен для контролируемой диагностики; T19 не повторять.

TELEGRAM_RECIPIENT/DELIVERY PASS: имя chat secret проверено, один fresh /start
отправлен, hidden helper завершён; один test alert принят Telegram и виден на
скриншоте владельца. Повторный secret entry/message/start не нужны.
Владелец отдельно подтвердил в этом чате видимость новой тестовой тревоги в
новом приватном чате бота и получение скриншота. Это прямое owner confirmation
для T19 delivery, дополнительно к accepted Send и отчёту исполнителя.
MONITOR_MAIN PASS: PR13 squash merged в main
`d61105e0d90213bec22492de278c8125c3b2b886`, public variables проверены, APP_URL/VITE_*
сохранены, Pages не запускался. Availability run
[43476279439](https://github.com/bronservis51-bot/bron-franchise/actions/runs/43476279439)
дал пять PASS, HTTPS/Send PASS. Это текущие source frontend/API и RF backup status;
российский кабинет/API пока maintenance. Monitoring flag включён/read-back true.
Scheduled run merged revision ещё не наблюдался; прежний source schedule не
закрывает эту проверку. Состояние PENDING_OBSERVATION не блокирует независимую
диагностику restore и не превращается в PASS. Уже выполненные T18/19 действия
сохраняются по квитанциям; ожидание schedule не требует повторного test dispatch.

Владелец потребовал один preflight bundle/checklist на пакет, native PostgreSQL
proof до PG-sensitive задач, per-action receipt и продолжение независимых веток.
Draft обновления `local-access-handoff.md` помечает T01 и старую точку продолжения
архивом, определяет PASS/FAIL/BLOCKED/UNKNOWN/REUSED, prerequisites и безопасное
возобновление. Никакие runtime pins/one-run/scope T19 не менялись.
Разбор handoff: явное «ждать следующего пакета» объясняет остановки после отчётов;
технический следующий шаг готовит координатор. Старый /start не равен свежему
update; просмотр доступного чата выполняет executor, owner нужен для реального
hidden input/MFA/личной приёмки. Pending schedule допускает финальный отчёт с
отдельным незакрытым статусом. Действия и гейты этим не расширяются/не ослабляются.

До следующего пакета в одном local cached PG17.12 fixture проверены прежние
ошибки reserved schema42939, missing plpgsql42704 и bootstrap grantor42501,
а также исходный DB metadata restore. Только synthetic data/network none/tmpfs;
owned container удалён. Это native preflight, не полное восстановление Supabase.

## T18: HTTPS-контроль установлен; найден искусственный DROP plpgsql — 13.11.2026

Один full restore exit2/10s дошёл до pg_cron1.6.4 (pg_catalog/supabase_admin),
затем SQLSTATE42704. Причина воспроизведена на native PG17: helper предварительно
удалял plpgsql; первый DO в официальном pg_cron install script требует этот язык,
хотя control не объявляет builtin dependency. T19 сохраняет свежий plpgsql ТОЛЬКО
при точном совпадении name/version/schema/owner с архивом и учитывает его в
dependency order. DROP/recreate/переписывание владельца не нужны. 23 restore tests
и native DO-after-DROP proof PASS; полный actual restore всё ещё НЕ PASS.

HTTPS_BACKUP_STATUS PASS: pinned helper/unit/maintenance Caddy/RO mount установлены,
watchdog/freshness/timers PASS; пересоздан только web, ID всех шести backend и
Compose model сохранены, default internal, host DB bindings loopback. Public health
endpoint HTTPS503 выдаёт ровно три поля с healthy=true. Координатор независимо
прочитал его через HTTPS: возраст проверки399s, копии3100s. Root-only beforeimages
T18 сохранены. Source/preview/product не менялись.

Telegram secret chat ID отсутствует. В истории есть owner /start15:35, но executor
НОВЫЙ /start не отправлял; getUpdates не хранит уже подтверждённые сообщения.
T19 явно разрешает одну свежую команду тому же боту, даже если старая есть в
истории, затем существующий helper с проверкой private owner identity. Дополнительный
инструмент чтения auth storage/новый token/guess ID не нужен без фактического
блокера этого пути. Секреты bot/chat разрешены только в repository Secrets; PAT нет.

Подготовлен отдельно [monitor-only PR13](https://github.com/bronservis51-bot/bron-franchise/pull/13),
head e68bcc7bf1f13f399f2392d63a6e46fed56c67ac, base main6bfdf52. Все семь изменённых
путей входят в Pages paths-ignore; frontend/package/SQL не меняются. CI и
независимый review PASS. BRON_BACKUP_STATUS_URL позволяет проверять RF status,
сохранив source APP_URL/VITE_* до финального окна. Merge/vars/доставка/расписание
пока не выполнены. Ops PR12 не сливать до допуска релиза.

## T17: создание БД пройдено; reserved schema и подготовка мониторинга — 13.11.2026

Full run завершился exit 2 за 10 секунд: globals/preloads и native DB creation
пройдены; bootstrap схем/расширений остановлен SQLSTATE42939. На настоящем PG17
воспроизведён точный отказ `CREATE SCHEMA IF NOT EXISTS pg_catalog`, хотя схема
существует. T18 сначала читает pg_namespace, создаёт лишь отсутствующие обычные
схемы, меняет owner только при расхождении и проверяет результат. Добавлены
точные whitelisted фазы и технические extension metadata. 20 ops tests PASS.
Полный Supabase17.11 fixture в облаке НЕ выполнен: Docker VFS не распаковал образ
по лимиту места; повторных pull/prune не делали. Проверка полного восстановления
остаётся на уже имеющемся exact VPS image; gate пока НЕ PASS.

Source/production без изменений, контейнер/socket репетиции удалены, timers и
freshness/watchdog PASS, три hostname HTTPS503/TLS0. Токен проверен отдельно:
[43458395170](https://github.com/bronservis51-bot/bron-franchise/actions/runs/43458395170)
дал TELEGRAM_BOT_TOKEN_VALID, Send SKIPPED. Владелец разрешил также
BRON_TELEGRAM_CHAT_ID; secret ещё отсутствует. AUX helper подтвердил бота, но
получил ноль уникальных private /start. При действующей Telegram-сессии исполнитель
может отправить /start тому же @BronServisBackupHealthBot и продолжить настройку;
пустой getUpdates не доказывает необходимость личного входа/MFA.

Подготовлен pull-monitor без PAT/SSH-secret на VPS: watchdog пишет только
checked_at/last_backup_utc/healthy, Caddy отдаёт один точный HTTPS path с HTTP503
в maintenance/preview и HTTP200 в production. Остальные app/API остаются закрыты.
18 Python + 6 Node tests, real Caddy2.11.8 validate/32 loopback checks и Compose
isolation PASS. Это подготовка, ещё не установка/доставка/активное расписание
GitHub main. Сам `--backup` не обновляет heartbeat watchdog. Изменения не требуют
переноса bot token на VPS или нового GitHub PAT. Manual alert имеет явный текст
тестового уведомления; отсутствие credentials считается ошибкой отправки.

## T16: архив прочитан; исправляется выбранное оглавление — 13.11.2026

Один full run завершился exit 2 за 10 секунд. Globals, точные preloads, полная
расшифровка в tmpfs и чтение оглавления PASS; зависания T15 больше нет. Остановка
`read-database-archive-toc / REHEARSAL_CREATE_DATABASE_ARCHIVE_REQUIRED` до импорта
данных. Исходный manifest T12 SHA256
`a1f6a1c9f187bd586aeec5d0189adc4f6648df29acb8c68490bf4fc77541d6b9`.

Исходники PostgreSQL 17 и отдельный настоящий PostgreSQL 17.12 показали: обычный
`pg_restore --list` выводит выбранные записи и скрывает DATABASE/PROPERTIES без
`--create`. В custom-архиве DATABASE присутствует независимо от producer -C;
пересоздание backup не нужно. Также properties-only повтор с --create пытается
снова создать DATABASE независимо от use-list. Правильный порядок проверен на
изолированном fixture: один начальный --create pass для DATABASE, PROPERTIES,
database ACL/comment/security label, затем полный import БЕЗ --create. Owner,
ACL, comment, connection limit, DB/role settings и данные fixture совпали.
Это ещё не full restore цели Supabase 17.11; соответствующий gate остаётся открыт.

Исправленный helper проверен 17 ops-тестами; нативный fixture сохранён в
`tests/ops/restore-native-pg17.py` и прошёл на PostgreSQL17.12. Он использует
только synthetic data, cached image, local Docker socket и tmpfs без портов;
контейнер удалён. Проверяется также семантический database ACL (defaults только
для NULL), owner/locale/connection limit, shared database comment/security labels
и настройки БД/ролей; после run рабочие метаданные должны остаться неизменными.

Контейнер/socket T16 удалены; timers/freshness/watchdog PASS, публичные домены
HTTPS503/TLS0. Source, preview и production не менялись. Исполнитель подтвердил:
BRON_TELEGRAM_BOT_TOKEN уже сохранён разрешённым owner hidden input, имя секрета
прочитано обратно; повторный ввод не нужен. Chat ID secret/PAT не разрешены и не
созданы. Подготавливается token-only getMe в Actions без получателя/сообщений;
доставку этим не считать подтверждённой.

## T15: роли восстановлены; зависание чтения оглавления — 13.11.2026

Один full run на прежнем manifest T12 завершился exit 2 за 310 секунд.
`T14_NATIVE_GLOBALS_RESULT`: exitStatus=0, GLOBALS_RESTORED,
bootstrapCreateSkipped=1; точные security preloads восстановлены. Исправление
OID10 подтверждено настоящим запуском. До full import/strict comparison дело
не дошло: следующий `pg_restore --list` завершился 0, zstd остался без читателя
до таймаута; pipeline [0,null,0]. Это воспроизведено синтетическими процессами.
Прежний phase label оставался preloads и неверно обозначал место отказа.

Для T16 готовится полная расшифровка database.dump в закрытый tmpfs временного
контейнера с проверкой всех producer exit codes; все pg_restore-проходы будут
читать один seekable-файл. Plaintext на диск хоста не пишется, memberships и
строгие критерии не ослабляются. Полное восстановление пока НЕ PASS.

Подготовленный T16 helper использует один tmpfs-файл для всех четырёх проходов;
ошибки файлового pg_restore сохраняют только безопасные exit/status/SQLSTATE/class.
15 tests PASS, включая реальные процессы с ранним consumer exit0, последующим
producer exit7 и немедленным consumer exit3. Предыдущие проверки OID10 и утечки
private SQL сохранены. Это проверка исправления, не actual restore PASS.

Временный контейнер/socket T15 удалены; backup/watchdog enabled/active,
freshness/health PASS, все три публичных hostname HTTPS503/TLS0. Пять ранее
проверенных пакетов не пересобираются. Source/freeze/preview/publication без изменений.

Anonymous GitHub Actions probe [43451655777](https://github.com/bronservis51-bot/bron-franchise/actions/runs/43451655777)
успешно проверил HTTPS Telegram; Send step SKIPPED, credentials не использовались.
Владелец отдельно разрешил ТОЛЬКО bot token как repository secret
BRON_TELEGRAM_BOT_TOKEN. Токен пока не введён. Разрешения хранить chat ID как
secret и создавать/хранить GitHub PAT нет; relay не активировать. Для разрешённого
токена готовится локальный hidden-input helper без записи токена в файл/argv/логи.

## T14: точный отказ GRANTED BY; подготовлена коррекция OID10 — 13.11.2026

Full restore за 9 секунд остановился до импорта данных: native globals psql exit3,
SQLSTATE42501, GRANT_ROLE, исходная строка117, роли anon/authenticator/supabase_admin,
marker0050. Bootstrap был настоящим superuser, оба preload пустые. Версия о
достаточности отключения Supautils не подтвердилась; временный контейнер/socket
удалены, source/рабочая цель не менялись.

На настоящем PostgreSQL17.5 воспроизведено правило: явный GRANTED BY для обычного
grantor без ADMIN option не проходит даже с SUPERUSER; тот же supabase_admin
с bootstrap OID10 проходит без дополнительных memberships. Случайное имя initdb
пользователя в нашем стенде занимало OID10 и ломало воспроизведение исходного
grantor. Это ошибка стенда, а не доказательство повреждения копии.

T15 сохраняет исходное bootstrap-имя из архивной конфигурации/immutable image,
проверяя имя/SUPER у primary OID10. Пропускается только уже выполненный initdb
bare CREATE этой роли; все ALTER/password/GRANTED BY сохраняются. Дополнительно
проверяются все атрибуты/пароли ролей в RAM и полный pg_auth_members с grantor и
ADMIN/INHERIT/SET, без исключений. 12 offline tests и интеграция helper на PG17.5
PASS; полный actual restore17.11 пока НЕ PASS.

Все пять архивов доставлены в закрытый `/opt/bron/stage/release-e487ec8/`, SHA и
manifest/files проверены. AppleDouble metadata валидирована и не распакована;
только manifest-listed static files. Preview Caddy2.11.8 actual validate:
тестовый IP exit0, пустой allowlist exit1; preview не применён. Mac system DNS и
1.1.1.1 теперь согласны по всем трём A; HTTPS503/TLS0, backup/watchdog PASS.
Согласие на Telegram→GitHub credential scope ещё не получено. Для независимой
проверки маршрута подготовлен workflow probe_only=true: без secret env и отправки.

## T13: откат подготовлен, причина globals ещё уточняется — 13.11.2026

Диагностика завершилась exit 0 как диагностика, НЕ restore pass. Внутренний psql
по-прежнему exit 3, SQLSTATE 42501 / ROLE_PERMISSION; bootstrap current/session
совпадают, rolsuper/is_superuser=true. Номер команды не был получен. Причина не
доказана только этими флагами; guards на рабочей цели не менялись. Временный
контейнер/socket удалены, primary baseline совпал.

Для T14 подготовлен нормальный cold-bootstrap порядок: initial native cluster
без shared/session preload → globals → точная исходная конфигурация и restart →
проверка preloads/изоляции → полный restore. SQL-маркеры в закрытом процессе
идентифицируют команду при отказе без вывода SQL/password material. На рабочую
цель этот порядок не применяется. Syntax и 9 offline tests PASS; actual run впереди.

Rollback-only build PASS; три target архива T12 неизменны. Source app e487ec8,
landing base fb5210c6. Готовы два дополнительных приватных архива:

| Bundle | Manifest SHA256 | Archive SHA256 |
| --- | --- | --- |
| app-source-rollback | 792f8ab3a9dde77fed8ce958ef5af1fddf5f2b85db9c0dc8fcb0a816ec16f1d2 | 708da93efb467d371a856e57eb6919d431476e80325ca6396dbe896d65409e72 |
| landing-source-rollback | 9634bc0e9df9f976c3c100e75cdbe831625d206cd26a1a615cebe8371cdc7a62 | cf7c79f873eb3d8dc851a9808d51c92499375f3753174f0098764ec33bff836e |

Backup/watchdog enabled/active, freshness/health PASS. Source keys активны.
Из облачной среды отдельные curl по обычному DNS всех трёх доменов дали exit 0,
TLS verify 0 и HTTP503. Mac curl exit6 требует локального разбора, публичный DNS
не менять по одному локальному отказу. Private-preview Caddy/override подготовлены,
но не применены: cold restore/final freeze/audit и приёмка ещё впереди.
Telegram credential relocation/PAT/Actions secrets всё ещё ожидают явного согласия.

## Фактический результат T12 и уточнения — 13.11.2026

Настоящие GoTrue-сессии четырёх существующих пользователей, все семь DB/RLS-групп,
HTTP роли/своя-чужая область и отзыв JWT/refresh — PASS. Trial sessions удалены,
Auth beforeimages восстановлены, target snapshot неизменён. Последующая полная
source/target сверка **exit 0**. Эти проверки повторять не требуется.

Новая копия `/var/backups/bron-franchise/target-20261113T133022Z-c4d9bbfd/manifest.json`
создана штатным сервисом, S3 upload/read-back SHA PASS. Isolated restore остановился
на restore-globals: producer/decrypt exit 0/0, psql exit 3, классификация PERMISSION.
Причина ещё не установлена; guards не отключались. Временный контейнер/socket
удалены. Доставка, версия расширений, Vault и данные из этой копии пока НЕ
считаются восстановленными. Backup/watchdog timer и freshness/health PASS.

Addendum исправляет первоначальный build BLOCKED: найден существующий точный
dependency tree с правильным package-lock/npm ls, без установки. Builder exit 0.
App source commit `e487ec88120056a54078c3ff1d9ff13d9245ac36`, landing base
`fb5210c6de3ac6df93bad2ddf0306a1856e98b73`; три готовых приватных архива:

| Bundle | Manifest SHA256 | Archive SHA256 |
| --- | --- | --- |
| app-root | e7e9acc8c54631d54b095dd6448130d38266491ab3f810f7bb6affe046efc1c4 | 5cbb2f61ff84f758efe35fac0be5ecb1e0332d706a36599804b9d5e6d5c4d61a |
| app-legacy | 19e937cfb67f0fbf408cff88d9777403b1f0ab63ab486a1e0e1362ddcdaa38e0 | 377ddac6b7eb210cad2af6007048430088e289c13d66a19ca7bbad3da066d4ab |
| landing-root | 4c3f2b8efd9be02ecc089a1b44a5d86d7cb830e5c685c9f3246c38c494e081b8 | 29c62cd56dd6d802feee6e0c2901dae90b91dea2e63e6e226879bb81d3c05abe |

Source rollback пока не собран: локального Supabase connector нет, background
dashboard отклонён инструментом `Capability is not available: visibility`.
Это не отказ аккаунта. Облачный Supabase connector подтвердил действующий legacy
anon. Его публичная настройка передана в `payloads/source-rollback-client.public.json`
для rollback-клиента; это НЕ service_role/secret key. Временная Actions Variable
не создавалась: облачный GitHub integration вернул 403 на Variables API.
В builder добавлен rollback-only режим: три российских архива сохраняются.

api.github.com с VPS HTTPS200; глобального IPv6 нет. Telegram credential, PAT и
Actions secrets не созданы/не перемещены. Согласие на новый credential scope
GitHub relay ещё не получено. Все новые домены/API остаются maintenance503;
source keys сохраняются активными до проверенного отката и финального окна.

## Результат T09; T10/T11 и граница credential scope — 13.11.2026

T09 подтвердил: ровно три target Auth timestamps изменены guarded-транзакцией,
закрытая beforeimage fsynced; полный post-audit **exit 0**. Проверки DB/RLS
BLOCKED из-за отсутствия подходящих существующих сессий/групп на цели, anonymous
grant/read-denial PASS. Внутренний gateway PASS: Auth health/settings, запрет
анонимного чтения, валидация RPC и неизменность row counts. Вход не проверен.

Первый target-backup через systemd **exit 0**, S3 upload/read-back SHA и watchdog
PASS, оба timer enabled/active. Репетиция холодного восстановления этой новой
формы копии ещё не выполнена. Для неё подготовлены точные versions/owners
расширений в manifest и native pg_dump --create с DATABASE PROPERTIES;
нужна новая копия и фактический запуск isolated restore, а не повтор старой копии.
Staging-кандидаты 5d134b5/fb5210c6 не имеют независимого provenance; подготовлен
изолированный builder из закреплённых git commits с SHA manifests.

T10: владелец выполнил /start; hidden-input wrapper вернул TELEGRAM_SETUP_FAILED,
VPS config не создан. api.telegram.org resolves, IPv4 TCP443 timeout; github.com
HTTPS200, OUTPUT ACCEPT. Ошибка не доказывает неправильность token; повторный
ввод до проверки маршрута не нужен. T11: SSH и таймеры работают; owner-login
handoff отсутствует, phone/VNC и внешнее хранение recovery key не подтверждены.

Предложен GitHub Actions relay на существующем availability workflow. Это
**изменяет согласованный T10 scope хранения**: bot token/chat ID будут в Actions
secrets, VPS получит отдельный fine-grained GitHub token с Actions read/write
только для bron-franchise. Эта permission шире одного dispatch endpoint;
клиент ограничивает фактически вызываемый endpoint. До явного подтверждения
владельца НЕ создавать PAT, НЕ загружать Telegram credentials в GitHub и
НЕ активировать relay. Код и workflow готовятся для review; независимые
Auth/build/restore проверки продолжаются, публичные сайты/API остаются 503.

## Уточнение владельца после поручения T09 — 13.11.2026

Для тревог выбран Telegram; существующего бота нет, его создание и настройка
поручаются локальному Codex. Личный вход/MFA запрашивается только если сервис
потребует его. Bot token и chat ID сохраняются только в закрытой конфигурации VPS.
Реквизиты оператора и политика для анкеты явно перенесены владельцем после релиза;
они больше не блокируют текущую публикацию. Остальные проверки данных/доступов,
резервирования и перехода пользователей сохраняются. T09 выдан; его результат
на момент этой записи ещё не получен.

## Выполнено T08; подготовлен T09 — 13.11.2026

Исполнитель подтвердил строгую сверку новым auditor: exit 1 только
`data:auth.users`. Все 16 UUID присутствуют на обеих сторонах; у трёх строк
только `updated_at` новее на source. Auth-триггер 1/1, логическое содержимое
Vault 1/1, cron 2/2 совпадают; Storage — один бакет и ноль объектов с обеих сторон.
Диагностика read-only, без входов/изменений БД. Изоляция/идентичность цели подтверждены.

DNS A всех трёх доменов указывает на российский VPS. Запущен только maintenance
web; backend не пересоздавался и остаётся internal. TLS проверен с обычным DNS
на Mac: все 15 hostname/path проверок дали 503, также прошли 15 SNI проверок.
VPS resolver местами возвращал curl exit 6; запросы DNS и внешние проверки прошли.
Это подготовленный HTTPS, а не опубликованный кабинет/API/лендинг.

На Free-проекте source доступна общая Pause project, Data API включён, для
современных API keys доступен Delete. Настройки не менялись, freeze не начинался.
Target Auth содержит правильные hostname, signup выключен, email включён,
anonymous выключен; SMTP не настроен. Автоматических target-копий и канала тревог нет.

Подготовлен target-only T09: предварительная полная сверка, проверка ровно трёх
отличий времени при совпадении всех остальных полей, закрытая beforeimage с fsync,
три guarded UPDATE одной транзакцией, повторная полная сверка. Отдельные read-only
проверки существующих ролей и внутреннего gateway запускаются только после exit 0.
Изолированные проверки reconciliation 8/8, DB/RLS 7 групп и отрицательные случаи,
HTTP guards 5/5 — PASS. Это подготовленные сценарии, ещё не результат на VPS.

Подготовлены регулярный encrypted target-backup через docker exec без Mac и
независимый watchdog; 32 Python-теста PASS. Установка/первый upload/read-back,
штатные запуски таймеров и реальная доставка тревоги ещё не выполнены. До выпуска
сохраняются финальное окно/дельта, Auth-вход, переход старых origin и приёмка.
Текущая человеческая последовательность теперь в [rollout-plan](../rollout-plan.md).

## Проверенная сверка T06 и диагностика T07 — 13.11.2026

Локальный исполнитель подтвердил успешный read-only probe цели и реальный
запуск строгой сверки с исправлением ACL из `c128f9b`. Exit 1: только
`data:auth.users`, `schema:constraints`, `schema:policies`.

T07 выполнил отдельные repeatable-read/read-only транзакции с откатом. В Auth
16/16 пользователей, нет source-only/target-only UUID; у трёх строк отличается
только `updated_at`. Направление изменений и причина пока не установлены;
поле не исключалось из сверки, записи не исправлялись. Constraints 257/257 и
policies 60/60: при одинаковом `search_path=pg_catalog` различий нет. Исходные
пути подключения различались видимостью схемы `auth`.

Auditor теперь задаёт `SET LOCAL search_path=pg_catalog` внутри своей транзакции,
сохраняя все проверки и настройки вызывающего после завершения. Регрессионный
тест проверяет разные исходные пути, восстановление пути и обнаружение настоящей
замены FK/RLS. Полный набор **328/328**, typecheck/build PASS. Новый SHA256:
`d63fbef0ab6fbed0bb3d09ed6d067ca5f7753d47a981bdb4c4bc8a4719468931`.
Это исправление ещё не доставлено на VPS и не является migration pass.

Установленная среда исполнения: Node
`/opt/bron/node-v22.23.5-linux-x64/bin/node`, private workspace
`/opt/bron/audit-runtime-c128f9b`, зависимости из уже существовавшего
`/opt/bron/rehearsal-audit.exfSfv9a/node_modules`; npm install не требовался.
Target URL строится в памяти из закрытой конфигурации контейнера. Для проверки
адреса PostgreSQL используется `host(inet_server_addr())`: текстовый cast
возвращал адрес с `/32`. Эти препятствия запуска устранены, повторный поиск
Node/пароля/зависимостей не нужен.

Auth-входы, запись в БД, freeze, DNS/Pages и публичное переключение в T01–T07
не выполнялись. Следующий этап: направление временных отличий, Auth-триггеры,
логическая сверка Vault, конфигурация Auth и повторная строгая сверка новым
auditor; независимо готовятся окончательный freeze и эксплуатационный допуск.

Для этого прохода подготовлен временный [payload T08](payloads/t08-readonly-diagnostics.mjs).
Он запускается из private runtime на VPS, проверяет идентичность/изоляцию цели,
читает Auth/Vault/cron/Storage только в read-only транзакциях и затем вызывает
полный auditor. Вывод содержит только счётчики/имена полей и метаданные триггеров;
значения пользователей, Vault, команд cron и секретной конфигурации не выводятся.
Payload не исправляет данные и не меняет критерии совпадения.

## Критическая проверка передачи — 13.11.2026, 11:07 MSK

Проверены изменения `a1e4300..417283c`, результаты CI и source-каталоги в явных
read-only транзакциях. Из облачной среды файлы/журналы VPS не прочитаны;
серверные кандидаты и `Matched 82` по-прежнему подтверждены отчётом исполнителя.

**Исправлен P1 в сверке ACL из `5d134b5`.** `canonicalAcl` приравнивал пустой
массив прав `{}` к `NULL`. В PostgreSQL `NULL` означает default privileges,
а `{}` — явно пустые grants; у функции defaults включают `PUBLIC EXECUTE`.
Изолированный тест подтвердил изменение реального доступа, которое прежняя
нормализация пропускала. Теперь `acldefault` подставляется только для `NULL`.
Сортировка grants и корректная нормализация grant option владельца сохранены.
Добавлены проверки функций и таблиц с реальными `has_*_privilege`, в обоих
направлениях. Целевые тесты 10/10; полный набор **327/327**, typecheck/build PASS.
QA build использует подставные URL/ключ; его не публиковать.

Это **не доказательство неправильных прав на восстановленной цели**. В текущем
source пустых объектных ACL функций/отношений из области сверки нет; target
не проверен. Однако старый `Matched 82` недостаточен для подтверждения прав.
Следующее серверное действие: сохранить его журнал/exit status и версию кода,
доставить исправленный auditor и один раз обоснованно повторить
`npm run migration:check -- --source-service` с существующей закрытой target
конфигурацией. Перед запуском убедиться, что прежний процесс завершён.
Повторный импорт не требуется. Новые расхождения разбирать, не фильтровать;
учитывать изменения рабочего source после снимка.

**Cron подтверждён и уточнён.** На source `bron-jobs` активен каждые пять минут;
все 288 запусков за последние сутки завершились ошибкой отсутствующей `run_jobs`.
Перегрузок этой функции нет. История `7511899` от 17.10.2026 удалила старую
`app_private.run_jobs(p_trigger text)` вместе с интеграционной подсистемой.
В текущем source также отсутствуют её `outbox`, `inbox`, `sync_run` и обработчики.
Это подтверждает оставшееся старое расписание, а не необходимость вернуть
удалённые функции продукта. На репетиционной цели восстановить исходные
определения/active при `cron.launch_active_jobs=off`, оригинал сохранить в
закрытом архиве; перед рабочим запуском отдельно документировать
судьбу этого задания, не восстанавливать прежнюю подсистему ради зелёного cron.
Источник не изменён; `bron-shop-worker` остаётся выключенным.

**Пределы остальной передачи.** Новых Pages-публикаций приложения/лендинга нет;
последние опубликованные SHA — `6bfdf52d` / `fb5210c6`. Независимый DNS-запрос
подтвердил отсутствие A/AAAA у `bronservis.ru` (NODATA) и NXDOMAIN у `app`/`api`.
Сам staging не является релизом. Финальный полный restore не обязателен сам по
себе: нужен проверенный перенос фактической дельты без потери принятых target
заявок. DNS/TLS можно готовить с закрытым приложением/API; действующий Caddyfile
нельзя открывать без допуска, поскольку он сразу раздаёт сайты и проксирует API.
Требование сведений об операторе/политики уже есть в release gates; оно относится
к публичному сбору данных лендингом и не останавливает независимые технические
проверки цели.

## Актуальная передача — 13.11.2026, 02:56 MSK

Эта запись новее всего ниже и фиксирует только наблюдавшиеся результаты.

- Рабочая ветка обновлена; локальная копия чистая и совпадает с `origin` на
  `5d134b58846172df0929e1f3f44b4e9c8c8c47bd`.
- VPS доступен по проверенному SSH-ключу. Источник слушает только
  `127.0.0.1:15432`; rehearsal DB — только `127.0.0.1:15433`. Оба сокетных
  unit активны. Контейнеры `supabase-db`, `auth`, `rest`, `storage`, `imgproxy`
  и внутренний `envoy` здоровы; наружу по-прежнему опубликован только SSH.
- Один актуальный запуск закреплённого `migration-check.mjs --source-service`
  завершился `exit 0`: `Matched 82 data/schema/sequence checks`, включая Auth
  identities, password hashes и прикладные таблицы. Проверка читала источник
  по canonical TLS и цель по loopback. Это совпадение текущих снимков rehearsal,
  не финальная сверка под freeze: источник остаётся рабочим и может измениться.
- Из точного снимка ветки собраны и проверены закрытые app-кандидаты для
  `app.bronservis.ru` (`/`) и старого GitHub Pages origin (`/bron-franchise/`).
  Typecheck/build прошли; manifests, base paths, CSP и target API/anon key
  проверены. Кандидаты сохранены root-only в `/opt/bron/stage/` и не раздаются.
- Текущий публичный лендинг скопирован только в root-only staging и подготовлен
  с target API/anon key и метаданными `bronservis.ru`; контракт `lead_submit`
  сохранён. В candidate согласие по умолчанию снято. Ссылки на политику обработки
  данных и подтверждённые сведения об операторе отсутствуют; не публиковать его
  до закрытия этого требования.
- DNS `bronservis.ru`, `app` и `api` с VPS не разрешаются. Caddy/HTTPS не
  опубликованы; порты 80/443 не слушаются. GitHub Pages пока соберёт старый
  backend API из существующих репозиторных variables; variables и публикации
  не менялись.
- Автоматического расписания target-backup и проверенного канала тревог нет.
  Ранее проверенная S3-копия и rehearsal не заменяют регулярную копию рабочей
  цели. Источник не заморожен; финальный snapshot/delta, новый финальный restore,
  late-leads bridge на площадке и новые сессии после финального restore не
  проверялись.

**Релиз не допущен.** Source freeze и финальная дельта не выполнены; публичные
DNS/HTTPS, регулярная target-копия с тревогой и приёмка входа/PWA на устройстве
владельца не готовы. Владельческая Supabase-сессия доступна; настройки не менялись.
До подготовки безопасного окна не переключать DNS, Pages или публичный Caddy.

### Уточнение после доступа владельца — 13.11.2026, 10:45 MSK

В Chrome подтверждена текущая production-панель проекта источника `bron-franchise`:
регион `us-west-2`, статус Healthy, тариф Free; панель показывает `No backups`.
Никакие настройки проекта не менялись.

В одной read-only транзакции по тому же каноническому TLS подтверждено:
`bron-jobs` активен каждые пять минут, `bron-shop-worker` выключен, очередь
pg_net пуста. За последние 24 часа у `bron-jobs` 288 ошибок; команда вызывает
`app_private.run_jobs()`, но такой функции в текущем source DB нет. Задание не
отключал и не переписывал: его назначение и последствия требуют разбирательства
до cutover. Исходник по-прежнему рабочий; финальный freeze не запускался.

## Актуальное продолжение из облачной среды, 12–13.11.2026

Этот раздел новее остальных записей ниже. Исходный HEAD рабочей ветки
`ops/russia-migration-20261110` проверен: `f615f8d1637f23bf7bfebb6c1381c671a02bdb78`.
HEAD лендинга: `fb5210c6de3ac6df93bad2ddf0306a1856e98b73`. Оба полученных checkout
были чистыми; подготовка VPS, экспорт и импорт заново не запускались.

**Более свежая передача владельца от локального исполнителя:** S3-копия проверена
обратным чтением/SHA, независимый ключ на Mac расшифровал артефакт, импорт из S3
в изолированную PostgreSQL завершён одной транзакцией. После перезапуска канала
источник ответил в read-only транзакции; строгая сверка уже запущена, её итог
не получен. Два определения cron ещё не восстановлены. Публичного переключения
не было. Эти серверные результаты переданы владельцем; журналы VPS из текущей
среды недоступны, поэтому независимая повторная проверка не заявляется.

### Проверено непосредственно в этой сессии

- Через подключённый Supabase выполнена явная `BEGIN READ ONLY`: PostgreSQL 17.11,
  `transaction_read_only=on`, 16 пользователей / 16 identities, один бакет / ноль
  объектов Storage, очередь pg_net пуста. Это не проверка SSH-канала VPS и не
  глобальный freeze источника.
- В источнике `bron-jobs.active=true`, `bron-shop-worker.active=false`.
  Пользовательский Auth-триггер `on_auth_user_created` включён. У Storage есть
  три `partner_docs_*` policy и `valid_auth_session` типа RESTRICTIVE / ALL /
  authenticated. Значения cron-команд, секреты и персональные данные не извлекались.
- Финальный полный локальный `npm test` после исправлений: **324/324**, 47 файлов,
  включая 11 новых CLI-тестов переносчика заявок. Отдельно прошли 24 transport/CLI
  и 6 изолированных DB-проверок. Финальные `typecheck` и production build прошли.
  Gateway: 3/3. QA-сборка использует подставной API/ключ; её не публиковать.
- `migration:leads -- --source-service [--apply]` теперь использует тот же
  защищённый source-service/TLS и запрет ошибочного target, что `migration:check`.
  Поддержка проверена локально, но на VPS ещё не доставлена/не применена.
  Режим сохраняет существующий алгоритм UUID и dry-run; он не заменяет проверку
  ограниченных ролей для постоянного расписания.
- Chromium / настоящая IndexedDB: экспорт, повторный импорт без дублей,
  атомарный отказ при конфликте, отказ чужому UUID, сохранность после навигации
  и перезапуска браузера, восстановление в новом профиле — успешно.
  Проверены все 18 сочетаний ширин 320/360/390/430/768/1280/1366/1440/1920 px
  и текста 100/200%, импорт и закрытие доступны вертикальной прокруткой.
  Исправлено только сжатие/обрезание пояснения импорта в `Shell.tsx`.
- Локальная репетиция настоящего старого service worker с опубликованной
  сборки `6bfdf52d018fa4faf1d758866be07603483667be` (build
  `2026-11-09T22:24:43.055Z`) → новая сборка (build
  `2026-11-12T20:59:32.808Z`) прошла на loopback с прежним путём
  `/bron-franchise/`. Обновление сохранило открытый ввод, очередь и черновик;
  guard запретил принудительную перезагрузку. После закрытия всех вкладок и
  повторного открытия загрузился новый JS, UUID/payload/version/error/черновик
  сохранились. Вход тем же синтетическим UUID и экспорт прошли, JS-ошибок нет.
  API подставные, внешний доступ тестового браузера заблокирован.
  **Это не проверка установленной PWA на устройстве владельца или российского API.**

### Точный внешний блокер

Выбранная облачная среда:
`ccarenv_b64_Y2NhcmVudl9hZDAxYWNkYTZhMTg4MTkxOTQ2YTYyNTc3YzhjNDUzZg`.
Маршрут к `152.228.115.115` существует, но TCP/22 возвращает `Connection refused`
как внутри песочницы, так и при разрешённой внешней проверке. Штатный TCP-прокси
`proxy:8088` также возвращает отказ соединения; VPN не настроен. Это не доказывает
отказ самого VPS для Mac. SSH с отдельной конфигурацией и обязательной проверкой
host key до авторизации не дошёл. Локального SSH-ключа и ssh-agent нет.

Инструменты управления браузером/веб-консолью в этой сессии отсутствуют;
remote desktop в статусе среды enabled/unknown, доступной browser/desktop-команды
управления нет. История сетевой диагностики пуста (`history_status=not_found`).
Проверки трёх согласованных HTTPS-адресов из этой среды получили отказ CONNECT
403; успешная публикация или отсутствие DNS этим не устанавливаются.

Владелец 13.11 выбрал продолжение в локальном Codex на Mac с существующим SSH,
в том числе на лёгкой модели. Полное подробное поручение:
[local-access-handoff.md](local-access-handoff.md). Постоянную пересылку команд
через владельца не организовывать; локальный исполнитель продолжает весь релиз.
Позднее владелец попросил сначала восстановить управление браузером в облачной
среде; локальное поручение сохраняется как резервный путь, автоматически на Mac
не запускалось.
Ограничение прежней передачи «только настройка доступа» снято владельцем;
обычная миграция, исправления и публикация после обязательных проверок разрешены.

Дополнительная диагностика браузера 13.11: текущий реестр tools не содержит
browser/CUA/js/js_reset/open_in_codex. Штатный локальный каталог браузерной среды
содержит js/js_reset/turn_ended, но они не предоставлены этому чату. Проверка
`cloud-agent-browser-runtime ready` вне песочницы завершилась
`Pool credentials cannot change after browser activation`; `cloud-agent-desktop`
сообщил `Orbit desktop is unavailable`. DISPLAY и X11 socket отсутствуют.
Диспетчер приложений для Browser сообщил `not_installed`. Эти наблюдения не
доказывают единую первопричину; служебные credentials не менялись и не извлекались.

### Следующее серверное действие

Найти **итог существующего** `migration:check`, не запускать второй экземпляр.
CLI `scripts/migration-check.mjs` не создаёт JSON-отчёт: результат — stdout/stderr
и exit status. Сначала определить реальный unit/PID и перенаправление stdout/stderr;
для systemd проверить `ActiveState`, `Result`, `ExecMainStatus`, `MainPID` и итоговые
строки его журнала. Не печатать process argv, environment, `ExecStart` и history:
они могут содержать credentials. Успех начинается с `Matched`, расхождение —
`Mismatch:`, ошибка выполнения — `Migration comparison failed:`. При потере
журнала сначала установить, что произошло с прежним процессом, а не повторять импорт.

Storage policies/grants уже входят в строгую сверку. Отдельно нужны Auth-триггеры,
managed columns/constraints/migrations, cron, Vault, файлы и конфигурация сервисов,
а также понятные суммы по каждой валюте. Точные исходные каталоги и cron обычно
содержатся в существующем зашифрованном `managed-metadata.json.zst.age`; сначала
найти его в актуальных manifest, не делать новую выгрузку вслепую.

Сохранить исходные признаки активности двух cron при восстановлении определений;
на репетиции оставить `cron.launch_active_jobs=off`, `pg_net.batch_size=0`, internal
network и DB только на `127.0.0.1:15433`. Не включать `bron-shop-worker`.
До окончания строгой сверки не выполнять входы/отзыв сессий, меняющие Auth-метаданные.

Старый совет `source-db-access.py --tunnel --connect` не применять вслепую после
старта восстановленных контейнеров: репозиторный preflight этого helper отказывает
при любых контейнерах. Не останавливать/удалять их ради helper. Канал проверить
через существующие закрытые service/pgpass, canonical TLS и настоящий read-only SQL.
Источник сохраняется; финальный freeze, дельта, старые формы/PWA, HTTPS/DNS,
резервирование и доставка тревоги требуют серверного исполнения, а не нового плана.

## Последнее уточнение: исполнение через существующий SSH на Mac

После этого checkpoint владелец явно разрешил продолжить серверную миграцию
локальным Codex на Mac через уже настроенный SSH. Прежнее ограничение «только
доступ и транспорт» в `local-access-handoff.md` и исходной передаче больше
не описывает разрешённый объём работы. Покупки по-прежнему запрещены.

При повторном подключении к VNC прочитан полный экран: пакет `python3-boto3`
установлен (`Setting up python3-boto3 (1.34.46+dfsg-1ubuntu1)`), apt завершился,
root-приглашение видно в каталоге исходной копии. Повторять установку не нужно.

Дальнейший ввод через консоль не подтверждён: попытки скачать новую версию
`/root/h` и выполнить read-only `pwd` не изменили экран. После reload VNC снова
показывает `Connected (encrypted)`, но ввод через другой документированный способ
завершился deadline. **Не считать скрипт обновлённым или запущенным**; сначала
проверить файлы и их SHA через существующий SSH. Прямой SSH из облачной среды
недоступен. Доступная нативная среда — отдельный Linux без приложения Codex и
открытых окон; это не Mac владельца. Автоматическая передача задания локальному
Codex из чата недоступна, владельцу требуется один раз передать текст задания.

Локальный исполнитель: найти существующий checkout, сохранить изменения,
проверить актуальную ветку, прочитать исходную передачу, этот checkpoint,
AGENTS.md и указанные runbook. Продолжить с существующей копии и фактического
manifest, не повторять исходный dump вслепую. Проверить SSH fingerprint из
передачи и состояние `~/.ssh/bron-source-tunnel status`; приватный SSH-ключ не
копировать на сервер или в чат. Пароль источника уже хранится закрыто на VPS.

Ближайшая последовательность:

1. Проверить фактические manifest/файлы/driver SHA и состояние target. Доставить
   текущие metadata/S3 helpers, сверить SHA ниже. Из каталога исходной копии
   запускать metadata helper с `--manifest manifest.json`. Это отдельный снимок;
   он не превращает исходный SQL snapshot в полную или финальную копию.
2. Использовать только созданного ограниченного S3-пользователя ниже. Перенос
   его credentials — в скрытый ввод `backup-s3.py --setup`, без вывода в чат,
   shell history или логи. Если нет безопасного доступа, нужен только личный
   скрытый ввод владельца. Сохранить независимую закрытую копию age identity у
   владельца вне VPS и вне git, проверить возможность расшифровки с неё.
3. Выполнить S3 probe (PUT/GET SHA и реальный отказ DELETE), затем независимую
   загрузку существующих семи файлов и дополнения с обратной сверкой GET/SHA.
   Не выдавать удаление/управление бакетом, не увеличивать оплаченный объём.
4. Изолированное восстановление строго по `restore-rehearsal.md`, до запуска
   внешних сервисов. Сверить исходные UUID/парольные хеши/Auth/права/суммы по
   валютам/файлы/Vault/managed-schema; не обходить несовместимость фильтрацией.
5. Только после строгой сверки — проверки ролей, безопасное финальное закрытие
   записи и сверка дельты с сохранением поздних заявок/старых PWA, HTTPS/DNS,
   проверенное резервирование и мониторинг. Источник не удалять. На production
   не создавать тестовые записи, не использовать seed/reset и не очищать IDB.

Разрешение на работу есть. Привлекать владельца для личного входа/MFA/скрытого
ввода секрета или реального изменения объёма; не запрашивать его повторно для
обычных обратимых шагов. Отчёт различает подготовленный код, применённую
настройку, проверенное поведение и оставшиеся блокеры.

## Проверено на VPS

- Через существующую зашифрованную VNC root-сессия доступна. Прямой SSH из этой
  среды недоступен по сети; повторный пароль источника не нужен.
- Manifest существующей копии:
  `/var/backups/bron-franchise/source-20261112T161139Z-0f8917c7/manifest.json`.
  Семь артефактов, суммарно **502684 байта**. Сценарий `/root/g` с SHA-256
  `3374208067b5bf6de71298d06202706ea89312a81efeac72fdc0ae6ece86c282`
  подтвердил размеры, SHA-256, age decryption и zstd integrity всех семи файлов.
  `complete=false`, `restore_performed=false`, открытые файлы не создавались.
- При проверке listener видны SSH и **только loopback `127.0.0.1:15432`** для
  исходного канала; `docker ps` пуст. Целевые сервисы ещё не запускались.
- Распакованные каталоги `deploy` и `deploy/timeweb` были root:root/0775.
  Выполнено `chmod -R go-w /opt/bron/migration`. После этого защитная проверка
  metadata helper прошла дальше проверки файлов/владельцев.
- Старый metadata helper загружен как `/root/h`, SHA-256
  `0827122746787560c2ea130f1baa1ddf4e0bc3e8e36885e846e2a25ea6707c1f`.
  Его исполнение остановилось на `EXPLICIT_SOURCE_MANIFEST_REQUIRED` из-за
  искажения длинного пути при вводе VNC. Дополнительная копия **не подтверждена**.
- `apt-get install -y python3-boto3`: изначально результат потерян из-за timeout;
  при продолжении установка подтверждена полным экраном, см. уточнение выше.

## Timeweb S3: применено и прочитано обратно

Создан дополнительный пользователь `bron-franchise-backup`, ID
`9d3e01f1-27ae-4d38-a2a9-33d46560d191`.
В его разделе «Права доступа» → **«Редактировать политики»** применён полный
`backup-uploader-policy.json` (SHA-256
`7646f130270dc45d69a89bf101a6908934946d0b0ca613b7b80a61037755f02d`).
Редактор повторно открыт: JSON точно совпал с проверенным файлом. Права показывают
«Пользовательский». Готовые preset-права не назначались.

Разрешены PUT/GET четырёх backup-префиксов и чтение списка/метаданных только
данного бакета; явно запрещены удаление, ACL и изменение управления бакетом.
**Основной S3-ключ не понадобился**: панель имеет собственный редактор политики.
Старый `source-s3-policy-bootstrap.py` с основным ключом не применять.

Ограниченные credentials не прочитаны и не перенесены на сервер. PUT/GET,
фактический отказ DELETE, независимая загрузка и восстановление ещё не проверены.
Ключ age отдельно владельцу ещё не передан; независимое владение не подтверждено.

## Подготовленный код, не рабочее поведение

Ветка GitHub: `ops/russia-migration-20261110`, commit
`0e2072d06002f23825860c91cc521387b2a9a1b4`.

- PWA: собственная очередь + черновики экспортируются/импортируются с прежними
  UUID, версиями и ошибками. Атомарный merge отказывает при коллизии; чужие данные
  не читаются. 161 unit test, typecheck/build прошли. Код не опубликован.
  Браузерная QA недоступна через `terminal.local` в локальном Chrome
  (`ERR_NAME_NOT_RESOLVED`), старое устройство не проверено.
- `source-metadata-supplement.py`: SHA-256
  `f860c468225c585a478bdfcccc9a97dc298c4cb68cea9561967eaa476c047cd4`.
  17 offline tests, SQL проверен на синтетическом PGlite. Новая версия разрешает
  буквальный `--manifest manifest.json` из каталога снимка, превращая его в
  абсолютный путь **без resolve/symlink-following**; прежние guards остаются.
  Создаёт отдельный snapshot и не меняет исходный manifest. Доставка новой версии
  на VPS не подтверждена.
- `backup-s3.py`: SHA-256
  `d0560679e9616dc75400331483aaa70e683c9158b9daf626080abb6ed6aa1362`.
  10 offline tests прошли. Режимы `--check`, `--setup [--hex-input]`, `--probe`,
  `--upload --manifest manifest.json`. Credentials только ограниченного пользователя
  сохраняются root/0600; основной ключ не используется. Upload требует успешного
  probe с отказом удаления, использует уникальные имена, conditional single PUT
  и потоковый GET/SHA. Ограничение бакета 800000000 байт из оплаченного 1 GB,
  одного запуска 100000000 байт. Не загружает age identity. Не доставлен на VPS.

## Дополнительные read-only подтверждения

Supabase: 16 users/16 identities, 1 bucket/0 objects, net queue=0.
Cron `bron-jobs` активен, `bron-shop-worker` выключен. Edge `shop-worker` v1 ACTIVE,
`verify_jwt=false`; deployed files совпадают с репозиторием. Значения env secrets
не извлекались. Полного source freeze нет.

В панели Auth: email enabled, все остальные стандартные providers disabled;
signup/manual linking/anonymous disabled, confirm email enabled; custom SMTP off,
default templates. JWT expiry=3600, refresh-token detection enabled, reuse interval=10;
single session off, timebox/inactivity=0. Эти настройки только прочитаны, не изменены.
Лендинг HEAD по подключённому GitHub: `fb5210c6de3ac6df93bad2ddf0306a1856e98b73`.

## Техническая особенность оставшегося доступа

VNC Paste clipboard искажает повторные клавиши и Shift-символы; полный длинный
timestamp нельзя вводить без последующей проверки. Не использовать shell
backticks/подстановки: закрывающий знак был потерян. Незавершённая строка закрыта,
root-приглашение после неё подтверждено. Перед продолжением читать свежий экран:
после reload нижние ~48px терминала находятся ниже viewport, нужна прокрутка.
Не объявлять успех по старому кадру. Последующие screenshot/reload несколько раз
вернули `Chat API request timed out`; это внешний сбой управления, не доказательство
состояния VPS. Команда может выполниться до потери ответа, поэтому сначала читать
факт результата. Секреты в терминал не вводились.
