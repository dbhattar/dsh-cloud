#!/bin/sh
# Show or change which sites the sandboxes' web access may reach (EGRESS_ALLOW_HOSTS in the env file), and apply it to the running stack.
#
#   scripts/egress-scope.sh --show                              the setting in the env file and in the running egress proxy
#   scripts/egress-scope.sh --set staging.example.org,*.api.example.org
#                                                               only these hosts, plus the base list (git, pip, npm, Go, the
#                                                               vulnerability scanners), are reachable; everything else is refused
#   scripts/egress-scope.sh --clear                             back to any public host
#   add --no-apply to change the env file only
#
# Entries are example.com (that host only), *.example.com (any subdomain, not the apex: list both to allow both) or an IPv4 address.
# Only that one line of the env file (.env, or DSH_ENV_FILE) is touched. Applying recreates the egress proxy, so sandboxes lose web
# access for about 15 seconds while the runner attaches the new one. Needs Node (to check the entries with the proxy's own rules) and
# docker pointed at the right daemon (scripts/lima/docker-context.sh). Details: egress-proxy/README.md.
set -eu
cd "$(dirname "$0")/.."
usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }
ENV_FILE="${DSH_ENV_FILE:-.env}"
COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.gateway.yml"
MODE=""; LIST=""; APPLY=yes
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --show|--clear) MODE="$1"; shift ;;
    --set) [ $# -ge 2 ] || { echo "--set needs a list of hosts" >&2; exit 2; }; MODE="$1"; LIST="$2"; shift 2 ;;
    --no-apply) APPLY=no; shift ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
[ -n "$MODE" ] || { usage >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE (run from the repository root, or set DSH_ENV_FILE)" >&2; exit 1; }

current() { sed -n 's/^[[:space:]]*EGRESS_ALLOW_HOSTS=//p' "$ENV_FILE" | tail -n 1 | sed "s/[[:space:]]\{1,\}#.*\$//; s/^[\"']//; s/[\"'][[:space:]]*\$//"; }
describe() { if [ -n "$1" ]; then echo "scoped: $1 (plus the base list)"; else echo "open: any public host on the allowed ports"; fi; }

case "$MODE" in
  --show)
    echo "env file ($ENV_FILE): $(describe "$(current)")"
    id="$($COMPOSE ps -q egress-proxy 2>/dev/null || true)"
    if [ -n "$id" ]; then
      running="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" | sed -n 's/^EGRESS_ALLOW_HOSTS=//p')"
      echo "running egress proxy: $(describe "$running")"
      [ "$running" = "$(current)" ] || echo "note: they differ; run scripts/egress-scope.sh --set or --clear to apply the env file's value"
    else
      echo "running egress proxy: not running"
    fi
    exit 0
    ;;
  --set)
    # The proxy's own parser decides what is allowed, so a list accepted here is a list the proxy will start with.
    node -e "import('./egress-proxy/src/scope.js').then((m) => { try { if (m.parseHostList(process.argv[1], 'EGRESS_ALLOW_HOSTS').length === 0) throw new Error('the list has no hosts: use --clear to go back to any public host'); } catch (e) { console.error(e.message); process.exit(1); } })" "$LIST" || exit 1
    LIST="$(printf '%s' "$LIST" | tr -d '[:space:]')"
    NEW="EGRESS_ALLOW_HOSTS=$LIST"
    ;;
  --clear) NEW="" ;;
esac

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -v '^[[:space:]]*EGRESS_ALLOW_HOSTS=' "$ENV_FILE" > "$tmp" || true
[ -z "$NEW" ] || echo "$NEW" >> "$tmp"
cat "$tmp" > "$ENV_FILE" # not mv: the env file keeps its permissions
echo "env file ($ENV_FILE): $(describe "$(current)")"
if [ "$APPLY" = yes ]; then
  $COMPOSE up -d --no-deps --force-recreate egress-proxy
  echo "applied: the egress proxy was recreated; sandboxes have web access again within about 15 seconds"
else
  echo "not applied (--no-apply): recreate the egress proxy to use it: $COMPOSE up -d --no-deps --force-recreate egress-proxy"
fi
