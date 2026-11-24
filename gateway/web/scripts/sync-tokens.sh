#!/bin/sh
# Refresh the vendored deepseek-harness design tokens (src/styles/*.css, BrandWordmark.tsx).
#   HARNESS_DIR=/path/to/deepseek-harness npm run sync-tokens
set -eu
cd "$(dirname "$0")/.."
H="${HARNESS_DIR:-$(cd ../../.. && pwd)/deepseek-harness}/packages/client"
cp "$H/ui-theme/src/styles/base.css" "$H/ui-theme/src/styles/design-platform.css" src/styles/
echo "synced tokens from $H (BrandWordmark.tsx is patched locally; diff before overwriting)"
