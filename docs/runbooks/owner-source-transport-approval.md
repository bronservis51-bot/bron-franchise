# Решение владельца: временная передача результатов сверки Source → VPS

**PENDING. Этот документ не является разрешением или EXECUTOR_TASK.**
T37 не развёрнут; source working/Auth rows по новому каналу не передавались.
Автоматическая проверка отклонила deployment до явного owner authorization
точного чувствительного payload и получателя.

## Один ограниченный data-scope для оставшегося выпуска

Запрашивается разрешение на временную функцию в существующем Source Supabase,
защищённую обязательным private256bit capability до обращения к БД; разрешены
только закреплённые READ ONLY запросы, не произвольный SQL/URL. Внешний JWTgate
отключён только у этой machine-auth функции; продуктовые Auth/RLS не меняются.

Единственный получатель — RAM VPS `152.228.115.115`. Полный ответ шифруется
AES-GCM/HKDF ещё в Source. Секрет создаётся/хранится только на VPS root0600;
Source code содержит SHA256/absolute expiry, секрет бывает в SourceRAM при вызове.
Один секрет действует максимум2часа. Если старый истёк до начала разрешённого
этапа, координатор готовит новый отдельно закреплённый пакет; скрытого продления
или запуска просроченного T37 не будет. Owner secret input для этого не нужен.
Mac получает только технический отчёт/counts, без ciphertext/workingdata/backup.

Payload каждого snapshot:

- полные прежние strict audit counts/SHA256 всех table/schema groups и sequence state;
- максимум16 compact Auth records: UUID, updated_at, epoch micros и per-user SHA256
  UTF8 представления `(to_jsonb(auth.users row)-'updated_at')::text`;
- этот digest зависит от всех остальных полей, ВКЛЮЧАЯ password-hash/token-related
  поля при наличии. Это credential-derived приватные данные; исходные значения
  password/token/profile fields не экспортируются;
- фиксированные технические поля: database/role/session/owner, READONLY/isolation,
  statement/idle deadlines, backendPID/backendStartMicros, serverAddress/databaseTime,
  frame started/finished/expiry и TLS-proof flags. SQL/DSN/credentials/raw rows и
  fence-beforeimage не входят в этот Auth-payload.

Максимум **три попытки Auth-bearing snapshot в сумме для этого выпуска**,
включая FAIL/timeout/неопределённый исход. Это общий бюджет для всех pinned
пакетов и capability: новый секрет его не сбрасывает. Никаких скрытых повторов:


1. Один T37 live read-only audit/Auth-план.
2. Один snapshot в финальном окне ДО target COMMIT, после подтверждённой остановки
   Source-записи и личного key/device proof.
3. Один после target COMMIT при всё ещё закрытом Source: доказать sourceUnchanged
   и полный strict match; затем Source может быть paused.

T37 как отдельный task по-прежнему имеет onePOST/no-DML/no-freeze; разрешение на
общий data-scope не запускает последующие этапы автоматически. Финальные два
вызова требуют другого pinned пакета, фактического pre-data backend witness,
проверенного inverse/beforeimage/барьера и остальных release-gates. Этот data-scope
не расширяет разрешения target/source DML, раскрытие иных полей, raw businessrows,
перенос через Mac или открытие API. Код финального HTTPS operator ещё адаптируется;
старый directPGrunner не активировать. Неустранимый diff вне timestamp-only scope
останавливает узкий final path, а не исключается из comparator.

После каждой завершённой snapshot-фазы временный endpoint явно закрывается/tombstone;
absolute expiry — дополнительный предел, не причина оставлять endpoint открытым;
ни одного нового чтения после SourcePause. Новый scope/payload/получатель/лимит
сверх трёх попыток потребует отдельного решения. До явного ответа владельца статус PENDING.
