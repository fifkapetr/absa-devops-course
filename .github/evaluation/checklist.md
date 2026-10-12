---
id: EVAL-CHECKLIST
title: PR evaluation checklist
section: Evaluation
updated: 2026-10-12
---

# PR evaluation checklist

Every item in this table is checked against a pull request when its "applies when" condition is met. Applicability is decided by code in `ops/tools/lib/pr-eval.ts` from the changed-file list and the diff content; the model never decides applicability.

The score counts only PASS and FAIL verdicts. NOT VERIFIABLE items are listed separately and excluded from the score.

| id | criterion | applies when | verified by |
|---|---|---|---|
| C-01 | Lint, tests and build pass | always | workflow results |
| C-02 | `verify.ts` reports 0 FAIL | `docker/**`, `compose.yaml` or `.dockerignore` changed | workflow results |
| C-03 | No secrets committed: no `.env` file, no literal token or password value in the diff | always | diff |
| C-04 | No applicant personal data (`applicantName`, e-mail address, real loan id) in code, logs, fixtures or docs (OPS-060, POL-070) | always | diff |
| C-05 | A change in code, API or logging updates the matching handbook document in the same PR | `server/**`, `shared/**` or `rag/**` changed | diff |
| C-06 | One concern per change: every changed file serves the stated summary or the acceptance criteria | always | diff and PR description |
| C-07 | New or changed log messages use only the eleven fixed message texts in the OPS-060 catalog | a `req.log.` call was added or changed in the diff | diff and OPS-060 |
| C-08 | No new dependency added without a reason stated in the PR description | `package.json` changed | diff |
| C-09 | Incident documents cite a source for every fact (no unsourced timeline rows or numbers) | `incident/**/postmortem.md` or `incident/**/exec-summary.md` changed | the document |
