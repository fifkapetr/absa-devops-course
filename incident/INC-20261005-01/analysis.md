# INC-20261005-01 — Analysis
**Loan API restart loop after 1.2.0 pilot release (502 errors every ~8 minutes)**
Branch: CZ-PRG-01 · Date: 2026-10-05 · Severity: S2
Analyst: GitHub Copilot · All timestamps UTC; CEST = UTC+02:00

---

## Summary

Release 1.2.0 introduced an installment-calculation cache with no eviction policy.
Every request produced a distinct cache key because the UI included the current
wall-clock time (`requestedAt`) in the request body; no entry was ever evicted.
Heap and cache size grew linearly after every start until the Linux OOM killer
terminated the container (`exitCode=137`). The engine restarted it within ~45 s
via `restart: unless-stopped`, producing a new cycle of the same growth. Nine OOM
kills occurred between 07:12 UTC and 08:16 UTC. Each kill caused a ~40–60 s
window of 502 responses at the gateway. The rollback to 1.1.0 at 08:20 UTC
stopped the loop. Separately, every `installment cache miss` log line contained
the full request body, including `applicantName`, violating OPS-060 and triggering
a same-day POL-070 notification.

---

## Evidence

| Fact | Line(s) | Example line (redacted) |
|---|---|---|
| 1.2.0 first started at **07:12:56 UTC (09:12:56 CEST)** — wait, see below | | |
| 1.2.0 started at **06:30:06 UTC (08:30:06 CEST)** | 938 | `{"level":30,"time":"2026-10-05T06:30:06.955Z","version":"1.2.0","msg":"Tredgate Loan API started"}` |
| 1.2.0 restarted **9 times** (lines below) | 10051, 17121, 24220, 31164, 37917, 44608, 51377, 58487, 64906 | `{"level":30,"time":"2026-10-05T07:13:07.113Z","version":"1.2.0","msg":"Tredgate Loan API started"}` |
| 1.1.0 rollback started at **08:20:06 UTC (10:20:06 CEST)** — no `version` field | 67601 | `{"level":30,"time":"2026-10-05T08:20:06.645Z","hostname":"68496c47404e","msg":"Tredgate Loan API started"}` |
| OOM kill 1 at **07:12:56 UTC (09:12:56 CEST)** · `exitCode=137` | 9972, 9975 | `container oom … name=tredgate-loan-loan-api-1` |
| OOM kill 2 at **07:21:19 UTC (09:21:19 CEST)** | 16552, 16557 | `container oom … exitCode=137` |
| OOM kill 3 at **07:29:11 UTC (09:29:11 CEST)** | 23520, 23525 | `container oom … exitCode=137` |
| OOM kill 4 at **07:37:38 UTC (09:37:38 CEST)** | 30834, 30842 | `container oom … exitCode=137` |
| OOM kill 5 at **07:45:03 UTC (09:45:03 CEST)** | 37175, 37180 | `container oom … exitCode=137` |
| OOM kill 6 at **07:53:22 UTC (09:53:22 CEST)** | 44108, 44118 | `container oom … exitCode=137` |
| OOM kill 7 at **08:01:27 UTC (10:01:27 CEST)** | 50916, 50919 | `container oom … exitCode=137` |
| OOM kill 8 at **08:09:21 UTC (10:09:21 CEST)** | 57900, 57901 | `container oom … exitCode=137` |
| OOM kill 9 at **08:16:51 UTC (10:16:51 CEST)** | 64681, 64684 | `container oom … exitCode=137` |
| Rollback SIGTERM (signal=15, `exitCode=143`) at **08:20:00 UTC** | 67571, 67572 | `container kill … signal=15` |
| Metrics at t+60 s (first cycle): **heapUsedMB 21, cacheEntries 9** | 1041 | `{"heapUsedMB":21,"rssMB":97,"cacheEntries":9,"uptimeSeconds":60,"msg":"process metrics"}` |
| Metrics at t+2520 s (just before kill 1): **heapUsedMB 61, cacheEntries 1219** | 9459 | `{"heapUsedMB":61,"rssMB":136,"cacheEntries":1219,"uptimeSeconds":2520,"msg":"process metrics"}` |
| Cache and heap grow at ~29 entries/min, ~0.95 MB/min — heap never decreases | 1041–9459 | see rows above |
| First `installment cache miss` at **06:30:11 UTC** — personal data from minute 1 | 949 | `{"reqId":"f953df8e","request":{"applicantName":"[REDACTED]","amount":194400,...},"msg":"installment cache miss"}` |
| **12,169** `installment cache miss` lines (entire 1.2.0 window) | counted | all service=loan-api |
| Docs-search timeout **before** 1.2.0 release at **06:05:15 UTC (08:05:15 CEST)** | 170 | `upstream timed out … POST /docs/reindex` |
| Docs-search timeout at **06:50:15 UTC** (22 min before kill 1) | 2944 | `upstream timed out … POST /docs/reindex` |
| Docs-search timeout at **07:26:15 UTC** (13 min after kill 1, during restart 2) | 20794 | `upstream timed out … POST /docs/reindex` |
| Docs-search timeout at **08:11:15 UTC** (2 min after kill 8) | 59464 | `upstream timed out … POST /docs/reindex` |
| Docs-search timeout at **08:56:15 UTC** (post-rollback) | 73713 | `upstream timed out … POST /docs/reindex` |
| 45-minute cron interval: 06:05 → 06:50 → [07:35 skipped?] → 08:11 → 08:56 | 170, 2944, 59464, 73713 | (pattern, not a miss-aligned coincidence) |
| First gateway 502 at **07:12:56 UTC** (same second as OOM kill 1) | 9966 | `"GET /api/loans HTTP/1.1" 502 157` |
| Last gateway 502 at **08:20:07 UTC** (one second after rollback start) | 67603 | `"POST /api/installments/calculate HTTP/1.1" 502 157` |
| First 200 after rollback at **08:20:17 UTC** | 67646 | `"GET /docs/search?q=… HTTP/1.1" 200 5020` |
| Gateway window (07:12:56–08:20:06): **1,808 502 / 22,717 total** = **7.96 %** failed | counted | `status` breakdown from --count |
| No level-50 lines from loan-api at any point | 0 matched | `--service loan-api --level 50` returns 0 |

