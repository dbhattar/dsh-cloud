#!/bin/sh
# Pin which harness goes into the sandbox image. The harness is built from a local checkout (default
# ../deepseek-harness), so a commit id alone is not enough: the working tree may carry local edits. The lock
# records the commit, version and a content hash of everything that would be staged, and a release build
# refuses to run if the tree no longer matches.
#
#   scripts/harness-lock.sh --update     record the current checkout in sandbox/harness.lock (commit it)
#   scripts/harness-lock.sh --check      fail unless the checkout matches the lock exactly
#   scripts/harness-lock.sh --show       print the lock
#
# scripts/build-harness.sh --locked runs --check first. Day-to-day builds do not need the lock; restart.sh
# already warns when the checkout changed since the last build.
set -eu
cd "$(dirname "$0")/.."
LOCK=sandbox/harness.lock

current() { # prints commit= dirty= version= source_hash= for the checkout as it is now
  scripts/stage-harness.sh >/dev/null
  cat sandbox/.harness-src/.staged-from
  printf 'source_hash=%s\n' "$(cd sandbox/.harness-src && find . -type f ! -name .staged-from -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
}
get() { sed -n "s/^$1=//p" "$2"; }

case "${1:---check}" in
  --update)
    current > "$LOCK.tmp" && mv "$LOCK.tmp" "$LOCK"
    echo "wrote $LOCK:"; sed 's/^/  /' "$LOCK"
    [ "$(get dirty "$LOCK")" = yes ] && echo "note: the checkout has uncommitted changes; the lock pins their content hash, but the commit id alone cannot reproduce this build." >&2
    exit 0 ;;
  --show) cat "$LOCK" ;;
  --check)
    [ -f "$LOCK" ] || { echo "no $LOCK; run scripts/harness-lock.sh --update" >&2; exit 1; }
    now="$(mktemp)"; trap 'rm -f "$now"' EXIT
    current > "$now"
    ok=0
    for k in commit version source_hash; do
      if [ "$(get $k "$LOCK")" != "$(get $k "$now")" ]; then
        echo "harness $k differs: locked $(get $k "$LOCK"), checkout $(get $k "$now")" >&2; ok=1
      fi
    done
    [ "$ok" = 0 ] || { echo "The harness checkout does not match $LOCK. Check out the locked commit, or run --update to accept the change." >&2; exit 1; }
    echo "harness matches the lock ($(get commit "$LOCK" | cut -c1-12), version $(get version "$LOCK"))" ;;
  *) echo "usage: scripts/harness-lock.sh --update | --check | --show" >&2; exit 2 ;;
esac
