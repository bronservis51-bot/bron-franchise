# T44: последняя изолированная recovery-попытка

Owner 15.11.2026 явно разрешил одну последнюю recovery-попытку через новый pinned
T44, с новым isolated guard/state, сохранением consumed T41 guard/result на месте,
без reset/overwrite/rerun. Метод и secret boundary прежние: plaintext AGE только
на VPS; новая личная фраза hidden phone TTY; только scrypt ciphertext напрямую
VPS→existing private Timeweb S3; unique no-overwrite PUT и bounded GET/readback.
Новых storage/egress permissions, сервисов или owner approval не требуется.

Прежний архивный черновик отменён до pin/deploy: он не исполнялся. T41 guard и
result остаются **в исходных путях и байтах**. Recovery T41 не повторять.

## 1. Что известно и что разрешено

T41 check READY подтверждён. Его первая recovery invocation остановилась на seal;
владелец подтвердил invalid-length/diversity input и отсутствие второго prompt.
Все4 ciphertext/put/download artifacts отсутствуют. Pinned control flow доказывает
отсутствие raw identity open и PUT/GET этой попыткой; credentials/HEAD были раньше.
Точный внутренний exception обработчик не сохранил. Неудача остаётся BLOCKED.

T44 имеет собственные task/action, manifest, prepared, guard, result и attestation
в `/root/bron-secrets/t44-owner-recovery`. Original T41 code/manifest/marker и
guard/result не меняются. Новый runner SHA-проверяет и компилирует original
workflow как non-main, переиспользует только metadata/FS/crypto/S3 primitives.
Original main/owner_recover/attest и изменение его globals запрещены. Новый
orchestration явно пишет task/action T44; выдавать его результат за T41 PASS нельзя.

## 2. Получение и metadata prepare

Fast-forward чистого checkout до commit из EXECUTOR_TASK; сверить manifest SHA и
все3 объявленных file SHA. Допустим Root bundle по уже работающему браузерному
маршруту; без новых DNS/сетевых экспериментов. ACCEPTED с receipt paths.

Strict SSH fingerprint прежний. Доставить только новый T44 runner и T44 manifest:
root:root0600 regular/nlink1, O_EXCL/no-follow, file+directory fsync/readback.
State directory root:root0700. Старые T41 файлы не трогать. AST-only syntax для
нового Python; dependencies/старые builds/restore/Telegram не повторять.

Один metadata-only prepare:

```sh
/usr/bin/python3 -I /root/bron-secrets/t44-owner-key-recovery.py --prepare --manifest /root/bron-secrets/t44-owner-recovery/manifest.json --sha256 <T44 manifest SHA>
```

Он проверяет шесть original public pins, exact old failure SHA, отсутствие4
побочных artifacts и чистоту нового state. Original load_context также выполняет
разрешённый lstat key/credentials/backup и читает public backup manifest, local
IP/age version; raw key/credential/ciphertext/backup bytes и S3 не читаются.
Собственный prepared.json создаётся и проверяется самим runner, не ручным marker.
Только успешные exit0 + фактический PREPARED и readback допускают phase3.
При BLOCKED/partial/неопределённом исходе — STOP, без удаления/перезаписи state.

## 3. Ровно одна последняя owner recovery invocation

До команды владелец подготовил новую сильную фразу:20–1024символа, минимум4
различных, минимум20 после trim, без управляющих символов, UTF-8≤1024bytes.
Подходят длинные случайные слова; не использовать пример из чата, пароль DMG
или сервера. Фраза заранее в независимой личной копии без VPS/Mac, предпочтительно
на бумаге. Не синхронизировать её на Mac. Саму фразу/её фрагменты не присылать.

Владелец лично на телефоне в рабочем physical root TTY, один раз:

```sh
python3 -I /root/bron-secrets/t44-owner-key-recovery.py --owner-recover
```

Это новый T44 command. Старый T41 command не запускать. Runner проверяет phone
TTY и создаёт новый one-shot guard до ввода; input retry loop отсутствует.
Новая фраза скрыто запрашивается дважды; приёмка input идёт до credentials/HEAD,
затем original approved seal→PUT1→GET1→downloaded identity verify на pinned backup.
По запросу ввести фразу из независимой копии. Не применять pipe/tee/redirect,
неисправный clipboard или запись экрана для секрета. При BLOCKED — STOP:
ещё одна invocation этим пакетом не разрешена; оба failed/success state сохраняются.

После actual crypto PASS и личного AdminVPS/Timeweb phone access, владелец:

```sh
python3 -I /root/bron-secrets/t44-owner-key-recovery.py --attest
```

ASCII yes подтверждает только действительно выполненные custody/device факты.
Executor передаёт Root safe result/attestation/prepared JSON и SHA, сведения о
новом guard и before/after hashes старого T41 guard/result. Key/ciphertext/backup
bytes и фраза не проходят через Mac/чат. Source effects пока запрещены.

## 4. Audit и критерий PASS

До новой owner invocation: actual recover total1 failed; additional authorized1;
max total2. После реального вызова actual total2. T44 result/attest несут taskT44,
own manifest SHA, original T41 manifest SHA, оба old failure SHA, attemptNumber2
и oldT41Unchanged. Сам metadata prepare не считается второй recovery invocation.

PASS означает downloaded S3 ciphertext hash verified и реальную расшифровку pinned
backup encrypted identity, без original raw identity при verify; затем отдельная
owner custody attestation. Root принимает только actual T44 evidence со своей
lineage, не переписывает старый T41 BLOCKED и не подменяет его результат.

Canonical `/root/bron-secrets/t44-release-receipt.json`, local mirror
`/tmp/bron-release-executor-20261113/T44-state.json`,0600/equalSHA. Фиксировать
actual commands/counts/outcomes и входные SHA. Source snapshot budget остаётся1/3.
После этой последней попытки дать фактический итог и минимальный release-plan.

## Минимальная последовательность до безопасного рабочего релиза

1. T44 actual key restore + отдельная независимая custody/device proof. Подготовка
   или check её не заменяют. При FAIL остаётся реальный key-proof blocker.
2. Один final-window пакет: actual T44 binding, свежесть backup, durable inverse,
   обратимое прекращение всех Source writes и проверка fence; перенос фактической
   дельты и strict final audit; известный COMMIT outcome, reader closure и Source
   Pause/readback. Другие data/schema/sequence diff не игнорировать. Узкий уже
   подготовленный updated_at path допускает только свой проверенный случай.
3. Private web-only preview + переходные static на старых Pages origins при
   IP-gated RF API; парольный UI-вход и реальная phone/PWA/draft/queue приёмка,
   формы/правильная запись и конфликты без вымышленных лидов/финансовых записей.
4. Один public switch после приёмки; live новые/старые URL, lead intake/write,
   единственный writer, Auth/RLS, routing существующего monitoring и rollback
   readiness. Откат после target writes требует reconciliation, не смены DNS.

Переиспользовать T12/T14/T18/T19/T21/T22/T37/T39/T40/T43 до затрагивающего изменения.
Не повторять restore, builds, Telegram delivery, schedule, TCP/MTU. Обязательную
адаптацию binding настоящего T44 proof и следующий operational checklist готовить
параллельно owner input, без новых Source действий до разрешённых gates.

После запуска: GitHub visibility, legal questionnaire/docs (owner deferred), SLA
procurement, МойСклад, product enhancements, optional hardening/cleanup. Новая
инфраструктура/monitoring/dispatch сейчас не требуются. Data preservation,
Auth/RLS, restoreability, safe rollback и реальная acceptance остаются обязательными.
