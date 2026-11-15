# Передача worker: закончить релиз, 15.11.2026

## 1. Цель и фактическая точка остановки

Владелец поручил полностью передать оставшуюся работу лёгкому worker, пока бюджет
сильного координатора восстанавливается к13:00МСК. Повторный независимый обзор
после reset допустим после выпуска; **личная essential-приёмка до публикации обязательна**.
Продукт/данные не переписывать. Сайт/API остаются maintenance до допуска.

Последний **T45 run-final завершён BLOCKED**: phase=source-fence-start,
code=FINAL_HTTPS_WINDOW_FAILED, targetWriteOutcome=UNCHANGED, sourceFrameAttempts=0.
Final guard consumed; **T45 не повторять и не reset**. SourceMustRemainClosed=true.
Четыре ACK не завершены; Source и target не считаются финально равными.
Последний известный ledger был1/3; актуальный ledger надо прочитать перед новым окном.

Причина первого ACK **подтверждена read-only metadata**: expires1794712433429ms;
final-result записан1794712433434ms (expiry+5ms), ACK появился1794712527545ms
(expiry+94,116ms). Canonical JSON+LF, SHA и все bindings ACK PASS. Реальная MCP
проверка закончилась в окне, но доставка запоздала. Final-result SHA:
`7987d55b1323c1b4a64aeeac7e8b7050f500f9fc6cf778d973c1b9d0e3cd9aca`.
Эту диагностику не повторять. Не увеличивать60s: устранить ручной медленный relay.

## 2. Роли, доступы и границы

- **Local executor:** проверенный SSH/VPS/FS/Compose/GitHub. Реальный Mac — только
  пульт; никакие keys/backup/ciphertext/Auth/business rows через него не переносить.
- **Coordinator worker:** роль Root, а не требование к сильной модели. Он исполняет
  exact pinned Source SQL только через подключённый Supabase MCP и выдаёт реальные
  nonce ACK. Новый Work-чат с уже подключённым Supabase plugin допустим без новых
  секретов. Наличие MCP сначала подтвердить обнаружением callable tools.
- Для автономного финального окна использовать **одного worker с SSH и Supabase
  MCP**, чтобы Source-проверка и запись ACK обходились без ручной пересылки между
  чатами. Если роли разделены, сначала доказать автоматическую доставку end-to-end
  ≤30s на отдельном readiness nonce. Прежний ручной путь занял154s и непригоден.
- Если у worker MCP отсутствует — STOP Source-ветки; не заменять её SQL из браузера,
  прямым PG через Mac, Edge-функцией записи или выдуманным ACK/Source clock.
- Владелец явно одобрил Source CONNECT fence/drain; временный capability WITNESS,
  затем DATA для двух оставшихся сверок; closure и Source Pause только после PASS.
  Владелец также поручил делегировать этот оставшийся объём. Новых секретов не нужно.
- Автоматический approval rejection не обходить: сохранить точную причину и получить
  требуемое уточнение, если проверка не принимает уже документированное разрешение.

## 3. Не переоткрывать подтверждённые gates

T12 Auth/RLS, T14 пять сборок цели/отката, T18 backup/status, T19 Telegram,
T21 cold restore, T22 настоящий scheduled run, T37 live inventory, T39 staging,
T40 metadata custody, T43 marker, **T44 crypto+custody**, T46 loopback repair,
T47 lock mode0644, T48 WITNESS/barrier PASS. Не повторять без затрагивающего сбоя.
Только текущая свежесть backup, текущий fence и финальная дельта имеют свежие проверки.

## 4. Точные anchors

Repository `bronservis51-bot/bron-franchise`, branch `ops/russia-migration-20261110`.
До этой передачи последний code commit: `82f38146ae6402b016869a294971be811f6f05c6`.
Пин самой передачи/SQL выдаётся новым EXECUTOR_TASK; будущие SHA не угадывать.

```text
Source project=vkkqffvmztpzgygzfxhq
VPS=root@152.228.115.115
SSH ED25519=SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0
Node=/opt/bron/node-v22.23.5-linux-x64/bin/node (22.23.5), pg=8.23.1
T45 manifest=67b2bb6c7b72ef39bd66dbb2e008f177fb5b38ae9713e052ad8aee0aa5182ad8
T45 owner approval=68b9789f062a5e3ad0d301afb251a5fb936f75712d6ffafddbd3fe6bda83a2a8
barrier receipt=0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6
fence context=564c015f97aea285659304a78437840562bf701e3ed5df55b94f04c9008c5f3b
final-prepared=a226cfa9eb96fbe9ca2276e20bffc637d04cbd2670417f18dc45f03df63f25a8
fence-input=c9e0b5fa1fd207e70f63292ad3a3c69d79218ec6b9185fafd5db0ac44ff6a4d6
DATA function=bron-source-reader-920938e06472 ACTIVE v2, verify_jwt=false
DATA index SHA=2a907c354343741d1b4ab0616b1ab1cbe3bf5668fda4db03331c4bccc3a2c28b
capability SHA=920938e064729dca455bc902f98674775c70e52c5cfc265f5f537550410ebb98
capability expires=2026-11-15T04:14:51.589Z (07:14:51МСК), value VPS-only
verifyFencedSql SHA=fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782
inverseSql SHA=68545c5bcb9f8b0aaacd2f703d0cb42a8424d737efa8077c22441547860cc51b
verifyOriginalSql SHA=81e21c3d9d2fee2a96269ff889885c19270030fcc7979debe8bc47e696884d78
```

