# Owner-only восстановление ключа — предложение, не EXECUTOR_TASK

Состояние: PREPARED, NOT AUTHORIZED. Реальная identity/DMG/S3 не открывались;
ключи/права не менялись и новых копий настоящего ключа не создавалось.
T41 release window остаётся draft. RF сайты/API maintenance.

Не найдена независимая копия владельца, не сам серверный ключ: с существующим
ключом ранее выполнялся успешный cold restore. Пароль от bron-source-recovery.dmg
открывает тот контейнер; его содержимое здесь не подтверждено. Он не доказывает,
что владелец может восстановиться без Mac. DMG не открывать и на VPS не переносить.

## Предпочтительный вариант при plaintext AGE только на VPS

- Открытая AGE identity остаётся на VPS, её не показывают в VNC/Chat/на Mac и не
  выдают executor-у. Ротация не нужна; старые backups сохраняют прежний ключ.
- Owner с телефона вводит новую сильную непустую фразу только в скрытый TTY.
  Фраза хранится отдельно у владельца, доступна без Mac/VPS; не внутри того же
  backup/S3/DMG. Helper не передаёт её через argv/env/логи и не сохраняет на VPS.
  Автогенерация age при пустом Enter не должна вывести её на общую VNC: wrapper
  валидирует скрытый ввод, stderr дочернего age не транслируется в консоль.
- Native age1.1.1 шифрует existing identity отдельной фразой. Только полученный
  scrypt-encrypted ciphertext идёт напрямую VPS→существующий private Timeweb S3:
  уникальный migration/owner-key-escrow-<actionUUID>/identity.age. Не новые сервисы,
  bucket/policy/lifecycle/ACL или общие artifact allowlists.
- Single conditional PUT/no overwrite, TLS, bounded GET/readbackSHA. Затем именно
  скачанный из S3 ciphertext используется как `age -d -i <encrypted identity>`
  для закреплённого roles.sql.zst.age → zstd --test. Original raw identity при
  verify не читается; plaintext identity/SQL остаются только в процессах/pipe.
- Receipt: method, object locator, ciphertext SHA/size, exact backup binding,
  readback/decryption PASS и отсутствие originalidentity-read при verify. Без
  фразы/AGE/SQL. Owner отдельно подтверждает сохранность фразы и личный доступ
  к Timeweb и серверному кабинету без Mac.

Новый helper нужен только для этого узкого flow, с новым reviewed/pinned scope.
Текущий T30 raw-identity verifier не является проверкой этой новой схемы;
T30 PASS задним числом не отмечать. T41 owner-proof validator должен явно принять
новый криптографический proof method, сохраняя реальный decrypt и custody gate.

## Доказанная feasibility и ограничения

На Cloud execution workspace выполнен synthetic native roundtrip exact agev1.1.1:
passphrase-encrypted identity, исходная raw identity удалена до восстановления,
backup восстановлен через encrypted -i; неправильная фраза отвергнута. Настоящие
ключи/данные/VPS/S3 не использовались; это crypto feasibility, не готовый serverPASS.
Driver: tests/ops/owner-key-escrow-native.py, только synthetic generated inputs.
Official reference: https://raw.githubusercontent.com/FiloSottile/age/v1.1.1/doc/age.1

## Scope, который требует решения владельца

Текущий backup-restore.md запрещает помещать AGE identity в этот bucket. Поэтому
предложение требует отдельного узкого разрешения на **только зашифрованную другой
фразой identity**, прямой VPS→existingS3 transfer, no Mac/plaintext/othercredentials.
Открытый ключ остаётся только на VPS, но encrypted key material появляется вне
сервера. Если запрещена даже такая внешняя копия, независимое восстановление
после полной потери VPS несовместимо с этим запретом. Альтернатива — личная
бумажная AGE-копия владельца; она проще, но открытый ключ уже покинет VPS.

## Личный доступ с телефона

Сначала owner лично открывает https://my.adminvps.ru/login, проходит свой login/MFA
и из карточки существующей услуги386078 / IP152.228.115.115 заново открывает
управление/консоль. Не переносить signed VNC-ссылку из Mac. Точное расположение
кнопок не подтверждено; причина «Неразрешенный» ещё не диагностирована.
Если страница снова пуста/Unauthorized — сообщить только домен и этап, без URL
с токенами, паролей и скриншотов секретов. Никаких reset/reinstall/reboot.
CDP navigation timeout на Mac — отдельный инструментальный сбой, не proof VPSdown.
До нормального личного TTY новый secret-entry flow не запускать.
