# dsh-cloud

Multi-user hosting for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`).
Each user gets a disposable sandbox running `dsh --profile web`. A gateway handles login and routing,
and an LLM proxy holds the real API key and meters usage.

The harness is built from a local checkout of deepseek-harness (default `../deepseek-harness`) into the sandbox image and pinned by `sandbox/harness.lock`. See [docs/plan.md](docs/plan.md).

| Dir | Purpose |
| --- | --- |
| `gateway/` | Auth, invite-only signup, user to sandbox mapping, limits, audit log, reverse proxy (HTTP + WebSocket) |
| `runner/` | `sandbox-runner`: the only service with the Docker socket; builds the hardened container spec and per-user networks |
| `llm-proxy/` | Holds the real provider key, per-user tokens, metering, quotas, global daily budget |
| `egress-proxy/` | The only way out of a user network: public destinations only, logged |
| `sandbox/` | Image with the locked harness, bubblewrap and the locked-down policy patch (`entrypoint.sh`) |
| `infra/` | Compose files and Caddy config |
| `scripts/` | restart, backup and restore, invites, audit, usage, harness build and lock, image pins, Lima VM setup |
| `tests/` | unit suites and the Docker acceptance suites (phase 1 to 4) |
| `docs/` | plans, design notes and research; start with [docs/plan.md](docs/plan.md) and [docs/plan-phase-4.md](docs/plan-phase-4.md) |

## Status

- Phase 1 (done): sandbox container behind Caddy TLS, WebSocket and cookies verified.
- Phase 2 (done): gateway with login, per-user sandbox containers and volumes, idle-stop/resume.
- Phase 3 (done): `llm-proxy` holds the real key; sandboxes get a per-user token, usage is metered with daily/monthly quotas and rate limits.
- Phase 4 (done for a Linux host with gVisor): no Docker socket in the gateway (`runner/`), gVisor sandboxes with a read-only root and one internal network each, an egress proxy, the llm-proxy admin API on a unix socket, capacity, run-time and disk limits, invite-only signup and a global token budget, an audit log, backups with a restore check, pinned images and harness, CI, and a locked-down agent policy with a working confined shell. See [docs/plan-phase-4.md](docs/plan-phase-4.md).
- Phase 5 (mostly done): clear states and limits, a usage panel, a welcome and curated UI, invite links, a crash watchdog and an admin panel (overview, users, invites, feedback, audit log, policies). See [docs/plan-phase-5.md](docs/plan-phase-5.md).
- Phase 6 (design only): the first users are cybersecurity professionals, which changes the toolbox, adds plugins, model privacy, conduct and egress accountability. See [docs/plan-phase-6.md](docs/plan-phase-6.md).

Run `tests/run.sh all` for regression tests (see [tests/README.md](tests/README.md)).

Working on this repository (people or agents): read [AGENTS.md](AGENTS.md) first. In short: a new topic branch for every change, tests written and run, findings saved in `docs/`, repeatable tasks turned into scripts.

## Running it

- **On a Mac, with gVisor:** `scripts/lima/setup.sh --stack` creates a Linux VM, installs gVisor and starts the stack with `SANDBOX_RUNTIME=runsc` ([docs/lima-setup.md](docs/lima-setup.md)). `scripts/lima/docker-context.sh` switches `docker` between Docker Desktop and the VM.
- **Plain Docker (runc):** copy `.env.example` to `.env`, fill in the secrets, build the harness (`scripts/build-harness.sh`), then `scripts/restart.sh`. The agent's shell tool needs gVisor; under runc it fails closed. `restart.sh` chooses the runtime itself (gVisor if the Docker daemon has it, else runc with a warning); `--runtime runsc|runc` forces one and `--print-runtime` shows the choice without changing anything.
- **Reading a private GitHub repository:** public repositories just clone; for a private one give git a read-only, single-repository, short-lived token with `dsh-git login` in the workspace terminal (never in the chat); see [docs/github-access.md](docs/github-access.md) for the steps and the risks.
- **Restricting web access:** `scripts/egress-scope.sh --set staging.example.org,*.api.example.org` limits the sandboxes' web access to those hosts plus what git, pip and the scanners need (`--clear` to undo); see [egress-proxy/README.md](egress-proxy/README.md).
- **Admin panel:** make an account an admin with `scripts/make-admin.sh you@example.com` (the account must exist), then open `/gw/admin` or use the Admin link in the workspace bar.
- **Signing up:** create invite links in the admin panel (Invites), or with `scripts/invite.sh create 3 --link` (bare codes without `--link`), or set `ALLOW_SIGNUP=true`. `scripts/invite.sh list` and `revoke ID` manage them from the shell.
- **Security:** a review of the whole code before a public deployment, with what was reproduced, what was only read, and the order to fix it in: [docs/security-review.md](docs/security-review.md).
- **Branding:** the service shows its own icon, not DeepSeek's; what changed (including the workspace's sidebar and home page, through a small plugin), what is still DeepSeek's (the animated "running" whale) and how to regenerate the icons are in [docs/branding.md](docs/branding.md).
- **Email:** password reset, emailed invites and a "workspace finished" notice, off until `MAIL_PROVIDER` is set; `scripts/mail-test.sh you@example.com` sends a test message ([docs/email.md](docs/email.md)).
- **Operating it:** `scripts/audit.sh` (audit trail), `scripts/usage.sh` (token usage), `scripts/backup.sh` and `scripts/restore.sh` ([docs/backup.md](docs/backup.md)).

## Upgrading the harness

Check out the version you want in `../deepseek-harness`, run `scripts/build-harness.sh`, then `scripts/harness-lock.sh --update` and commit `sandbox/harness.lock`. Release builds use `scripts/build-harness.sh --locked`, which refuses a checkout that differs from the lock ([docs/build-pinning.md](docs/build-pinning.md)). The upstream project is pre-release and makes no compatibility promises: run `tests/run.sh phase2` and `phase4` after an upgrade, and re-check the policy row ids in `sandbox/entrypoint.sh` against `dsh --profile web --dump-config`.
