# DevOps on Autopilot: Infrastructure & Incidents

Participant quick reference for the 4-hour course on branch `course/devops-autopilot`. You work with GitHub Copilot (VS Code agent mode and Copilot CLI) on a repository that is **broken on purpose**: release 1.2.0 of Tredgate Loan, its first container pilot, two recorded incidents and the tooling to investigate them. Everything is fictional. Everything runs on plain Node.js; Docker is optional.

## Setup (10 minutes)

Requirements: Node.js 22.19 or newer (`node --version`), npm, Git, VS Code with GitHub Copilot, optionally Copilot CLI (`npm install -g @github/copilot`).

```bash
git clone <repository url>
cd tredgate-loan
git checkout course/devops-autopilot
npm install
npm run setup          # creates .env from .env.example
npm run build          # type-checks everything and builds the UI
npm run test           # 60 tests, all green on the course branch
```

Start the app the normal way with `npm run dev` (UI on http://localhost:5173, API on 3000, handbook search on 3001). The new installment preview in the form is the 1.2.0 feature at the heart of incident 1.

## Scripts you will use

| Script | What it does | Typical use |
|---|---|---|
| `npm run ops:incident` | API under a restarting supervisor with a 96 MB heap and a `process metrics` line every 5 s, plus the handbook search | Reproduce the restart loop locally; Ctrl+C stops everything |
| `npm run ops:load` | 30 requests/s for 180 s (60 % calculator, 25 % loan reads, 15 % handbook search); live line every 10 s; exit 1 above 1 % errors, 500 ms p95 or when the API restarted | Run next to `ops:incident`; the API crashes after 60 to 120 s; after your fix it must pass |
| `npm run ops:verify` | Static checks OPS-001 to OPS-011 of `docker/*.Dockerfile`, `.dockerignore`, `compose.yaml`; `--path <dir>` for another folder | Before and after fixing the container files; also on `incident/INC-20261007-01/deploy` |
| `npm run logs -- --file <log> ...` | Cross-platform log reader: `--service`, `--level`, `--from`, `--to`, `--grep`, `--msg`, `--status`, `--redact`, `--count`, `--head`, `--line-numbers` | Investigate `incident/*/logs/combined.log` without pasting it anywhere |
| `npm run rag -- "question"` | Handbook search (also on http://localhost:3001 and as the `loan-handbook-search` skill) | Ask what OPS-040, OPS-060, POL-070 require |
| `npm run data:reset` | Seed data back, audit trail deleted | After experiments |
| `npm run incidents:generate` | Regenerates the incident logs from fixed seeds | Only if you broke them |

Every script prints its options with `--help`. They are TypeScript run with `tsx`; the same commands work in PowerShell and zsh.

## Folders

| Folder | Content |
|---|---|
| `server/`, `shared/`, `src/` | The app. Release 1.2.0 added `server/installmentCache.ts`, `server/auditLog.ts`, `server/memoryStore.ts`, `server/metrics.ts`, `server/persistence.ts` |
| `docker/`, `compose.yaml`, `.env.example` | The container pilot as deployed to branch CZ-PRG-01 |
| `ops/tools/` | The scripts above; `ops/legacy/deploy.sh` is the old bash deployment (read it, never run it); `ops/k8s/` a Kubernetes sketch to explain, never apply |
| `incident/INC-20261005-01/` | Monday 2026-10-05, "Loan API restart loop", S2: `logs/combined.log` (about 80,000 lines, UTC), `logs/metrics.csv`, `comms/` (chat export, e-mails, ticket; CEST) |
| `incident/INC-20261007-01/` | Wednesday 2026-10-07, "Lost applications after redeploy", S2: same structure plus `deploy/` with the files that caused it |
| `templates/` | Postmortem (OPS-040) and executive summary templates |
| `.github/agents/` | `pir-writer` and `ops-reviewer` custom agents; `.github/ops-review-checklist.md`; `.github/workflows/generate-pir.yml` |
| `docs/handbook/` | The operations handbook: OPS-040 incidents, OPS-050 releases, OPS-060 logging, POL-070 data handling, RB-00x runbooks, REF-0x0 reference |

## Incident ids and the story in one line each

- **INC-20261005-01** (S2): 1.2.0 goes live at 08:30 CEST; from 09:12 the API is killed by its memory limit about every 8 minutes and restarted by a watchdog; rollback to 1.1.0 at 10:20; resolved 11:30. Red herrings: gateway `upstream timed out` lines (present before the release) and a "data file, KI-001 again?" theory.
- **INC-20261007-01** (S2): a hardened container configuration runs as a non-root user on a root-owned data folder; the API starts with `persistence disabled`, keeps the day's applications in memory, decisions fail with 500 `EACCES`, and a 15:42 restart loses three applications.

Logs are UTC (`Z`), chat, e-mails and tickets are CEST (UTC+2). The mismatch is intentional.

## What you will do

1. Reproduce incident 1 locally (`ops:incident` + `ops:load`), find the leaking cache, fix it (eviction, TTL, key without `requestedAt` and `applicantName`, no request body in the log) and prove it with the load test and the handbook (OPS-060 catalog, POL-070).
2. Analyse the recorded logs with `npm run logs` and write `incident/INC-20261005-01/analysis.md` with line numbers as evidence; then let `pir-writer` turn it into a postmortem and an executive summary.
3. Review and fix the container files until `npm run ops:verify` passes; read `ops/legacy/deploy.sh` and `ops/k8s/loan-api.yaml` with Copilot and list what is wrong; find the leaked configuration in git history (`git log -p -- .env`).
4. Do the same for incident 2, including the `deploy/` snapshot, and file Known Issue entries KI-005 and KI-006 as OPS-040 requires.
5. Extend `.github/copilot-instructions.md` with an "Operations work" section so Copilot follows the handbook rules by itself.

The handbook rule to remember: **a change in code, API or logging must update the matching handbook document** in the same pull request.
