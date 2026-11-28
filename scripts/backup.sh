#!/bin/sh
# Back up everything that matters, from a running or stopped stack: both SQLite databases (consistent online
# copies, so accounts, sessions, invites, audit rows, proxy tokens and usage), every user's two volumes, and the
# Caddy data volume (TLS certificates and CA keys). Then prove the backup restores (see scripts/restore.sh --check).
#
#   scripts/backup.sh                        write ~/dsh-backups/dsh-YYYYmmdd-HHMMSS/ (mode 700) and verify it
#   scripts/backup.sh --out /mnt/backups     choose the parent directory (default: $DSH_BACKUP_DIR, else ~/dsh-backups); never inside this checkout
#   scripts/backup.sh --encrypt-to age1...   after verifying, encrypt to that age public key and delete the plaintext: dsh-STAMP.tar.age
#                                            ($DSH_BACKUP_RECIPIENT sets it for cron; --encrypt-to-file FILE reads recipients from a file)
#   scripts/backup.sh --keep 14              afterwards delete all but the newest 14 backups in that directory
#   scripts/backup.sh --keep-days 30         afterwards delete backups older than 30 days
#   scripts/backup.sh --no-verify            skip the restore check
#
# Works through the `docker` CLI only, so it follows your current context (Docker Desktop, the Lima VM, a server).
# Backups are written on the machine running this script. User volumes are archived while sandboxes may be
# running, so a file being written at that moment can be captured half-written; stop sandboxes first for a
# crash-free copy. A backup holds password hashes, live session tokens, every workspace (including stored GitHub tokens) and the
# Caddy keys: files are created owner-only (umask 077), but an UNENCRYPTED backup is as sensitive as the live data and a copy
# on the same disk does not survive the disk. Encrypt, and copy the .age file off the host (docs/backup.md; SEC-13).
set -eu
umask 077 # nothing here is for anyone but the owner
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${DSH_BACKUP_DIR:-${HOME:-/var/backups}/dsh-backups}"
KEEP=0
KEEP_DAYS=0
VERIFY=1
RECIPIENT="${DSH_BACKUP_RECIPIENT:-}"
RECIPIENT_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --keep-days) KEEP_DAYS="$2"; shift 2 ;;
    --encrypt-to) RECIPIENT="$2"; shift 2 ;;
    --encrypt-to-file) RECIPIENT_FILE="$2"; shift 2 ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
