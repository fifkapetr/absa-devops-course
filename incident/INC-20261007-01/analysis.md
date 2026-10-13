# INC-20261007-01 — Analysis

**Branch:** CZ-PRG-01  
**Severity:** S2 (data integrity in doubt)  
**Log timezone:** Container logs are UTC; all CEST times are UTC+02:00.  
**Analyst note:** `combined.log` was never read directly; all log evidence was extracted with
`npx tsx ops/tools/logs.ts … --redact`. Every claim cites a line number in that file.

---

## Summary

At **13:00 CEST** (11:00:02 UTC) release 1.2.0 was deployed using a hardened container
configuration (`USER node`, pinned images, memory limit 512 m, healthchecks). The hardening
introduced a non-root process user, but the bind-mount folder `./data:/data` on the host was still
owned by `root`. When `loan-api` started it could not write `DATA_FILE` and immediately emitted a
single level-40 `"persistence disabled"` line (REF-030), then continued running with an in-memory
store seeded from `loans.seed.json`.

Between 13:10 and 15:35 CEST three new loan applications were created and stored only in memory.
Two approval attempts at 13:25 and 14:50 CEST failed with HTTP 500 because the audit trail
(`AUDIT_FILE=/data/audit.log`) is written on every decision and the container user had no write
access to `/data`. Both failures were visible in the log as `AuditWriteError: EACCES` but were
not escalated at the time.

At **15:42 CEST** (13:42 UTC) the Release Engineer recreated the `loan-api` container to raise
the memory limit. The new container started with the same root-owned bind mount, again emitted
`persistence disabled`, and the in-memory state from the previous container (the three new
applications) was lost. The Total Applications tile dropped from 9 to 6 (only the six seed records
remained). The incident was declared at 15:53 CEST.

The fix — correcting `/data` ownership on the host and switching to a named volume — was applied
at **16:40 CEST** (14:40 UTC). The API booted without `persistence disabled`. The three
applications were re-entered from officers' paper notes (16:43–16:47 CEST) and the two approvals
were recorded successfully (16:50, 16:52 CEST). The incident was resolved at **17:00 CEST**.

Total duration of data-at-risk window: **13:00–16:40 CEST (3 h 40 min)**.  
Data-missing window (tile showed 6): **15:42–16:53 CEST (1 h 11 min)**.

---

## Evidence

All lines are from `incident/INC-20261007-01/logs/combined.log`.  
Lines printed with `--redact`; `[REDACTED]` replaces values the tool masks.

