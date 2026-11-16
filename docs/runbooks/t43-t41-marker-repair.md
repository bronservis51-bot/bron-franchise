# T43: завершить доставку отсутствующего approval marker T41

Причина установлена T42: marker отсутствует, errno2; остальные5 public inputs
совпадают. Это исправление служебных metadata. Нового helper/версии key protocol
нет; исходные T41 manifest и все54 file pins остаются прежними. Сайты/API maintenance.
T42 SSH inspect1/1 использован; он не повторяется.

T41 marker был отдельным пунктом `approval_marker`, вне26 `deliveries`. Поэтому
26/26 SHA не доказывало его наличие. Почему и когда файл стал отсутствовать,
не установлено; расследование истории сейчас не требуется для этого исправления.
В T43 marker — отдельный явно закреплённый delivery artifact.

## 1. Принятие

Fast-forward чистого checkout только до commit из EXECUTOR_TASK. Проверить SHA
manifest и все2 `files`; ACCEPTED с local/canonical receipt paths. Допустим
подготовленный Root Git bundle через уже проверенный браузерный маршрут. Только
код/служебные metadata, без Source/ключей/backup. Транспортную ветку не checkout.

## 2. Фактические условия перед единственной записью

- Strict SSH fingerprint из manifest. Проверить exactSHA canonical T42 receipt
  и сохранённого safe inspect result по принятым путям T42. Результат должен
  подтверждать MARKER/FileNotFoundError/errno2 и MATCH остальных5 inputs.
- Обычным чтением файлов сверить original T41 owner manifest, wrapper, crypto,
  workflow и S3 code по `expected_t41_public_files`. Это проверка перед записью,
  не повторный запуск T42 helper. Ни identity, ни backup/credentials не читать.
- Проверить существующие ancestors `/root`, `/root/bron-secrets`,
  `/root/bron-secrets/t41-owner-recovery`: root:root0700, directory, не symlink.
- Проверить новый marker artifact: ровно65 bytes, lowerhex64+LF; его bytes равны
  исходному T41 manifest SHA + LF, SHA artifact совпадает с manifest T43.

## 3. Единственный разрешённый ремонт

Доставить artifact в **точный** destination:
`/root/bron-secrets/t41-owner-recovery/approved-manifest.sha256`.
Использовать ту же проверенную доставку файлов с O_EXCL/no-follow, root:root0600,
file fsync + directory fsync и последующим SHA/size/content readback.
В manifest T43 явно перечислены только этот artifact и собственный task manifest.
Трассировочные T43 receipt/state разрешены отдельно; других T41 изменений нет.

Если marker уже есть, не перезаписывать и не chmod: только если он regular,
root:root0600, nlink1, no symlink, exact65 bytes/SHA/content, допустим результат
`NO_WRITE_ALREADY_MATCHED`. Иначе BLOCKED_STATE_CHANGED. При частичной записи/
ошибке сохранять факт и остановиться; не удалять и не переписывать файл.

После записи или NO_WRITE_ALREADY_MATCHED подтвердить все6 public pins и metadata
marker. Marker SHA:
`2d2b23617cc14ef16668a9c9260cad5f4f19d69e861a85126609b0335e6415a4`.
Никакой интерпретации текста marker как shell-команды. В нём нет секретов.

## 4. Продолжение без нового task ID

После marker PASS владелец лично в физической root-консоли телефона один раз:

```sh
python3 -I /root/bron-secrets/t41-owner-console.py check
```

Если actual `READY`, продолжить уже одобренный T41 `recover → attest` по его
checklist. T43 сам не выполняет recovery; новое согласие не нужно. В T41 по-прежнему
один conditional PUT/bounded GET, hidden phone TTY, никакого Mac-transit секретов.

Если снова именно `OWNER_CONSOLE_CHECK_FAILED`, разрешён оставшийся0/1 phone
diagnostic T42, **только после успешных6 T43 pins**, absent phone-result и exactSHA
уже доставленного T42 diagnostic. Это явное T43 разрешение заменяет для этой
неиспользованной phone-ветки старое условие успешного T42 SSH inspect. Сам T42
SSH inspect не повторять. Владелец один раз запускает:

```sh
python3 -I /root/bron-secrets/t42-owner-console-diagnostic.py --diagnose
```

Не pipe/tee/redirect stdio. Прочитать созданный safe phone-result.json по SSH и
передать Root вместе с SHA. Не повторять check после этого и не ремонтировать
другие файлы. При любом другом BLOCKED code сразу передать safe code/phase.

## 5. Квитанции и границы

Canonical `/root/bron-secrets/t43-release-receipt.json`, local mirror
`/tmp/bron-release-executor-20261113/T43-state.json`,0600 и равныеSHA.
Фиксировать входные SHA, CREATED/NO_WRITE_ALREADY_MATCHED, marker path/stat/
SHA/content equality,6pins, owner check result, optional phone diagnostic counts,
changed paths и actual outcomes. Safe metadata only. Source effects, данные,
backups, credentials, helper/manifest edits, S3, network repair, preview/Pages и
publication под T43 запрещены. T41 budget остаётся1/3 до его final phases.
