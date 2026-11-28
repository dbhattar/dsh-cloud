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
scripts/backup.sh                       # ~/dsh-backups/dsh-YYYYmmdd-HHMMSS/ (owner-only), then verifies it
scripts/backup.sh --out /mnt/backups --keep 14 --keep-days 30
scripts/backup.sh --encrypt-to age1...  # verify, then encrypt to that age public key and delete the plaintext: dsh-STAMP.tar.age
```

It uses only the `docker` CLI, so it follows your current Docker context: against the Lima VM (`scripts/lima/docker-context.sh lima`) it backs up the VM's stack, and the files are written on the machine running the script. A backup directory holds `gateway.db`, `llm-proxy.db`, `volumes/*.tar.gz` and a `MANIFEST` (sha256 and size of every file, row counts per table, file count per archive). It contains password hashes, live session tokens, users' workspaces (with any stored GitHub tokens) and the Caddy volume (certificate and CA keys): protect it like the live data.

**Where it goes, and who can read it (SEC-13).** Everything is created with `umask 077` (the parent directory and each backup directory are mode 700, files 600). The default is `$DSH_BACKUP_DIR`, else `~/dsh-backups`, and the script **refuses a directory inside the checkout**: a deploy that cleans or re-clones the checkout would delete the backups, and `git status` would offer them to a commit. Before this, backups went to `./backups` with the umask of whoever ran it.

**Encrypting.** `--encrypt-to age1...` (or `DSH_BACKUP_RECIPIENT` for cron, or `--encrypt-to-file` for a recipients file) encrypts with [age](https://github.com/FiloSottile/age) **after** the restore check has passed on the plaintext, writes `dsh-STAMP.tar.age`, and deletes the plaintext only once the encrypted file exists. Asking for encryption without `age` installed is an error, never a silent plaintext backup; without a recipient the script prints a warning that the backup is not encrypted. Make the key pair on **another machine** (`age-keygen -o key.txt`; the line starting `age1` is the public key), put only the public key on the server, and keep `key.txt` off it (a password manager, a safe): a server that can only encrypt cannot have its backups read after a break-in. Losing the private key means losing the backups; store it before you rely on them.

**Pruning.** `--keep N` keeps the newest N (plain or encrypted); `--keep-days N` removes backups older than N days. Only names of the form `dsh-YYYYmmdd-HHMMSS` and `.tar.age` are touched.

Schedule it with cron or a systemd timer on the Docker host, for example `0 3 * * * cd /opt/dsh-cloud && DSH_BACKUP_RECIPIENT=age1... scripts/backup.sh --keep-days 30`, and copy the `.age` files off the host (`rsync`, `rclone`, object storage); a backup on the same disk does not survive the disk. The copy step is not scripted here.

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
scripts/restore.sh --yes ~/dsh-backups/dsh-20261123-235128                    # or dsh-STAMP.tar.age --identity key.txt
scripts/restart.sh                                               # or: docker compose ... up -d
```

`--yes` replaces the databases (including their WAL files) and the volumes in the backup. It refuses to run while the stack is running, and also while any user sandbox is running if the backup holds user volumes (a database-only backup is not blocked by sandboxes).

**File ownership is restored too.** The manifest records the owner (`uid:gid`) of each database and its directory (`owner.<db>`, `dirowner.<db>`). The llm-proxy runs as the unprivileged `node` user (1000), so its database must belong to it. A restore into a volume that did not exist yet used to create it root-owned, and the llm-proxy then exited at start with "attempt to write a readonly database" (seen on 2026-11-25; my earlier restores had only worked because the volumes already existed). Now `restore.sh` applies the recorded owner; for backups made before owners were recorded it keeps the owner an existing volume already has, and otherwise uses the service default (llm-proxy 1000:1000, gateway root). A malformed owner value in a manifest is ignored. User volumes need nothing extra: `tar` restores their ownership from the archive. Anything created after the backup is lost: accounts, invites, audit rows, workspace changes. Volumes that exist now but are not in the backup are left alone. Sandboxes are recreated on the user's next visit with a fresh proxy token.

**Encrypted backups.** Pass the `.tar.age` file and `--identity KEYFILE` (the private key, brought to the machine only for this). It is decrypted into a private temporary directory (`mktemp -d`, mode 700) that is removed when the script ends, whether it succeeded or not. Before anything is extracted, every member of the archive must sit under one `dsh-YYYYmmdd-HHMMSS/` directory (no absolute path, no `..`). `restore.sh` also only accepts volume archives named like an account volume or Caddy's, so a backup from elsewhere cannot overwrite any other volume.

**What a restore revives.** Everything as of the backup: password hashes, sessions that were valid then, proxy tokens, GitHub tokens inside workspaces. People who signed out, were suspended or changed their password since the backup are back as they were. After restoring an old backup, look at the admin panel and revoke what should not be there. `restore.sh --yes` prints a reminder at the end.

## Verified

On the Lima VM under gVisor: a backup of a stack with accounts and workspaces passed its restore check; a flipped byte in the database and a missing archive each failed it, and left no scratch volumes behind; `restore --yes` refused while the stack ran; a real restore brought back the accounts and a deleted workspace file and dropped an account created after the backup. Automated in `tests/phase4/backup.test.mjs`.

## Limits

- **Not crash-consistent for workspaces.** Volumes are archived while sandboxes may be running, so a file being written at that moment can be captured half-written. The databases are consistent; stop sandboxes first if workspaces must be exact.
- **Not point-in-time.** Each run is a full copy. Whatever happens between two backups is lost. A large number of big workspaces makes this slow and large; incremental backups (restic, borg, or filesystem snapshots) are the next step and are not done.
- **No off-host copy** is built in: encryption is (above), moving the file is yours to schedule. Encryption is `age` only; a backup encrypted to a key you no longer have cannot be recovered.
- **One host.** Restore assumes the same volume names; it does not migrate between compose project names.
- **Only `linux-arm64`/Docker 29 was exercised**; the scripts use POSIX `sh`, `tar` and `sha256sum` or `shasum`, and a throwaway `node:24-slim` container (override with `BACKUP_IMAGE`).

### Verified for SEC-13 (2026-11-27)

- **Real round trip on the Lima VM** (Ubuntu, age 1.2.1, your live stack, read-only, output deleted afterwards): `backup.sh --encrypt-to` produced a 3.9 MB `.tar.age` (mode 600, no plaintext left), `restore.sh --check` with the key passed (both databases' integrity and row counts, 25 volume archives), and a second key failed with "could not decrypt".
- **Unit tests** (`tests/scripts/backup-security.test.mjs`, 7 tests, stub `docker` and stub `age`): default location and modes, refusal inside the checkout (and no directory left behind), encryption plumbing and key validation (an option, a short or upper-case string and `key;rm` are refused), refusal without `age`, pruning by age, decryption with the right and wrong key, nothing left in `TMPDIR`, and a hostile archive member refused. Three mutations (no `umask`, plaintext not removed, the member check disabled) each made a test fail.
- **Live test** `tests/phase4/backup.test.mjs` has an encrypted case, skipped when `age` is not installed on the machine running it. **Not run yet** (the Docker suites delete data; see the security review).
- **Not verified:** a backup of a large installation (time, size), cron behaviour, restoring an encrypted backup with `--yes` (the decrypt step is shared with `--check`, the replace step is the old one).
