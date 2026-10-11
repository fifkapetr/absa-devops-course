# Teams export: CZ-PRG-01 Branch Operations (channel), Monday 2026-10-05

Exported 2026-10-05 12:02 CEST by Eva Horakova. Times are local (CEST, UTC+2). Names are the display names of the channel members.

**[08:31] Lukas Benes:** Pilot host updated to 1.2.0 as planned, `docker compose up -d --build` finished 08:30. Health says `"version":"1.2.0"`. Shift log entry done.

**[08:33] Eva Horakova:** Thanks Lukas. Officers come in at 08:45, branch opens 09:00. I'll do the start-of-day checks on the new version.

**[08:52] Eva Horakova:** Tiles look right, 6 applications shown (test data on the pilot host) plus the 3 from Friday. The new installment preview in the form is nice, it updates while you type.

**[09:14] Eva Horakova:** Anyone else seeing the red banner "Failed to load loan applications" for a second and then it goes away?

**[09:16] Eva Horakova:** Two officers (desks 3 and 7) report the calculator preview shows nothing and then "Request failed with status 502" in the form. Reloading sometimes helps.

**[09:17] Eva Horakova:** Reproduced it myself at 09:17: form says `Request failed with status 502`, then after a reload it works again. Health check from my machine: `curl http://cz-prg-01-pilot:8080/api/health` -> `{"status":"ok","version":"1.2.0","uptimeSeconds":241}`.

**[09:19] Eva Horakova:** Declaring. S2 because the UI works between the errors and decisions still go through.

**[09:19] Eva Horakova:**
```
INCIDENT DECLARED  INC-20261005-01  Severity: S2
Branch: CZ-PRG-01   Declared by: Operations Lead   Start: 09:17 local
Impact: Installment preview and sometimes the application list fail with "Request failed with status 502"; works again after a reload. Decisions appear to go through.
Evidence: GET /api/health ok, version 1.2.0, uptimeSeconds 241 at 09:17 (expected about 2800 since the 08:30 release).
Actions so far: on-call contacted by e-mail and phone; no data file action taken yet (pilot runs in containers, data on /data).
Workaround: reload the page; take the installment from the table column instead of the preview.
Next update: 11:19
```

**[09:20] Eva Horakova:** Emailed and called Jana (on-call this week).

**[09:24] Jana Novakova:** Acknowledged, on it. Looking at the pilot host now. Uptime 241 s at 09:17 means the API restarted at 09:13. Pulling the logs: `docker compose logs -t --no-color > /tmp/inc-20261005-01.log` and `docker events --since 08:00`.

**[09:26] Tomas Dvorak:** I'm around if you need anything about the calculator, I wrote most of 1.2.0.

**[09:27] Jana Novakova:** Gateway shows 502s in bursts. In between everything is 200. Looks like the API drops out for half a minute every now and then.

**[09:28] Jana Novakova:** Also seeing this in the gateway error log, twice this morning: `upstream timed out (110: Connection timed out) while reading response header from upstream` for `POST /docs/reindex`. Last one 09:26.

**[09:29] Tomas Dvorak:** Timeouts to an upstream = network. The pilot host is on the new VLAN since Friday, could the switch be dropping the docker bridge traffic? That would explain both the 502s and the timeouts.

**[09:31] Jana Novakova:** Possible. Asking facilities whether anything changed on the VLAN. Meanwhile checking whether the timeouts correlate with the 502s.

**[09:34] Eva Horakova:** Officer at desk 5 says "Action failed: Request failed with status 502" when approving. So decisions are hit too, briefly.

**[09:36] Tomas Dvorak:** Wait. Red banner, list failing, 500-ish errors... isn't this the data file? KI-001 again? The /data volume is a bind mount, if the file got truncated we'd see exactly this.

**[09:37] Jana Novakova:** Would be a 500 with `SyntaxError` in the API log though, not a 502 from the gateway. Checking anyway, RB-003 step 3.

**[09:40] Eva Horakova:** Facilities say nothing changed on the VLAN since Friday 17:00.

**[09:43] Jana Novakova:** Data file is fine. `GET /api/loans` returns 9 records, `node -e "JSON.parse(...)"` on /data/loans.json says OK, no level 50 lines in the API log at all. Dropping the data-file theory.

**[09:44] Tomas Dvorak:** OK, scratch that.

**[09:45] Eva Horakova:** Martin asked for an ETA by mail, I told him we are still in diagnosis.

**[09:47] Jana Novakova:** The upstream timeouts: the first one today is at 08:05, before the release, and there's another at 08:50 when nothing was wrong. They are the handbook reindex cron hitting the 5 s gateway timeout. Annoying, but not our incident.

**[09:48] Tomas Dvorak:** Fair. So not network either.

**[09:52] Jana Novakova:** Found it in `docker events`: `container oom` followed by `container die ... exitCode=137` for loan-api. 137 = killed by the kernel OOM killer, we have `mem_limit: 256m` on that container. The watchdog cron starts it again within a minute, that's the "works after reload".

**[09:52] Jana Novakova:** Counting `Tredgate Loan API started` lines since 08:30: the release start at 08:30 and then 09:13, 09:22, 09:30, 09:38, 09:46. Five restarts so far, roughly every eight minutes. Kills at 09:12, 09:21, 09:29, 09:37, 09:45.

**[09:54] Eva Horakova:** So every 8 minutes we lose the API for about half a minute. That matches what the officers describe.

**[09:55] Martin Kral:** Reading along. Memory limit too low for 1.2.0? Can we just raise it?

**[09:57] Jana Novakova:** Raising it buys time but something is growing. 1.1.0 ran in the same limit for two weeks. Looking at the new `process metrics` lines first.

