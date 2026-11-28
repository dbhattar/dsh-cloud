#!/bin/sh
# Render the icons the gateway pages use from ONE square source icon (PNG, at least 512 px).
#
#   scripts/render-branding.sh [SOURCE.png]    default source: ../vid2doc/marketing/public/images/framewrite_icon.png
#   scripts/render-branding.sh --help
#
# Writes gateway/web/public/brand-icon.png (128 px, the mark in page headers), favicon-32.png and apple-touch-icon.png (180 px),
# and sandbox/brand/lib/client.js, the harness plugin that shows the same icon in the workspace (the icon embedded as a data URI).
# Rebuild the pages afterwards (cd gateway/web && npm run build). Safe to run again: it overwrites its own four outputs and nothing else.
# Needs: macOS `sips`. On Linux, render the three sizes with any tool and copy them to the same names (see docs/branding.md).
set -eu
case "${1:-}" in -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0;; esac
cd "$(dirname "$0")/.."
SRC="${1:-../vid2doc/marketing/public/images/framewrite_icon.png}"
OUT=gateway/web/public
command -v sips >/dev/null 2>&1 || { echo "render-branding: 'sips' not found (macOS only); see docs/branding.md for the manual steps" >&2; exit 1; }
[ -f "$SRC" ] || { echo "render-branding: source icon not found: $SRC" >&2; exit 1; }
W=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/ {print $2}')
H=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/ {print $2}')
[ "$W" = "$H" ] && [ "${W:-0}" -ge 512 ] || { echo "render-branding: the source must be square and at least 512 px (it is ${W}x${H})" >&2; exit 1; }
mkdir -p "$OUT"
sips -z 128 128 "$SRC" --out "$OUT/brand-icon.png" >/dev/null
sips -z 32 32 "$SRC" --out "$OUT/favicon-32.png" >/dev/null
sips -z 180 180 "$SRC" --out "$OUT/apple-touch-icon.png" >/dev/null
DATA=$(base64 < "$OUT/brand-icon.png" | tr -d '\n')
mkdir -p sandbox/brand/lib
awk -v data="data:image/png;base64,$DATA" '{ i = index($0, "__ICON_DATA_URI__"); if (i) $0 = substr($0, 1, i - 1) data substr($0, i + 17); print }' sandbox/brand/client.template.js > sandbox/brand/lib/client.js
echo "wrote sandbox/brand/lib/client.js"
echo "wrote $OUT/brand-icon.png favicon-32.png apple-touch-icon.png from $SRC"