| Fact                                                                                                 | Line(s)                           | Example line (redacted)                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Previous container stopped (SIGTERM, exitCode=143) for the 13:00 deployment                          | 1052                              | `docker \| 2026-10-07T11:00:00.180Z container die … exitCode=143`                                                                                                                                                                       |
| New container started at 13:00 CEST                                                                  | 1058                              | `docker \| 2026-10-07T11:00:02.100Z container start af4097840e81…`                                                                                                                                                                      |
| **`persistence disabled`** at first boot (13:00:06 CEST / 11:00:06 UTC) — API running in memory only | 1061                              | `loan-api \| {"level":40,"time":"2026-10-07T11:00:06.822Z","pid":41,"hostname":"af4097840e81","reason":"EACCES /data/loans.json","msg":"persistence disabled"}`                                                                         |
| `Tredgate Loan API started` v1.2.0 — no error, process up                                            | 1062                              | `loan-api \| {"level":30,"time":"2026-10-07T11:00:06.882Z","pid":41,"hostname":"af4097840e81","version":"1.2.0","port":3000,"dataFile":"/data/loans.json","msg":"Tredgate Loan API started"}`                                           |
| Application **mv9c2k1lzq8r4ta** created in memory (13:10:24 CEST / 11:10:24 UTC)                     | 1417                              | `loan-api \| {"level":30,"time":"2026-10-07T11:10:24.301Z","pid":41,"loanId":"mv9c2k1lzq8r4ta","amount":18000,"termMonths":24,"msg":"loan created"}`                                                                                    |
| Application **mv9dt0f7hrx3n2w** created in memory (14:05:51 CEST / 12:05:51 UTC)                     | 3255                              | `loan-api \| {"level":30,"time":"2026-10-07T12:05:51.301Z","pid":41,"loanId":"mv9dt0f7hrx3n2w","amount":42000,"termMonths":48,"msg":"loan created"}`                                                                                    |
| Application **mv9g8w3bq1pm7ye** created in memory (15:35:08 CEST / 13:35:08 UTC)                     | 6350                              | `loan-api \| {"level":30,"time":"2026-10-07T13:35:08.301Z","pid":41,"loanId":"mv9g8w3bq1pm7ye","amount":9500,"termMonths":12,"msg":"loan created"}`                                                                                     |
| **First approval failure** — `AuditWriteError` EACCES on audit.log (13:25:40 CEST / 11:25:40 UTC)    | 1932                              | `loan-api \| {"level":50,"time":"2026-10-07T11:25:40.303Z","pid":41,"reqId":"4b0e29e0","err":{"type":"AuditWriteError","message":"EACCES: permission denied, open '/data/audit.log'"},"msg":"request failed with an unexpected error"}` |
| Gateway saw HTTP 500 for first approval (PATCH mv9c2k1lzq8r4ta)                                      | 1934                              | `gateway \| 10.20.7.26 - - [07/Oct/2026:11:25:40 +0000] "PATCH /api/loans/mv9c2k1lzq8r4ta/status HTTP/1.1" 500 68`                                                                                                                      |
| **Second approval failure** — same error (14:50:17 CEST / 12:50:17 UTC)                              | 4765                              | `loan-api \| {"level":50,"time":"2026-10-07T12:50:17.303Z","pid":41,"reqId":"eff57ba8","err":{"type":"AuditWriteError","message":"EACCES: permission denied, open '/data/audit.log'"},"msg":"request failed with an unexpected error"}` |
| Gateway saw HTTP 500 for second approval (PATCH mv9dt0f7hrx3n2w)                                     | 4766                              | `gateway \| 10.20.7.41 - - [07/Oct/2026:12:50:17 +0000] "PATCH /api/loans/mv9dt0f7hrx3n2w/status HTTP/1.1" 500 68`                                                                                                                      |
| **15:42 CEST restart** — container killed with SIGTERM (signal=15)                                   | 6594                              | `docker \| 2026-10-07T13:42:00.000Z container kill af4097840e81… signal=15`                                                                                                                                                             |
| Container died gracefully (exitCode=143 = 128+SIGTERM), not a crash                                  | 6595                              | `docker \| 2026-10-07T13:42:00.180Z container die af4097840e81… exitCode=143`                                                                                                                                                           |
| `persistence disabled` at second boot (15:42:06 CEST / 13:42:06 UTC) — same EACCES                   | 6604                              | `loan-api \| {"level":40,"time":"2026-10-07T13:42:06.819Z","pid":41,"hostname":"71fd736f7762","reason":"EACCES /data/loans.json","msg":"persistence disabled"}`                                                                         |
| **Fix restart** at 16:40:00 CEST — container killed with SIGTERM                                     | 8594                              | `docker \| 2026-10-07T14:40:00.000Z container kill 71fd736f7762… signal=15`                                                                                                                                                             |
| Fix restart — exitCode=143, not a crash                                                              | 8595                              | `docker \| 2026-10-07T14:40:00.180Z container die 71fd736f7762… exitCode=143`                                                                                                                                                           |
| **No `persistence disabled`** at fix boot — first loan-api line is `Tredgate Loan API started`       | 8612                              | `loan-api \| {"level":30,"time":"2026-10-07T14:40:06.816Z","pid":26,"hostname":"5c0fb0e79aba","version":"1.2.0","msg":"Tredgate Loan API started"}`                                                                                     |
| Application mv9kq4d2xz7n1rb re-entered (16:43:12 CEST)                                               | 8728                              | `loan-api \| {"level":30,"time":"2026-10-07T14:43:12.301Z","pid":26,"loanId":"mv9kq4d2xz7n1rb","amount":18000,"termMonths":24,"msg":"loan created"}`                                                                                    |
| Application mv9kr7m8vt3c5la re-entered (16:45:03 CEST)                                               | 8787                              | `loan-api \| {"level":30,"time":"2026-10-07T14:45:03.301Z","pid":26,"loanId":"mv9kr7m8vt3c5la","amount":42000,"termMonths":48,"msg":"loan created"}`                                                                                    |
| Application mv9ksx1h9fq2w6e re-entered (16:47:39 CEST)                                               | 8876                              | `loan-api \| {"level":30,"time":"2026-10-07T14:47:39.301Z","pid":26,"loanId":"mv9ksx1h9fq2w6e","amount":9500,"termMonths":12,"msg":"loan created"}`                                                                                     |
| **First approval succeeded** post-fix (16:50:22 CEST)                                                | 8952                              | `loan-api \| {"level":30,"time":"2026-10-07T14:50:22.301Z","pid":26,"reqId":"76f28070","loanId":"mv9kq4d2xz7n1rb","status":"approved","msg":"loan status updated"}`                                                                     |
| **`decision audited`** — audit.log write succeeded (fix confirmed)                                   | 8953                              | `loan-api \| {"level":30,"time":"2026-10-07T14:50:22.301Z","pid":26,"reqId":"76f28070","loanId":"mv9kq4d2xz7n1rb","decision":"approved","msg":"decision audited"}`                                                                      |
| Second approval succeeded (16:52:08 CEST)                                                            | 8995                              | `loan-api \| {"level":30,...,"loanId":"mv9kr7m8vt3c5la","status":"approved","msg":"loan status updated"}`                                                                                                                               |
| `decision audited` for second approval                                                               | 8996                              | `loan-api \| {"level":30,...,"loanId":"mv9kr7m8vt3c5la","decision":"approved","msg":"decision audited"}`                                                                                                                                |
| Gateway `POST /docs/reindex` 504 — first occurrence (pre-incident, 10:35 UTC)                        | 170–171                           | `gateway \| … "POST /docs/reindex?token=[REDACTED] HTTP/1.1" 504 167`                                                                                                                                                                   |
| Periodic reindex 504s at 45-min intervals (6 occurrences before resolution)                          | 170, 1735, 3232, 4763, 6355, 7945 | same pattern, `upstream timed out (110: Connection timed out)`                                                                                                                                                                          |
| `applicantName` in `installment cache miss` lines (OPS-060 concern)                                  | 1063 et al.                       | `loan-api \| {"level":30,...,"request":{"applicantName":"[REDACTED]","amount":169500,...},"msg":"installment cache miss"}`                                                                                                              |
| `DOCS_ADMIN_TOKEN` in gateway URL query string (OPS-060 concern)                                     | 170 et al.                        | `gateway \| … request: "POST /docs/reindex?token=[REDACTED] HTTP/1.1"`                                                                                                                                                                  |

