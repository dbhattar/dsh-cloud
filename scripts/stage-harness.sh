#!/bin/sh
# Copy the local deepseek-harness source into sandbox/.harness-src for the image build.
#
# Stages exactly the files git would consider part of the project: tracked files plus untracked
# files that are not ignored, taken from the WORKING TREE (so uncommitted customizations are
# included). node_modules, old lib/ outputs, .git and other ignored files are left out, which
# keeps the Docker build context small and the image build independent of your host OS.
#
#   HARNESS_DIR=/path/to/deepseek-harness scripts/stage-harness.sh
set -eu
cd "$(dirname "$0")/.."

HARNESS_DIR="${HARNESS_DIR:-$(cd .. && pwd)/deepseek-harness}"
DEST="sandbox/.harness-src"

[ -f "$HARNESS_DIR/package.json" ] || { echo "stage-harness: no harness checkout at $HARNESS_DIR (set HARNESS_DIR)" >&2; exit 1; }
git -C "$HARNESS_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "stage-harness: $HARNESS_DIR is not a git checkout" >&2; exit 1; }

mkdir -p "$DEST"
# rsync exit 23/24 = some listed files vanished (tracked but deleted in the working tree): fine.
git -C "$HARNESS_DIR" ls-files -z --cached --others --exclude-standard \
  | rsync -a --delete --delete-excluded --from0 --files-from=- "$HARNESS_DIR/" "$DEST/" \
  || { rc=$?; [ "$rc" = 23 ] || [ "$rc" = 24 ] || exit "$rc"; }

# Record what was staged so an image can be traced back to a commit (+ whether it had local edits).
{
  echo "commit=$(git -C "$HARNESS_DIR" rev-parse HEAD)"
  echo "dirty=$([ -n "$(git -C "$HARNESS_DIR" status --porcelain)" ] && echo yes || echo no)"
  echo "version=$(node -p "require('$HARNESS_DIR/apps/cli/package.json').version" 2>/dev/null || echo unknown)"
} > "$DEST/.staged-from"

echo "staged $(du -sh "$DEST" | cut -f1) from $HARNESS_DIR ($(tr '\n' ' ' < "$DEST/.staged-from"))"
