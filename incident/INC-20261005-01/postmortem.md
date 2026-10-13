# Postmortem INC-20261005-01

|                        |                                                |
| ---------------------- | ---------------------------------------------- |
| Severity               | S2                                             |
| Branch                 | CZ-PRG-01                                      |
| Incident window (CEST) | detected 09:16, declared 09:19, resolved 11:30 |
| Author role            | Platform Engineer on-call                      |
| Reviewer role          | Operations Lead                                |
| Distribution           | Compliance Officer, Platform Engineering Lead  |

All times in this document are CEST (UTC+2). Log timestamps (UTC) have been converted; the UTC original is shown in parentheses where relevant.

---

## 1. Summary

On Monday 2026-10-05 the CZ-PRG-01 branch pilot was updated to release 1.2.0 at 08:30 CEST. The new release introduced an installment-calculation cache with no eviction policy; because the UI included the current wall-clock time (`requestedAt`) in every calculation request, each request generated a unique cache key and the cache grew without bound. After approximately 42 minutes of operation the `loan-api` container's heap reached the 256 MB memory limit; the Linux OOM killer terminated the container (`exitCode=137`). The container was restarted automatically (see Section 5 for the restart mechanism), but the cache resumed growing from zero each time. Nine OOM kills occurred between 09:12:56 CEST and 10:16:51 CEST; each kill caused a window of approximately 40–60 seconds during which the gateway returned 502 errors for all API routes. The branch experienced intermittent failures to the installment preview, the application list, and — on at least one occasion — a decision approval. The Platform Engineering Lead approved a rollback to 1.1.0 at 10:12 CEST; the Release Engineer completed it at 10:20:06 CEST. The system ran without errors from 10:20 CEST and was declared resolved at 11:30 CEST. Separately, the `installment cache miss` log line introduced in 1.2.0 wrote the full request body, including `applicantName`, to the container log in violation of OPS-060 and POL-070; the Compliance Officer was informed at 10:10 CEST on the same day.

---

## 2. Timeline

