#!/bin/sh
# Restore from a backup made by scripts/backup.sh, or prove that it can be restored.
#
#   scripts/restore.sh --check DIR     restore into scratch volumes, compare with the manifest, delete the scratch
#                                      volumes. Touches no live data; safe on a running stack. This is what
#                                      backup.sh runs after every backup.
#   scripts/restore.sh --yes DIR       REPLACE the live databases and volumes with the backup. The stack must be
#                                      stopped first (docker compose ... down); user sandboxes must not be running
#                                      when the backup holds their volumes. File ownership is restored too (see below).
#
# What --check verifies: every file's sha256 and size against the manifest; each database opens, passes SQLite's
# integrity_check and has the same row count in every table as at backup time; each archive extracts and holds the
# same number of files. It does not boot the stack from the restored data.
#
# Ownership: each database gets back the owner (uid:gid) the manifest recorded; for older backups, the owner the volume already
# has if it is not root, else the service's default (llm-proxy 1000:1000, gateway root). Without this, a restore into a volume
# that did not exist leaves it root-owned and the llm-proxy, which runs as `node`, cannot write its database and exits.
set -eu
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=""
DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --yes) MODE=restore; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    *) DIR="$1"; shift ;;
  esac
done
[ -n "$MODE" ] && [ -n "$DIR" ] || { echo "usage: scripts/restore.sh --check DIR | --yes DIR" >&2; exit 2; }
[ -f "$DIR/MANIFEST" ] || { echo "$DIR has no MANIFEST; is it a backup from scripts/backup.sh?" >&2; exit 1; }
IMG="${BACKUP_IMAGE:-node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54}"
PROJECT="$(sed -n 's/^project=//p' "$DIR/MANIFEST")"
PROJECT="${PROJECT:-dshcloud}"
TOOL="$(cat "$HERE/backup/sqlite-tool.mjs")"
FAIL=0
fail() { echo "   FAIL: $*" >&2; FAIL=1; }
manifest_get() { sed -n "s/^$1=//p" "$DIR/MANIFEST"; }

echo "==> files against the manifest"
grep '^[0-9a-f]\{64\}  ' "$DIR/MANIFEST" | while read -r sum bytes file; do
  [ -f "$DIR/$file" ] || { echo "   FAIL: $file is missing" >&2; exit 1; }
  [ "$(sha256  "$DIR/$file" | cut -d' ' -f1)" = "$sum" ] || { echo "   FAIL: $file does not match its checksum" >&2; exit 1; }
  [ "$(wc -c < "$DIR/$file" | tr -d ' ')" = "$bytes" ] || { echo "   FAIL: $file has the wrong size" >&2; exit 1; }
done || FAIL=1
[ "$FAIL" = 0 ] && echo "   all checksums match"

check_db() { # name
  [ -f "$DIR/$1.db" ] || return 0
  scratch="dsh-restorecheck-$$-$1"
  docker volume create "$scratch" >/dev/null
  docker run --rm -i -v "$scratch:/data" "$IMG" sh -c 'cat > /data/restored.db' < "$DIR/$1.db"
  got="$(docker run --rm -v "$scratch:/data" "$IMG" node --input-type=module -e "$TOOL" check /data/restored.db 2>&1 || true)"
  docker volume rm "$scratch" >/dev/null
  want="$(manifest_get "counts.$1")"
  case "$got" in *'"integrity":"ok"'*) ;; *) fail "$1.db: $got"; return 0 ;; esac
  [ "$got" = "$want" ] && echo "   $1.db: integrity ok, row counts match ($got)" || fail "$1.db row counts differ: backup had $want, restore has $got"
}

check_volume() { # archive
  name="$(basename "$1" .tar.gz)"
  scratch="dsh-restorecheck-$$-$name"
  docker volume create "$scratch" >/dev/null
  docker run --rm -i -v "$scratch:/v" "$IMG" tar xzf - -C /v < "$1"
  got="$(docker run --rm -v "$scratch:/v:ro" "$IMG" sh -c 'find /v -type f | wc -l' | tr -d ' ')"
  docker volume rm "$scratch" >/dev/null
  want="$(manifest_get "files.$name")"
  [ "$got" = "$want" ] || fail "$name: $got files after restore, $want in the backup"
}

