#!/bin/sh
# Pin which harness goes into the sandbox image: one commit of the harness repository, its version and a content hash
# of the files that commit stages. A release build (scripts/build-harness.sh --locked, and CI) stages exactly that
# commit with git archive, so the result does not depend on anyone's working tree, and refuses anything else.
#
#   scripts/harness-lock.sh --update              pin the checkout's HEAD (commit sandbox/harness.lock afterwards)
#   scripts/harness-lock.sh --update --commit SHA pin another commit that exists in the checkout
#   scripts/harness-lock.sh --check               fail unless the locked commit stages to the locked hash
#   scripts/harness-lock.sh --show                print the lock
#
# --update refuses a checkout with uncommitted changes (commit them in the harness repository first: the lock pins a
# commit, and a hash of local edits cannot be rebuilt from anywhere else), and refuses a commit that no remote branch
# contains (CI could not fetch it). --allow-dirty and --allow-unpushed override each, for experiments: the lock then says
# dirty=yes or has no remote, and --check refuses it. HARNESS_DIR overrides the checkout (default ../deepseek-harness).
set -eu
cd "$(dirname "$0")/.."
LOCK="${HARNESS_LOCK:-sandbox/harness.lock}"
HARNESS_DIR="${HARNESS_DIR:-$(cd .. && pwd)/deepseek-harness}"
export HARNESS_DIR

sums() { (cd sandbox/.harness-src && find . -type f ! -name .staged-from -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }
get() { sed -n "s/^$1=//p" "$2"; }
# https form of the origin, so CI can use it without an ssh key: git@github.com:o/r.git -> https://github.com/o/r.git
repo_url() { git -C "$HARNESS_DIR" remote get-url origin 2>/dev/null | sed -e 's#^git@github.com:#https://github.com/#' -e 's#^ssh://git@github.com/#https://github.com/#' || true; }

ACTION=""; COMMIT=""; ALLOW_DIRTY=0; ALLOW_UNPUSHED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --update|--check|--show) ACTION="$1"; shift ;;
    --commit) [ $# -ge 2 ] || { echo "--commit needs a commit id" >&2; exit 2; }; COMMIT="$2"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --allow-unpushed) ALLOW_UNPUSHED=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: scripts/harness-lock.sh --update [--commit SHA] | --check | --show (try --help)" >&2; exit 2 ;;
  esac
done

case "${ACTION:---check}" in
  --update)
    [ -d "$HARNESS_DIR/.git" ] || [ -f "$HARNESS_DIR/.git" ] || { echo "no harness checkout at $HARNESS_DIR (set HARNESS_DIR)" >&2; exit 1; }
    if [ -z "$COMMIT" ]; then COMMIT="$(git -C "$HARNESS_DIR" rev-parse HEAD)"; else COMMIT="$(git -C "$HARNESS_DIR" rev-parse --verify "$COMMIT^{commit}")"; fi
    DIRTY=no
    if [ -n "$(git -C "$HARNESS_DIR" status --porcelain)" ]; then
      DIRTY=yes
      [ "$ALLOW_DIRTY" = 1 ] || { echo "The harness checkout at $HARNESS_DIR has uncommitted changes:" >&2; git -C "$HARNESS_DIR" status --short | head -10 >&2
        echo "Commit them in the harness repository (and push), then run this again. (--allow-dirty records the working tree, which no build can reproduce.)" >&2; exit 1; }
    fi
    if [ "$DIRTY" = no ] && [ "$ALLOW_UNPUSHED" = 0 ] && [ -z "$(git -C "$HARNESS_DIR" branch -r --contains "$COMMIT" 2>/dev/null)" ]; then
      echo "Commit $COMMIT is on no remote branch of $HARNESS_DIR, so CI could not fetch it. Push it first. (--allow-unpushed to pin it anyway.)" >&2; exit 1
    fi
    if [ "$DIRTY" = yes ]; then scripts/stage-harness.sh >/dev/null; else scripts/stage-harness.sh --commit "$COMMIT" >/dev/null; fi
    {
      echo "repo=$(repo_url)"
      cat sandbox/.harness-src/.staged-from
      printf 'source_hash=%s\n' "$(sums)"
    } > "$LOCK.tmp" && mv "$LOCK.tmp" "$LOCK"
    echo "wrote $LOCK:"; sed 's/^/  /' "$LOCK"
    [ "$DIRTY" = no ] || echo "note: dirty=yes. This lock cannot be built by scripts/build-harness.sh --locked or by CI." >&2
    exit 0 ;;
  --show) cat "$LOCK" ;;
  --check)
    [ -f "$LOCK" ] || { echo "no $LOCK; run scripts/harness-lock.sh --update" >&2; exit 1; }
    commit="$(get commit "$LOCK")"
    [ "$(get dirty "$LOCK")" = no ] || { echo "$LOCK says dirty=$(get dirty "$LOCK"): it pins uncommitted edits, which no build can reproduce. Commit them in the harness repository and run --update." >&2; exit 1; }
    case "$commit" in *[!0-9a-f]*|'') echo "$LOCK has no valid commit=" >&2; exit 1 ;; esac
    [ "${#commit}" = 40 ] || { echo "$LOCK has no valid commit=" >&2; exit 1; }
    # The checkout's working tree does not matter: the locked commit itself is staged and hashed.
    scripts/stage-harness.sh --commit "$commit" >/dev/null
    ok=0
    now_version="$(get version sandbox/.harness-src/.staged-from)"; now_hash="$(sums)"
    [ "$now_version" = "$(get version "$LOCK")" ] || { echo "harness version differs: locked $(get version "$LOCK"), commit has $now_version" >&2; ok=1; }
    [ "$now_hash" = "$(get source_hash "$LOCK")" ] || { echo "harness source_hash differs: locked $(get source_hash "$LOCK"), commit stages to $now_hash" >&2; ok=1; }
    [ "$ok" = 0 ] || { echo "The locked commit does not stage to what $LOCK records. Run --update to accept, or fix the lock." >&2; exit 1; }
    echo "harness commit matches the lock ($(echo "$commit" | cut -c1-12), version $(get version "$LOCK"))" ;;
esac
