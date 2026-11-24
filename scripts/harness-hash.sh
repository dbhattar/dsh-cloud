#!/bin/sh
# Print a content hash of the harness working tree (the files stage-harness.sh would stage).
# build-harness.sh records it; restart.sh compares to warn when the harness changed since the last build.
set -eu
cd "$(dirname "$0")/.."
scripts/stage-harness.sh >/dev/null
(cd sandbox/.harness-src && find . -type f ! -name .staged-from -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