if [ "$MODE" = check ]; then
  echo "==> restoring into scratch volumes"
  check_db gateway
  check_db llm-proxy
  n=0
  for f in "$DIR"/volumes/*.tar.gz; do
    [ -f "$f" ] || continue
    check_volume "$f"; n=$((n + 1))
  done
  echo "   $n volume archives extracted, file counts compared"
  [ "$FAIL" = 0 ] || { echo "Restore check FAILED" >&2; exit 1; }
  echo "Restore check passed"
  exit 0
fi

# --- real restore ---
# The stack holds the databases open, so it must be down. User sandboxes only matter when the backup replaces their volumes.
HAS_VOLUMES=0
for f in "$DIR"/volumes/*.tar.gz; do [ -f "$f" ] && HAS_VOLUMES=1; done
RUNNING="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")"
[ "$HAS_VOLUMES" = 0 ] || RUNNING="$RUNNING$(docker ps -q --filter label=dsh-cloud.user)"
[ -z "$RUNNING" ] || { echo "the stack or a user sandbox is running. Stop it first:  docker compose --env-file .env -f infra/docker-compose.gateway.yml down  (and docker rm -f any dsh-sbx-*)" >&2; exit 1; }
[ "$FAIL" = 0 ] || { echo "the backup failed its checksum check; not restoring" >&2; exit 1; }
echo "==> restoring databases"
# uid:gid, digits only (the manifest is data, never interpolated unchecked into a command).
valid_owner() { case "$1" in ''|*[!0-9:]*|:*|*:|*:*:*) return 1 ;; *) return 0 ;; esac; }
# What the service in each image runs as, for backups made before the manifest recorded owners.
default_owner() { case "$1" in llm-proxy) echo 1000:1000 ;; *) echo 0:0 ;; esac; }
for db in gateway llm-proxy; do
  [ -f "$DIR/$db.db" ] || continue
  vol="${PROJECT}_${db}-data"
  docker volume create "$vol" >/dev/null
  # Ownership matters: a volume created here is root-owned, and the llm-proxy runs as `node` and could not write its database.
  # Order of preference: what the backup recorded; else the owner the volume already has (if not root); else the service's default.
  file_owner="$(manifest_get "owner.$db")"; valid_owner "$file_owner" || file_owner=""
  dir_owner="$(manifest_get "dirowner.$db")"; valid_owner "$dir_owner" || dir_owner=""
  if [ -z "$file_owner" ]; then
    existing="$(docker run --rm -v "$vol:/data:ro" "$IMG" stat -c %u:%g /data)"
    if [ "$existing" != "0:0" ]; then file_owner="$existing"; else file_owner="$(default_owner "$db")"; fi
  fi
  [ -n "$dir_owner" ] || dir_owner="$file_owner"
  # Remove the old WAL files too: leftovers from the replaced database would corrupt the restored one.
  docker run --rm -i -v "$vol:/data" "$IMG" sh -c "rm -f /data/$db.db /data/$db.db-wal /data/$db.db-shm; cat > /data/$db.db; chown $dir_owner /data; chown $file_owner /data/$db.db" < "$DIR/$db.db"
  echo "   $db.db -> $vol (owner $file_owner)"
done
echo "==> restoring volumes"
for f in "$DIR"/volumes/*.tar.gz; do
  [ -f "$f" ] || continue
  name="$(basename "$f" .tar.gz)"
  # The archive's file name becomes a Docker volume name that is WIPED and refilled: only the names a backup holds (account volumes, with or
  # without their key, and Caddy's) are accepted, so a backup from elsewhere cannot overwrite any other volume (docs/security-review.md, SEC-13).
  case "$name" in
    dsh-data-[0-9]*|dsh-ws-[0-9]*) echo "$name" | grep -Eq '^dsh-(data|ws)-[0-9]+(-[0-9a-f]{16})?$' || { echo "refusing volume archive with an unexpected name: $name" >&2; exit 1; } ;;
    *_caddy-data) ;;
    *) echo "refusing volume archive with an unexpected name: $name" >&2; exit 1 ;;
  esac
  docker volume create "$name" >/dev/null
  docker run --rm -i -v "$name:/v" "$IMG" sh -c 'find /v -mindepth 1 -delete; tar xzf - -C /v' < "$f"
  echo "   $name"
done
echo "Restored. Start the stack again (scripts/restart.sh, or docker compose up -d)."
