# E-mails related to INC-20261007-01

All times CEST (UTC+2). Addresses are the internal `@example.com` mailboxes.

---

**From:** Eva Horakova <eva.horakova@example.com>
**To:** Jana Novakova <jana.novakova@example.com>
**Cc:** Martin Kral <martin.kral@example.com>; Lukas Benes <lukas.benes@example.com>
**Date:** Wednesday 2026-10-07 15:53
**Subject:** INCIDENT DECLARED INC-20261007-01 S2 CZ-PRG-01: applications missing after 15:42 restart

Jana,

declaring INC-20261007-01, severity S2 (data integrity in doubt), branch CZ-PRG-01, start 15:50 local.

Impact: the Total Applications tile dropped from 9 to 6 after Lukas recreated the loan-api container at 15:42 (memory limit change). The three applications created today at 13:10, 14:05 and 15:35 are missing from the list; only the seed records ln-1001 to ln-1006 are shown. Earlier today two approvals failed with "Action failed: EACCES: permission denied, open '/data/audit.log'" (13:27 and 14:52), which I did not escalate because creating worked.

Actions so far: officers stopped entering applications; the paper notes of the three applications are with me; nobody has run data:reset; Lukas is checking /data on the host.

Next update 17:53 at the latest.

Eva Horakova
Operations Lead, CZ-PRG-01

---

**From:** Eva Horakova <eva.horakova@example.com>
**To:** Hana Vesela <hana.vesela@example.com>
**Cc:** Jana Novakova <jana.novakova@example.com>; Martin Kral <martin.kral@example.com>
**Date:** Wednesday 2026-10-07 16:35
**Subject:** INC-20261007-01: three applications lost and re-entered (POL-070)

Hana,

informing you the same day per OPS-040 step 6 and POL-070: three loan applications created today between 13:10 and 15:35 at CZ-PRG-01 were lost when the Tredgate Loan container was restarted at 15:42. The system had started at 13:00 with persistence disabled (data folder not writable by the container user) and kept the applications in memory only. Two approvals recorded on paper for those applications had failed in the system with a permission error.

No data left the system and no applicant data appears in the logs of this incident. The three applications will be re-entered from the officers' paper notes once Platform Engineering confirms the fix, and they will receive new application ids; the Decision Register will reference both the paper note and the new id.

Eva Horakova
Operations Lead, CZ-PRG-01

---

**From:** Eva Horakova <eva.horakova@example.com>
**To:** Martin Kral <martin.kral@example.com>
**Cc:** Jana Novakova <jana.novakova@example.com>; Hana Vesela <hana.vesela@example.com>; Lukas Benes <lukas.benes@example.com>; Tomas Dvorak <tomas.dvorak@example.com>
**Date:** Wednesday 2026-10-07 17:05
**Subject:** INCIDENT RESOLVED INC-20261007-01 S2 CZ-PRG-01

Martin,

INC-20261007-01 is resolved as of 17:00. The data folder ownership was corrected and the container recreated at 16:40 without the "persistence disabled" warning; the three applications were re-entered from paper notes (16:43 to 16:47) and the two approvals recorded (16:50, 16:52). The tile shows 12, which equals the shift log.

Timeline for the ticket: 13:00 hardened 1.2.0 deployed; 13:25 and 14:50 approvals failed with a permission error; 15:42 container recreated for a memory limit change; 15:50 tile drop noticed; 15:53 declared; 16:05 on-call responded; 16:25 cause confirmed; 16:40 fix applied; 17:00 resolved.

Jana will write the postmortem by Tuesday 2026-10-14 per OPS-040; Known Issue entry KI-006. I will add "check the boot log for persistence disabled" to the release checklist proposal.

Eva Horakova
Operations Lead, CZ-PRG-01
