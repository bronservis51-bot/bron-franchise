# T57 — technical Auth catalog diagnosis after the stopped T56 window

T56 is BLOCKED/target-frame-before/FINAL_HTTPS_NON_TIMESTAMP_OR_DIRECTION_DIFF,
targetWriteOutcome=UNCHANGED, sourceFrameAttempts=1. Shared ledger used=2/max3,
remaining=1, uncertain=false. Root stopped its broker after exactly ready+start
technical MCP checks. Do not restart T56, claim another snapshot, write target or
reopen Source. Keep public app/API in maintenance.

The exact failure proves that the first strict snapshot comparison passed every
group except auth.users and both Auth cohorts have16rows. It does not distinguish
different UUID membership, other-field digest differences, target-newer timestamps
or null timestamp differences. The failed core did not persist the aggregate plan;
the Source and target row frames were RAM-only and cannot be reconstructed from
safe receipts. Do not read process memory or personal history to recover them.

## Bounded actions

1. Fast-forward only a clean, idle checkout to the supplied T57 commit. Verify the
   manifest SHA and both declared file pins. Create private local T57 state.
2. Read ONLY existing safe T56 final-result metadata: SHA/status/phase/code,
   mismatchGroups, recovery.sourceFrameAttempts, recovery.targetWriteOutcome,
   recovery.sourceMustRemainClosed, recovery.beforeImage path-or-null; lstat only
   the timestamp before-image and final guard; record their safe metadata/SHA
   for the guard only. Do not read capability, Auth values, row digests, backup
   or ciphertext. Preserve every T56 artifact and the old canonical receipt.
3. Verify the exact existing supabase-db container ID/image/healthy status from
   the manifest. Read no Docker environment or rendered Compose config. Deliver
   only the pinned SQL to /root/bron-secrets/t57-auth-catalog.sql with root:root
   0600/O_EXCL/O_NOFOLLOW/fsync/readback. Existing identical SQL may be verified;
   differing destination stops. No service/container/network changes.
4. Execute the following once through existing strict SSH. The container's stock
   psql uses its existing local credentials; no password is printed or requested:

```sh
docker --host unix:///var/run/docker.sock exec -i supabase-db psql -X -q -t -A -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < /root/bron-secrets/t57-auth-catalog.sql
```

   SQL is fixed RR READ ONLY; every statement reads session settings or PostgreSQL
   catalog metadata only, followed by ROLLBACK. It never selects from auth.users.
   Expected one JSON object: database postgres, role/session_role supabase_admin,
   read_only on, isolation repeatable read, timezone UTC, nonempty unique column
   descriptors. Defaults are hashed, not returned as expressions. Capture stdout
   privately; do not log stderr verbatim on failure. No retry or repair.
5. Root runs this same pinned SQL exactly once through connected Supabase MCP
   for project vkkqffvmztpzgygzfxhq (role/session_role postgres), retaining the
   catalog object. Catalog metadata is not a Source private-row snapshot and does
   not claim/reset the shared ledger. Executor must not invoke Source SQL or POST.
6. Send the target catalog JSON (technical metadata only) or its immutable Git
   blob+SHA to Root for comparison. Report current safe T56 result and T57 phase,
   exit, SQL SHA, metadata result SHA, no row reads/writes/snapshots, maintenance.
   Canonical /root/bron-secrets/t57-release-receipt.json and local
   /private/tmp/bron-release-executor-20261113/T57-state.json must match as 0600
   files; retain their previous versions if updates are needed.

## Boundaries and acceptance

Success is diagnosis only. Column differences can explain differing whole-row
digests but do not authorize schema/DML normalization or ignoring a strict
mismatch. Identical catalogs do not prove identical private fields. Do not spend
the last approved snapshot on an unsupported replay: a new two-frame final window
would require an explicit extended data grant, since only one attempt remains.
Prepare a concrete plan and explain that boundary before requesting approval.

Reuse all passed restore/Auth/RLS/build/backup/monitor/key gates. No preview,
publication, new infrastructure, owner login or secret entry under T57. Report
the release's confirmed gates, Auth blocker and next actual step without percentages.
