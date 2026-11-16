# T59 — one conditional release package

This pinned packet authorizes the complete conditional route, not the new data
scope by itself. The immutable manifest uses OWNER_PROOF_REQUIRED. Until Root
records the actual owner decision in a separately SHA-pinned APPROVED owner proof,
do not deliver/prepare/deploy/query/run. No new task ID or manifest is required
after that proof. Source stays
fenced and app/API maintenance. This is the final reconciliation route, not another
diagnostic. T58 established only last_sign_in_at+updated_at differences in2users.

## A. Accept now; prepare only after actual owner proof

1. Clean idle checkout: fast-forward to the issued commit and verify MAIN manifest
   SHA/all declared files. Acceptance/local static checks may finish now. Root
   supplies actual owner-approval.json bytes/SHA only after explicit owner consent;
   place them at /root/bron-secrets/t59-release/owner-approval.json with exclusive
   root0600/fsync/readback during the authorized delivery. The helper refuses
   pending/missing/unbound proof. Preserve
   every old claim/guard/result. Use canonical /private/tmp/bron-release-executor-20261113/T59
   0700 and local T59-state.json0600; never use the /tmp symlink as driver directory.
2. Reuse strict pinned SSH. Verify existing Node22.23.5/pg8.23.1/lock pins, healthy
   target ID/image, loopback15433 and no T59 process/state/guards. Reuse T44 key
   proof and existing T45 control/T55 channel; do not repeat their live checks.
3. Create T59 directories root:root0700 and deliver only manifest deliveries with
   O_EXCL/O_NOFOLLOW, root:root0600, fsync and exact byte/SHA readback. The isolated
   new /root/bron-secrets/t59-runtime contains exactly the12 runtime_files paths.
   Existing old runtime/ledgers are verify-only. No overwrite/install/service change.
   Existing identical delivery files may be verified; differing files stop.
4. One remote preparation (task supplies both public pins):

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t59-final-window.mjs --prepare-final --manifest /root/bron-secrets/t59-release/manifest.json --sha256 MAIN_SHA --t55-receipt-sha256 ae80d30eea394c17935cf0c53da0baacff9f9dbe75f9d8088597a2cde3e623f4 --owner-approval-sha256 ROOT_OWNER_PROOF_SHA
```

Expected FINAL_READY, target metadata-only probe PASS/rollback, Auth reads0,
source snapshots0, effective prior used3/new remaining2. The new append-only scope
seals the immutable old2claims+T58claim3; fresh capability stays VPS-only for2hours.
Report only preparedSha256/capabilitySha256/functionName/expiresUtc/six executable
hashes, target probe and safe receipt SHA. Do not read/print/copy capability.
Canonical /root/bron-secrets/t59-release-receipt.json and local
/private/tmp/bron-release-executor-20261113/T59-state.json0600 must match; retain
unique previous receipt versions, never overwrite guards/results.

## B. Root deployment and automatic transport

Root deploys the pinned template with new six-field Auth module and unchanged full
audit/fingerprint/encryption/witness code, verifies six executable hashes, ACTIVE,
JWT=false and TLS GET403/purposeBRON_PRIVATE_SNAPSHOT_V1. Store only Root-supplied
deployment-proof.json bytes/SHA at the fixed T59 path, root0600/exclusive/fsync.

Root creates the existing-repository technical relay branch; no workflow/monitor
dispatch or new credential. Parent uses the proven five-stage Python+GitHub relay,
not native CLI/SQLite/manual chat ACK. Use actual prepared/proof pins below:

```sh
python3 -I docs/runbooks/payloads/t59-relay-driver.py --manifest docs/runbooks/payloads/t59-final-window.json --sha256 MAIN_SHA --ssh-options-json /tmp/bron-release-executor-20261113/T55/ssh-options.json --directory /private/tmp/bron-release-executor-20261113/T59 --prepared-sha256 ACTUAL_PREPARED_SHA --deployment-proof-sha256 ACTUAL_DEPLOYMENT_SHA --t55-receipt-sha256 ae80d30eea394c17935cf0c53da0baacff9f9dbe75f9d8088597a2cde3e623f4 --preflight
```

Report T59_CLIENT_READY_NO_NONCE. No timer/Source call before explicit Root
T59_BROKER_ARMED. Then execute the same command with --run instead of --preflight,
exactly once. Checkout stays fixed during the window. The parent checks current
backup-health (TLS503/healthytrue/check<=25m/backup<=70m), performs one ready exchange
(roundtrip/age<=30s), immediately starts final and serves four automatic ACKs
(Source-clock/request binding/<=60s). Capability headroom>620s; final wall<=480s.

## C. Exact effects and final acceptance

Source frames are fresh RR READ ONLY/UTC with physical backend witness before
working rows, strict TLS/negative control, encryption directly to VPS RAM. They
carry the old full strict snapshot plus <=16 UUID+updated_at+last_sign_in_at
text/microsecond records and a digest of all remaining Auth fields. No raw
password/token/profile/business values; no private frames/ciphertext on Mac/disk.

Only if cohort16 and every other Auth field match, modify at most2 existing target
users in one guarded transaction. Copy only the two timestamp columns from Source,
with exact microseconds/NULLs under explicit Source-authoritative permission.
Lock/check captured target values/other-field hash and metadata, fsync old-target
UUID+two-timestamp before-image first; verify every update count and precommit
equality. No schema/account/password/token/role/business changes. Any outside-field
or row-bound mismatch stops without widening scope; safe plan counters survive.

Second fresh Source frame proves Source unchanged, then complete target audit must
strictly match. Full auth.users audit includes ALL fields and both timestamps;
there is no ignored Auth column. Roles/database unchanged, all four current fence
ACKs, old T45/T53/T56/T58 files unchanged, effective budget5/5 not uncertain,
durable result/receipt and cleanup are required. Zero-delta PASS is UNCHANGED;
positive update PASS is COMMITTED. UNKNOWN is preserved through later errors.

Report actual status/phase/code/authPlanSummary counts, changedAuthTimestampRows,
targetWriteOutcome, Source frame counts/effective budget and technical receipt
SHAs only. No per-user identifier/digest/timestamp values. BLOCKED/UNKNOWN stops;
no retry/reset/refund/Source inverse. Do not automatically reopen Source after
COMMITTED/UNKNOWN or any later user writes.

After actual strict PASS Root closes reader/readback410 and pauses Source/provider
status verification. Then actual owner phone/password/PWA/existing drafts+queue
acceptance, one public switch/live checks. These accepted release gates remain;
optional cleanup/hardening/infra/extra diagnostics and repeated closed tests do not.

## D. Continue through public launch in this same task

Follow the manifest-pinned `docs/runbooks/t59-post-final-cutover.md` immediately
after actual strict PASS. It contains the exact web-only Compose commands,
Source closure/pause, paired public client variables, required old-origin queue
preservation, actual owner acceptance and public/live checks. Do not wait for
another task ID. Root deployment/proof and broker ARMED are technical inputs;
they are not additional owner permission requests. Never substitute manual ACKs.

Progress schema (safe fields only):
`task,stage,status,phase,code,manifestSha256,preparedSha256,deploymentProofSha256,
authPlanSummary,changedAuthTimestampRows,targetWriteOutcome,sourceFrameAttempts,
effectiveAttemptsUsed,budgetUncertain,sourceMustRemainClosed,ownerAcceptance,
publicLiveChecks,changedPaths,receiptSha256,nextBlocker,remainingMinutes`.
Final `RELEASED` requires strict final PASS, Source closure/pause verified, actual
owner acceptance and working public RF cabinet/API; static200 alone is insufficient.
