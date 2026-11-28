#!/bin/sh
# Copy the deepseek-harness source into sandbox/.harness-src for the image build.
#
#   scripts/stage-harness.sh                stage the WORKING TREE (tracked files plus untracked files that are not
#                                           ignored, uncommitted edits included). For day-to-day development only: the
#                                           result cannot be reproduced from a commit, and .staged-from says dirty=yes.
#   scripts/stage-harness.sh --commit SHA   stage exactly the files committed in SHA (git archive). Nothing from the
#                                           working tree or untracked files can get in; this is what release builds use.
#
# HARNESS_DIR=/path/to/deepseek-harness overrides the checkout (default ../deepseek-harness). node_modules, old lib/
# outputs, .git and other ignored files are left out, which keeps the Docker build context small.
set -eu
cd "$(dirname "$0")/.."

COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) [ $# -ge 2 ] || { echo "stage-harness: --commit needs a commit id" >&2; exit 2; }; COMMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

HARNESS_DIR="${HARNESS_DIR:-$(cd .. && pwd)/deepseek-harness}"
DEST="sandbox/.harness-src"

[ -f "$HARNESS_DIR/package.json" ] || { echo "stage-harness: no harness checkout at $HARNESS_DIR (set HARNESS_DIR)" >&2; exit 1; }
git -C "$HARNESS_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "stage-harness: $HARNESS_DIR is not a git checkout" >&2; exit 1; }

if [ -n "$COMMIT" ]; then
  case "$COMMIT" in *[!0-9a-f]*|'') echo "stage-harness: $COMMIT is not a full commit id" >&2; exit 2 ;; esac
  [ "${#COMMIT}" = 40 ] || { echo "stage-harness: $COMMIT is not a full 40-character commit id" >&2; exit 2; }
  git -C "$HARNESS_DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null \
    || { echo "stage-harness: commit $COMMIT is not in $HARNESS_DIR; fetch it (git -C $HARNESS_DIR fetch origin) or check it out" >&2; exit 1; }
  rm -rf "$DEST"; mkdir -p "$DEST"
  git -C "$HARNESS_DIR" archive --format=tar "$COMMIT" | tar -x -C "$DEST"
  {
    echo "commit=$COMMIT"
    echo "dirty=no"
    echo "version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DEST/apps/cli/package.json" | head -1)"
  } > "$DEST/.staged-from"
else
  mkdir -p "$DEST"
  # rsync exit 23/24 = some listed files vanished (tracked but deleted in the working tree): fine.
  git -C "$HARNESS_DIR" ls-files -z --cached --others --exclude-standard \
    | rsync -a --delete --delete-excluded --from0 --files-from=- "$HARNESS_DIR/" "$DEST/" \
    || { rc=$?; [ "$rc" = 23 ] || [ "$rc" = 24 ] || exit "$rc"; }
  # Record what was staged so an image can be traced back to a commit (+ whether it had local edits).
  {
    echo "commit=$(git -C "$HARNESS_DIR" rev-parse HEAD)"
    echo "dirty=$([ -n "$(git -C "$HARNESS_DIR" status --porcelain)" ] && echo yes || echo no)"
    echo "version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HARNESS_DIR/apps/cli/package.json" | head -1)"
  } > "$DEST/.staged-from"
fi

echo "staged $(du -sh "$DEST" | cut -f1) from $HARNESS_DIR ($(tr '\n' ' ' < "$DEST/.staged-from"))"
