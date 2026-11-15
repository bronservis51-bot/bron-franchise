# T60 — isolated replacement final window through release

This is one self-contained successor, not a T59 retry. Conditional manifest
metadata alone is not approval: **before delivery/prepare/deployment/query**, Root
must provide the actual APPROVED owner-proof, exact bytes/SHA, bound to the issued
T60 commit, manifest and `t60-extra-frame-scope.md`. No repeated general owner
permission is required after that entry gate. Keep Source fenced and public web
in maintenance until the retained final/acceptance/live gates pass.

## A. Accept once, preserve T59, prepare once

1. Idle clean checkout: fast-forward to the exact issued T60 commit; verify MAIN
   manifest SHA and every file/runtime pin, plus Root's separate APPROVED proof.
   No reset/stash/clean. Keep T59 scope, guard, result, claims and failure evidence
   unchanged. Confirm its recorded target UNCHANGED/beforeImage=null and valid
   append-only budget4used/1remaining/certain; no T59 helper/window rerun.
2. Reuse existing strict pinned SSH and T55 transport proof. Verify only pinned
   Node22.23.5/pg8.23.1/lock, expected healthy target ID/image/loopback15433, exact
   current T59 evidence bindings and absence of T60 state/guards/process. Do not
   reopen restore/build/RLS/Telegram/schedule/key/S3 gates.
3. Deliver ONLY T60 manifest-declared files, O_EXCL/O_NOFOLLOW, root:root0600,
   fsync+exact byte/SHA readback; private directories0700. Runtime destination and
   exact inventory come from MAIN. Existing old runtimes/ledgers are verify-only.
   Preserve differing/preexisting T60 state and stop; never overwrite/reset it.
4. Use the canonical Mac directory
   `/private/tmp/bron-release-executor-20261113/T60`0700, not the `/tmp` symlink.
   On VPS run this preparation exactly once, with the issued actual SHA inputs:

```bash
/opt/bron/node-v22.23.5-linux-x64/bin/node /root/bron-secrets/t60-final-window.mjs --prepare-final --manifest /root/bron-secrets/t60-release/manifest.json --sha256 MAIN_SHA --t55-receipt-sha256 ae80d30eea394c17935cf0c53da0baacff9f9dbe75f9d8088597a2cde3e623f4 --owner-approval-sha256 ROOT_OWNER_PROOF_SHA
```

Expected FINAL_READY; target metadata probe READ ONLY/rollback; no working Auth
rows read, no Source snapshot and no target write. Effective budget starts4/6,
remaining2, uncertain=false. Fresh <=2h capability stays VPS-only. Report only
preparedSha256/capabilitySha256/functionName/expiresUtc/executable hashes and safe
receipt SHA. Canonical `/root/bron-secrets/t60-release-receipt.json` and local
`/private/tmp/bron-release-executor-20261113/T60-state.json`0600 must match, retaining
prior receipt versions. Never read/copy capability value.

## B. Root deployment and the same automatic broker

Root deploys the manifest-pinned Source template/runtime, verifies executable
hashes, ACTIVE/JWT=false and normal TLS GET403 with the fixed purpose. Persist only
Root's exact deployment-proof.json bytes/SHA at the manifest T60 path, exclusive,
root0600/fsynced. Do not change Source schema or other project configuration.

Use the T60 relay branch/request prefix from MAIN and the existing authenticated
GitHub/Supabase path. No native CLI/SQLite/manual chat ACK, new credential, OAuth
or monitor/workflow dispatch. The replacement changes only response GET5s→20s;
per-call remaining-deadline cap and all stage/security limits stay enforced:
readiness30s, each of four fence stages60s, nonce/request/source-clock checks,
SSH8s, PUT5s. No new retry loops. Do not silently change bounds if a call fails.

Parent runs the pinned client preflight once (actual SHA placeholders are supplied
by the issued task and actual preparation/deployment result):

```bash
python3 -I docs/runbooks/payloads/t60-relay-driver.py --manifest docs/runbooks/payloads/t60-final-window.json --sha256 MAIN_SHA --ssh-options-json /tmp/bron-release-executor-20261113/T55/ssh-options.json --directory /private/tmp/bron-release-executor-20261113/T60 --prepared-sha256 ACTUAL_PREPARED_SHA --deployment-proof-sha256 ACTUAL_DEPLOYMENT_SHA --t55-receipt-sha256 ae80d30eea394c17935cf0c53da0baacff9f9dbe75f9d8088597a2cde3e623f4 --preflight
```

