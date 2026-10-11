# E-mails related to INC-20261005-01

All times CEST (UTC+2). Addresses are the internal `@example.com` mailboxes.

---

**From:** Eva Horakova <eva.horakova@example.com>
**To:** Jana Novakova <jana.novakova@example.com>
**Cc:** Martin Kral <martin.kral@example.com>
**Date:** Monday 2026-10-05 09:19
**Subject:** INCIDENT DECLARED INC-20261005-01 S2 CZ-PRG-01: 502 errors in Tredgate Loan after the 1.2.0 pilot release

Jana,

declaring INC-20261005-01, severity S2, branch CZ-PRG-01, start 09:17 local (my confirmation).

Impact: the installment preview and sometimes the application list fail with "Request failed with status 502"; a reload fixes it for a while. One officer reports a failed approval. Health check answers ok with version 1.2.0 but uptimeSeconds was 241 at 09:17, so the API restarted around 09:13.

The 1.2.0 release went to the pilot host at 08:30 (Lukas, shift log). Nothing else changed today.

Actions so far: officers told to reload and to use the installment column of the table; no data file action taken. I am calling you as well.

Next update 11:19 at the latest, per the S2 schedule.

Eva Horakova
Operations Lead, CZ-PRG-01

---

**From:** Martin Kral <martin.kral@example.com>
**To:** Jana Novakova <jana.novakova@example.com>; Eva Horakova <eva.horakova@example.com>
**Date:** Monday 2026-10-05 09:45
**Subject:** RE: INCIDENT DECLARED INC-20261005-01 S2: ETA?

Jana, Eva,

the branch manager of CZ-PRG-01 called me. Can you give me an ETA or at least the current hypothesis by 10:15? If the pilot cannot be stabilised quickly I prefer a rollback to 1.1.0 over a hot fix during business hours (OPS-050).

Martin Kral
Platform Engineering Lead

---

**From:** Jana Novakova <jana.novakova@example.com>
**To:** Hana Vesela <hana.vesela@example.com>
**Cc:** Martin Kral <martin.kral@example.com>; Eva Horakova <eva.horakova@example.com>
**Date:** Monday 2026-10-05 10:10
**Subject:** INC-20261005-01: applicant names in the Tredgate Loan log (POL-070)

Hana,

while investigating INC-20261005-01 on the CZ-PRG-01 pilot host I found that release 1.2.0 writes a log line `installment cache miss` for every installment calculation, and that this line contains the full request body including `applicantName`. The lines exist from the release at 08:30 until the rollback that is being prepared now. The log is the container log on the pilot host plus the export I took at 09:25 for the investigation; it has not been sent anywhere else.

I am informing you the same day per OPS-040 step 6 and POL-070. I will provide the number of distinct applicants concerned once I have counted them from the log, and the lines will be redacted in anything I share. The permanent fix (no request body in the log, message added to the OPS-060 catalog) will go through the data and logging review of OPS-050.

Jana Novakova
Platform Engineer, on-call

---

**From:** Eva Horakova <eva.horakova@example.com>
**To:** CZ-PRG-01 Loan Officers <cz-prg-01-officers@example.com>
**Cc:** Martin Kral <martin.kral@example.com>; Jana Novakova <jana.novakova@example.com>; Hana Vesela <hana.vesela@example.com>
**Date:** Monday 2026-10-05 11:30
**Subject:** INCIDENT RESOLVED INC-20261005-01 S2 CZ-PRG-01

All,

INC-20261005-01 is resolved as of 11:30. Tredgate Loan has run without errors since the rollback to version 1.1.0 at 10:20.

What happened: the 1.2.0 pilot release had a defect that made the API run out of memory and restart every few minutes between 09:12 and 10:20; each restart caused about half a minute of "Request failed with status 502" errors. No data was lost: the Total Applications tile shows 12, which matches the shift log plus the three applications entered after 10:20.

The installment preview in the form is gone again with 1.1.0; use the Monthly Payment column of the table as before.

A postmortem will follow within 5 business days. Thank you for reporting quickly and for keeping paper notes.

Eva Horakova
Operations Lead, CZ-PRG-01

---

**From:** Martin Kral <martin.kral@example.com>
**To:** Jana Novakova <jana.novakova@example.com>
**Cc:** Eva Horakova <eva.horakova@example.com>; Hana Vesela <hana.vesela@example.com>; Tomas Dvorak <tomas.dvorak@example.com>; Lukas Benes <lukas.benes@example.com>
**Date:** Monday 2026-10-05 11:45
**Subject:** INC-20261005-01: postmortem by Monday 2026-10-12

Jana,

please write the postmortem for INC-20261005-01 per OPS-040 within 5 business days, that is by Monday 2026-10-12, using the eight-section template. Blameless: roles and actions, no names, no applicant data. Eva reviews it, Hana receives it with the count of applicants whose names appeared in the log.

Please cover explicitly: the time between the first kill (09:12) and the first report (09:16) and declaration (09:19), the two wrong hypotheses we spent time on (network, data file), why the release passed review with an uncatalogued log message, the missing restart policy and the watchdog, and the Known Issue entry (KI-005). Lukas can supply the release and rollback times from the shift log.

Thanks,
Martin Kral
Platform Engineering Lead
