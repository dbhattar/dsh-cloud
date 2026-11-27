#!/bin/sh
# The release binaries in the sandbox image (httpx, nuclei, gitleaks, osv-scanner) are pinned by version and SHA-256 for each
# architecture in sandbox/tools.lock, so a rebuild gets the same bytes and a moved or replaced release cannot change what ships.
#
#   scripts/pin-tools.sh --check     offline: the lock is well formed (every tool has both architectures at one version, real
#                                    hashes, release URLs on github.com). CI runs this.
#   scripts/pin-tools.sh --verify    download every artifact and compare with the lock (needs network; run before a release)
#   scripts/pin-tools.sh --update    download every artifact, require its hash to match the project's own published checksums
#                                    file, and write the hashes into the lock (needs network)
#
# To move a tool to a new release: change the version in its url and checksums-url lines in sandbox/tools.lock, run --update,
# review the diff, rebuild the image and run tests/phase6/toolbox.test.mjs. Not pinned this way, and why: the Debian packages
# follow the pinned base image's release (as for bubblewrap), and the Python tools are pinned by version in sandbox/pytools.txt.
# TOOLS_LOCK overrides the lock path (for tests).
set -eu
cd "$(dirname "$0")/.."
LOCK="${TOOLS_LOCK:-sandbox/tools.lock}"
MODE="${1:---check}"

entries() { grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$LOCK"; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

check() {
  [ -f "$LOCK" ] || { echo "no lock file: $LOCK" >&2; exit 1; }
  entries | awk '
    function bad(msg) { print "tools.lock line " NR ": " msg > "/dev/stderr"; failed = 1 }
    NF != 6 { bad("expected 6 fields (tool version arch sha256 url checksums-url), found " NF); next }
    $1 !~ /^[a-z0-9][a-z0-9-]*$/ { bad("bad tool name " $1) }
    $2 !~ /^[0-9][0-9A-Za-z.+-]*$/ { bad("bad version " $2) }
    $3 != "amd64" && $3 != "arm64" { bad("architecture must be amd64 or arm64, not " $3) }
    $4 !~ /^[0-9a-f]{64}$/ { bad("sha256 is not a 64-character hash (" $4 "); run scripts/pin-tools.sh --update") }
    $5 !~ /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^ ]+$/ { bad("url must be a github.com release download: " $5) }
    $6 !~ /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^ ]+$/ { bad("checksums-url must be a github.com release download: " $6) }
    index($5, $2) == 0 { bad("the url of " $1 " does not contain its version " $2) }
    {
      key = $1 " " $3
      if (key in seen) bad("duplicate entry for " $1 " " $3)
      seen[key] = 1
      tools[$1] = 1
      ver[$1 " " $3] = $2
      archs[$1] = archs[$1] " " $3
    }
    END {
      n = 0
      for (t in tools) {
        n++
        if (!(t " amd64" in seen) || !(t " arm64" in seen)) bad(t " needs both amd64 and arm64")
        else if (ver[t " amd64"] != ver[t " arm64"]) bad(t " has different versions for amd64 and arm64")
      }
      if (n == 0) bad("no tools listed")
      if (failed) exit 1
      print "tools.lock: " n " tools, each pinned by version and SHA-256 for amd64 and arm64"
    }'
}

# Download one entry, check it against the project's published checksums, print its SHA-256. Needs curl and network.
fetch_hash() { # url checksums-url
  (
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    name="${1##*/}"
    curl -fsSL --retry 3 -o "$tmp/artifact" "$1"
    curl -fsSL --retry 3 -o "$tmp/sums" "$2"
    got="$(sha256 "$tmp/artifact")"
    want="$(awk -v n="$name" '{ f = $2; sub(/^\*/, "", f); if (f == n) print $1 }' "$tmp/sums" | head -1)"
    [ -n "$want" ] || { echo "$name is not listed in $2" >&2; exit 1; }
    [ "$got" = "$want" ] || { echo "$name: downloaded $got but the project publishes $want" >&2; exit 1; }
    echo "$got"
  )
}

case "$MODE" in
  --check) check ;;
  --verify)
    check >/dev/null
    entries | while read -r tool version arch sha url sums; do
      got="$(fetch_hash "$url" "$sums")"
      [ "$got" = "$sha" ] || { echo "$tool $version $arch: the lock says $sha but the release is $got" >&2; exit 1; }
      echo "ok  $tool $version $arch"
    done
    ;;
  --update)
    [ -f "$LOCK" ] || { echo "no lock file: $LOCK" >&2; exit 1; }
    out="$(mktemp)"
    while IFS= read -r line; do
      case "$line" in
        ''|'#'*|' '*'#'*) echo "$line" >> "$out"; continue ;;
      esac
      set -- $line
      [ $# -eq 6 ] || { echo "bad line (need 6 fields): $line" >&2; rm -f "$out"; exit 1; }
      new="$(fetch_hash "$5" "$6")" || { rm -f "$out"; exit 1; }
      [ "$new" = "$4" ] || echo "$1 $2 $3: ${4%"${4#????????}"}... -> ${new%"${new#????????}"}..." >&2
      echo "$1 $2 $3 $new $5 $6" >> "$out"
    done < "$LOCK"
    mv "$out" "$LOCK"
    check
    ;;
  *) echo "usage: scripts/pin-tools.sh --check | --verify | --update" >&2; exit 2 ;;
esac