Exact SQL — `payloads/worker-t45-verify-fenced.sql`, `worker-t45-inverse.sql`,
`worker-t45-verify-original.sql`; проверить bytes/SHA из manifest передачи.
Хешировать SQL-файлы как есть, без trim или добавления LF. Точные bodies сохранены
без завершающего LF; SHA фиксирует все исходные bytes.
VPS state `/root/bron-secrets/t45-release/`: final-run.guard, final-result.json,
fence-check-start.request.json, fence-check-start.ack.json, source-barrier.json,
final-prepared.json, fence-input.json, final-capability. Ключ capability не читать в отчёт.
Canonical T45 receipt `/root/bron-secrets/t45-release-receipt.json`;
shared ledger `/root/bron-secrets/source-transfer-budget`, scope/max3 неизменны.

## 5. Следующий worker-пакет: один изолированный successor window

1. Проверить exit процесса и сохранённый final-result. Пока процесс активен —
   **никаких checkout/fetch/restart**. Не повторять T45. Старые guards/results сохранить.
2. Использовать подтверждённый выше late-delivery диагноз; новый разбор ACK не нужен.
3. Прочитать actual ledger через уже pinned `source-transfer-budget.mjs` на VPS;
   выводить только status/counts/action/hash. Читать final-result и before-image
   existence metadata. Если target outcome не UNCHANGED, ledger uncertain или used≠1 —
   STOP новой записи; Source держать закрытым, сначала выяснить фактический outcome.
4. При подтверждённых ledger1/3 и target UNCHANGED разрешён **один новый** final-window
   T49 с новым guard/receipt, не ещё один вызов T45. Использовать только T49 commit/
   manifest SHA из envelope передачи. Его launcher/ACK namespace переиспользует
   неизменённые `final-https-window.mjs`, `final-https-transport.mjs`, `final-auth-window.mjs`.
   Старые T45 evidence сохраняются; T49 task/manifest/before-image/guard/ACK paths новые.
5. Проверить T49 pins перед доставкой. Перед запуском обязательна отдельная реальная
   end-to-end readiness проба ≤30s, затем свежий coordinator-ready.json/SHA.
   Source clock — фактический MCP, ACK не выдумывать. Команда T49 указана в его checklist.
   Новый ID/capability не сбрасывает shared ledger: POST до отправки занимает slot,
   failed/unknown тоже расходуется; всего максимум3 включая T37.live.
6. Существующий capability/deployment/boundary/Root proof не продлевать молча.
   До старта должны хватать реальные expiry и wall budget. Если срок истёк — STOP:
   отдельная fresh pinned continuation с тем же общим бюджетом; старые bytes не менять.
7. До любых новых effects backup/status HTTPS503/TLS verified/healthy=true,
   checked_at≤25min, last_backup_utc≤70min; текущий fence проверить pinned SQL через MCP.
   Не переустанавливать backup/monitor и не повторять сборки/restore.

