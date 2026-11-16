# T60 — minimal review delta from consumed T59

T59 remains immutable and is never rerun. It completed one private Source frame,
passed the initial strict non-Auth comparison and two-timestamp plan, then stopped
before target writes: ACK_TIMEOUT, target UNCHANGED, beforeImage=null.

## Transport fix

After namespace isolation, the sole functional transport change is:

```diff
-response = gh_read(relay_path(stage, 'response'), min(5, left()))
+response = gh_read(relay_path(stage, 'response'), min(20, left()))
```

No retry loop added. The same absolute fence expiry60s, internal57s bound,
ready30s/internal26s, nonce, Source-clock, canonical-byte and exclusive-file checks
remain. PUT5s and SSH8s unchanged. No Source SQL, reads or writes occur in this fix.

## Accounting and isolation

Four spent attempts remain spent. T60 links their unchanged claims and the exact
zero-write T59 failure, sealing their SHA at preparation. Fresh frames are5 and6.
The ONLY new owner permission is one additional frame, total cap5→6. New T60
state/guards/capability avoid resetting any T59 evidence. The full-frame core only
changes exact prior3/max5 permission to prior4/max6; data, two-column/two-user write
scope, whole-row strict comparison and source-before/after equality stay identical.

No product code, database schema, passwords, roles, backup/restore, build, RLS,
Telegram, monitoring infrastructure or prior acceptance gate changes.

## Terminal behavior

No actual owner-proof means no preparation, deployment, Source call or target write.
A failure before DML is UNCHANGED; an uncommitted write transaction rolls back when
known. COMMIT_UNKNOWN remains UNKNOWN, and any committed/unknown/new user write
forbids automatic Source reopening. Any BLOCKED stops this one window; no retry,
refund, extra Source POST or relaxed freshness check. Strict PASS still precedes
reader closure/Source pause, actual owner acceptance and public/live verification.
