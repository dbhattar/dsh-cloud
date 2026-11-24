#!/bin/sh
# Back up everything that matters, from a running or stopped stack: both SQLite databases (consistent online
# copies, so accounts, sessions, invites, audit rows, proxy tokens and usage), every user's two volumes, and the
# Caddy data volume (TLS certificates). Then prove the backup restores (see scripts/restore.sh --check).
#
#   scripts/backup.sh                        write backups/dsh-YYYYmmdd-HHMMSS/ and verify it
#   scripts/backup.sh --out /mnt/backups     choose the parent directory
#   scripts/backup.sh --keep 14              afterwards delete all but the newest 14 backups in that directory
#   scripts/backup.sh --no-verify            skip the restore check
#
# Works through the `docker` CLI only, so it follows your current context (Docker Desktop, the Lima VM, a server).
# Backups are written on the machine running this script. User volumes are archived while sandboxes may be
# running, so a file being written at that moment can be captured half-written; stop sandboxes first for a
# crash-free copy. The backup contains password hashes and workspaces: protect it like the live data.
set -eu
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="$REPO/backups"
KEEP=0
VERIFY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
IMG="${BACKUP_IMAGE:-node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54}" # needs node:sqlite (Node >= 24) and tar
PROJECT="${COMPOSE_PROJECT_NAME:-dshcloud}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT/dsh-$STAMP"
TOOL="$(cat "$HERE/backup/sqlite-tool.mjs")"

docker info >/dev/null 2>&1 || { echo "cannot reach Docker (context: $(docker context show 2>/dev/null))" >&2; exit 1; }
mkdir -p "$DEST/volumes"
echo "==> backing up to $DEST (docker context: $(docker context show 2>/dev/null || echo default))"

sqlite_backup() { # volume file name
  docker volume inspect "$1" >/dev/null 2>&1 || { echo "   skipped $3: no volume $1"; return 0; }
  docker run --rm -v "$1:/data" "$IMG" node --input-type=module -e "$TOOL" backup "/data/$2" > "$DEST/$3.db"
  [ -s "$DEST/$3.db" ] || { echo "backup of $3 is empty" >&2; exit 1; }
  echo "   $3.db ($(wc -c < "$DEST/$3.db" | tr -d ' ') bytes)"
}
echo "==> databases"
sqlite_backup "${PROJECT}_gateway-data" gateway.db gateway
sqlite_backup "${PROJECT}_llm-proxy-data" llm-proxy.db llm-proxy

echo "==> volumes"
VOLS="$(docker volume ls --format '{{.Name}}' | grep -E "^dsh-(data|ws)-[0-9]+\$|^${PROJECT}_caddy-data\$" | sort || true)"
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
for f in "$DEST"/volumes/*.tar.gz; do
  [ -f "$f" ] || continue
  printf 'files.%s=%s\n' "$(basename "$f" .tar.gz)" "$(tar tzf "$f" | grep -vc '/$' || true)" >> "$DEST/MANIFEST"
done
echo "   $(grep -c '^[0-9a-f]\{64\}' "$DEST/MANIFEST") files recorded"

if [ "$VERIFY" = 1 ]; then
  echo "==> restore check"
  "$HERE/restore.sh" --check "$DEST"
fi

if [ "$KEEP" -gt 0 ]; then
  # shellcheck disable=SC2012
  ls -1d "$OUT"/dsh-????????-?????? 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    echo "==> removing old backup $old"; rm -rf "$old"
  done
fi
echo "Backup complete: $DEST"
