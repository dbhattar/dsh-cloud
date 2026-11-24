#!/bin/sh
# Rebuild and restart the whole stack (phase 2): sandbox image (built from the LOCAL deepseek-harness
# checkout, default ../deepseek-harness, override with HARNESS_DIR), gateway, Caddy, and user sandboxes.
# The harness itself is built separately by scripts/build-harness.sh and only rebuilt on request.
#
#   scripts/restart.sh            keep all data (accounts, user workspaces)
#   scripts/restart.sh --wipe     ALSO delete accounts, every user sandbox and their volumes (asks first)
#   scripts/restart.sh --harness  rebuild the deepseek-harness first (slow; only when you changed it)
#   scripts/restart.sh --no-cache rebuild images from scratch (also the harness when combined with --harness)
#
# User sandboxes are removed (not their volumes) so they are recreated from the fresh image on
# the user's next visit. Open sessions are dropped and reconnect on their own.
set -eu
cd "$(dirname "$0")/.."

WIPE=0
BUILD_HARNESS=0
BUILD_ARGS=""
for arg in "$@"; do
  case "$arg" in
    --wipe) WIPE=1 ;;
    --harness) BUILD_HARNESS=1 ;;
    --no-cache) BUILD_ARGS="--no-cache" ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

COMPOSE="docker compose --env-file .env -f infra/docker-compose.gateway.yml"
SANDBOXES="$(docker ps -a --filter label=dsh-cloud.user --format '{{.Names}}')"

if [ "$WIPE" = 1 ]; then
  echo "--wipe will delete ALL accounts and ALL user workspaces:"
  echo "${SANDBOXES:-  (no user sandboxes exist)}"
  printf "Type 'wipe' to continue: "
  read -r answer
  [ "$answer" = "wipe" ] || { echo "aborted"; exit 1; }
fi

# Both stacks bind host port 443.
if [ -n "$(docker compose -f infra/docker-compose.yml ps -q 2>/dev/null)" ]; then
  echo "==> stopping the phase 1 prototype stack (it also uses port 443)"
  docker compose -f infra/docker-compose.yml down
fi

echo "==> removing user sandboxes (volumes are kept unless --wipe)"
for c in $SANDBOXES; do
  docker rm -f "$c" >/dev/null
  if [ "$WIPE" = 1 ]; then
    id="${c#dsh-sbx-}"
    docker volume rm "dsh-data-$id" "dsh-ws-$id" >/dev/null 2>&1 || true
    docker network rm "dsh-net-$id" >/dev/null 2>&1 || true
  fi
done

if [ "$BUILD_HARNESS" = 1 ] || [ ! -f sandbox/.harness-dist/apps/cli/lib/bin.js ]; then
  [ "$BUILD_HARNESS" = 1 ] || echo "==> no built harness found; building it now"
  scripts/build-harness.sh $BUILD_ARGS
else
  BUILT="$(sed -n 's/^source_hash=//p' sandbox/.harness-dist/BUILD_INFO 2>/dev/null)"
  NOW="$(scripts/harness-hash.sh)"
  if [ "$BUILT" != "$NOW" ]; then
    echo "WARNING: the deepseek-harness source changed since the last harness build; the sandbox image will use the OLD build."
    echo "         Run scripts/restart.sh --harness (or scripts/build-harness.sh) to pick up your changes."
  else
    echo "==> harness build is current ($(sed -n 's/^built_at=//p' sandbox/.harness-dist/BUILD_INFO))"
  fi
fi

echo "==> building images"
$COMPOSE build $BUILD_ARGS

if [ "$WIPE" = 1 ]; then
  echo "==> deleting gateway data"
  $COMPOSE down -v --remove-orphans
fi

echo "==> stopping stack"
$COMPOSE down --remove-orphans
# A network left over from an older compose layout has mismatched labels; recreate it cleanly.
docker network rm dsh-sandboxes >/dev/null 2>&1 || true
docker network rm dsh-control >/dev/null 2>&1 || true # from the layout before per-user networks

echo "==> starting stack"
$COMPOSE up -d --force-recreate

echo "==> waiting for the gateway"
i=0
until curl -sk -o /dev/null -f https://localhost/gw/healthz; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "gateway did not become healthy. Networks per container:" >&2
    for c in $($COMPOSE ps -q); do
      docker inspect -f '  {{.Name}}: {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" >&2
    done
    echo "recent logs:" >&2
    $COMPOSE logs --tail 15 gateway proxy >&2
    exit 1
  fi
  sleep 1
done

$COMPOSE ps
echo
echo "Ready: https://localhost/  (sign in at https://localhost/gw/login)"