| Time (CEST) | Event                                                                                                                                                                                                                                                                                   | Source                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 08:30:06    | Release 1.2.0 deployed to pilot host: `docker compose up -d --build` finished, health check confirms `"version":"1.2.0"`                                                                                                                                                                | [chat 08:31], [ticket]                                               |
| 08:33       | Operations Lead performs start-of-day check; tiles look correct                                                                                                                                                                                                                         | [chat 08:33]                                                         |
| 08:52       | Operations Lead notes 9 applications visible (6 test + 3 from previous week)                                                                                                                                                                                                            | [chat 08:52]                                                         |
| 09:12:56    | **First OOM kill** — kernel OOM killer terminates `tredgate-loan-loan-api-1` (`exitCode=137`); `heapUsedMB` 61, `cacheEntries` 1,219 at last `process metrics` before the kill                                                                                                          | [analysis], [metrics 07:12Z]                                         |
| 09:13:07    | `loan-api` restarted; `Tredgate Loan API started` v1.2.0 in the log                                                                                                                                                                                                                     | [analysis line 10051]                                                |
| 09:14       | Operations Lead notes brief red banner "Failed to load loan applications"                                                                                                                                                                                                               | [chat 09:14]                                                         |
| 09:16       | **Detected** — two loan officers report installment preview showing nothing, then "Request failed with status 502"                                                                                                                                                                      | [chat 09:16], [ticket]                                               |
| 09:17       | Operations Lead confirms 502 on personal test; health endpoint responds OK with `uptimeSeconds: 241`, implying restart around 09:13                                                                                                                                                     | [chat 09:17], [ticket]                                               |
| 09:19       | **Declared** — Operations Lead declares INC-20261005-01, S2; posts `INCIDENT DECLARED` message on branch channel and sends email to on-call and Platform Engineering Lead                                                                                                               | [chat 09:19], [email 1], [ticket]                                    |
| 09:20       | On-call contacted by email and phone                                                                                                                                                                                                                                                    | [chat 09:20]                                                         |
| 09:21:19    | OOM kill 2 (`exitCode=137`)                                                                                                                                                                                                                                                             | [analysis line 16552]                                                |
| 09:22:06    | `loan-api` restart 2                                                                                                                                                                                                                                                                    | [analysis line 17121]                                                |
| 09:24       | **Acknowledged** — Platform Engineer on-call acknowledges; begins reviewing host logs and docker events                                                                                                                                                                                 | [chat 09:24], [ticket]                                               |
| 09:27–09:31 | **Hypothesis 1 (wrong): network / VLAN.** Platform Engineer on-call observes gateway upstream-timeout errors for `POST /docs/reindex`; Developer raises VLAN change hypothesis; facilities contacted                                                                                    | [chat 09:27–09:31]                                                   |
| 09:29:11    | OOM kill 3                                                                                                                                                                                                                                                                              | [analysis line 23520]                                                |
| 09:34       | Loan officer at desk 5 reports "Action failed: Request failed with status 502" on an approval                                                                                                                                                                                           | [chat 09:34]                                                         |
| 09:36–09:43 | **Hypothesis 2 (wrong): corrupted data file (KI-001).** Developer raises hypothesis; Platform Engineer on-call runs RB-003 step 3; `GET /api/loans` returns 9 records, data file parses OK, no level-50 lines in `loan-api` log                                                         | [chat 09:36–09:43], [ticket]                                         |
| 09:37:38    | OOM kill 4                                                                                                                                                                                                                                                                              | [analysis line 30834]                                                |
| 09:40       | Facilities confirm no VLAN change since Friday 17:00; network hypothesis dropped                                                                                                                                                                                                        | [chat 09:40]                                                         |
| 09:45:03    | OOM kill 5                                                                                                                                                                                                                                                                              | [analysis line 37175]                                                |
| 09:47       | Platform Engineer on-call determines that the upstream timeouts (`08:05 CEST` and `08:50 CEST`) predate the 1.2.0 release and follow a 45-minute cron interval for handbook reindexing; not related to the incident                                                                     | [chat 09:47], [analysis]                                             |
| 09:52       | **Root cause identified (partial)** — `docker events` shows `container oom` / `die exitCode=137` for `loan-api`; 5 restarts counted since 08:30 at intervals of ~8 minutes                                                                                                              | [chat 09:52], [ticket]                                               |
| 09:53:22    | OOM kill 6                                                                                                                                                                                                                                                                              | [analysis line 44108]                                                |
| 10:01:27    | OOM kill 7                                                                                                                                                                                                                                                                              | [analysis line 50916]                                                |
| 10:05       | **Root cause identified (full)** — `process metrics` log entries confirm `heapUsedMB` and `cacheEntries` grow linearly after each restart (~0.47 entries/s), driven by the unbounded installment cache; every `installment cache miss` line contains `applicantName` (OPS-060, POL-070) | [chat 10:05], [ticket]                                               |
| 10:09:21    | OOM kill 8                                                                                                                                                                                                                                                                              | [analysis line 57900]                                                |
| 10:10       | Compliance Officer informed by email per POL-070 and OPS-040 step 6                                                                                                                                                                                                                     | [chat 10:10], [email 3], [ticket]                                    |
| 10:12       | Platform Engineering Lead approves rollback to 1.1.0 (OPS-050); Release Engineer instructed                                                                                                                                                                                             | [chat 10:12], [ticket]                                               |
| 10:13       | Release Engineer begins rolling back: updates compose file to 1.1.0 image tag, runs `docker compose up -d`                                                                                                                                                                              | [chat 10:13]                                                         |
| 10:16:51    | OOM kill 9 (while rollback was in progress)                                                                                                                                                                                                                                             | [analysis line 64681]                                                |
| 10:17       | Another burst of 502 errors during rollback; officers told to pause decisions for 5 minutes                                                                                                                                                                                             | [chat 10:17]                                                         |
| 10:20:00    | Rollback SIGTERM sent to 1.2.0 container (UTC 08:20:00)                                                                                                                                                                                                                                 | [analysis line 67571]                                                |
| 10:20:06    | **Mitigated** — `loan-api` starts from 1.1.0 image; health returns ok, no `version` field; last 502 recorded at 10:20:07 CEST (UTC 08:20:07)                                                                                                                                            | [chat 10:20], [ticket], [analysis line 67601], [analysis line 67603] |
| 10:21       | Operations Lead sends `INCIDENT UPDATE #1` on branch channel                                                                                                                                                                                                                            | [chat 10:21]                                                         |
| 10:24       | Operations Lead verifies Total Applications tile = 12; cross-checks with shift log                                                                                                                                                                                                      | [chat 10:24]                                                         |
| 10:31       | Platform Engineer on-call: 10 minutes clean on the gateway; `loan-api` memory flat at ~150 MB                                                                                                                                                                                           | [chat 10:31]                                                         |
| 10:40       | Compliance Officer acknowledges notification; instructs team to treat pilot log as personal data; requests count of distinct applicants for the register and postmortem                                                                                                                 | [chat 10:40]                                                         |
| 11:28       | Platform Engineer on-call: 68 minutes clean; first 200 response after rollback recorded at 10:20:17 CEST (UTC 08:20:17)                                                                                                                                                                 | [chat 11:28], [analysis line 67646]                                  |
| 11:30       | **Resolved** — Operations Lead declares INC-20261005-01 resolved; `INCIDENT RESOLVED` message sent on channel and by email to all officers                                                                                                                                              | [chat 11:30], [email 4], [ticket]                                    |
| 11:33       | Platform Engineering Lead requests postmortem within 5 business days (by 2026-10-12) per OPS-040                                                                                                                                                                                        | [chat 11:33], [email 5]                                              |
| 11:36       | Release Engineer notes: pilot has no `restart:` policy in `compose.yaml`; restarts came from host watchdog cron                                                                                                                                                                         | [chat 11:36]                                                         |
| 11:38       | Developer notes: `installment cache miss` message is not in the OPS-060 catalog; release should not have passed review                                                                                                                                                                  | [chat 11:38]                                                         |
| 11:45       | Postmortem requested by 2026-10-12; KI-005 to be filed                                                                                                                                                                                                                                  | [email 5], [ticket]                                                  |