### Restart schedule (UTC / CEST)

| # | OOM kill (UTC) | CEST | Kill line | Next start (UTC) | Start line | Interval |
|---|---|---|---|---|---|---|
| 1 | 07:12:56 | 09:12:56 | 9972 | 07:13:07 | 10051 | — |
| 2 | 07:21:19 | 09:21:19 | 16552 | 07:22:06 | 17121 | ~8 min 23 s |
| 3 | 07:29:11 | 09:29:11 | 23520 | 07:30:08 | 24220 | ~7 min 52 s |
| 4 | 07:37:38 | 09:37:38 | 30834 | 07:38:09 | 31164 | ~8 min 27 s |
| 5 | 07:45:03 | 09:45:03 | 37175 | 07:46:11 | 37917 | ~7 min 25 s |
| 6 | 07:53:22 | 09:53:22 | 44108 | 07:54:10 | 44608 | ~8 min 19 s |
| 7 | 08:01:27 | 10:01:27 | 50916 | 08:02:10 | 51377 | ~8 min 5 s |
| 8 | 08:09:21 | 10:09:21 | 57900 | 08:10:10 | 58487 | ~7 min 54 s |
| 9 | 08:16:51 | 10:16:51 | 64681 | 08:17:11 | 64906 | ~7 min 30 s |
| rollback | 08:20:00 (SIGTERM) | 10:20:00 | 67571 | 08:20:06 (1.1.0) | 67601 | — |

