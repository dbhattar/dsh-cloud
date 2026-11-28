#!/bin/sh
# Build the local deepseek-harness (default ../deepseek-harness, override with HARNESS_DIR) on Linux
# inside Docker and export it to sandbox/.harness-dist/ for the sandbox image.
#
#   scripts/build-harness.sh              build (reuses Docker layer cache)
#   scripts/build-harness.sh --no-cache   build from scratch
#   scripts/build-harness.sh --locked     release build: stage exactly the commit in sandbox/harness.lock (git archive, so the working
#                                         tree is ignored) and refuse unless it matches the lock and the lock is clean
#
# Needs roughly 6 GB of free Docker disk and ~8 GB RAM for the TypeScript build while it runs.
# Rebuilding the sandbox image from the output takes seconds: scripts/restart.sh
set -eu
cd "$(dirname "$0")/.."

NO_CACHE=""
LOCKED=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    --locked) LOCKED=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ "$LOCKED" = 1 ]; then
  scripts/harness-lock.sh --check
  scripts/stage-harness.sh --commit "$(sed -n 's/^commit=//p' sandbox/harness.lock)"
else
  scripts/stage-harness.sh
fi
HASH="$(cd sandbox/.harness-src && find . -type f ! -name .staged-from -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"

OUT=sandbox/.harness-dist
rm -rf "$OUT.tmp"
echo "==> building harness in Docker (first build downloads ~1.5 GB of dependencies)"
COMMIT="$(sed -n 's/^commit=//p' sandbox/.harness-src/.staged-from)"
# Not `docker build --output type=local`: with this tree (about 115,000 files) that exporter stalled part-way three times on the Lima VM
# (docs/deploy-images.md). Saving the stage as an image and copying it out with `docker cp` took about 2 minutes in total.
IMAGE="dsh-harness-dist:build-$$"
docker build $NO_CACHE --progress=plain --target dist --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" \
  -f sandbox/harness.Dockerfile -t "$IMAGE" sandbox/.harness-src
CID="$(docker create "$IMAGE" true)"
mkdir -p "$OUT.tmp"
docker cp "$CID:/." "$OUT.tmp" || { docker rm "$CID" >/dev/null; docker rmi "$IMAGE" >/dev/null 2>&1; echo "could not copy the harness build out of the image" >&2; exit 1; }
docker rm "$CID" >/dev/null; docker rmi "$IMAGE" >/dev/null 2>&1 || true
test -f "$OUT.tmp/apps/cli/lib/bin.js" || { echo "build produced no apps/cli/lib/bin.js" >&2; exit 1; }

cp sandbox/.harness-src/.staged-from "$OUT.tmp/BUILD_INFO"
echo "source_hash=$HASH" >> "$OUT.tmp/BUILD_INFO"
echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT.tmp/BUILD_INFO"
rm -rf "$OUT"; mv "$OUT.tmp" "$OUT"

echo "==> harness ready: $OUT ($(du -sh "$OUT" | cut -f1)); $(tr '\n' ' ' < "$OUT/BUILD_INFO")"
echo "Next: scripts/restart.sh"
