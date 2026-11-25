#!/bin/sh
# Invite codes for sign-up (needed while ALLOW_SIGNUP is not "true"). Each code works for one account.
#
#   scripts/invite.sh create [count] [--note TEXT] [--days N]   print new codes (shown once; only hashes are stored)
#   scripts/invite.sh create 3 --link                           print each as a sign-up link to send, e.g. https://host/gw/signup?invite=inv_...
#   scripts/invite.sh list                                      who used which invite, what is unused or expired
#
# Runs inside the gateway container, so point docker at the right daemon first (scripts/lima/docker-context.sh).
set -eu
exec docker exec "${GATEWAY_CONTAINER:-dshcloud-gateway-1}" node src/cli.js invite "$@"