---

## 3. Impact

**Customer impact window:** 09:12:56 CEST to 10:20:07 CEST — **67 minutes 11 seconds** [analysis lines 9966, 67603].

**Service availability:** 1,808 of 22,717 gateway requests returned HTTP 502 during the impact window — **7.96% of requests failed** [analysis]. Failures were intermittent, concentrated in ~40–60 s windows after each of the 9 OOM kills [analysis]. The system was functional between kills; a reload typically resolved the transient error [chat 09:17].

**Applications affected:** Three new applications were created during the morning and are confirmed in the system (Total Applications tile = 12 after rollback; pre-incident count was 9 [chat 08:52]) [chat 10:24, email 4]. The specific `loanId`s of applications or decisions that encountered 502 errors during submission are not recorded in the sources. No paper applications required re-entry: the Resolved message states "Paper applications to enter: 0" [chat 11:30].

**Data loss:** None. Total Applications tile = 12 after rollback, consistent with pre-release count of 9 plus 3 applications entered during the morning [chat 10:24, chat 11:30, email 4].

**Personal data exposure:** Release 1.2.0 wrote 12,169 `installment cache miss` log lines containing `applicantName` and the full request body to the container log, from 08:30:11 CEST (UTC 06:30:11; analysis line 949) until the rollback at 10:20 CEST, in violation of OPS-060 [analysis]. The count of distinct applicants whose names appear in those lines is **TBD — not in sources (analysis.md notes this requires redacted log processing)** [analysis]. The Compliance Officer has requested this count for the data register and for this postmortem [chat 10:40].

