# T59 continuation — final PASS to public release

This is the ordered continuation of the same T59 package, not a new task or a new
snapshot allowance. The issued T59 manifest must pin this file and every referenced
web template before execution. Root supplies actual deployment/Source evidence;
executor advances automatically when each prerequisite passes. Stop for a failed
gate, an actual owner acceptance decision, or a mutation outside the issued scope.
Do not request another general permission to proceed.

## Entry, retained evidence and custody

Enter only after the actual T59 final result is strict PASS, both complete frames
match, the two-timestamp update affected at most two existing users, write outcome
is known (UNCHANGED or COMMITTED), and the append-only ledger is certain and within
its fresh owner-approved maximum of five total attempts. The new owner grant is a
separate entry gate; this document does not grant it. No extra Source snapshot,
reader run, ignored Auth column or broadened target update is permitted here.

Reuse T12 Auth/RLS, T14 artifacts/rollback packages, T18 backup/status, T19 Telegram,
T21 cold restore, T22 scheduled monitoring, T37/T40 source evidence, T39 static
staging and T44 independent key/device proof. Do not repeat restore, RF builds,
role tests, Telegram delivery, schedule observation or key/S3 checks. Only check
inputs that changed, the exact publishing head's CI, and current health freshness.
The existing health JSON must have healthy=true, checked_at age <=25 minutes and
last_backup_utc age <=70 minutes (strict TLS; HTTP503 is expected in maintenance
and preview). Read existing status; do not launch a new backup/monitor dispatch.

Mac handles public code/configuration and technical control only. No private row,
per-user digest/timestamp, snapshot, ciphertext, backup, AGE identity or passphrase
may transit through Mac, GitHub or chat. Use existing strict SSH argv and host-key
pin. Public anon client keys are allowed in public clients; report their SHA only.
Retain private before-images and receipts on VPS with root:root 0600, directories
0700, and exclusive/fsynced writes. Preserve all consumed guards and old results.

## 1. Root closes the reader and pauses Source

Root, through the already connected Supabase MCP, replaces the **actual T59
functionName** from the prepared/deployment proof with the pinned
`docs/runbooks/payloads/worker-reader-tombstone.ts`. Do not redeploy an old expired
function name. Read back the deployed executable, verify its pinned SHA and that a
normal TLS GET returns 410. Then pause project `vkkqffvmztpzgygzfxhq` and verify its
provider status becomes INACTIVE/paused. An accepted pause request alone is not a
PASS. No further Source SQL, API user reads or snapshots follow the pause.

Root sends safe evidence (function/name+source SHA, 410, project/status/timestamp).
Executor records it in the same T59 receipt and continues. Source remains fenced
and paused throughout acceptance/publication. Do not apply Source inverse SQL or
resume it automatically after COMMITTED, UNKNOWN, or any target user write.

## 2. Stage only the existing web templates and verify one effective model

Use the manifest-pinned existing `deploy/timeweb/Caddyfile`,
`Caddyfile.preview`, `compose.preview.override.yml` and
`compose.production.override.yml`; destination is
`/opt/bron/supabase/docker/bron/` with the same filenames. Before replacing an
existing template, preserve its exact root-only before-image. Identical files are
verify-only. Do not modify the five existing base/maintenance Compose files.
T39 already placed the RF app/landing content at `bron/site/app` and
`bron/site/landing`; their manifests must still match the pinned T14/T39 evidence.
Do not rebuild/re-extract or copy these packages through Mac.

One owner handoff covers the actual phone public IP(s), password UI login and the
acceptance checklist below. Obtain the real phone's active IPv4/IPv6 address for
the network it will use; never assume the Mac IP. Create the existing preview
configuration path `/root/bron-secrets/preview.env` root:root0600 with actual IPs.
The format is literal JSON string arguments, e.g. the **syntax only** is:

```dotenv
BRON_PREVIEW_ALLOWED_IPS='"ACTUAL_PHONE_IP","ACTUAL_EXECUTOR_IP"'
```

Replace both examples with verified addresses; omit an unnecessary executor IP.
`Caddyfile.preview` requires nonempty addresses, not CIDRs. Never apply the example.

Run on VPS in one Bash session:

```bash
cd /opt/bron/supabase/docker
bron_compose=(docker compose -p supabase --profile publish-only
  -f docker-compose.yml
  -f bron/compose.override.yml
  -f bron/compose.rehearsal-retry.override.yml
  -f bron/compose.restore.override.yml
  -f bron/compose.maintenance.override.yml)
```

Capture baseline and preview `"${bron_compose[@]}" config --format json` /
`"${bron_compose[@]}" -f bron/compose.preview.override.yml config --format json`
in VPS process memory; compare every non-web service exactly. Do not print/store
full rendered config/environment in executor logs. Confirm cached image/Caddy
pins, the six pinned non-web container IDs unchanged, default network internal,
no backend public host bindings, and expected target loopback listener15433.
T46 supplies that loopback proxy; Docker's null published-port field is not a
listener failure. No backend restart or Compose up without a web service name.

```bash
"${bron_compose[@]}" -f bron/compose.preview.override.yml run --rm --no-deps --pull never web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
"${bron_compose[@]}" -f bron/compose.preview.override.yml up -d --no-deps --pull never web
```

From an allowed phone/executor IP, strict TLS must serve the RF app/landing and
client API; from a nonallowed IP all three product entry points remain503. Status
remains503 with fresh healthy JSON. Recheck only the six non-web IDs/isolation
invariants affected by Compose, not the already passed DB/Auth/RLS suites.

## 3. RF cabinet first; preserve the old PWA only where required for acceptance

Bind `bron_t59_commit` to the accepted checkout with `git rev-parse HEAD`; it must
equal the exact commit in the issued task and the pinned file hashes must match.
Read only the existing target public `ANON_KEY` entry from the VPS Compose `.env`
into private executor process memory; do not print/read other entries or use
service_role. Compare its SHA and API host with the staged RF client before any
client-variable change. No new key is created or rotated.

Use executor's existing authenticated `gh`; Root connector HTTP403 is not evidence
that executor/owner lacks rights. No fresh OAuth/login/PAT unless an actual denial
requires owner action. Read back current public variables/settings once; retain
old values privately for the already approved pre-write rollback plan. Verify the
RF URL/public key pair against the staged RF client and target's public anon
configuration; key must be the target client/anon key, never service_role or a
secret API key. Compare SHA in reports, not key value. Do not recreate secrets.

The RF app already uses its verified staged pair; do not republish it. The following
legacy-app transition is required when the owner uses the old PWA/origin or has
old-origin drafts/queued work to accept. If the owner confirms there is no such
work and accepts the new RF cabinet, defer this publisher transition; preserve
all old browser storage and explicitly report the legacy URL as not transitioned.
It is not a reason to delay a working accepted RF cabinet. When needed, set both
existing app repository variables **before** its one normal publish:

```bash
gh variable set VITE_SUPABASE_URL --repo bronservis51-bot/bron-franchise --body https://api.bronservis.ru
gh variable set VITE_SUPABASE_PUBLISHABLE_KEY --repo bronservis51-bot/bron-franchise --body "$bron_public_anon_key"
```

`bron_public_anon_key` is the already verified public pair in private executor
memory, with shell tracing disabled. Readback must match URL+keySHA. Leave
BRON_MONITORING_ENABLED=true and the existing backup-status URL at
`https://api.bronservis.ru/.well-known/bron-health.json`; change only a proven stale
public variable. APP_URL changes to the RF cabinet after public opening below.

PR12 must have the exact issued T59 commit as head, the intended main base and
only the reviewed release diff. Check that exact head's CI and actual github-pages
environment protection; never bypass it or merge a stale pinned head. If PR12 is
already merged, verify its actual merge/head and skip another merge. Otherwise:

