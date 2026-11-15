# T58 owner approval — one Auth-only diagnostic, attempt 3/3

APPROVED by the owner in this conversation on 2026-11-15. This changes only the
purpose/payload of the unused third attempt; the total stays three. The old two
spent attempts, scope, claims, guards and results remain immutable.

Exact owner decision:

> OWNER_APPROVAL T58: Разрешаю именно описанный scope. Используйте последнюю,
> третью попытку на одну read-only Auth-диагностику вместо финального after-снимка:
> до 16 прежних компактных Auth-записей и до 35 агрегированных SHA/count целых
> колонок; Source→RAM VPS encryption; в Mac/чат только счётчики и названия
> отличающихся полей; без исходных значений, DML, повторов и сброса ledger.
> Понимаю: это исчерпывает 3/3 и само по себе не публикует сайт.

The described scope accepted by this decision includes fingerprints derived from
password/token/profile-related columns. Raw field values and per-user/per-field
hash vectors are excluded. Original compact records contain only UUID, updated_at,
epoch micros and whole-other-fields SHA. They and the whole-column fingerprints
are encrypted in Source before response and decrypted only in VPS152.228.115.115
RAM. They are not sent to Mac/GitHub/chat or written to private-frame files.

The temporary fixed reader requires a private256bit capability before database
access; platform JWT is disabled only for this capability-authenticated endpoint.
The capability stays root0600 on VPS and lasts <=2hours. Fixed queries only,
READ ONLY/RR/UTC/deadlines, native CA+hostname and negative TLS control, current
Source fence proof and a fresh physical backend witness precede Auth reads.

A separate append-only T58 scope binds the immutable old scope+claims1/2 and
explicitly supersedes the unused original slot; it claims release attempt3 before
POST. FAIL/timeout/unknown consumes the attempt. Historical old count2 is reported
separately from effective release total3; no reset/refund, repeat, or future final
read is authorized. After the phase Root tombstones the reader and verifies410.

T58 permits no target/source DML, raw Auth transfer, Source pause, preview or public
release. The remaining exact Auth correction and fresh two-frame final verification
require their own concrete scope after diagnosis. All existing release gates and
Source write fence/maintenance remain in force; no new OAuth or secret entry needed.
