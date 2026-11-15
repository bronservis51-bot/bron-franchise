# T58 — authorized single Auth-only diagnostic

Source remains write-fenced; app/API remain maintenance. T56 is stopped with no
target write. T57 catalog comparison is closed; do not repeat it. This task uses
only the owner's newly approved remaining attempt3 for diagnosis, never repair.

## A. Accept and prepare once

1. Fast-forward a clean, idle checkout to the supplied exact commit. Verify the
   manifest SHA and every declared file; separately verify the Root owner-proof
   SHA supplied with the task. Keep T56/T57 evidence and all spent guards/claims.
   Use canonical private local /private/tmp/bron-release-executor-20261113/T58
   (0700) and /private/tmp/bron-release-executor-20261113/T58-state.json (0600).
2. Reuse strict SSH/known-host identity SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0.
   Verify existing Node22.23.5/pg8.23.1/lock pins, target DB container/image healthy,
   no T58 process/guards/state/extension ledger. No Source request or target Auth
   read yet. Do not dump Docker env or Compose configuration, install or restart.
3. Create /root/bron-secrets/t58-release as root:root0700 only if absent. Deliver
   exactly manifest deliveries with O_EXCL/O_NOFOLLOW, root:root0600, file/directory
   fsync+byte/SHA readback. Existing identical delivery files may be verified;
   differing files stop. Include separately pinned owner-approval.json. No old
   runtime file is replaced. Verify Node syntax of the three new MJS modules.
4. Execute one --prepare (replace MAIN_SHA and ROOT_OWNER_PROOF_SHA by task pins):

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t58-auth-diagnostic.mjs --prepare --manifest /root/bron-secrets/t58-release/manifest.json --sha256 MAIN_SHA --owner-approval-sha256 ROOT_OWNER_PROOF_SHA
```

Expected PREPARED: no private-row reads/POST, no spent attempt3 yet. The helper
validates actual old budget2/3, consumed T56 no-write result and guard, then seals
their hashes in a separate root-only extension scope and creates a fresh2h
capability on VPS. Do not read/print/copy capability. Report preparedSha256,
capabilitySha256, functionName, expiresUtc, expectedExecutableFileHashes (four),
extensionScopeSha256, status/counts and safe receipt SHA. Canonical receipt
/root/bron-secrets/t58-release-receipt.json and local T58-state.json0600 must match;
preserve prior versions when updating, never overwrite guards/results.

## B. Root deploys; executor runs once after actual proofs

Root renders the pinned Source template from public prepared metadata and unchanged
fence context. Deploy four fixed files, JWT=false/private capability; verify ACTIVE,
exact four executable hashes and strict TLS GET403/purposeBRON_AUTH_DIAGNOSTIC_V1.
Root supplies immutable deployment-proof.json bytes/SHA. Root also runs the pinned
technical verify-fenced SQL once and supplies source-read-gate.json bytes/SHA with
the actual Source clock; it must be <=600s old at run/POST. Neither is an Auth read.
Store supplied proofs root0600/O_EXCL/fsync/readback at the fixed T58 paths.

Only after Root provides these actual proof pins, run exactly once:

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t58-auth-diagnostic.mjs --run --manifest /root/bron-secrets/t58-release/manifest.json --sha256 MAIN_SHA --owner-approval-sha256 ROOT_OWNER_PROOF_SHA --prepared-sha256 ACTUAL_PREPARED_SHA --deployment-proof-sha256 ACTUAL_DEPLOYMENT_PROOF_SHA --source-read-gate-sha256 ACTUAL_SOURCE_READ_GATE_SHA
```

No chat ACK loop or native CLI worker. The helper reads the fixed Auth diagnostic
from target in RR READ ONLY/UTC and rolls back. It verifies legacy immutability
again, claims effective attempt3 before its single HTTPS Source POST, decrypts in
VPS RAM and persists/prints only the safe summary. Source does no business-table
reads: <=16compact Auth records and <=35WHOLE-column aggregate fingerprints only.
Raw passwords/tokens/profiles and per-user/per-field vectors are never exported.

## C. Result and stop conditions

Success is DIAGNOSTICS_COMPLETE, not release PASS. Report summary counters and
mismatched column names only; no UUID/digest/timestamp/ciphertext values. Required
evidence: targetWrites0/UNCHANGED, SourceSnapshotAttempts1, effective globalUsed3,
remaining0, oldLedgerUnchanged/oldT56Unchanged, safe result/claim/receipt SHA, client
cleanup. A later metadata failure preserves an already computed safe summary.
Budget uncertainty is reported as uncertain, not falsely asserted as unused.

On BLOCKED preserve all evidence; no same-ID retry/reset/relabel of old claims,
no source/target DML or new Source reads. Keep Source closed and maintenance.
Root closes this temporary endpoint after the phase and verifies410; Source pause
waits for an actual final strict PASS. Do not reopen passed restore/build/Auth/RLS/
monitor/key gates. No owner password, phone-console action or OAuth under T58.

After diagnosis Root prepares the exact permitted Auth correction and two fresh
final snapshots as a new scoped decision. This approval does not authorize them.
Then the mandatory path is strict final PASS, Source closure/pause, actual owner
phone/password/PWA/draft-and-queue acceptance, one public switch/live checks.
