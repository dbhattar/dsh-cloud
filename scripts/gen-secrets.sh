#!/bin/sh
# Print strong values for the shared secrets, to paste into .env (it never writes the file itself, so nothing is overwritten and nothing is
# left in a shell history or a CI log by accident). Each is 48 characters from 24 random bytes; the services refuse anything weaker
# than 24 characters and 10 different ones (docs/security-review.md, SEC-10).
#
#   scripts/gen-secrets.sh            RUNNER_SECRET and LLM_ADMIN_SECRET
#   scripts/gen-secrets.sh --help
#
# Needs: openssl, or /dev/urandom with od. Keep the output out of the chat, tickets and commits.
set -eu
case "${1:-}" in -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; '') ;; *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;; esac
secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24
  elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo
  else echo "need openssl, or /dev/urandom and od" >&2; exit 1; fi
}
echo "RUNNER_SECRET=$(secret)"
echo "LLM_ADMIN_SECRET=$(secret)"