Expected T60_CLIENT_READY_NO_NONCE. Root arms the automatic broker before saying
T60_BROKER_ARMED. Only then execute the identical command with `--run` instead of
`--preflight`, exactly once. Hold checkout fixed throughout. Current technical
health JSON must be strict TLS503/healthytrue/check<=25m/backup<=70m; read existing
status only. Capability headroom>620s, one final wall<=480s. Keep automatic ready
and all four current fence ACKs moving immediately, never through owner/chat.

## C. Bounded effects, final PASS and terminal failure

Two fresh Source frames consume attempt5 then6 before each POST; no refund for a
failed/uncertain claim. Encrypt directly Source→VPS RAM, fixed read-only queries,
fresh backend witness, RR/UTC/deadlines and full strict comparison. T59 Auth
planner semantics are unchanged: cohort16; at most2 existing users; only
last_sign_in_at+updated_at; Source authoritative including NULL/older values;
all other fields strict; durable root0600 before-image before target DML; locks,
unchanged target checks, exact update counts and precommit checks.

PASS requires both full frames, Source unchanged under the fence, complete target
strict match including ALL Auth fields/timestamps, unchanged roles/database,
four valid current ACKs, certain budget6/6, immutable old T59/prior evidence and
safe durable result/receipt/cleanup. Target result is UNCHANGED or COMMITTED, never
an assumed write outcome. On BLOCKED/UNKNOWN preserve the actual result and stop;
no retry, reset, refund, extra Source call or Source inverse. Precommit failures
roll back when known; COMMIT_UNKNOWN stays UNKNOWN and Source must remain closed.
Do not reopen Source after any target commit/unknown/later user writes.

## D. Continue directly to accepted RF cabinet launch

After actual strict PASS, continue automatically through the already pinned
`docs/runbooks/t59-post-final-cutover.md`; do not create another large cutover plan
or a new task ID. Root closure410+provider Pause verification, web-only private
preview, actual owner phone/password/PWA/old-queue acceptance and one public switch
remain mandatory. RF cabinet/API are the priority; the old landing publisher is
optional as stated there. Existing RF artifacts are reused; the normal legacy
app Pages deployment is needed only for actual old-origin PWA/queue acceptance.

The shared continuation's historical T59 evidence stays historical. For **active
T60** paths/names only, use this exact mapping from the accepted T60 manifest:

| Shared continuation reference | Active T60 binding |
| --- | --- |
| issued T59 commit / `$bron_t59_commit` | issued T60 commit / `$bron_t60_commit` |
| T59 final/prepared/deployment result | `/root/bron-secrets/t60-release/` corresponding file |
| T59 private runtime | `/root/bron-secrets/t60-runtime/` inventory in MAIN |
| T59 canonical receipt | `/root/bron-secrets/t60-release-receipt.json` |
| local T59 directory/state | `/private/tmp/bron-release-executor-20261113/T60` and `T60-state.json` |
| active Source function | actual T60 prepared/deployment functionName, never an old reader |
| active append-only scope | `/root/bron-secrets/source-auth-final-e60a2026/` (claims5+6) |
| total5 / two-timestamp final permission | total6 including4spent; same fields/max2users |

Do not rename existing shared Auth code or historical artifacts merely because
this task is T60. Shared Caddyfiles, five-file Compose chain, T55 SSH argv, staged
RF artifacts, public URLs and Source project are unchanged. T60 MAIN pins shared
continuation/templates and supplies the public target anon pair/actual commit
binding; only public anon key material is used in clients, never service_role.
Root/executor must stop for actual owner acceptance, not repeat old console/MFA/key
checks. Public routing/live checks must pass before RELEASED; on failure reclose
web using the shared maintenance command, retaining Source pause and target data.

## Minimal report

Every update: confirmed release gates; current blocker; next mandatory step;
deferred work; rough remaining time. Final-window report includes actual
status/phase/code/upstreamCode, targetWriteOutcome, safe Auth plan counts/changed
rows, Source frame count/effective budget/uncertainty, immutable prior-evidence
status, cleanup and receipt SHA. No UUID/per-user timestamp/digest/capability.
Report owner acceptance and public live results separately; do not call FINAL_READY
or strict final PASS a public release. Optional hardening, diagnostics, cleanup,
new infrastructure and repeated closed gates stay deferred. No deadline overrides
the actual final/owner/live acceptance gates.
