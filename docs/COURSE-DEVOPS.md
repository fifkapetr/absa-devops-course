# DevOps on Autopilot: Infrastructure & Incidents

Participant quick reference for the 4-hour course on branch `course/devops-autopilot`. You work with GitHub Copilot (VS Code agent mode and Copilot CLI) on a repository that is **broken on purpose**: release 1.2.0 of Tredgate Loan, its first container pilot, two recorded incidents and the tooling to investigate them. Everything is fictional. Everything runs on plain Node.js; Docker is optional.

All commands below work in Windows PowerShell 5.1, PowerShell 7 and zsh. Where a command differs per shell, both forms are given.

## Setup (10 minutes)

Requirements: Node.js 22.19 or newer (`node --version`), npm, Git, VS Code with GitHub Copilot, optionally Copilot CLI (`npm install -g @github/copilot`).

```
git clone <repository url>
cd tredgate-loan
git checkout course/devops-autopilot
npm install
npm run setup
npm run build
npm run test
```

`npm run setup` creates `.env` from `.env.example`; `npm run build` type-checks everything and builds the UI; `npm run test` runs 62 tests, all green on the course branch. Start the app the normal way with `npm run dev` (UI on http://localhost:5173, API on 3000, handbook search on 3001).

A quick HTTP check of the API:

```
curl.exe http://localhost:3000/api/health          # Windows (curl without .exe is a PowerShell alias)
curl http://localhost:3000/api/health              # macOS
Invoke-RestMethod http://localhost:3000/api/health # PowerShell alternative
```

## Tools

The operations tools live in `ops/tools/` and are TypeScript run with `tsx`. Call them directly with `npx tsx`; this form needs no `--` separator and behaves the same in every shell. The `npm run` aliases (`npm run logs -- --file ...`, `npm run ops:verify -- --path ...`) are equivalent. Every tool prints its options with `--help`.

| Tool | Direct form | What it does |
|---|---|---|
| Log reader | `npx tsx ops/tools/logs.ts --file <log> [options]` | Streams a log file of any size and prints the lines that match the filters. Options: `--service`, `--level` (30/40/50 or info/warn/error), `--from` / `--to` (ISO UTC), `--grep <regex>` (repeat for OR), `--msg`, `--status` (e.g. 502 or 5xx), `--redact`, `--count`, `--head N`, `--tail N`, `--line-numbers` |
| Infrastructure checks | `npx tsx ops/tools/verify.ts [--path <dir>]` | Static rules OPS-001 to OPS-011 for `docker/*.Dockerfile`, `.dockerignore` and `compose.yaml`; one PASS/WARN/FAIL line per rule, exit 1 on any FAIL |
| Incident supervisor | `npx tsx ops/tools/incident.ts [--heap MB] [--port N] [--data-file <path>] [--log-file <path>]` | Runs the API the way the pilot host does (restarting supervisor, 96 MB heap, metrics every 5 s) plus the handbook search on 3001. Ctrl+C stops everything |
| Load generator | `npx tsx ops/tools/load.ts [--duration s] [--rps n] [--target url]` | Realistic traffic for 180 s at 30 req/s; live line every 10 s; summary with p50/p95/p99; the last line is `RESULT: PASS` or `RESULT: FAIL (<reasons>)`, exit 1 on FAIL |
| Handbook search | `npx tsx rag/cli.ts "<question>" --k 5` | The handbook sections that answer a question (also as the `loan-handbook-search` skill and on http://localhost:3001) |
| Data reset | `npm run data:reset` | Seed data back, audit trail deleted |
| Setup | `npm run setup` | `.env` from `.env.example` |

One neutral example per tool:

```
npx tsx ops/tools/logs.ts --file incident/INC-20261005-01/logs/combined.log --count
npx tsx ops/tools/logs.ts --file incident/INC-20261005-01/logs/combined.log --service gateway --status 5xx --tail 5 --line-numbers
npx tsx ops/tools/verify.ts --path incident/INC-20261007-01/deploy
npx tsx ops/tools/incident.ts --heap 96
npx tsx ops/tools/load.ts --duration 60
npx tsx rag/cli.ts "What does OPS-040 require after an S2 incident?" --k 3
```

Environment variables of the app (`PORT`, `DATA_FILE`, `AUDIT_FILE`, `LOG_FILE`, `LOG_LEVEL`, `METRICS_INTERVAL_MS`, REF-030) are set per shell when you need them for `npm run dev`:

```
$env:LOG_LEVEL = "info"; npm run dev        # PowerShell
LOG_LEVEL=info npm run dev                  # zsh
```

With the supervisor you do not need them: `--port`, `--data-file`, `--log-file` and `--heap` are flags.

## Folders

| Folder | Content |
|---|---|
| `server/`, `shared/`, `src/` | The app. Release 1.2.0 added the installment calculator, the decision audit trail, process metrics and an in-memory fallback store (changelog 1.2.0) |
| `docker/`, `compose.yaml`, `.env.example` | The container pilot as deployed to branch CZ-PRG-01 |
| `ops/tools/` | The tools above; `ops/legacy/deploy.sh` is the old bash deployment (read it, never run it); `ops/k8s/` is a Kubernetes sketch to explain, never apply |
| `incident/INC-20261005-01/` | Monday 2026-10-05, "Loan API restart loop", S2: `logs/combined.log` (about 80,000 lines, UTC), `logs/metrics.csv`, `comms/` (chat export, e-mails, ticket; CEST) |
| `incident/INC-20261007-01/` | Wednesday 2026-10-07, "Lost applications after redeploy", S2: same structure plus `deploy/` with the files that were deployed that day |
| `templates/` | Postmortem (OPS-040) and executive summary templates |
| `.github/agents/` | `pir-writer`, `ops-reviewer` and `pr-evaluator` custom agents; `.github/ops-review-checklist.md`; `.github/evaluation/checklist.md`; `.github/workflows/generate-pir.yml`, `.github/workflows/evaluate-pr.yml` |
| `docs/handbook/` | The operations handbook: OPS-040 incidents, OPS-050 releases, OPS-060 logging, POL-070 data handling, RB-00x runbooks, REF-0x0 reference. It describes Linux branch workstations, so its own shell commands are not PowerShell-safe; use the tools above instead |

## The two incidents

- **INC-20261005-01** (S2): 1.2.0 goes live on the pilot at 08:30 CEST. From 09:12 officers see "Request failed with status 502" in bursts; the Operations Lead declares at 09:19; the release is rolled back to 1.1.0 at 10:20; resolved 11:30. Your job: find out from the evidence what happened and why.
- **INC-20261007-01** (S2): a reworked container configuration is deployed at 13:00 CEST. During the afternoon two approvals fail with a 500; at 15:42 the container is restarted for a configuration change and the Total Applications tile drops from 9 to 6; declared 15:53, resolved 17:00. The files that were deployed are in `deploy/`.

Logs are UTC (`Z`), chat, e-mails and tickets are CEST (UTC+2). The mismatch is intentional. Every number you put in a postmortem must come from a source you can name.

## Working rules

- Never paste `combined.log` into a chat; it is too large and it contains personal data. Use the log reader with `--redact` when quoting.
- A change in code, API or logging must update the matching handbook document (OPS-050).
- Every S1/S2 incident ends with a Known Issue entry (`docs/handbook/known-issues/README.md`) and a postmortem (`templates/`).

## PR evaluator (bonus chapter)

The `pr-evaluator` agent checks a pull request against explicit acceptance criteria and posts one scored comment. It is advisory: it never blocks a merge; a human still approves.

**Where criteria come from (in order):**
1. The `## Acceptance criteria` section of the PR description.
2. The `## Acceptance criteria` section of issues linked with `Closes #N`, `Fixes #N` or `Resolves #N`.
3. Applicable items from `.github/evaluation/checklist.md` (C-01 to C-09).

If the PR description has no `## Acceptance criteria` section, the PR-specific part is `NOT EVALUABLE`. The agent never invents criteria.

**Workflow:** `.github/workflows/evaluate-pr.yml` ("Evaluate pull request (AI)"). It runs on every non-draft pull request. Re-run on demand with `workflow_dispatch` and the PR number. The model defaults to `gpt-4o-mini`; set the repository variable `PR_EVAL_MODEL` to override without editing the workflow.

**Local run (both shells):**

```
# 1. Build the context folder
npx tsx ops/tools/pr-context.ts --base origin/course/devops-autopilot --criteria my-criteria.md

# 2a. Run the agent (Copilot CLI)
copilot --agent pr-evaluator -p "Evaluate .pr-eval" --allow-tool "write, shell(npx tsx rag/cli.ts:*)" --no-ask-user -s

# 2b. Or: open VS Code, select the pr-evaluator agent, type: Evaluate .pr-eval

# 3. Compute the score and open the comment
npx tsx ops/tools/pr-score.ts
```

The comment file is `.pr-eval/comment.md`. Open it in VS Code to read the result.

| Tool | Direct form | What it does |
|---|---|---|
| Context builder | `npx tsx ops/tools/pr-context.ts [options]` | Builds `.pr-eval/`: criteria, diff, check results, untrusted text. `--help` for options |
| Score calculator | `npx tsx ops/tools/pr-score.ts` | Reads `.pr-eval/result.json`, validates it, writes `.pr-eval/comment.md` |
