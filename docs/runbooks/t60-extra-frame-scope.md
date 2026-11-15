# T60 — one additional Source attempt; unchanged reconciliation scope

OWNER DECISION PENDING. This reviewable document and the conditional manifest are
not consent. No T60 delivery/prepare, Source deployment/query, snapshot or target
mutation may run before the actual owner's yes is bound by Root's separately
pinned APPROVED owner-proof to the exact accepted T60 manifest/document SHA.

## Why one additional attempt is needed

T59 reached the first complete Source frame and the guarded Auth plan, but its
before-target-write fence exchange timed out. Existing evidence records target
UNCHANGED, beforeImage=null, one Source frame, valid claim4 and no claim5. T59's
run guard is consumed; its files, earlier four spent claims and results stay
immutable. A successful replacement needs two fresh before/after frames; reusing
an old frame or skipping the after frame would weaken the final acceptance gate.

Permit T60 to use the previously unspent attempt5 and **one additional attempt6**:
total cap rises only from5 to6, including all four already spent attempts. T60
creates an append-only scope linking the unchanged T59 scope/result/claims. Claims
5 and6 belong to T60.final_before/T60.final_after and one fresh T60 capability.
Failed, timed-out and uncertain claimed attempts count; no reset, refund, guard
replacement, extra retry or additional diagnostic is allowed.

## Exact data and mutation scope stays the same as approved T59

Two fixed RR READ ONLY/UTC Source snapshots: existing complete strict counts/SHA,
sequences and schema fingerprints, plus at most16 existing compact Auth records
with UUID, exact last_sign_in_at and updated_at text/microseconds (including NULL),
and the digest of all remaining fields. Those digests may be derived from
password/token fields; no raw passwords, tokens, emails, profiles or business-row
values are returned. Encrypt directly Source→RAM of VPS152.228.115.115. No private
frames/values/ciphertext on Mac, GitHub, chat or snapshot files.

In one guarded target transaction, copy ONLY last_sign_in_at and updated_at from
Source into at most TWO existing Auth users. Source remains authoritative for
both timestamps, including NULL/older values. No other Auth field, membership,
password, token, role, schema or business record changes. Cohort16 and every other
Auth field must match. Preserve target locking, unchanged-value/hash checks,
root0600/fsynced target UUID+two-old-timestamp before-image, row-count/precommit
checks, full final strict comparator and before/after Source equality. No ignored
Auth columns. An outside-scope mismatch stops without broadening permission.

The transport correction only increases the existing GitHub **response GET**
per-call allowance5s→20s, capped by the unchanged remaining stage deadline. It does
not add retry loops or extend the60s fence stage, nonce/source-clock checks,
30s readiness, SSH8s or GitHub PUT5s bounds. Capability/TLS/encryption/read-only
witness/security boundaries and temporary endpoint closure remain unchanged.

After strict final PASS: close the reader/verify410, pause/verify Source, actual
owner phone/password/PWA/existing-queue acceptance, then one public switch/live
verification. Reuse all closed PASS gates; no additional OAuth, secret entry,
backup/restore, RF build, RLS, Telegram or schedule check is introduced. Publication
is not implied by approval of the extra attempt.

The exact owner decision is: approve ONE additional Source attempt, total6 with
four spent, enabling two fresh T60 frames5+6 and the unchanged T59 two-timestamp,
max-two-user guarded reconciliation and completion route. Until that yes and
Root's matching APPROVED proof, T60 remains nonexecuting and maintenance stays on.
