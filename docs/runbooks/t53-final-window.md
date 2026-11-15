# T53 — fresh final window through the proven automatic MCP relay

This is one successor window to the zero-effect T45 failure. T55 is closed PASS;
its canonical receipt is required, not rerun. Source remains fenced and all public
product/API paths remain in maintenance. This task does not authorize preview or
publication. No new owner action or secret entry is required here.

## A. Accept and prepare now

1. Fast-forward the clean executor checkout to the coordinator's exact commit.
   Verify the separately supplied SHA-256 of `payloads/t53-final-window.json`
   and every declared file. Preserve all consumed T45/T50–T55 guards/results.
   Create private local T53 state (directory 0700, files 0600) and report ACCEPTED.
2. Reuse the existing strict SSH argv and pinned ED25519 host fingerprint. Verify
   the actual T55 canonical receipt SHA and its helper result SHA against this
   manifest. Do not repeat T55. No personal history, browser storage, or secrets.
3. Once, verify current maintenance on the three canonical domains with strict
   TLS/HTTP 503, plus `api.bronservis.ru/.well-known/bron-health.json`: healthy=true,
   check age <=25 minutes and backup age <=70 minutes. Preserve status fields only.
   A failed or stale bound stops preparation; do not reinstall backup helpers.
4. Verify existing runtime/dependency/target pins against the manifest and adopted
   T45 manifest; lock file must lack group/world write. Verify no active final
   process, no T53 state artifacts and no timestamp before-image. No service,
   network, database, old receipt, or ledger repair is authorized.
5. Create `/root/bron-secrets/t53-release` as root:root 0700 only if absent. Deliver
   exactly the four manifest `deliveries` with O_EXCL/O_NOFOLLOW, root:root 0600,
   file/directory fsync and byte/SHA readback. Existing identical delivery files
   may be verified; do not overwrite differing files. Verify Node syntax of the
   two modules. Do not copy working data, capabilities or backups onto the Mac.
6. Run exactly once (substitute the published MAIN_MANIFEST_SHA):

```sh
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t53-final-window.mjs --prepare-final --manifest /root/bron-secrets/t53-release/manifest.json --sha256 MAIN_MANIFEST_SHA --t55-receipt-sha256 ae80d30eea394c17935cf0c53da0baacff9f9dbe75f9d8088597a2cde3e623f4
```

Expected `T53_RESULT` status FINAL_READY; one target metadata-only read-only probe,
rollback; fresh two-hour capability generated and retained VPS-only; budget still
1/3 used, two remaining. Do not read or print `final-capability`. Report only
preparedSha256, capabilitySha256, functionName, expiresUtc, exact six executable
file hashes, targetMetadataProbe status, and attempt counts. Preserve the output
as root-only metadata. Create canonical `/root/bron-secrets/t53-release-receipt.json`
and matching local `/tmp/bron-release-executor-20261113/T53-state.json`, both 0600;
record task/manifest, input SHAs, phases/counts/status/paths and resulting SHA.
Receipt updates preserve unique previous versions; never overwrite a guard/result.

## B. Automatic continuation after FINAL_READY

Root renders the already pinned DATA template with the fresh public capability
hash/expiry and unchanged fence context. Root deploys seven pinned source files,
verifies six executable readback hashes, ACTIVE/version/JWT=false, strict TLS GET
403 with purpose BRON_PRIVATE_SNAPSHOT_V1, then supplies exact deployment-proof
bytes and SHA. Executor stores only that public proof at
`/root/bron-secrets/t53-release/deployment-proof.json`, root:root 0600, no overwrite.
This is not a Source data POST and consumes no snapshot attempt.

The five-stage broker/parent transport is issued as a separately pinned appendix
bound to this unchanged MAIN manifest SHA. Do not use the obsolete native CLI
bridge or hand-relay a 60-second ACK. No readiness nonce or final window starts
until the appendix has passed offline checks, executor transport preflight is
ready, and Root explicitly emits T53_BROKER_ARMED.

The appendix then performs one `--prepare-ready`, one automatic MCP technical
query and `--accept-ready`, immediately followed by one `--run-final` using the
actual ready SHA. Ready round trip and age <=30s; each of four bound Source-clock
ACKs <=60s. Check current backup freshness immediately before this sequence.
No clock fabrication, deadline relaxation, chat relay or manual SQL fallback.

The unchanged core claims each of the two remaining shared attempts before POST;
reads snapshots directly encrypted Source→VPS; permits at most one guarded target
auth.users.updated_at reconciliation after all other fields match; persists its
before-image; and performs the second full strict comparison. No generic delta,
missing-row repair, raw credentials/profile data, or Source business write.

## C. Acceptance and hard stops

FINAL_READY is preparation only. Actual final PASS requires strict mismatch list
empty, two snapshot claims total in this window/shared budget 3/3 and not uncertain,
known target transaction outcome, unchanged old T45 guard/result, durable result
and receipt, and connection/process cleanup. Report exact status/phase/safe code,
targetWriteOutcome, budget/attempt counts, mismatch groups only, receipt SHA/path.
Never send Auth identifiers, field values, per-user digests or ciphertext to Mac,
GitHub or chat. Source business data remains on the approved Source→VPS path.

On BLOCKED/unknown outcome: stop, retain all evidence and the Source fence,
maintenance and ledger. No same-ID retry/reset, fresh capability extension, or
automatic inverse. After COMMITTED/UNKNOWN, reopening Source is unsafe without
explicit reconciliation. Closing web alone is not writer rollback.

After actual strict PASS Root closes the reader (tombstone/readback/410) and pauses
Source with verified provider status. Then proceed directly to a separate bounded
web-only private preview/legacy-origin transition, actual owner password/phone/PWA/
existing draft-and-queue acceptance, public switch and live checks. Do not wake
the owner for tooling. Already passed restore/Auth/RLS/build/backup/Telegram/
schedule/key-custody gates are reused. Legal docs, SLA, visibility, enhancements,
extra infrastructure/monitor dispatch, process cleanup and hardening stay deferred.

Every progress report states confirmed gates, current blocker, remaining work and
next action, without percentages. Keep Source closed and maintenance until the
actual release gates pass.