**[10:01] Lukas Benes:** FYI the 1.1.0 image is still on the host (`tredgate-loan-loan-api:1.1.0`), a rollback is `docker compose up -d` with the old tag, about 2 minutes.

**[10:05] Jana Novakova:** Here it is. `process metrics` every minute: after each restart `heapUsedMB` starts around 20 and climbs to about 65, `cacheEntries` climbs from 0 to roughly 1300, then the container dies. Straight line, never goes down. That cache is the new installment calculator cache from 1.2.0.

**[10:05] Jana Novakova:** And every calculator request logs `installment cache miss` with the full request body. The body contains `applicantName`. Full names of applicants, hundreds of lines this morning. That's a POL-070 problem on top of the outage.

**[10:06] Tomas Dvorak:** The cache key includes `requestedAt`, which the UI sets to the current time on every call. So every request is a miss and every entry stays forever. I see it now. The log line was a debug aid, it should never have shipped with the body.

**[10:07] Martin Kral:** Thanks for owning that Tomas. Fix later, first stop the bleeding.

**[10:10] Jana Novakova:** Informing Hana (Compliance) by mail now: applicant names in the pilot log since 08:30 (POL-070, OPS-060).

**[10:12] Jana Novakova:** Proposal: roll back to 1.1.0 now (OPS-050 rollback, no data format change in 1.2.0 so no data restore needed), fix the cache properly in a pull request, redeploy after review. Martin?

**[10:12] Martin Kral:** Approved. Lukas, please.

**[10:13] Lukas Benes:** Rolling back. Pulling the compose file to the 1.1.0 image tag, `docker compose up -d`.

**[10:17] Eva Horakova:** Another burst of 502s at 10:17, officers told to pause decisions for 5 minutes.

**[10:20] Lukas Benes:** Done. loan-api recreated at 10:20 from the 1.1.0 image. Health: `{"status":"ok","uptimeSeconds":14}`, no `version` field, that's 1.1.0. Gateway clean so far.

**[10:21] Eva Horakova:**
```
INCIDENT UPDATE  INC-20261005-01  Severity: S2  Update #1  10:21 local
Status: fix applied, verifying
Findings: loan-api container killed by the memory limit (exitCode=137) every ~8 minutes since 09:12 and restarted by the watchdog; cause is the 1.2.0 installment cache growing without limit (process metrics: cacheEntries ~1300, heapUsedMB ~65 before each kill). Rolled back to 1.1.0 at 10:20 (OPS-050). Applicant names found in 1.2.0 log lines; Compliance informed 10:10.
Next step: monitor for 60 minutes (on-call); Platform Engineering prepares the cache fix in a pull request.
Next update: 11:30
```

**[10:24] Eva Horakova:** Tiles: Total Applications 9, same as my 08:52 reading plus the ones created this morning: 12 now. Checking with the officers' paper notes.

**[10:31] Jana Novakova:** 10 minutes clean on the gateway. Uptime climbing normally. Memory on loan-api flat at about 150 MB.

**[10:40] Hana Vesela:** Received Jana's mail. For the record: the pilot log containing applicant names is to be treated as personal data from now on. Do not paste it into chat or tickets without redaction. I need the count of distinct applicants affected for the register, and the postmortem.

**[10:41] Jana Novakova:** Understood. I'll count from the log with the names redacted in anything I share. The raw export stays on the pilot host and the incident folder with restricted access.

**[10:45] Tomas Dvorak:** Draft fix: cache key without `requestedAt` and `applicantName`, LRU with a maximum of 500 entries and a 5 minute TTL, log line without the body. 15 lines. Opening the PR after lunch with the OPS-060 catalog update.

**[10:46] Martin Kral:** Compliance review on the logging change please (OPS-050, data and logging category).

**[11:05] Eva Horakova:** 45 minutes without a single error report from the floor.

**[11:28] Jana Novakova:** 68 minutes clean. Gateway access log shows 200s only since 10:20:10. Calling it resolved with Eva.

**[11:30] Eva Horakova:**
```
INCIDENT RESOLVED  INC-20261005-01  Severity: S2  Resolved: 11:30 local  Duration: 2 h 13 min (customer impact 09:12-10:20)
Cause (preliminary): release 1.2.0 installment cache grows without eviction until the container memory limit kills loan-api; the watchdog restarts it, causing ~30 s of 502 errors every ~8 minutes.
Fix: rollback to 1.1.0 at 10:20 (OPS-050 rollback); permanent fix in a pull request (cache eviction, log line without request body).
Data check: Total Applications tile = 12, equals the shift log value plus 3 paper applications entered after 10:20.
Follow-up: postmortem by 2026-10-12, Known Issue entry KI-005. Paper applications to enter: 0. Compliance informed (applicant names in 1.2.0 log).
```

**[11:33] Martin Kral:** Good work everyone. Jana, postmortem please within 5 business days per OPS-040, blameless. I'll mail the details.

**[11:35] Jana Novakova:** Will do. Evidence I'm keeping: the combined log export, metrics from the host monitoring, this channel, the e-mails and the ticket. Analysis first, then the postmortem.

**[11:36] Lukas Benes:** Note for the postmortem: the pilot has no restart policy in compose, the restarts came from the old cron watchdog on the host. Without it we'd have had an S1 at 09:12 instead of a flapping S2.

**[11:38] Tomas Dvorak:** Also for the postmortem: the `installment cache miss` message is not in the OPS-060 catalog. The release should not have passed review with it.

**[11:40] Eva Horakova:** Ticket updated with all timestamps. Closing the channel for this incident, thanks all.

**[11:52] Hana Vesela:** Reminder for the postmortem: no applicant names in it, counts only. Thanks.
