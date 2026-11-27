#!/bin/sh
# Installs the pinned release binaries from tools.lock for this architecture into /usr/local/bin, at image build. Every download
# is checked against the SHA-256 in the lock and the build fails on any difference, so a replaced or moved release cannot get in.
#
#   install-tools.sh tools.lock
#
# TOOLS_DEST and TOOLS_ARCH override the install directory and architecture (for tests); by default the architecture comes
# from dpkg. Needs curl, sha256sum, unzip and tar. See scripts/pin-tools.sh for how the lock is made and checked.
set -eu
LOCK="${1:?usage: install-tools.sh tools.lock}"
DEST="${TOOLS_DEST:-/usr/local/bin}"
ARCH="${TOOLS_ARCH:-$(dpkg --print-architecture)}"
case "$ARCH" in
  amd64|arm64) ;;
  *) echo "install-tools: unsupported architecture $ARCH (the lock covers amd64 and arm64)" >&2; exit 1 ;;
esac
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$LOCK" > "$WORK/entries"
count=0
while read -r tool version arch sha url _sums; do
  [ "$arch" = "$ARCH" ] || continue
  dir="$WORK/$tool"
  mkdir -p "$dir/x"
  curl -fsSL --retry 3 -o "$dir/artifact" "$url"
  got="$(sha256sum "$dir/artifact" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    echo "install-tools: $tool $version ($ARCH): the download is $got but the lock pins $sha" >&2
    exit 1
  fi
  case "$url" in
    *.zip) unzip -q -o "$dir/artifact" -d "$dir/x"; src="$dir/x/$tool" ;;
    *.tar.gz) tar -xzf "$dir/artifact" -C "$dir/x"; src="$dir/x/$tool" ;;
    *) src="$dir/artifact" ;;
  esac
  [ -f "$src" ] || { echo "install-tools: $tool $version: no file named $tool in the download" >&2; exit 1; }
  install -m 0755 "$src" "$DEST/$tool"
  echo "installed $tool $version ($ARCH)"
  count=$((count + 1))
done < "$WORK/entries"
[ "$count" -gt 0 ] || { echo "install-tools: nothing in $LOCK for $ARCH" >&2; exit 1; }