```bash
# Execute ready only when the verified PR metadata says isDraft=true.
gh pr ready 12 --repo bronservis51-bot/bron-franchise
gh pr merge 12 --repo bronservis51-bot/bron-franchise --squash --match-head-commit "$bron_t59_commit"
```

Do not delete the source branch. Confirm resulting main/merge SHA and one normal
Pages workflow deploy for that revision. `.github/workflows/pages.yml` supplies
base `/bron-franchise/` and builds with these public variables. This required
legacy publisher run is not a repeat RF artifact build. Wait its actual successful
deployment; do not dispatch a duplicate, run `npm run deploy`, or force-push a
fallback gh-pages branch. If environment protection actually requests owner
approval, hand over its exact pending approval once, with the phone acceptance.

The old landing transition below is independent and is **not a cabinet-release
gate**. Its form does not implement the cabinet offline queue. Prepare it in
parallel only if it fits the remaining time; otherwise defer it and report the
old landing as not transitioned, without claiming its Source-backed form works.
Do not add a new owner step or gate for this legacy landing.

The old landing is a separate repository, not part of app Pages. Verified current
publisher: `bronservis51-bot/bronservice-franchise`, legacy Pages from `main:/`.
Known unchanged `index.html` blob is
`f75e5d39a54ab4db524965ff114a10c9e7d45b88` (37,745 bytes). It has exactly one pair
`var API='SOURCE_URL/rest/v1/rpc/lead_submit', KEY='PUBLIC_KEY', WA=...`.
Read the current main blob and publisher once; if different, inspect the relevant
diff before any write rather than overwrite another change. Perform one guarded
Contents API commit with the current blob SHA: replace **only** API with
`https://api.bronservis.ru/rest/v1/rpc/lead_submit` and KEY with the same verified
target public anon key. Preserve every other byte, asset URL/base and WA value.
Use `gh api --method PUT repos/bronservis51-bot/bronservice-franchise/contents/index.html --input -`
with structured JSON `{message,branch:"main",sha:CURRENT_BLOB_SHA,content:BASE64_NEW_BYTES}`;
feed it on stdin, never interpolate HTML/key into shell code or print request body.
Wait the existing landing Pages publisher for that exact commit; no new workflow,
repo, infrastructure or RF landing rebuild. Report commit/blob/APIhost/keySHA only.

For each transition actually performed, verify its published old URL uses the RF
pair with its original base; do not wait for a deferred landing publisher:
`https://bronservis51-bot.github.io/bron-franchise/` and
`https://bronservis51-bot.github.io/bronservice-franchise/`.
Both share the github.io origin. The RF cabinet is a different origin and cannot
automatically read the old session/IndexedDB `bron-local` drafts or queue.

## 4. One actual owner acceptance, before the public switch

The owner uses their real phone and intended account; enters the password only in
the real HTTPS application UI. No password, user row or screenshot containing
secrets goes to chat. Record explicit observed outcomes, not an assumed PASS:

- RF cabinet password login works; intended role/scope and existing data appear.
- Real Safari/installed PWA opens at its correct URL/base/scope, navigation and an
  essential intended operation work. Preserve the existing old PWA session and
  queued-operation UUIDs. No Clear-Site-Data, localStorage.clear, IndexedDB deletion,
  forced service-worker activation or forced reload while a queue is pending.
- Existing old-origin drafts/queue remain present. If a real operation is pending,
  use the transitioned **old origin** with the same account to resume it once and
  observe acknowledgment without duplication; the new origin cannot import it
  automatically. Do not fabricate a lead/payment/financial record as a test.
- The landing form and its real intended lead submission work if the owner has an
  actual intended request. Contract stays POST `/rest/v1/rpc/lead_submit`, body
  `{p_lead:{...}}`, response `{ok:true}`. Never expose/read the anonymous lead table.

