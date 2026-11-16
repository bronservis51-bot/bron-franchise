# T64A — немедленное исправление технического доступа сотрудников

Production остаётся публичным, Source INACTIVE. Это отдельный срочный ACL hotfix
по прямому поручению владельца: устранить «Недостаточно прав» у франчайзи и
сотрудников. Без ожидания сборки телефона-логина или рейтинга. T63 client и его
14 дней выручки сохраняются. Ни один Source/backup/restore gate не повторяется.

Точный commit и SHA `payloads/t64a-access-hotfix.json` выдаёт Root. Проверить его
четыре file pins, отправить ACCEPTED и продолжать без нового подтверждения.
Если другой helper работает, checkout не менять; получить четыре закреплённых
файла через git show указанного commit в отдельную private папку.

## Доставить и выполнить один helper

Каталог VPS `/root/bron-secrets/t64a-access` root:root0700. Файлы root:root0600,
O_EXCL/no-follow, fsync/SHA readback:

- `t64a-access-hotfix.py`;
- `20261116040000_staff_helper_execute.sql`;
- `t64a-migration-manifest.json` под именем `migration-manifest.json`.

Использовать прежний strict SSH с закреплённым ED25519 ключом сервера. Никаких
новых owner-команд, логинов/MFA, ключей или сетевой настройки не требуется.

```sh
python3 -I /root/bron-secrets/t64a-access/t64a-access-hotfix.py --migrate --directory /root/bron-secrets/t64a-access --manifest /root/bron-secrets/t64a-access/migration-manifest.json
```

Helper проверяет прежние DB container/image и T63 live manifest, читает текущую
freshness уже созданной копии/health; backup не создаёт. Каталог до/после — только
pg_proc/pg_roles/EXECUTE, 9 функций и 11 связей, без пользователей/Auth/денег.
В одной транзакции проверяются три точных ledger checksum T63 (без их повторного
исполнения), применяется только миграция040000 и сохраняется её checksum.

Миграция проверяет фактических владельцев старых RPC/новых helpers. Добавляется
только недостающий EXECUTE четырёх приватных helper-функций прежнему доверенному
владельцу приложения postgres. PUBLIC/anon/authenticated, owners/role flags,
назначения бизнес-ролей, аккаунты, пароли, сессии и финансовые записи не меняются.
Неизвестные owners/missing functions блокируют транзакцию, не расширяют права.

## Принять результат и проверить реальную страницу

Ожидается `MIGRATIONS_COMMITTED`, `missingExecuteAfter=[]`,
`aclCatalogPostcheck=PASS`. До postcheck сохраняется durable `migration-commit.json`;
затем `catalog-after.json` и `migration-receipt.json`.

Если `aclGapObservedBefore=false`, технический разрыв не был подтверждён;
не выдавать это за доказанное устранение причины. При
`COMMITTED_POSTCHECK_BLOCKED` схема уже применена, результат не UNCHANGED;
повтор запрещён. После неоднозначного обрыва сверить сохранённый COMMIT/ledger,
не перезапускать и не удалять state. Нового клиента здесь нет.

В существующей законной сессии повторить ранее упавший readonly запрос/экран
обычной кнопкой повтора. Сетевой менеджер открывает сотрудников в карточке
франчайзи, франчайзи/управляющий — свой экран; сотрудник — свои смены. Не очищать
storage/PWA queue, не создавать фиктивные смены/выручку, не подменять JWT/роли.
В чат только код роли/permissions booleans, RPC/code и PASS/отказ, не личные данные.

Итог: safe canonical `/root/bron-secrets/t64a-release-receipt.json` 0600 и
идентичный local mirror `/private/tmp/bron-release-executor-20261113/T64A-state.json`:
commit/manifest SHA, migration checksum, before/after gaps, COMMIT, UI outcome,
Sourcequeries=0, resets=0, roleAssignmentsChanged=0, servingMode=PRODUCTION_PUBLIC.
Копировать в него безопасные поля helper receipt без личных данных.

Роль исполнителя остаётся активной. После этого основной T64 применит рейтинг
и телефоны-логины, а 040000 по совпавшему ledger SHA **пропустит**, не запустит снова.
Если реальные права по-прежнему отклонены, сообщить исходный RPC/code; не угадывать
партнёра/назначение и не выдавать всем дополнительные роли.