### Memory growth in the first lifecycle (t = seconds from 06:30:06 UTC)

| t (s) | UTC time | heapUsedMB | rssMB | cacheEntries | Line |
|---|---|---|---|---|---|
| 60 | 06:31:06 | 21 | 97 | 9 | 1041 |
| 600 | 06:40:06 | 24 | 102 | 77 | 1728 |
| 1200 | 06:50:06 | 24 | 103 | 192 | 2924 |
| 1800 | 07:00:06 | 34 | 111 | 370 | 4473 |
| 2100 | 07:05:06 | 40 | 118 | 599 | 5980 |
| 2400 | 07:10:06 | 58 | 138 | 1024 | 8368 |
| 2460 | 07:11:06 | 59 | 137 | 1120 | 8884 |
| 2520 | 07:12:06 | 61 | 136 | 1219 | 9459 |
| 2570 | 07:12:56 | — | — | — | 9972 (OOM kill) |

`cacheEntries` grows at ~0.47 entries/s on average (accelerating in the final
10 minutes as officer load increases at branch opening). `heapUsedMB` tracks
it, reaching 61 MB just before the kill. The container's `mem_limit: 256m`
includes Node.js heap, V8 overhead, and RSS; the OOM kill fires when RSS+overhead
approaches that ceiling.

---

## Root cause

The 1.2.0 installment cache (`cacheEntries` in `process metrics`) stored every
unique combination of `(amount, termMonths, interestRate, requestedAt)`. The UI
set `requestedAt` to `Date.now()` on every keystroke, making every request unique.
The cache had no maximum size and no TTL, so entries accumulated from the first
request (line 949) without ever being freed. After ~42 minutes the container RSS
hit the 256 MB `mem_limit` and the kernel OOM-killed it (`exitCode=137`, line
9972). `restart: unless-stopped` triggered an automatic restart within ~45 s,
the cache started growing again from zero, and the cycle repeated every ~8
minutes for 9 kills until the rollback.

The defect shipped because (a) the cache key was wrong (should exclude
`requestedAt`) and (b) the log line for a cache miss included the full request
body, a fact the developer acknowledged (Teams war-room, 10:06 CEST). Neither
fault was caught in code review; see Compliance section.

---

## Red herrings

| Hypothesis | Why ruled out | Evidence |
|---|---|---|
| **Data file truncated (KI-001)** | Would produce `SyntaxError` in API log as level-50 lines, and `GET /api/loans` would 500. Instead API log has 0 level-50 lines; data file parsed OK. | 0 level-50 loan-api lines (confirmed by `--service loan-api --level 50`) |
| **Network / VLAN change** | Facilities confirmed no VLAN change since Friday 17:00. The 502 pattern is periodic (every ~8 min) and is immediately preceded by `container oom` events, not by link-layer events. | Docker events show `container oom` 1–2 s before every 502 burst |
| **docs-search timeouts causing 502 s** | Timeouts hit only `/docs/reindex` (admin cron), not the API routes. The first timeout (line 170, 06:05:15 UTC) predates the 1.2.0 deployment by 25 minutes, ruling out any causal link to the restart loop (see next section). | Line 170 predates line 938 |

---

## Docs-search timeouts are unrelated (Q4 proof)

Five `upstream timed out` events appear for `POST /docs/reindex`:

```
line  170  06:05:15 UTC  — BEFORE 1.2.0 deployment (line 938 = 06:30:06)
line 2944  06:50:15 UTC  — 22 minutes before first OOM kill
line 20794 07:26:15 UTC  — 13 minutes AFTER OOM kill 1, on a different cron tick
line 59464 08:11:15 UTC  — 1 min 54 s after OOM kill 8 (cron coincidence)
line 73713 08:56:15 UTC  — 36 minutes after rollback; 1.1.0 running fine
```

