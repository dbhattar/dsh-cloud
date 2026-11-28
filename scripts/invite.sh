#!/bin/sh
# Invite codes for sign-up (needed while ALLOW_SIGNUP is not "true"). Each code works for one account.
#
#   scripts/invite.sh create [count] [--note TEXT] [--days N]   print new codes (shown once; only hashes are stored)
#   scripts/invite.sh create 3 --link                           print each as a sign-up link to send, e.g. https://host/gw/signup?invite=inv_...
#   scripts/invite.sh create --email name@example.com --days 7  create one invite and MAIL it (needs MAIL_PROVIDER, docs/email.md); also prints the code
#   scripts/invite.sh list                                      each invite with its id, and whether it is unused, used, expired or revoked
#   scripts/invite.sh revoke ID                                 make an unused invite stop working (the id is the first column of list)
#
# Runs inside the gateway container, so point docker at the right daemon first (scripts/lima/docker-context.sh).
set -eu
exec docker exec -u node "${GATEWAY_CONTAINER:-dshcloud-gateway-1}" node src/cli.js invite "$@"