---

## Root Cause

**Single root cause: the bind-mount `/data` folder was root-owned after the hardened 1.2.0
deployment, but the container now runs as the non-root user `node`.**

`deploy/api.Dockerfile` adds `USER node` (line 20) but neither creates `/data` nor sets its
ownership. `deploy/compose.yaml` mounts `./data:/data` (line 27), which maps the host directory
`./data` — created by earlier root-owned Docker operations and never re-chowned. When `loan-api`
started, it could not open `DATA_FILE` for writing, logged `persistence disabled` (REF-030
behaviour), and fell back to an in-memory store without surfacing any user-visible error.

**Contributing factor:** The `AUDIT_FILE` is checked separately, on every decision (per REF-030).
That check failed with `EACCES` when the first officer tried to approve, producing HTTP 500. This
was the only externally visible symptom before the 15:42 restart, and it was not escalated.

**Trigger for data loss:** The Release Engineer recreated the container at 15:42 CEST for an
unrelated memory limit change. Because the store was in-memory, this discarded all three
applications created since 13:00.

**Why the boot warning was missed:** The `persistence disabled` line is level 40 (warn), logged
before the `Tredgate Loan API started` info line. There was no alerting rule for this log event
and no item in the release checklist requiring a boot-log inspection. The `ops:verify` tool had no
rule for the combination of a non-root user and a root-owned bind mount (Tomas Dvorak, teams
16:06; proposed as OPS-011).

---

## Red Herrings

1. **Memory limit (512 m → 1 g).** The 15:42 restart was triggered by a routine memory limit
   change, not by a memory-pressure failure. The heap at restart was ~45 MB (teams chat 15:40).
   The memory limit change was the _trigger_ that discarded in-memory state, but not the _cause_
   of the data being in memory.

2. **Application creation returning 201.** Because `persistence disabled` keeps the in-memory
   store writable, all three `POST /api/loans` requests succeeded and returned 201. The tile grew
   to 9. This masked the problem from officers who were only monitoring whether creating worked.