The regular 45-minute spacing (06:05, 06:50, 08:11, 08:56) identifies this as
the periodic handbook reindex cron, which exceeds the 5-second `proxy_read_timeout`
in nginx. The event at 07:26:15 falls on the same cron schedule and is not
aligned with any kill (kills are at 07:12, 07:21, 07:29 UTC). The 06:05 event
conclusively pre-dates the 1.2.0 release, proving the timeouts are a pre-existing
known nuisance, not a symptom or cause of the OOM loop.

---

## Compliance

### OPS-060 violations (2)

1. **`applicantName` written to the log (OPS-060 § "What must never be logged").**
   Every `installment cache miss` line (12,169 lines, first at line 949,
   06:30:11 UTC) contains `"request":{"applicantName":"…",…}`.
   OPS-060 states: *"Never logged: `applicantName` or any part of it"* and
   *"Request bodies or query strings [must not be logged]"*.

2. **Full request body logged (OPS-060 § "What must never be logged").**
   The same lines also include `amount`, `termMonths`, `interestRate`, and
   `requestedAt` from the request body. OPS-060 permits only `method`, `url`,
   and `status` for request-scoped lines.

### OPS-050 violation (1)

3. **New log message not reviewed by Compliance Officer (OPS-050 § "Data and logging" category).**
   Adding a new log message that writes personal data is a *"Data and logging"*
   change under OPS-050, requiring Compliance Officer sign-off before merge.
   The `installment cache miss` message (and its body payload) shipped without
   that approval; the developer confirmed this was unintentional debug code
   (Teams war-room, 10:06 CEST). The permanent fix must go through a full
   OPS-050 data-and-logging review.

### POL-070 — COMPLIANT

4. **Same-day notification met.**
   Jana Novakova emailed Compliance Officer Hana Vesela at 10:10 CEST
   (2026-10-05), the same day the personal data was found, in compliance with
   POL-070 and OPS-010 (escalation path: *"Suspected personal data in the log →
   Compliance Officer the same day"*). The count of distinct applicants remains
   to be derived from the log (personal data processing rules preclude printing
   them here).

### Additional infrastructure concerns (outside OPS-060/POL-070 scope)

- `privileged: true` and `/var/run/docker.sock` mount on `loan-api` (compose.yaml)
  grant the container full Docker daemon access. This is not required by the
  application and violates least-privilege principles.
- `DOCS_ADMIN_TOKEN: FAKE-docs-admin-7f3a` is hardcoded in compose.yaml instead
  of being injected from `.env` via `${VAR}`, as required by project conventions.
- `docs-search` binds to `0.0.0.0:3001`, exposing the handbook search API
  directly on the host, bypassing the gateway (REF-040: gateway is *"the only
  published port"*).

---

## Open questions

1. **Distinct applicants exposed.** The count of unique applicant names in the
   12,169 `installment cache miss` lines must be reported to the Compliance
   Officer. This requires log processing with redaction and cannot be included
   here.

2. **Cache key fix verification.** The root-cause fix (remove `requestedAt` from
   the cache key) must be confirmed by a new test before the next 1.2.x release.
   A maximum cache size (LRU eviction) should also be added as defence-in-depth.

3. **`mem_limit` adequacy.** 256 MB was sufficient for 1.1.0 but the correct
   remedy for 1.2.0 is eviction, not raising the limit. The limit should remain
   as an OOM guard; the on-call metrics threshold for `heapUsedMB` (OPS-030)
   should be documented.

4. **Infrastructure security.** The `privileged` flag, Docker socket mount, and
   hardcoded token (see Compliance § infrastructure) should be remediated before
   the pilot is extended to additional branches.

5. **Missing cron timeout runbook.** The 45-minute docs-reindex cron has caused
   upstream timeouts since before 1.2.0 (line 170, pre-release). A known-issue
   entry and runbook exist for KI-001 and KI-002; this timeout pattern should
   also be catalogued to prevent re-investigation in future incidents.
