# Recorded incidents

Evidence of two incidents at the container pilot of branch CZ-PRG-01, kept for postmortem work. Everything here is fictional training material: people, applicants, hosts and tokens are invented.

| Folder | Incident | Severity | Story |
|---|---|---|---|
| `INC-20261005-01/` | Loan API restart loop | S2 | Monday 2026-10-05: release 1.2.0 goes to the pilot at 08:30 CEST; from 09:12 the API container is killed by its memory limit about every eight minutes and restarted by a watchdog; rollback to 1.1.0 at 10:20. |
| `INC-20261007-01/` | Lost applications after redeploy | S2 | Wednesday 2026-10-07: a hardened container configuration runs as a non-root user on a root-owned data folder; the API starts with persistence disabled, keeps the day's applications in memory and loses them at a 15:42 restart. |

## What each folder contains

| Path | Content | Time zone |
|---|---|---|
| `logs/combined.log` | Export of the pilot host: `docker compose logs --no-color` of `gateway`, `loan-api` and `docs-search` merged with `docker events`, one `service \| line` per row. Gateway lines are nginx access (combined format) and error lines, loan-api lines are pino JSON (OPS-060), docs-search lines are plain text with the collector's timestamp, docker lines are container events. | **UTC** (`Z`, `+0000`) |
| `logs/metrics.csv` | Host monitoring, one row per minute and service: `timestamp_utc,service,cpu_pct,mem_mb,restarts` | **UTC** |
| `comms/teams-war-room.md` | Export of the branch operations channel | **CEST (UTC+2)** |
| `comms/emails.md` | The e-mails sent during the incident | **CEST (UTC+2)** |
| `comms/ticket.json` | The incident log entry (OPS-040) with timestamps, roles and work notes | **CEST, with `+02:00` offset** |
| `deploy/` (INC-20261007-01 only) | The Dockerfiles, compose file and `.dockerignore` that were deployed and caused the incident | |

The log files are large on purpose (the first one has about 80,000 lines). Read them with `npm run logs -- --file incident/<id>/logs/combined.log ...` (filters, counts, redaction; see `--help`), not by pasting them into a chat.

The logs contain applicant names (a defect of release 1.2.0, see OPS-060 and POL-070). Use `--redact` when quoting lines anywhere.

## Regenerating the logs

`npm run incidents:generate` rewrites `logs/combined.log` and `logs/metrics.csv` of both incidents from fixed seeds (`ops/tools/generate-incidents.ts`); the output is byte-for-byte identical on every platform. The chat exports, e-mails and tickets are written by hand and are consistent with the generated numbers.
