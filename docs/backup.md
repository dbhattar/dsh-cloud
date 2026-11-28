# Backups

Phase 4, task E2. Two scripts: `scripts/backup.sh` takes the backup and proves it restores; `scripts/restore.sh` checks a backup or replaces live data with it.

> **A workspace volume can hold a GitHub token.** If a user has run `dsh-git login` (docs/github-access.md), the token is in `/workspace/.config/dsh/git-credentials` and so in every backup of that volume. The token is meant to be read-only, single-repository and short-lived, but treat backups as sensitive, and note that `dsh-git logout` removes it from the live volume only.

## What is backed up

| Data | Where it lives | How |
| --- | --- | --- |
| Accounts, sessions, invites, feedback, audit trail | SQLite `gateway.db` in volume `dshcloud_gateway-data` | consistent online copy with SQLite's backup API (safe while the gateway writes) |
| Proxy tokens (hashed) and usage counters | SQLite `llm-proxy.db` in `dshcloud_llm-proxy-data` | same |
| Every user's `$DSH_HOME` and workspace | volumes `dsh-data-<id>-<key>` and `dsh-ws-<id>-<key>` (`dsh-data-<id>` and `dsh-ws-<id>` for accounts that predate keys) | `tar.gz` per volume |
| TLS certificates and ACME account | `dshcloud_caddy-data` | `tar.gz` |

Not backed up, on purpose: `.env` (it holds secrets; keep it in your secret store), container images, the `llm-admin` socket volume, and the sandboxes themselves (they are recreated from the image and the volumes).

## Taking a backup

```
scripts/backup.sh                       # ./backups/dsh-YYYYmmdd-HHMMSS/, then verifies it
scripts/backup.sh --out /mnt/backups --keep 14
```

It uses only the `docker` CLI, so it follows your current Docker context: against the Lima VM (`scripts/lima/docker-context.sh lima`) it backs up the VM's stack, and the files are written on the machine running the script. A backup directory holds `gateway.db`, `llm-proxy.db`, `volumes/*.tar.gz` and a `MANIFEST` (sha256 and size of every file, row counts per table, file count per archive). It contains password hashes and users' workspaces: protect it like the live data and encrypt it before it leaves the host.

Schedule it with cron or a systemd timer on the Docker host, for example `0 3 * * * cd /opt/dsh-cloud && scripts/backup.sh --out /mnt/backups --keep 14`. Copy backups off the host; a backup on the same disk does not survive the disk.

## The restore check

`scripts/restore.sh --check DIR` (run automatically after every backup) restores into scratch volumes, compares, and deletes them. It touches no live data and is safe on a running stack. It verifies:

- every file against its sha256 and size in the manifest (catches truncation and bit rot),
- each database opens, passes SQLite's `integrity_check`, and has the same row count in every table as when it was taken,
- each archive extracts and holds the same number of files.

It does not boot the stack from the restored data; the full round trip is covered by the `phase4/backup` test.

## Restoring for real

```
docker compose --env-file .env -f infra/docker-compose.gateway.yml down
docker rm -f $(docker ps -aq --filter label=dsh-cloud.user)      # user sandboxes
scripts/restore.sh --yes backups/dsh-20261123-235128
scripts/restart.sh                                               # or: docker compose ... up -d
```

`--yes` replaces the databases (including their WAL files) and the volumes in the backup. It refuses to run while the stack is running, and also while any user sandbox is running if the backup holds user volumes (a database-only backup is not blocked by sandboxes).

**File ownership is restored too.** The manifest records the owner (`uid:gid`) of each database and its directory (`owner.<db>`, `dirowner.<db>`). The llm-proxy runs as the unprivileged `node` user (1000), so its database must belong to it. A restore into a volume that did not exist yet used to create it root-owned, and the llm-proxy then exited at start with "attempt to write a readonly database" (seen on 2026-11-25; my earlier restores had only worked because the volumes already existed). Now `restore.sh` applies the recorded owner; for backups made before owners were recorded it keeps the owner an existing volume already has, and otherwise uses the service default (llm-proxy 1000:1000, gateway root). A malformed owner value in a manifest is ignored. User volumes need nothing extra: `tar` restores their ownership from the archive. Anything created after the backup is lost: accounts, invites, audit rows, workspace changes. Volumes that exist now but are not in the backup are left alone. Sandboxes are recreated on the user's next visit with a fresh proxy token.

## Verified

On the Lima VM under gVisor: a backup of a stack with accounts and workspaces passed its restore check; a flipped byte in the database and a missing archive each failed it, and left no scratch volumes behind; `restore --yes` refused while the stack ran; a real restore brought back the accounts and a deleted workspace file and dropped an account created after the backup. Automated in `tests/phase4/backup.test.mjs`.

## Limits

- **Not crash-consistent for workspaces.** Volumes are archived while sandboxes may be running, so a file being written at that moment can be captured half-written. The databases are consistent; stop sandboxes first if workspaces must be exact.
- **Not point-in-time.** Each run is a full copy. Whatever happens between two backups is lost. A large number of big workspaces makes this slow and large; incremental backups (restic, borg, or filesystem snapshots) are the next step and are not done.
- **No encryption or off-host copy** is built in.
- **One host.** Restore assumes the same volume names; it does not migrate between compose project names.
- **Only `linux-arm64`/Docker 29 was exercised**; the scripts use POSIX `sh`, `tar` and `sha256sum` or `shasum`, and a throwaway `node:24-slim` container (override with `BACKUP_IMAGE`).