**Compliance:** OPS-050 data-and-logging review was not obtained for the `installment cache miss` log message before it shipped. POL-070 same-day notification was met: Compliance Officer informed at 10:10 CEST on 2026-10-05 [email 3, ticket].

---

## 4. Log signature

The following log lines identify this failure. All names have been redacted.

**OOM kill event (docker events, one per kill; 9 total):**

```
container oom … name=tredgate-loan-loan-api-1
container die … exitCode=137  name=tredgate-loan-loan-api-1
```

[analysis lines 9972, 9975 (kill 1); pattern repeats at analysis lines 16552, 23520, 30834, 37175, 44108, 50916, 57900, 64681]

**Memory growth approaching kill (loan-api `process metrics` — final entry before kill 1):**

```json
{
  "heapUsedMB": 61,
  "rssMB": 136,
  "cacheEntries": 1219,
  "uptimeSeconds": 2520,
  "msg": "process metrics"
}
```

[analysis line 9459]

**Personal data in log (loan-api, first occurrence — name redacted):**

```json
{"reqId":"f953df8e","request":{"applicantName":"[REDACTED]","amount":194400,...},"msg":"installment cache miss"}
```

[analysis line 949]

**Gateway 502 (first occurrence, same second as kill 1):**

```
"GET /api/loans HTTP/1.1" 502 157
```

[analysis line 9966]

**Rollback start and clean gateway (1.1.0, no `version` field):**

```json
{
  "level": 30,
  "time": "2026-10-05T08:20:06.645Z",
  "hostname": "68496c47404e",
  "msg": "Tredgate Loan API started"
}
```

[analysis line 67601]

**Absence of level-50 lines (confirmed 0 matches for `--service loan-api --level 50`):** This confirms the data file was not corrupted and helps rule out KI-001 [analysis].

---

## 5. Root cause

Release 1.2.0 introduced an in-memory installment-calculation cache. The cache key included the `requestedAt` field, which the UI set to `Date.now()` on every keystroke. Because no two requests shared the same millisecond timestamp, every request was a cache miss, every entry was inserted, and no entry was ever evicted. There was no maximum cache size and no TTL. `cacheEntries` grew at approximately 0.47 entries/second (accelerating as the branch opened); `heapUsedMB` tracked the growth linearly, reaching 61 MB just before the first kill [analysis]. When the container's RSS approached the 256 MB `mem_limit`, the Linux OOM killer terminated the process (`exitCode=137`) [analysis, chat 09:52].

The container was restarted after each kill. **Note: sources disagree on the restart mechanism.** The analysis [analysis] attributes the restart to `restart: unless-stopped` in `compose.yaml`, while the Release Engineer stated on the channel that "the pilot has no restart policy in compose, the restarts came from the old cron watchdog on the host" [chat 11:36]. Both sources agree the container restarted within approximately 45 seconds, producing a new cycle of the same memory growth. Nine kills occurred over 67 minutes until the rollback stopped the loop.

The defect shipped because:

1. The cache key incorrectly included `requestedAt` — the Developer acknowledged this was unintentional [chat 10:06].
2. The `installment cache miss` log line included the full request body containing `applicantName`, which violated OPS-060 and should have triggered an OPS-050 data-and-logging review before merge; it did not [chat 11:38, analysis].

---

## 6. Fix

**Immediate (service restored):** Rollback to 1.1.0 at 10:20:06 CEST, approved by the Platform Engineering Lead and executed by the Release Engineer under OPS-050 rollback procedure [chat 10:12–10:20, ticket]. No data file restore was required: no data format change in 1.2.0 and Total Applications tile was consistent [chat 11:30, email 4].

