# T59 — proposed final scope: two Auth timestamps, two final snapshots

PENDING OWNER DECISION. No Source data read, target DML, new capability or live
window is authorized by this proposal. It prepares the smallest remaining repair.

## Confirmed problem

T58 completed its one authorized diagnostic and exhausted the original three
attempts. Source/target each have16 matching user UUIDs. Two records differ:
one differs in last_sign_in_at+updated_at, the other only in updated_at. The
updated_at values are Source-newer (2), target-newer0, null-change0. All other
Auth column fingerprints matched. Target was not modified. T58 reader is now
tombstoned and verified410; Source write fence and public maintenance remain.

T58 safe evidence: result385e9c2f6e5005b10fb06bb49d78b889ee452ecaa119e89f445b2b04eccee94b;
guard0a4c6e1d07e43e84c36f02d3f5ac73d6b2f6cbb0ce4603dc4e9a1563690adaab;
attempt3claim6f9700af4cd91d643bc133602cbcdb72da40ceee60eed69025917d6ca953c972.

## Exact proposed permission

1. Permit exactly two new READ ONLY Source snapshots, release attempts4 and5,
   before and after the guarded target reconciliation. Total limit5 includes
   the three already spent; failure/timeout/unknown consumes its claimed attempt.
   Old scopes, claims, guards and results remain immutable. A new append-only
   final scope links the old two claims and T58 claim3; no reset or refund.
2. Each snapshot keeps the full existing strict counts/SHA/sequence state and
   <=16 compact Auth records: UUID, updated_at text+epoch micros, LAST_SIGN_IN_AT
   text+epoch micros, and SHA of the remaining fields. Those other-field digests
   remain password/token-derived; raw passwords/tokens/emails/profiles/business
   records are excluded. New timestamp values are encrypted directly in Source
   and decrypted ONLY in RAM of VPS152.228.115.115, never Mac/GitHub/chat/disk.
3. Permit a single guarded target transaction to copy exact Source values of
   ONLY last_sign_in_at and updated_at into at most TWO existing Auth users.
   Source is authoritative for both timestamps, including NULL/older values if
   present. No other field, user UUID, account membership, password, token, role,
   schema or business record may be changed. Any other mismatch stops the run.
4. Before writing, lock the target rows, verify unchanged captured values and
   SHA of every other field, and fsync a root0600 before-image containing only
   target UUID+two old timestamps and technical bindings/metadata SHA on VPS.
   Precommit checks, rollback and COMMIT_UNKNOWN handling remain mandatory.
5. The final auditor still compares WHOLE Auth rows, including both timestamps;
   no field is excluded from the strict migration comparison. Only the guarded
   repair planner excludes the two fields it is permitted to change. Keep two
   fresh Source frames, full target snapshots, all four current fence ACKs,
   Source-before/after equality, roles/database invariants and freshness gates.

As before: mandatory private256bit capability before Source DB access, <=2hour
expiry, fixed read-only queries, RR/UTC/deadlines, native TLS/hostname plus negative
control, fresh physical backend witness, Source→VPS AES-GCM/HKDF, no private data
through Mac. Platform JWT is off only on the temporary capability-authenticated
machine endpoint. Safe output contains only counts, field names and technical
receipt hashes. Close the reader after the phase. Pause Source ONLY after actual
strict PASS; no Source data query after pause.

## Completion route

After actual approval proof AND the pinned conditional T59 packet: prepare once, Root deploys and
verifies Source code, parent preflight, automatic ready+four-ACK broker, one final
window. On strict PASS close/pause Source, then actual owner phone/password/PWA/
existing draft-and-queue acceptance and one public switch/live verification.
No OAuth, owner secret entry or repeated closed restore/build/Auth/RLS/monitor/key
checks are needed. No further diagnostic, generic migration framework, extra
infrastructure, hardening or closure paperwork is part of this route.

The proposed owner decision is only the two timestamp fields/max2 target rows and
the two extra encrypted Source snapshots (total5). Publication remains gated by
actual final strict PASS and actual owner acceptance.
