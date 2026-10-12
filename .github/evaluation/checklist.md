# Pull request checklist

The `pr-evaluator` agent checks every pull request against the items below whose "Applies when" matches the changed files, in addition to the acceptance criteria in the pull request and its linked issues. Edit this list to change what every pull request is checked against.

| Id | Check | Applies when |
|---|---|---|
| C-01 | `npm run lint` and `npm run test` pass | always |
| C-02 | `npx tsx ops/tools/verify.ts` reports 0 FAIL | `docker/**`, `compose.yaml` or `.dockerignore` changed |
| C-03 | No secrets: no `.env` file, no literal token or password values | always |
| C-04 | No applicant personal data in code, test data, logs or documents (OPS-060, POL-070) | always |
| C-05 | A change in code, API or logging updates the matching handbook document | `server/**`, `shared/**` or `rag/**` changed |
| C-06 | One concern per change: every changed file serves the summary of the pull request | always |
| C-07 | New or changed log messages are in the OPS-060 message catalog | a logger call was added or changed |
| C-08 | A new dependency is explained in the pull request description | `package.json` changed |
