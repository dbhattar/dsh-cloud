#!/bin/sh
# Send one test message through the gateway's mail settings, to see that they work (docs/email.md).
#
#   scripts/mail-test.sh you@example.com
#   scripts/mail-test.sh --help
#
# Runs inside the gateway container, so point docker at the right daemon first (scripts/lima/docker-context.sh), and
# restart the stack after changing MAIL_* or MAILGUN_* in .env (scripts/restart.sh). Prints the outcome (mail.sent or
# mail.failed with the reason) and exits 0 only when the provider accepted the message. Refuses when MAIL_PROVIDER is log.
# This SENDS A REAL MESSAGE with the mailgun provider: use an address you own.
set -eu
case "${1:-}" in -h|--help|'') sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; [ -n "${1:-}" ] && exit 0 || exit 2;; esac
exec docker exec -u node "${GATEWAY_CONTAINER:-dshcloud-gateway-1}" node src/cli.js mail test "$1"
