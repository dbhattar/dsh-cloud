# Setting up a VPS

Written 2026-11-28. `scripts/vps/setup.sh` prepares a fresh server; this page says how to use it and, as plainly as the rest of these documents, what has and has not been checked. Read [production-config.md](production-config.md) (what the stack needs) and the pipeline checklist at the end of [security-review.md](security-review.md) first.

## What you need

- A Debian 12 or Ubuntu 22.04+ server, amd64 or arm64, with a **kernel and virtualisation that can run gVisor** (test `runsc` on the plan you buy before building on it; most KVM virtual machines can, some container-style VPS products cannot), at least 2 GB of memory (each sandbox may use 1 GB) and 20 GB of disk or more (each user may use 2 GB, plus images and logs).
- A DNS name whose A (and AAAA) record points at the server, and ports 80, 443 and 443/udp reachable. Create the record before the first start so Let's Encrypt can issue the certificate.
- The repository checked out on the server, and an SSH public key for the account that will deploy.

## Run it

```
# look first: prints everything it would do and changes nothing; needs no root
scripts/vps/setup.sh --dry-run --domain cloud.example.com --ssh-key-file ~/deploy_key.pub

# then, as root
sudo scripts/vps/setup.sh --domain cloud.example.com --ssh-key-file ~/deploy_key.pub
```

The phases run in this order, and `--only` and `--skip` pick some of them: `preflight`, `packages`, `docker`, `gvisor`, `daemon`, `firewall`, `upgrades`, `user`, `ssh`, `env`, `verify`. It is safe to run again: each phase checks before it acts, a file it changes is backed up beside itself (`.dsh-bak-<time>`), and an existing `.env` is never overwritten.

| Phase | Does |
| --- | --- |
| `preflight` | OS and architecture; memory and disk warnings; **refuses a Docker address pool (default `10.200.0.0/14`) that overlaps a network the host already uses** (providers often use 10.x privately), with `--docker-pool` as the way out |
| `packages` | `ca-certificates curl gnupg ufw fail2ban unattended-upgrades jq openssl age` (`age` encrypts backups, [backup.md](backup.md)) |
| `docker` | Docker Engine and the compose plugin from Docker's apt repository. **It refuses to continue unless the repository key's fingerprint is the expected one** |
| `gvisor` | `runsc` from gVisor's apt repository, registered as a Docker runtime. The key is fetched over TLS and its fingerprint **printed** for you to compare with gVisor's documentation (it is not pinned here) |
| `daemon` | merges `daemon.json`: `local` log driver (20m by 5), `live-restore`, the private address pool; **refuses a daemon that listens on TCP**. Does not restart Docker unless you pass `--yes` (a restart stops every running container) |
| `firewall` | `ufw`: deny incoming, allow SSH (on the port `sshd` really uses), 80, 443/tcp and 443/udp, and **deny traffic from the sandbox address pool to the host itself**, inserted first so no allow rule can match it |
| `upgrades` | unattended security updates that never touch `docker-ce`, `containerd.io`, the compose and buildx plugins or `runsc`, and never reboot; `fail2ban` for SSH |
| `user` | a deploy user (default `dsh`) in the `docker` group, your key in its `authorized_keys` (a private key or a non-key is refused), and `/opt/dsh-cloud` |
| `ssh` | **only with `--harden-ssh`**: no password logins, no root login. Refused when the deploy user has no key; the new file is checked with `sshd -t` and removed if sshd rejects it. **Keep your session open and log in again from another terminal before you close it** |
| `env` | creates `.env` (mode 600): `RUNNER_SECRET` and `LLM_ADMIN_SECRET` generated, `UPSTREAM_API_KEY` from `--upstream-key-file`, the `UPSTREAM_API_KEY` environment variable or a hidden prompt, `DOMAIN`, `PUBLIC_URL`, `CADDYFILE=Caddyfile.production`, `ALLOW_SIGNUP=false`. Secrets are never printed and never taken as an argument |
| `verify` | `runsc` is registered; **a container under `runsc` really reports gVisor's kernel**; the log driver; nothing on Docker's TCP port; the firewall; what is listening |

It does **not** start the stack. Next, as the deploy user: put the repository in `/opt/dsh-cloud`, get the images (they are built by CI from a pinned harness commit and deployed by digest: [deploy-images.md](deploy-images.md); the sandbox image can no longer come from anyone's laptop), set `EGRESS_ALLOW_HOSTS` in `.env` before opening sign-ups, then
`docker compose --env-file .env -f infra/docker-compose.gateway.yml up -d`, and from another machine check that only 22, 80 and 443 answer.

## What was checked

- **Tests** (`tests/scripts/vps-setup.test.mjs`, 14 tests, no Docker): the script runs against a fake root directory, where commands are only printed and files are written under it. They check the usage errors (exit 2), the OS, architecture and address-pool checks, the dry run (nothing written, no secret shown), the `daemon.json` merge (existing runtimes and settings kept, backed up, unchanged on a second run, TCP refused, no restart without `--yes`), the firewall order (the sandbox-pool deny **first**, SSH on the real port, ufw enabled last, no reset of existing rules), the unattended-upgrades blacklist, the key checks, the `--harden-ssh` guard, and `.env` creation (mode 600, secrets that pass the services' own rule, never printed, never overwritten). Each of these fails when I break the line it covers (7 mutations tried; one first survived because the check was unreachable for a plain private key, and the test now uses a file that reaches it).
- **A dry run on a real Ubuntu 26.04 (arm64) host** (the Lima VM): preflight detected the OS, memory and disk (and warned about under 20 GB free), recognised that Docker and gVisor were already installed, produced a `daemon.json` that kept the existing `runsc` registration and the `features` block, and printed the firewall, upgrade, fail2ban and user steps. Nothing was changed.

## Not verified

- **It has never been run for real on a VPS.** The package installation, repository setup, `ufw --force enable`, the SSH change and the services' behaviour afterwards are untested. Run `--dry-run` first, and keep a console session (the provider's web console) available in case a firewall or SSH change locks you out.
- **Docker's key fingerprint** (`9DC858229FC7DD38854AE2D88D81803C0EBFCD88`) is written from memory of Docker's documentation; if it is wrong the script **stops with a clear message instead of continuing**, which is the safe direction, but check it against https://docs.docker.com/engine/install/ and fix the constant if Docker's key changed.
- **gVisor's key is not pinned**, only printed.
- **The firewall rule's effect.** The deny of the sandbox pool to the host is by source address through ufw; that sandboxes then really cannot reach the host's bridge address (SEC-20) has not been tested (`nc <bridge-ip> 22` from a sandbox, after the stack runs).
- **`live-restore` with the stack running**, and what a Docker restart does to the compose stack on a real host.
- Debian 12 is covered by the OS check in tests only; no Debian host was available.
