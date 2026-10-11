# Teams export: CZ-PRG-01 Branch Operations (channel), Wednesday 2026-10-07

Exported 2026-10-07 17:20 CEST by Eva Horakova. Times are local (CEST, UTC+2).

**[13:02] Lukas Benes:** Pilot host back on 1.2.0 with the hardened container setup (non-root user, healthchecks, pinned images, no published ports except the gateway, memory limit 512m until the 1.2.1 cache fix is merged). `docker compose up -d --build` done 13:00, health ok, version 1.2.0.

**[13:03] Tomas Dvorak:** For the record the hardening came from the agent run we did yesterday on the compose and Dockerfiles; it passed everything we asked for. The cache fix PR is waiting for the Compliance review of the logging change.

**[13:04] Eva Horakova:** Thanks. Lunch shift is light today, 4 officers on the floor.

**[13:27] Eva Horakova:** Desk 3 reports "Action failed: EACCES: permission denied, open '/data/audit.log'" when approving an application entered a quarter ago. Creating worked, approving did not. Is that the gateway again?

**[13:31] Tomas Dvorak:** That message is the new audit trail of 1.2.0. Permission denied on the audit file... odd. Can the officer try again later? I'm in a review until 15:00.

**[13:32] Eva Horakova:** Told her to leave it pending and carry on.

**[14:52] Eva Horakova:** Second one: desk 7, same text, approving the 42,000 application from 14:05. Creating works, approving fails. Two applications pending now that should be approved.

**[14:55] Eva Horakova:** Not declaring yet, decisions are not urgent today and creating works. Will raise it with Jana after her meeting.

**[15:40] Lukas Benes:** Heads-up: loan-api memory is at ~45 MB heap after 2.5 hours, still the old cache, so I'm raising the limit from 512m to 1g to be safe for the rest of the week. Recreating the container now, takes 10 seconds.

**[15:42] Lukas Benes:** Done, 15:42. Health ok.

**[15:50] Eva Horakova:** Total Applications tile shows 6. It showed 9 at 15:35 after desk 5 entered the third one. The three applications from today are gone from the list. ln-1001 to ln-1006 only.

**[15:51] Eva Horakova:** Reloaded twice, still 6. OPS-040 runbook table: "tile dropped to 6" is RB-003 then RB-006. Nobody ran a reset?

**[15:52] Lukas Benes:** I did not run data:reset, only the compose change. Checking /data on the host.

**[15:53] Eva Horakova:** Declaring S2 (data integrity in doubt).

**[15:53] Eva Horakova:**
```
INCIDENT DECLARED  INC-20261007-01  Severity: S2
Branch: CZ-PRG-01   Declared by: Operations Lead   Start: 15:50 local
Impact: Total Applications tile dropped from 9 to 6 after the 15:42 container restart; the three applications created today (13:10, 14:05, 15:35) are missing. Earlier today two approvals failed with "EACCES: permission denied, open '/data/audit.log'".
Evidence: GET /api/loans returns the six seed records only; GET /api/health ok, version 1.2.0, uptime since 15:42.
Actions so far: officers asked to stop entering applications; paper notes of the three applications secured; Release Engineer checking /data on the host.
Workaround: applications on paper until recovery.
Next update: 17:53
```

**[15:54] Eva Horakova:** Mailed Jana.

**[15:58] Lukas Benes:** /data on the host: `loans.json` is dated Monday 10:21, 9 records (the Friday and Monday data). `audit.log` does not exist. Both the folder and the file are owned by root. The container now runs as `node`.

**[16:05] Jana Novakova:** Acknowledged, I'm on the host. Jumping straight to the loan-api log from the 13:00 start.

**[16:11] Jana Novakova:** Second line after the 13:00 boot: `{"level":40,...,"reason":"EACCES /data/loans.json","msg":"persistence disabled"}`. Same line again after the 15:42 boot. That's the 1.2.0 behaviour from REF-030: if the data file is not writable the API runs from the seed in memory and keeps going.

**[16:14] Jana Novakova:** So since 13:00 every application was created in memory only, the tile showed 9 because the memory copy had the three new ones, and the audit append failed with EACCES because `/data` is root-owned and the process is `node` now. The 15:42 recreate threw the memory away. The 500s at 13:25 and 14:50 were the early warning.

**[16:18] Tomas Dvorak:** The hardening added `USER node` but kept the bind mount `./data:/data`. The image never creates or chowns /data. Nothing we ran checks that combination.

**[16:25] Jana Novakova:** Cause confirmed: data folder owned by root, container user `node`, no write access, `persistence disabled` at both boots. Not a data file corruption, so RB-003's restore steps do not apply; the Monday file is intact. We lost only today's three applications and the two decisions, and those are on paper.

**[16:27] Martin Kral:** Fix options?

**[16:28] Jana Novakova:** Fix: `chown -R 1000:1000 /srv/tredgate/data` on the host for now, then switch the compose file to a named volume so the image owns the data path; the Dockerfile gets a `mkdir -p /data && chown node:node /data`. Lukas applies, I verify the boot has no `persistence disabled` line before anybody enters anything.

**[16:30] Martin Kral:** Approved. Eva, please inform Hana: applications were lost and re-entered (POL-070).

**[16:35] Eva Horakova:** Mail to Hana sent.

**[16:40] Lukas Benes:** Fixed and recreated at 16:40. Boot log: deprecation warning, then `Tredgate Loan API started` directly, no `persistence disabled`. `GET /api/loans` returns the 9 records from Monday.

**[16:41] Jana Novakova:** Confirmed on the host. `/data/audit.log` gets created on the first decision now. Eva, you can re-enter.

**[16:48] Eva Horakova:** The three applications are re-entered from the paper notes (16:43, 16:45, 16:47), tile shows 12. Approving the two that were approved on paper now.

**[16:53] Eva Horakova:** Both approvals went through, `decision audited` in the log per Jana. New ids, the applications get today's createdAt; noted in the Decision Register.

**[17:00] Eva Horakova:**
```
INCIDENT RESOLVED  INC-20261007-01  Severity: S2  Resolved: 17:00 local  Duration: 1 h 10 min (data at risk since 13:00)
Cause (preliminary): hardened container runs as a non-root user while the /data bind mount is owned by root; 1.2.0 started with "persistence disabled" and kept today's applications in memory only; the 15:42 restart discarded them.
Fix: data folder ownership corrected and named volume configured (RB-003 does not apply, file intact); applications re-entered from paper notes.
Data check: Total Applications tile = 12 (9 from Monday + 3 re-entered), equals shift log.
Follow-up: postmortem by 2026-10-14, Known Issue entry KI-006. Paper applications to enter: 0. Compliance informed 16:35.
```

**[17:02] Martin Kral:** Thanks. Jana, postmortem within 5 business days please; include why a verified-looking configuration got deployed without a check for the data path. I'll add the verification requirement to OPS-050.

**[17:04] Hana Vesela:** Acknowledged Eva's mail. For the register: three applications lost and re-entered, no data left the system. Please note in the postmortem that the officers' paper notes are what saved us.

**[17:06] Tomas Dvorak:** For the postmortem: `ops:verify` had no rule for "non-root user plus bind mount". Proposing OPS-011.