3. **Health check green throughout.** `GET /api/health` returned 200 continuously (e.g., lines
   1063, 8940). The healthcheck does not test data file writability, so Docker saw the container as
   healthy even in memory-only mode.

4. **The first two approval failures (13:25, 14:50).** These were real symptoms of the root
   cause, not red herrings per se — but they were misread as a gateway or audit-feature problem
   rather than a sign of `persistence disabled`. Not escalating them meant the window of data at
   risk was not shortened.

---

## Compliance

### Q7: Does the log contain personal data or secrets (OPS-060, POL-070)?

**OPS-060 prohibits logging `applicantName` or any personal data.** The `installment cache miss`
log lines (e.g., line 1063) include the full request body, which contains `applicantName` as a
field. The `--redact` flag of `ops/tools/logs.ts` masks the value at display time, but the raw
`combined.log` file stores the name in plain text. This violates OPS-060.

This is a **pre-existing known defect under active remediation**: the teams war-room export
(13:03) records that "the cache fix PR is waiting for the Compliance review of the logging
change." The OPS-060 fix is in-flight but was not merged before the incident.

**OPS-060 also prohibits logging secrets.** The gateway nginx access log records the full request
URI including query strings. All `POST /docs/reindex?token=…` lines (first at line 170) contain
the `DOCS_ADMIN_TOKEN` value in the URL. The `--redact` flag masks it to `[REDACTED]` in the log
reader output, but the raw file holds the token in plain text.

**Comparison with the e-mails and ticket:**

| Source                                    | Claim                                                                       | Assessment                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Eva's e-mail 16:35 (POL-070 notification) | "no applicant data appears in the logs of this incident"                    | **Partially incorrect.** `applicantName` is present in the raw log (in `installment cache miss` lines). The statement may have been based on the standard `request completed` and `loan created` lines, which are compliant. Eva was likely unaware of the cache-miss logging issue. |
| Ticket `impact.personal_data`             | "none in logs; applications re-entered from paper notes (POL-070 informed)" | Same partial inaccuracy; ticket was written after comms.                                                                                                                                                                                                                             |
| Teams war-room 13:03                      | Cache fix PR "waiting for Compliance review of the logging change"          | Confirms the `applicantName`-in-logs defect was known before the incident.                                                                                                                                                                                                           |

**Summary:** Two OPS-060 violations exist in the log: (1) `applicantName` in cache-miss lines —
known, being fixed; (2) `DOCS_ADMIN_TOKEN` in gateway access log — not mentioned anywhere in the
comms or ticket and should be raised separately. Neither violation involves data leaving the system
to an external party.

---

## Open Questions

1. **Why was `ops:verify` not run after the hardening changes?** The ticket notes the hardening
   came from an agent run that "passed everything we asked for" (teams 13:03). Was `npx tsx
ops/tools/verify.ts` run against the final `deploy/` folder? The current verify tool has no
   rule for a non-root user plus a root-owned bind mount (proposed OPS-011 check).

2. **Is the `DOCS_ADMIN_TOKEN` in the gateway log a compliance incident?** The token appears in
   plaintext in every `/docs/reindex` request line in the nginx access log (line 170 et al.). This
   is not mentioned in the emails or ticket. The docs-search reindex appears to run on a 45-minute
   schedule — who or what is calling it, and is the token rotatable?

3. **Why does the reindex call time out every 45 minutes?** The 504s (lines 170, 1735, 3232, 4763,
   6355, 7945) occur at regular 45-minute intervals throughout the day. This is unrelated to the
   persistence failure, but a persistent 504 on an admin endpoint warrants investigation (slow
   index, insufficient gateway timeout, or oversized docs corpus).

4. **Were any other application creations affected?** The three lost applications have loanIds
   listed in the ticket. The ticket lists their replacement ids. Were there any installment
   calculations (`installment cache miss` at lines ~1063 et al.) that corresponded to applications
   the officers decided not to submit? Those calculation results were also lost but are not
   tracked.

5. **Postmortem and KI-006.** The postmortem is due 2026-10-14. KI-006 ("container started with
   persistence disabled") has not yet been filed. Does the KI entry need to cross-reference the
   `DOCS_ADMIN_TOKEN` logging issue, or is that a separate KI?
