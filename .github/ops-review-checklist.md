# Operations review checklist (container pilot)

Used by the `ops-reviewer` agent and by human reviewers of `docker/**`, `compose.yaml`, `ops/**` and `incident/*/deploy/**`. The first part is what `npm run ops:verify` checks automatically; the second part is what a script cannot judge and a reviewer must.

## Part 1: automated rules (npm run ops:verify)

| ID | Rule | Why |
|---|---|---|
| OPS-001 | `FROM` and compose `image:` pin a version tag, never `latest` or no tag (FAIL); a digest is recommended (WARN without one) | Rebuilds must be reproducible; a rollback to "what ran yesterday" needs a known image |
| OPS-002 | The runtime stage has a non-root `USER` | A container breakout or a code defect as root owns the host's bind mounts and sockets |
| OPS-003 | No `ENV` or `ARG` named like `TOKEN`, `SECRET`, `PASSWORD`, `KEY` with a literal value | Image layers are shared and cached; a secret in a layer is public to anyone with the image |
| OPS-004 | `.dockerignore` exists and excludes `.env`, `.git`, `node_modules` | `COPY . .` otherwise ships local secrets, the full history and platform-specific binaries |
| OPS-005 | `loan-api` and `docs-search` have a healthcheck (Dockerfile or compose); `loan-api` checks `/api/loans` or `/api/health` | Restart policies and `depends_on` conditions only work with a healthcheck; `/api/health` never reads the data file (REF-010), so a deep check prefers `/api/loans` |
| OPS-006 | Only `gateway` publishes ports | The API has no authentication (REF-010); `0.0.0.0:3001` exposes the handbook admin route to the network |
| OPS-007 | No `privileged: true` | Equivalent to root on the host |
| OPS-008 | No `/var/run/docker.sock` mount | Control of the Docker daemon is control of the host |
| OPS-009 | No literal secret values in compose `environment`; use `${VAR}` from `.env` or `env_file` | Compose files are committed; `.env` is not |
| OPS-010 | A `restart` policy on every service | Without one a killed container stays dead (INC-20261005-01 only survived thanks to a cron watchdog) |
| OPS-011 | Data path writable by the runtime user: with a non-root `USER` the image creates and `chown`s the data folder and compose uses a named volume, not a root-owned bind mount | A root-owned bind mount makes 1.2.0 start with `persistence disabled` and lose data at the next restart (INC-20261007-01). Heuristic: the rule looks for `mkdir` + `chown` of the data path in the runtime stage and for a declared named volume |

## Part 2: what a reviewer must judge

- **Blast radius.** What else breaks if this container misbehaves? Memory limits, CPU limits, what shares the host, what the gateway does when an upstream is down (502 page vs. cached UI).
- **Rollback path to the previous version.** Is the previous image still on the host or in a registry? Does the data file format change (OPS-050: data rollback needed)? Who runs the rollback and how long does it take?
- **Data persistence and ownership.** Where does `/data` live, who owns it, what happens on `docker compose down -v`, is it in the backup (POL-070 retention)? Does the start-up log contain `persistence disabled`?
- **Secrets in git history and logs.** `git log -p -- .env`; tokens in URLs (`?token=` in the gateway access log); passwords in scripts (`ops/legacy/deploy.sh`).
- **Personal data in logs (OPS-060, POL-070).** Does any new log line carry a request body, `applicantName` or an e-mail address? Is every `msg` in the OPS-060 catalog?
- **Least privilege.** Which user, which capabilities, which mounts, which ports; does the gateway need `server_tokens on`; does the admin route need to be reachable from the network at all?
- **Resource limits.** Is `mem_limit` justified by a measurement (process metrics) or a guess? What happens at the limit: a restart loop or a clean failure?
- **Observability.** Are container events, gateway logs and application logs collected together with one time zone? Can the on-call engineer answer "how many restarts since 08:30" in one command?
- **Documentation.** Does the handbook describe the change (REF-030, REF-040, OPS-060) in the same pull request?

## Output format for reviews

```
| severity | file:line | finding | fix |
|---|---|---|---|
| high | compose.yaml:18 | loan-api runs privileged (OPS-007) | remove `privileged: true` |

APPROVE / REQUEST CHANGES
```

Severity: **high** = exploitable or data-losing (OPS-002, 003, 006, 007, 008, 009, 011, secrets in history); **medium** = availability or reproducibility (OPS-001 FAIL, 005, 010, missing limits); **low** = hygiene (OPS-001 WARN, 004 for build size, wording).