An actual acceptance failure keeps preview/maintenance. Owner acceptance is the
remaining human decision, not a request to repeat key/MFA/phone-console proof. If
the owner cannot attend, report WAITING_OWNER_ACCEPTANCE; do not pretend it passed.
After the first target login/write, do not compare against/reopen Source as a writer.

## 5. One public web switch and live acceptance

With actual owner PASS, fresh health JSON and Source pause verified, compare the
production effective non-web model with the unchanged baseline in VPS memory.
Then validate and change **only web** using the same Bash array:

```bash
"${bron_compose[@]}" -f bron/compose.production.override.yml run --rm --no-deps --pull never web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
"${bron_compose[@]}" -f bron/compose.production.override.yml up -d --no-deps --pull never web
```

Verify strict TLS RF app and landing200; expected staged version/base/manifest/SW;
API Auth settings200 and unconfigured/admin routes404; backup health200 with
healthy=true and the same age limits; each required legacy-app transition uses
RF clients (deferred legacy landing is reported separately); six backend
IDs, internal default network and loopback-only DB remain unchanged. Confirm the
owner's intended operation acknowledgment/lead receipt once; no duplicate writes.
These focused checks cover changed routes, not a repeat complete RLS/Auth suite.

After RF routes pass, update the existing monitor's app URL and read back it and
its already enabled/public routing configuration, without dispatching a test:

```bash
gh variable set APP_URL --repo bronservis51-bot/bron-franchise --body https://app.bronservis.ru/
```

Do not send Telegram again or wait for another schedule as a new gate. A normal
scheduled result, when available, may be recorded. Until live verification passes
status is PUBLIC_SWITCH_PENDING_VERIFY, not RELEASED. On any critical live failure
immediately reclose web using the existing maintenance chain:

```bash
"${bron_compose[@]}" up -d --no-deps --pull never web
```

Confirm strict TLS503 again. This is containment, not a writer rollback. Preserve
Source pause, all target data and receipts. After any target commit/unknown/user
write, no Source inverse, DNS-only reversal or blind source-client rollback; an
explicit data reconciliation decision is required. Existing T14 rollback bundles
remain retained and unmodified.

## Receipt, progress and remaining work

Use the existing T59 canonical receipt/mirror with preserved prior versions;
record stage/timestamp, actual input/config/code SHAs, Source closure+pause proof,
preview/legacy deployments, owner acceptance facts, public/live results, changed
paths and safe failure codes. No per-user values. Every update states: confirmed
release gates; current blocker; next mandatory step; deferred work; rough remaining
time. Report RELEASED only after actual final PASS, Source paused, owner acceptance
and public live checks. No new task ID or repeated general approval between stages.

Deadline target is the functioning cabinet at `app.bronservis.ru` and its API.
At 16:57 MSK on 2026-11-15, 33 minutes remained before 17:30 MSK; no clock estimate
is evidence of a passed gate. After strict final PASS, aim for Source closure/pause
2–5min, web preview 2–5min, essential owner phone/login/queue acceptance 5–10min,
then switch/live checks 3–5min. A necessary legacy-app Pages deploy can overlap
preview and may add 5–15min or a real protected-environment wait. Defer the old
landing publisher and nonessential form checks if they threaten cabinet timing. Work
independent metadata/publisher preparation in parallel, but preserve the sequence
at mutation/acceptance boundaries. Owner availability or a real failed gate extends
calendar time; do not promise a launch before their actual PASS.

Deferred: extra diagnostics, closure paperwork beyond this safe receipt, extra
backup/restore/build/RLS/Telegram/schedule repetitions, GitHub visibility, optional
hardening/cleanup, new infrastructure, SLA procurement, legal questionnaire/docs
already deferred by owner, МойСклад and product enhancements. Do not reintroduce
these on the release critical path.
