# T38: локальный read-only аудит контракта переключения

Независим от T37: его approval остаётся pending, функция не развёрнута.
T38 не разрешает T37, working-data read, owner secret или публикацию.
Бюджет10минут; по истечении сохранить COMPLETE/PARTIAL с точными неизвестными.

## Подготовка

1. Проверить, что нет работающего helper прежнего task; не менять checkout его
   процесса. Чистый fast-forward до commit EXECUTOR_TASK T38; без reset/stash/clean.
   Проверить SHA manifest и всех `files`. Отправить ACCEPTED и продолжить без ACK.
2. Создать только локальные private outputs в
   `/tmp/bron-release-executor-20261113/T38/` (directory0700/files0600).
   Разрешены git fetch/fast-forward публичного кода и эти отчётные файлы;
   исходники, runtime, личный browser profile и сервисы не изменять.
3. Не читать `.env`, credential stores, browser/local/sessionStorage/IndexedDB,
   backup, Auth rows, VPS-файлы. Не выполнять npm build/ci/install, unit/PWA tests,
   SSH, Caddy/Compose apply, API submissions, PR merge, dispatch, variables/secrets
   writes. Закрытые T12/T14/T18/T19/T21/T22/T36 не повторять.

## A. Происхождение будущей клиентской сборки

Базовый подтверждённый app-source:
`e487ec88120056a54078c3ff1d9ff13d9245ac36`.
Сравнить с exact pinned T38 HEAD через git blob IDs/`git diff --name-only`, только:
`src/`, `public/`, `index.html`, `help.html`, `package.json`, `package-lock.json`,
`vite.config.ts`, `tsconfig.json` и другие tracked `tsconfig*.json`.
Никакого rebuild. Если baseline object отсутствует, одна read-only fetch попытка;
при отказе OBJECT_UNAVAILABLE, без угадывания и повторов.

Отчёт: SAME_PRODUCT_BUILD_INPUTS либо BUILD_INPUTS_CHANGED с именами файлов;
это не обещание byte-identical dist — build timestamp меняется. Сформировать
воспроизводимый список mode/type/blob/path и SHA256 его bytes для обеих ревизий.
Runtime/API env — отдельный вход будущей штатной Pages-сборки, не игнорировать.

## B. Четыре адреса и storage

По pinned публичному коду/известным T14 manifests составить таблицу:

- app.bronservis.ru: app-root, base/scope `/`, RF API, `/srv/app`;
- старое Pages-приложение: app-legacy, base/scope `/bron-franchise/`, RF API после
  будущей transition-публикации, существующий штатный Pages publisher;
- bronservis.ru: landing-root, base `/`, RF API, `/srv/landing`;
- старый Pages-лендинг: точный URL/publisher взять из публичных metadata, не угадать.

У каждой строки: URL/origin/base/scope/API, публичный package/sourceCommit,
Caddy или publisher path, какие browser storage сохраняются/не переносятся.
Два Pages пути одного github.io origin не называть разными origins. RF app и
landing — разные origins; новая RF страница не читает IndexedDB старого origin.
Не открывать реальные PWA/storage. Связать утверждения с файлами/строками,
включая `vite.config.ts`, `src/platform/{supabase,offline,localRecovery,update}.ts`,
Caddy preview/production и builder. Storage recovery и парольный вход требуют
позднейшей личной приёмки; этот task её не закрывает.

## C. Публикация и дополнительный ручной допуск

Один запуск `python3 docs/runbooks/payloads/t38-publication-metadata.py`.
Helper делает только4 фиксированных GET существующим gh auth, canonical github.com;
выводит разрешённые Pages/environment/PR metadata. Не вызывает login/secret APIs,
не читает variables values, не печатает usernames/reviewer identities или raw errors.
При недоступном gh/сети/403 записать BLOCKED/UNKNOWN, не выводить заключение
«у владельца нет доступа». Никаких повторов, другого account, MFA или owner prompt.

Сопоставить с `.github/workflows/pages.yml`: способ публикации, точный старый URL,
base/path и сохранение PWA origin. Environment required_reviewers/wait_timer/
branch policy указать как реальное условие, требующее дальнейшей проверки,
не как разрешение удалить защиту. Environment GET не доказывает все repo/org rules;
PR mergeability=null/unknown не трактовать как PASS. Если дополнительный ручной
допуск обнаружен — записать точное условие и момент, не запускать публикацию.

## D. Готовая последовательность, без исполнения

По текущему rollout-plan и коду workflows составить конкретный план оставшегося
окна после owner-key/source/final-audit gates. Включить:

- shared `VITE_SUPABASE_*` у Pages/availability, `APP_URL`, существующий monitoring
  flag: целевые публичные URL и названия переменных, не secret values;
- когда planned-maintenance выключение existing flag необходимо, какой receipt
  и ответственный восстановят его после public acceptance; не создавать новый
  монитор/таймер и не выключать сейчас;
- один согласованный PR12 merge/штатная Pages publication для старого origin;
  RF preview остаётся IP-gated, поэтому GitHub monitor ещё может получать503;
- личный парольный вход, старая PWA/очередь на телефоне, Wi-Fi/mobile, сохранение
  operation UUIDs/черновиков; никаких clear-site-data/storage/reset;
- public switch после acceptance, target public variables/APP_URL и monitoring
  enabled readback, затем наблюдение обычных проверок без нового test alert;
- safe rollback ДО новых target writes и отдельная reconciliation ПОСЛЕ них;
  не предлагать простое возвращение DNS как безопасный откат записанных операций.

Привести точные будущие команды только как НЕИСПОЛНЕННЫЕ drafts с prerequisites,
inputs и acceptance. Не включать реальные ключи, private IP allowlist или authdata.
Если надёжной команды нет — явно NEEDS_COORDINATOR_PACKAGE, не выдумывать.

## Приёмка и handoff

Один `T38-cutover-plan.md` с A/B/C/D, ссылками path:line и safe metadata evidence,
таблицей UNKNOWN/BLOCKED/READY_FOR_LATER_PACKAGE; без ложного «release ready».
Локальная `T38-state.json`: exact commit/manifest/fileSHAs, времена, выполненные
read-only actions, metadata helper exit/status, changed report paths, plan/log SHA.
Никакого VPS receipt в этом task (SSH запрещён). Отчёт не задерживать на owner/T37.

`EXECUTOR_REPORT T38`: BUNDLE; PRODUCT_INPUTS; ORIGIN_STORAGE_MAP;
PAGES_AND_OWNER_GATES; VARIABLE_MONITOR_SEQUENCE; UNKNOWNS;
LOCAL_OUTPUTS_SHA; RELEASE_STATUS. Сайт/API maintenance; T37 approval pending.