Read-only ledger command на VPS, после подтверждённого завершения старого процесса:

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node --input-type=module - <<'JS'
import {readBudgetStatus,SOURCE_TRANSFER_SCOPE_SHA256} from '/root/bron-secrets/t45-runtime/docs/runbooks/payloads/source-transfer-budget.mjs';
const s=readBudgetStatus({directory:'/root/bron-secrets/source-transfer-budget',scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',maxAttempts:3});
console.log(JSON.stringify({used:s.used,remaining:s.remaining,uncertain:s.uncertain,claims:s.claims.map(c=>({attempt:c.attempt,status:c.status,actionId:c.actionId,claimSha256:c.claimSha256}))}));
JS
```

## 6. Четыре ACK: одинаковый строгий протокол, быстрая передача

Окно emits stages: `start`, `before-target-write`, `before-final-audit`, `end`.
Coordinator получает challenge немедленно и **сразу** делает real verifyFencedSQL
на Source (READ COMMITTED, прежний advisory lock/identity/ACL/provider checks),
затем SELECT Source clock `floor(extract(epoch FROM clock_timestamp())*1000000)::numeric::text`.
Оба шага в одной транзакции: BEGIN READ COMMITTED → exact verify SQL → clock SELECT → COMMIT.
Не начинать запрос на50-й секунде: coordinator+executor должны быть готовы заранее;
выделить прямую быструю передачу, сохраняя deadline60s и skew±5s.

ACK JSON имеет ровно поля: format=1, protocol=BRON_COORDINATOR_FENCE_ACK_V1,
actionId/manifestSha256 **текущего нового окна**, sourceProject,
sourceBarrierActionId=T40.http_source_admission, sourceBarrierReceiptSha256,
verifyFencedSqlSha256, stage, nonceSha256, sourceCheckedMicros, expiresEpochMs,
normalConnectDenied=true, existingClientsDrained=true, providerBoundaryReviewed=true.
Все context/nonce/stage/expiry брать из **данного** проверенного challenge; не из прошлого.
`ackJson` = JSON с отсортированными top-level keys, compact UTF-8 + один LF;
`rootAckSha256` = SHA256 **точных ackJson bytes**. Envelope только
`{"ackJson":<эта строка>,"rootAckSha256":<этот SHA>}`.
Executor пишет envelope O_EXCL/root600/fsync/readback только в exact ackPath challenge.
Нет Source MCP/неуспех verify/истёкший nonce — ACK не выдавать и не фабриковать;
helper сам останавливается. Не увеличивать TTL, не менять часы, не делать auto retry.

## 7. Финал данных → приёмка → публичный запуск

Два фиксированных read-only Source snapshots — counts/SHA и одобренные ≤16 Auth
UUID/updated_at/другие-field digests, encrypted напрямую VPS, без raw values/Mac.
Допустим только guarded source-newer updated_at-only UPDATE max1 с durable before-image.
Иные Auth/business/schema/sequence diff — STOP narrow path, данные не игнорировать.
COMMIT UNKNOWN/потерянный ACK: Source закрыт, без inverse/reopen/повторов.

После actual strict PASS и известного commit: coordinator tombstone той же функции
(HTTP410 без DB), exact readback/GET410/available log counts; затем Source Pause
через MCP и provider status readback. После Pause Source DB/REST не читать.
Не удалять capability/backup/key/before-images для уборки.

Tombstone payload уже готов: `payloads/worker-reader-tombstone.ts`, проверить его
SHA по envelope передачи. Через MCP `deploy_edge_function` заменить **ту же**
`bron-source-reader-920938e06472`, entrypoint index.ts, verify_jwt=false, одним
файлом index.ts с exact pinned content. Get/readback должен совпасть; GET возвращает
410 и `{ok:false,retired:true}`. Затем MCP pause_project только vkkqffvmztpzgygzfxhq
и get_project до подтверждённого provider paused/INACTIVE status. Не выполнять
SQL после Pause. Доступные логи проверять только агрегатами, без сырых body/ПД.

Private preview — только после этих gates. Existing templates:
`deploy/timeweb/{Caddyfile.preview,compose.preview.override.yml,Caddyfile,compose.production.override.yml}`.
На VPS cwd `/opt/bron/supabase/docker`; наблюдавшаяся база Compose:
docker-compose.yml + bron/compose.override.yml + bron/compose.rehearsal-retry.override.yml
+ bron/compose.restore.override.yml + bron/compose.maintenance.override.yml.
Preview override LAST; root600 `/root/bron-secrets/preview.env`, непустой
BRON_PREVIEW_ALLOWED_IPS с actual phone IP (не угадывать по Mac). Перед apply закрытые
before-images и comparison models в RAM; кроме web всё прежнее. Caddy validate,
затем только `up -d --no-deps --pull never web`; backend IDs/network.internal/loopback сохраняются.
Значение allowlist — comma-separated JSON string literals отдельных IP, не CIDR/array;
точный синтаксис задан существующим Caddyfile.preview, пустое значение недопустимо.
T39 static67files и T14 target/rollback packages reuse, не пересобирать.

После закрытых before-images/diff-проверки только web, точные команды VPS:

```sh
cd /opt/bron/supabase/docker
bron_compose=(docker compose -p supabase --profile publish-only
  -f docker-compose.yml -f bron/compose.override.yml
  -f bron/compose.rehearsal-retry.override.yml -f bron/compose.restore.override.yml
  -f bron/compose.maintenance.override.yml)
"${bron_compose[@]}" -f bron/compose.preview.override.yml run --rm --no-deps --pull never web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
"${bron_compose[@]}" -f bron/compose.preview.override.yml up -d --no-deps --pull never web
```

Только после actual acceptance + успешных private live checks:

```sh
"${bron_compose[@]}" -f bron/compose.production.override.yml up -d --no-deps --pull never web
```

Для закрытия web без возврата Source writer:

```sh
"${bron_compose[@]}" up -d --no-deps --pull never web
```

Эти команды требуют действующих pinned конфигураций: файлы/изменённые SHA и web-only
model diff записать в отдельную WB03 receipt перед apply; не выводить rendered env.

Подготовить одним проходом transition старых app Pages и отдельного landing repository:
paired target public VITE_SUPABASE_URL/key перед обычной проверенной publication;
app PR12 exact head/CI/diff подтвердить, старый draft не merge вслепую.
URL app.bronservis.ru, bronservis.ru, api.bronservis.ru; legacy
bronservis51-bot.github.io/bron-franchise/ и /bronservice-franchise/.
Origins отличаются: новый RF origin не читает старый IndexedDB. Старые transition
static нужны до old-PWA приёмки при IP-gated RF API. Очереди/storage не стирать.

**Один owner-сеанс:** парольный UI-вход лично, реальный phone/PWA, drafts/queue/
conflict handling, основные операции и форма. Только реальные намеренные записи;
никаких seed/fake leads/финансовых fixtures. Новые target Auth sessions не откатывать.
После actual acceptance — production override LAST вместо preview; один web-only
switch, live новые+оба старых URL/Auth/lead_submit/запись/monitor routing/rollback readiness.
BRON_MONITORING_ENABLED=true; без повторных Telegram /start/dispatch и новых услуг.
После публичного открытия APP_URL и monitor endpoints перевести на проверенные RF
адреса; flagtrue не снимает Caddy maintenance и не заменяет фактическую проверку.
Если target уже писал, rollback требует reconciliation; возврат DNS/Source writer недостаточен.

## 8. Отчёт и что отложено

Каждый update: подтверждённые gates, current blocker, ближайший шаг; без процентов.
Различать pinned/issued/running/actual PASS. Final report хранит actual commands/counts,
UTC/SHA/commit/outcomes; canonical VPS и private local mirror root600/equal SHA.
Owner только essential acceptance; никаких новых секретов. Новые реальные внешние
approval blocks сообщать точной причиной, не обходить.
После релиза: GH visibility, legal docs (owner deferred), SLA, МойСклад, enhancements,
optional hardening/cleanup и дополнительный сильный review после13:00МСК.

## 9. Одно поручение за раз, без ожидания прежней сильной модели

- **WB01 закрыт:** late ACK доказан, повторять диагностику/старый T45 нельзя.
- **T49:** prerequisites/actual ledger → real MCP+SSH rehearsal ≤30s → один новый
  final window → strict PASS. Новая Task49 manifest/argv выдаются в том же pinned
  пакете; старые Source/WITNESS/crypto/restore gates переиспользуются.
- **WB02:** только после T49 PASS закрыть reader и Source Pause/readback, сохранить
  receipts. Если исход неполный/UNKNOWN, остановиться; Source не открывать.
- **WB03:** web-only private preview, оба legacy publisher перехода, одна настоящая
  owner essential acceptance. Перед новыми configuration writes записать private
  before-images, выбранные file SHA/commit, точные команды и проверку моделей.
- **WB04:** после actual acceptance/private live PASS один public switch, live checks
  всех новых/старых адресов, сохранности очереди/записи и routing existing monitoring.

После PASS следующая задача разрешена без подтверждения прежнего Root. Если
необходим новый небольшой operational patch — делать только для названного gate,
сначала focused verification и pinned commit/manifest/receipt, затем исполнение.
Это не разрешение ещё одного window/бюджета, arbitrary SQL, расширения ingress или
обхода failed/unknown. Вне этих границ STOP и конкретный blocker владельцу.

Стартовое сообщение автономному worker (подставить только реальные envelope pins):

```text
Заверши релиз Бронь Сервис. Ты принимаешь delegated coordinator/executor role;
дополнительный strong-model review не является gate. Используй только pinned
commit и manifest передачи, проверь их SHA и все files. Прочитай handoff целиком.
Подтверди callable Supabase MCP и SSH в одном рабочем агенте, затем выполняй WB01
(уже закрыт) → T49 → WB02 → WB03 → WB04 по одному. Source SQL только exact pinned
MCP verify; нет MCP/нет быстрого READY — STOP до окна. Старый T45 не повторять.
Все existing owner approvals переданы; owner-only остаётся настоящая phone/PWA
приёмка перед public. Секретов в чат/логи/Mac не запрашивать. Отчитывайся фактами
и продолжай после PASS без ожидания прежнего координатора.
```

**Ограничение автономности:** документ не создаёт отсутствующий MCP-доступ. Если
локальный Codex его не имеет, сначала подключить уже авторизованный Supabase app
в пригодной worker-среде с SSH. Новые credentials/API keys не извлекать. При новом
OAuth/MFA владелец действует лично; без этого Source-часть не может продолжиться
безопасно. Не обещать запуск без требуемых tools и не возвращаться к медленному relay.
