#!/bin/sh
# Give or take away the admin role (the admin panel at /gw/admin). This is the only way to do it: no page or request can grant it.
#
#   scripts/make-admin.sh you@example.com            make this account an admin (it must already exist: sign up first)
#   scripts/make-admin.sh --revoke you@example.com   take the role away
#   scripts/make-admin.sh --list                     who is an admin
#
# Grants and revokes are written to the audit log. Runs inside the gateway container, so point docker at the right daemon first
# (scripts/lima/docker-context.sh). GATEWAY_CONTAINER overrides the container name.
set -eu
usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }
GATEWAY="${GATEWAY_CONTAINER:-dshcloud-gateway-1}"
case "${1:-}" in
  -h|--help|"") usage; [ -n "${1:-}" ] || exit 2; exit 0 ;;
  --list) exec docker exec -u node "$GATEWAY" node src/cli.js admin list ;;
  --revoke) [ -n "${2:-}" ] || { usage; exit 2; }; exec docker exec -u node "$GATEWAY" node src/cli.js admin revoke "$2" ;;
  -*) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  *) exec docker exec -u node "$GATEWAY" node src/cli.js admin grant "$1" ;;
esac