**Permanent fix (in progress at time of postmortem):** The Developer described the fix on the channel: cache key without `requestedAt` and `applicantName`, LRU with a maximum of 500 entries and a 5-minute TTL, and the `installment cache miss` log line removed [chat 10:45]. The pull request must go through the **OPS-050 data-and-logging review category**, requiring Compliance Officer sign-off before merge, as directed by the Platform Engineering Lead [chat 10:46, OPS-050]. The `installment cache miss` message text must be added to the OPS-060 catalog in the same pull request, or replaced with a catalog-conforming message [chat 11:38, OPS-060].

---

## 7. Prevention

| Action                                                                                                                                                                                                                                                                     | Owner role                | Due                              | Ticket |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------- | ------ |
| Fix cache key: remove `requestedAt` (and `applicantName`) from the key; add LRU eviction with a maximum of 500 entries and a 5-minute TTL                                                                                                                                  | Developer                 | 2026-10-12 [email 5]             | TBD    |
| Remove `applicantName` and the full request body from the `installment cache miss` log line; ensure the message is absent or replaced with a catalog-conforming entry in OPS-060                                                                                           | Developer                 | 2026-10-12 [email 5]             | TBD    |
| Submit the cache and logging fix PR through OPS-050 data-and-logging review (Compliance Officer sign-off required before merge)                                                                                                                                            | Platform Engineer on-call | 2026-10-12 [email 5, OPS-050]    | TBD    |
| Obtain the count of distinct applicants whose names appeared in the 1.2.0 log (12,169 lines) and report it to the Compliance Officer for the data register                                                                                                                 | Platform Engineer on-call | TBD — not in sources             | TBD    |
| File Known Issue entry KI-005 per `docs/handbook/known-issues/README.md` covering: symptom (`loan-api` restart loop, 502 errors every ~8 min), log signature (`container oom exitCode=137`, linear `cacheEntries` / `heapUsedMB` growth), root cause, fix, and prevention  | Platform Engineer on-call | 2026-10-12 [chat 11:30, OPS-040] | TBD    |
| Resolve the discrepancy in `compose.yaml` regarding the `restart:` policy (analysis indicates `restart: unless-stopped`; Release Engineer states no policy exists and restarts came from host watchdog cron); document the authoritative restart mechanism and its runbook | Platform Engineer on-call | TBD — not in sources             | TBD    |
| Add a `process metrics` alert threshold for `heapUsedMB` in OPS-030 to catch unbounded memory growth before OOM kill                                                                                                                                                       | Platform Engineer on-call | TBD — not in sources             | TBD    |
| Catalogue the docs-search reindex cron upstream-timeout pattern as a known issue (cron hits the 5 s `proxy_read_timeout` on a 45-minute schedule; predates 1.2.0); entry should prevent re-investigation in future incidents                                               | Platform Engineer on-call | TBD — not in sources             | TBD    |

---

## 8. Known Issue

Known Issue entry **KI-005** is to be filed per `docs/handbook/known-issues/README.md` as part of the postmortem and permanent-fix pull request [chat 11:30, email 5, ticket]. The entry does not yet exist in `docs/handbook/known-issues/` at the time of writing.

---

## Open TBDs

The following items remain `TBD — not in sources` in this document:

1. **Distinct applicants exposed** — count of unique applicant names in the 12,169 `installment cache miss` lines (Section 3, Prevention action 4). Required by Compliance Officer for the data register [chat 10:40].
2. **Restart mechanism** — whether `restart: unless-stopped` is in `compose.yaml` or whether a host watchdog cron is solely responsible (Section 5, Prevention action 6). Sources disagree [analysis vs chat 11:36].
3. **`heapUsedMB` alert threshold** (Prevention action 7) and **docs-search cron known-issue entry** (Prevention action 8) — no due dates or ticket numbers in sources.
4. **Ticket numbers** for all action items — no tracking tickets cited in sources.
