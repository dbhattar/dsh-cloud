#!/bin/sh
# The gateway must not run as root (docs/security-review.md, SEC-10): it parses everything an anonymous visitor sends and holds the runner
# and llm-proxy secrets and the accounts database.
#
# It still STARTS as root with only CAP_CHOWN, CAP_SETUID and CAP_SETGID, for one reason: volumes made before this change belong to root
# (the database, an earlier unix socket), and a non-root process cannot write to them. So it takes over the three directories it uses
# (a no-op once they are right), drops every capability and every privilege, and only then runs the gateway as `node`.
# On a fresh install the volumes are already node's and the chown does nothing.
set -eu
if [ "$(id -u)" = 0 ]; then
  for d in "${DATA_DIR:-/data}" /run/llm-admin /run/gw; do
    [ -d "$d" ] && chown -R node:node "$d"
  done
  exec setpriv --reuid=node --regid=node --init-groups --bounding-set=-all --inh-caps=-all -- "$0" "$@"
fi
exec "$@"
