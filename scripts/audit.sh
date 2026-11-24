#!/bin/sh
# Read the gateway's audit trail (sign-ups, sign-ins and failures, sandbox start/stop/recreate/limit stops,
# token issue, invite creation). Newest rows last. Passwords, tokens and model content are never recorded.
#
#   scripts/audit.sh                                  last 50 events
#   scripts/audit.sh --user 3 --since 24h             one user, last day
#   scripts/audit.sh --event login.fail --limit 200   one event; "sandbox." matches every sandbox.* event
#   scripts/audit.sh --json                           one JSON object per line
#
# Quota and budget hits are logged by the llm-proxy: docker logs dshcloud-llm-proxy-1 | grep '^.* audit '
# Runs inside the gateway container, so point docker at the right daemon first (scripts/lima/docker-context.sh).
set -eu
exec docker exec "${GATEWAY_CONTAINER:-dshcloud-gateway-1}" node src/cli.js audit "$@"