case "$KEEP" in ''|*[!0-9]*) echo "--keep needs a number" >&2; exit 2 ;; esac
case "$KEEP_DAYS" in ''|*[!0-9]*) echo "--keep-days needs a number" >&2; exit 2 ;; esac
# An age public key (not a path, not an option): it is passed to `age -r` and nowhere else.
[ -z "$RECIPIENT" ] || echo "$RECIPIENT" | grep -Eq '^age1[a-z0-9]{50,}$' || { echo "--encrypt-to wants an age public key (age1...); make one with: age-keygen" >&2; exit 2; }
[ -z "$RECIPIENT_FILE" ] || [ -f "$RECIPIENT_FILE" ] || { echo "no recipients file $RECIPIENT_FILE" >&2; exit 2; }
ENCRYPT=0; [ -z "$RECIPIENT$RECIPIENT_FILE" ] || ENCRYPT=1
[ "$ENCRYPT" = 0 ] || command -v age >/dev/null 2>&1 || { echo "age is not installed (apt install age / brew install age); refusing to write an unencrypted backup you asked to be encrypted" >&2; exit 1; }
# Not inside the checkout: a deploy that cleans or re-clones it would delete the backups, and git status would offer them to a commit.
mkdir -p "$OUT"; chmod 700 "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
case "$OUT/" in "$(cd "$REPO" && pwd -P)"/*) rmdir "$OUT" 2>/dev/null || true; echo "refusing to write backups inside the checkout ($REPO); use --out or DSH_BACKUP_DIR" >&2; exit 2 ;; esac
IMG="${BACKUP_IMAGE:-node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54}" # needs node:sqlite (Node >= 24) and tar
PROJECT="${COMPOSE_PROJECT_NAME:-dshcloud}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT/dsh-$STAMP"
TOOL="$(cat "$HERE/backup/sqlite-tool.mjs")"

docker info >/dev/null 2>&1 || { echo "cannot reach Docker (context: $(docker context show 2>/dev/null))" >&2; exit 1; }
mkdir -p "$DEST/volumes"; chmod 700 "$DEST"
echo "==> backing up to $DEST (docker context: $(docker context show 2>/dev/null || echo default))"

sqlite_backup() { # volume file name
  docker volume inspect "$1" >/dev/null 2>&1 || { echo "   skipped $3: no volume $1"; return 0; }
  docker run --rm -v "$1:/data" "$IMG" node --input-type=module -e "$TOOL" backup "/data/$2" > "$DEST/$3.db"
  [ -s "$DEST/$3.db" ] || { echo "backup of $3 is empty" >&2; exit 1; }
  echo "   $3.db ($(wc -c < "$DEST/$3.db" | tr -d ' ') bytes)"
  # Who owns the data: the service that uses this volume may not run as root (the llm-proxy runs as `node`), and a volume
  # created fresh by a restore is root-owned unless restore.sh sets it back. Recorded as uid:gid in the manifest.
  own="$(docker run --rm -v "$1:/data:ro" "$IMG" stat -c '%u:%g' /data "/data/$2")"
  printf 'dirowner.%s=%s\nowner.%s=%s\n' "$3" "$(printf '%s\n' "$own" | sed -n 1p)" "$3" "$(printf '%s\n' "$own" | sed -n 2p)" >> "$DEST/.owners"
}
echo "==> databases"
sqlite_backup "${PROJECT}_gateway-data" gateway.db gateway
sqlite_backup "${PROJECT}_llm-proxy-data" llm-proxy.db llm-proxy

echo "==> volumes"
VOLS="$(docker volume ls --format '{{.Name}}' | grep -E "^dsh-(data|ws)-[0-9]+(-[0-9a-f]{16})?\$|^${PROJECT}_caddy-data\$" | sort || true)"
COUNT=0
for v in $VOLS; do
  # tar exits 1 when a file changed while it was read; that is a warning, not a failure.
  docker run --rm -v "$v:/v:ro" "$IMG" tar czf - -C /v . > "$DEST/volumes/$v.tar.gz" || [ $? -eq 1 ]
  COUNT=$((COUNT + 1))
done
echo "   $COUNT volumes"

echo "==> manifest"
{
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "docker_context=$(docker context show 2>/dev/null || echo default)"
  echo "project=$PROJECT"
  echo "# sha256  bytes  file"
} > "$DEST/MANIFEST"
( cd "$DEST" && for f in *.db volumes/*.tar.gz; do
    [ -f "$f" ] || continue
    printf '%s  %s  %s\n' "$(sha256  "$f" | cut -d' ' -f1)" "$(wc -c < "$f" | tr -d ' ')" "$f"
  done ) >> "$DEST/MANIFEST"
# What a restore must reproduce: row counts per table, and the number of files in each archive.
for db in gateway llm-proxy; do
  [ -f "$DEST/$db.db" ] || continue
  printf 'counts.%s=%s\n' "$db" "$(docker run --rm -i "$IMG" sh -c 'cat > /tmp/in.db; exec node --input-type=module -e "$0" check /tmp/in.db' "$TOOL" < "$DEST/$db.db")" >> "$DEST/MANIFEST"
done
[ ! -f "$DEST/.owners" ] || { cat "$DEST/.owners" >> "$DEST/MANIFEST"; rm -f "$DEST/.owners"; }
for f in "$DEST"/volumes/*.tar.gz; do
  [ -f "$f" ] || continue
  printf 'files.%s=%s\n' "$(basename "$f" .tar.gz)" "$(tar tzf "$f" | grep -vc '/$' || true)" >> "$DEST/MANIFEST"
done
echo "   $(grep -c '^[0-9a-f]\{64\}' "$DEST/MANIFEST") files recorded"

if [ "$VERIFY" = 1 ]; then
  echo "==> restore check"
  "$HERE/restore.sh" --check "$DEST"
fi

FINAL="$DEST"
if [ "$ENCRYPT" = 1 ]; then
  echo "==> encrypting"
  FINAL="$DEST.tar.age"
  if [ -n "$RECIPIENT_FILE" ]; then set -- -R "$RECIPIENT_FILE"; else set -- -r "$RECIPIENT"; fi
  tar -C "$OUT" -cf - "dsh-$STAMP" | age "$@" -o "$FINAL.tmp"
  [ -s "$FINAL.tmp" ] || { rm -f "$FINAL.tmp"; echo "encryption produced nothing; the plaintext backup was kept at $DEST" >&2; exit 1; }
  mv "$FINAL.tmp" "$FINAL"
  rm -rf "$DEST" # only after the encrypted copy exists
  echo "   $(wc -c < "$FINAL" | tr -d ' ') bytes; the plaintext backup was removed"
else
  echo "WARNING: this backup is NOT encrypted. It holds password hashes, session tokens, workspaces and GitHub tokens. Use --encrypt-to." >&2
fi

if [ "$KEEP" -gt 0 ]; then
  # shellcheck disable=SC2012
  ls -1d "$OUT"/dsh-????????-?????? "$OUT"/dsh-????????-??????.tar.age 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    echo "==> removing old backup $old"; rm -rf "$old"
  done
fi
if [ "$KEEP_DAYS" -gt 0 ]; then
  find "$OUT" -maxdepth 1 \( -name 'dsh-????????-??????' -o -name 'dsh-????????-??????.tar.age' \) -mtime +"$KEEP_DAYS" | while read -r old; do
    echo "==> removing backup older than $KEEP_DAYS days: $old"; rm -rf "$old"
  done
fi
echo "Backup complete: $FINAL"
