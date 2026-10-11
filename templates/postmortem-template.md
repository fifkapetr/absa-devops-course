<!--
Blameless postmortem rules (OPS-040):
- Name roles and actions, never individuals. Write "the Platform Engineer on-call rolled back", not a person's name.
- No applicant personal data. Identify applications by loanId only; count applicants, never list names.
- Every timeline entry and every number cites its source: [chat 09:36], [email 2], [ticket], [metrics 07:12Z], [analysis], [OPS-040].
- Facts that are not in the sources are written as "TBD - not in sources", never guessed.
- All times in CEST (UTC+2); say so once at the top. Logs are in UTC: convert them.
-->

# Postmortem INC-<YYYYMMDD>-<nn>

| | |
|---|---|
| Severity | S_ |
| Branch | |
| Incident window (CEST) | detected __:__, declared __:__, resolved __:__ |
| Author role | Platform Engineer on-call |
| Reviewer role | Operations Lead |
| Distribution | Compliance Officer, Platform Engineering Lead |

All times in this document are CEST (UTC+2). Log timestamps (UTC) have been converted.

## 1. Summary

One paragraph: what the branch experienced, for how long, and what ended it. Written for someone who was not there.

## 2. Timeline

Detected, declared, on-call responded, cause found, fix applied, resolved, verified. One row per event, every row with a source.

| Time (CEST) | Event | Source |
|---|---|---|
| | | |

## 3. Impact

Downtime minutes in business hours; applications delayed (loanIds); decisions failed; data lost or restored; SLA breaches (OPS-020); personal data exposure (POL-070). Numbers come from the log analysis or the metrics and say where they come from.

## 4. Log signature

The exact `msg`, `level` and `err.message` lines that identify this failure, with `reqId` where there is one, quoted from the analysis (names redacted). This is what the next engineer searches for.

## 5. Root cause

The underlying reason, not the symptom. Name the file, function or configuration line that was wrong and why the system behaved as it did.

## 6. Fix

What restored service (runbook used, rollback or configuration change) and what corrects the cause permanently (pull request, OPS-050 category and approvals needed).

## 7. Prevention

Checklist, runbook, verification or validation changes that stop a repeat. Each item has an owner role and a due date.

| Action | Owner role | Due | Ticket |
|---|---|---|---|
| | | | |

## 8. Known Issue

KI number filed (template in `docs/handbook/known-issues/README.md`), status of the pull request that files it.
