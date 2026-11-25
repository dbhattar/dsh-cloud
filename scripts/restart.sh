#!/bin/sh
# Rebuild and restart the whole stack (phase 2): sandbox image (built from the LOCAL deepseek-harness
# checkout, default ../deepseek-harness, override with HARNESS_DIR), gateway, Caddy, and user sandboxes.
# The harness itself is built separately by scripts/build-harness.sh and only rebuilt on request.
#
#   scripts/restart.sh                   keep all data (accounts, user workspaces)
#   scripts/restart.sh --wipe            ALSO delete accounts, every user sandbox and their volumes (asks first)
#   scripts/restart.sh --harness         rebuild the deepseek-harness first (slow; only when you changed it)
#   scripts/restart.sh --no-cache        rebuild images from scratch (also the harness when combined with --harness)
#   scripts/restart.sh --runtime runsc   choose the sandbox runtime: runsc (gVisor) or runc (plain Docker)
#   scripts/restart.sh --print-runtime   say which runtime would be used and why, then exit (changes nothing)
#
# Sandbox runtime, first match wins: --runtime; the SANDBOX_RUNTIME environment variable; SANDBOX_RUNTIME in
# the env file (.env, or DSH_ENV_FILE); otherwise automatic: runsc if the current Docker daemon has it registered,
# else runc. It follows your Docker context, so the Lima VM gets gVisor and Docker Desktop gets runc. Under runc the
# agent's shell tool does not work (the harness refuses to run commands unconfined), so a warning is printed.
#
# User sandboxes are removed (not their volumes) so they are recreated from the fresh image on
# the user's next visit. Open sessions are dropped and reconnect on their own.
set -eu
cd "$(dirname "$0")/.."

WIPE=0
BUILD_HARNESS=0
BUILD_ARGS=""
RUNTIME_FLAG=""
PRINT_RUNTIME=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wipe) WIPE=1 ;;
    --harness) BUILD_HARNESS=1 ;;
    --no-cache) BUILD_ARGS="--no-cache" ;;
    --runtime) [ $# -ge 2 ] || { echo "--runtime needs a name (runsc or runc)" >&2; exit 2; }; RUNTIME_FLAG="$2"; shift ;;
    --runtime=*) RUNTIME_FLAG="${1#--runtime=}" ;;
    --print-runtime) PRINT_RUNTIME=1 ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

ENV_FILE="${DSH_ENV_FILE:-.env}"

# Last uncommented KEY=value in the env file, without quotes or a trailing comment.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | sed "s/[[:space:]]\{1,\}#.*\$//; s/^[\"']//; s/[\"'][[:space:]]*\$//"
}

# Runtimes the current Docker daemon knows (empty if it cannot be reached).
registered_runtimes() {
  docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null || true
}

REGISTERED="$(registered_runtimes)"
if [ -n "$RUNTIME_FLAG" ]; then
  RUNTIME="$RUNTIME_FLAG"; SOURCE="--runtime"
elif [ -n "${SANDBOX_RUNTIME:-}" ]; then
  RUNTIME="$SANDBOX_RUNTIME"; SOURCE="SANDBOX_RUNTIME environment variable"
elif [ -n "$(env_value SANDBOX_RUNTIME)" ]; then
  RUNTIME="$(env_value SANDBOX_RUNTIME)"; SOURCE="SANDBOX_RUNTIME in $ENV_FILE"
else
  case " $REGISTERED" in
    *" runsc "*) RUNTIME=runsc; SOURCE="automatic: runsc is registered with this Docker daemon" ;;
    *) RUNTIME=runc; SOURCE="automatic: runsc is not registered with this Docker daemon" ;;
  esac
fi
case "$RUNTIME" in
  [a-z0-9]*) ;;
  *) echo "invalid sandbox runtime '$RUNTIME' (expected a name such as runsc or runc)" >&2; exit 2 ;;
esac
case "$RUNTIME" in *[!a-z0-9_.-]*) echo "invalid sandbox runtime '$RUNTIME' (expected a name such as runsc or runc)" >&2; exit 2 ;; esac
if [ -n "$REGISTERED" ] && [ "$RUNTIME" != runc ]; then
  case " $REGISTERED" in
    *" $RUNTIME "*) ;;
    *) echo "sandbox runtime '$RUNTIME' ($SOURCE) is not registered with this Docker daemon (it has: ${REGISTERED}). Sandboxes could not start. Context: $(docker context show 2>/dev/null || echo default). For gVisor on a Mac use the Lima VM: scripts/lima/setup.sh" >&2; exit 1 ;;
  esac
fi
if [ "$PRINT_RUNTIME" = 1 ]; then
  echo "runtime=$RUNTIME source=$SOURCE"
  exit 0
fi
echo "==> sandbox runtime: $RUNTIME ($SOURCE)"
if [ "$RUNTIME" = runc ]; then
  echo "WARNING: sandboxes will run under runc. The agent's shell tool does NOT work there: user namespaces are denied, so" >&2
  echo "         the harness refuses to run commands unconfined (\"no sandbox backend is usable\")." >&2
  echo "         For the full experience use gVisor: scripts/lima/setup.sh (Lima VM on a Mac), or --runtime runsc on a host where it is registered." >&2
fi
export SANDBOX_RUNTIME="$RUNTIME"

COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.gateway.yml"
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
