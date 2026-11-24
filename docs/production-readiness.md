# Production readiness findings

> **Status (2026-11-24): this is the assessment that phase 4 was written against.** The blockers below have been addressed on a Linux host with gVisor; this file is kept as the original finding, not the current state. The current state is in [plan-phase-4.md](plan-phase-4.md).
>
> | Blocker | Now |
> | --- | --- |
> | 1 Docker socket in the gateway | Removed: only `sandbox-runner` mounts it |
> | 2 Shared host kernel | gVisor (`runsc`) via `SANDBOX_RUNTIME`; no microVM, no escape review |
> | 3 No network isolation or egress policy | Per-user internal networks, egress proxy, admin API on a unix socket |
> | 4 No disk or wall-clock limits | `MAX_DISK_MB` (checked, not enforced) and `MAX_RUN_SECONDS` |
> | 5 No cap on running sandboxes | `MAX_RUNNING_SANDBOXES` with idle eviction |
> | 6 Open signup | Invite codes, global daily token budget; no email verification |
> | 7 Permission preset not locked down | `workspace-write` plus `ask`, no `danger-full-access` preset; confined shell |
> | Reliability: no backups, unpinned image, no audit log, no CI | `scripts/backup.sh`, pinned images and harness lock, audit log, CI workflow (not yet run on GitHub) |
> | Still open | single instance, in-memory rate limits, password reset, monitoring, TLS and domain config, HA |

Assessment of why the current deepseek-harness deployment (`dsh-cloud`, phases 1-3) is not ready for untrusted public users. Based on reading the docs, gateway and llm-proxy source, the compose file and the sandbox image. Nothing was run, and `llm-proxy/src/server.js` was only skimmed.

## Upstream harness

`SAFETY.md` in deepseek-harness states it has "not undergone a security audit and must not be treated as secure or production-ready." It also says not to rely on it "as the sole security control for untrusted workloads."

The web profile is a single-owner appliance: one launch token, one owner, one `$DSH_HOME`. The plan chose one container per user instead of making it multi-tenant, so all isolation comes from the Docker setup, not from the harness.

## Blockers for untrusted public users

These are the issues phase 4 (hardening) is meant to cover.

1. **The gateway mounts `/var/run/docker.sock`.** That is root on the host; a compromised gateway means a compromised host (`infra/docker-compose.gateway.yml`).
2. **Sandboxes use plain Docker (runc) and share the host kernel.** They drop capabilities and set `no-new-privileges`, with memory, CPU and pid limits (`gateway/src/sandbox.js`, `spec()`). The plan called for gVisor, Kata or Firecracker. A kernel escape from model-generated code is the main risk.
3. **There is no network isolation or egress policy.**
   - Every sandbox and every service sits on one bridge network, `dsh-sandboxes`.
   - Sandboxes can reach each other, the gateway, the llm-proxy admin route (protected only by the shared secret) and the cloud metadata endpoint. They can also reach the open internet.
   - The plan's own check, "web fetch tool against internal addresses", would fail today.
   - Open egress also allows scanning, spam and being used as an attack platform.
4. **There are no disk or wall-clock limits.** The volumes have no quota, so one user can fill the host disk. The container spec has no limit on how long a process can run.
5. **There is no cap on how many sandboxes run at once.** Each user gets up to 1 GB and 1 CPU, and nothing limits the total. Enough signups or concurrent users will exhaust the host.
6. **Anyone can sign up with no email verification.**
   - Quotas are per account (500k tokens a day, 5M a month), so a user can multiply their allowance by creating accounts.
   - The only signup control is a limit of 10 per hour per IP.
   - This is a direct cost-abuse path against the provider key.
7. **The agent's permission preset isn't locked down.** The plan said to ship `workspace-write` + `ask` and hide `danger-full-access` and the directory picker. `sandbox/entrypoint.sh` only patches the UI settings and the model; no permission restriction was found. This matters less inside the container, but it combines with open egress.

## Reliability and operations

- **Everything is a single instance.** One gateway, one proxy, SQLite files, and state held in Docker containers and volumes. No HA, no horizontal scaling.
- **Rate limits live in memory.** The gateway's login, signup and feedback limiters and the proxy's per-user limits reset on every restart.
- **There are no backups.** User data, `$DSH_HOME` and workspaces sit in named volumes. Nothing backs up the SQLite databases (accounts, usage ledger) or the volumes.
- **The quota can be overshot.** The proxy only learns usage after a call finishes, so a user can exceed it by up to `MAX_CONCURRENT x MAX_OUTPUT_TOKENS` (acknowledged in `llm-proxy/README.md`).
- **A gateway restart drops all WebSockets.** It also loses cached cookies and idle timers, though it recovers from container state.
- **Startup depends on scraping `docker logs`.** The gateway reads the launch token from the sandbox's log output (`gateway/src/sandbox.js`, `#start()`), which is fragile.
- **The sandbox image isn't reproducible.** It is built from a local, unpinned checkout of deepseek-harness copied into `.harness-dist/` (`sandbox/Dockerfile`). Nothing pins or tracks the harness version.

## Product and compliance gaps

- **Account basics are missing:** password reset, email verification, account deletion, data retention policy and an admin UI.
- **There is no audit logging.** The proxy logs each call as a JSON line, but nothing records who did what in the gateway or sandbox.
- **There is no monitoring or alerting, and no CI.** Tests exist under `tests/`, but there is no pipeline.
- **Deployment config is hardcoded for local use:** `PUBLIC_URL: https://localhost/` and a `tls internal` Caddy certificate (`infra/Caddyfile.gateway`). Secrets are managed only through `.env`.

## What is already solid

- **Provider key:** it never enters the gateway or a sandbox.
- **Metering:** the llm-proxy meters per user with quotas, hashed tokens and constant-time admin auth.
- **Passwords and sessions:** scrypt password hashing, HttpOnly session cookies, and an Origin check on POSTs and WebSocket upgrades.
- **Sandbox credentials:** the sandbox's own auth cookie never reaches the browser.

## Suggested order

1. Replace the Docker socket with a socket proxy or an orchestrator API.
2. Switch to gVisor or Kata.
3. Add a per-sandbox network policy: egress blocked by default, only the llm-proxy allowed.
4. Add disk quotas and a cap on running sandboxes.
5. Add email verification or invite-only signup.
6. Add backups.

For a closed beta with invited users, items 3-6 are the minimum and 1-2 can follow. For fully public signup, all of them are needed.
