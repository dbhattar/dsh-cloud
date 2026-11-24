#!/bin/sh
# One command to get a Linux VM with Docker and gVisor (runsc) ready for dsh-cloud, on this Mac.
# Safe to re-run: every step checks first and skips what is already done.
#
#   scripts/lima/setup.sh             create/start the VM, install gVisor, verify it, create a docker context
#   scripts/lima/setup.sh --stack     ... then also start the whole dsh-cloud stack in the VM with gVisor sandboxes
#
# Steps: 1 VM (create-vm.sh, or start it if stopped)  2 gVisor (install-gvisor.sh, if runsc is not registered)
#        3 smoke test (gvisor-smoke.sh)  4 docker context "lima-<name>" (created, NOT made current)
#        5 with --stack: scripts/restart.sh against the VM with SANDBOX_RUNTIME=runsc
#
# Your global docker context is never changed here; --stack targets the VM through DOCKER_CONTEXT for that
# one command. To use the VM from your shell afterwards: scripts/lima/docker-context.sh lima
# Needs Lima (brew install lima). Variables: DSH_VM_NAME (dsh-linux), DSH_VM_CPUS (4), DSH_VM_MEMORY_GB (6),
# DSH_VM_DISK_GB (40). The stack needs host port 443 free (stop any other dsh-cloud stack first) and a built
# harness (scripts/build-harness.sh).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NAME="${DSH_VM_NAME:-dsh-linux}"
CTX="lima-$NAME"
SOCK="$HOME/.lima/$NAME/sock/docker.sock"
STACK=0
for arg in "$@"; do
  case "$arg" in
    --stack) STACK=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done
step() { printf '\n==> %s\n' "$*"; }
vm_status() { limactl list --format '{{.Status}}' "$NAME" 2>/dev/null || true; }

command -v limactl >/dev/null || { echo "limactl not found. Install Lima first: brew install lima" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker CLI not found (Docker Desktop provides it)" >&2; exit 1; }

step "1/4 VM '$NAME'"
case "$(vm_status)" in
  Running) echo "already running" ;;
  "")      "$HERE/create-vm.sh" ;;
  *)       echo "VM exists but is $(vm_status); starting it"; limactl start "$NAME" ;;
esac
[ "$(vm_status)" = Running ] || { echo "VM '$NAME' is not running" >&2; exit 1; }

step "2/4 gVisor (runsc)"
# Read the registered runtimes into a variable first. If the query fails we stop: reinstalling on a
# failed query would restart Docker in the VM, which kills anything running and breaks the Mac-side socket.
RUNTIMES="$(limactl shell "$NAME" -- sudo docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null || true)"
[ -n "$RUNTIMES" ] || { echo "could not query Docker in the VM; is it up? (limactl shell $NAME -- sudo systemctl status docker)" >&2; exit 1; }
case " $RUNTIMES" in
  *" runsc "*) echo "runsc is already registered with the VM's Docker" ;;
  *)
    RUNNING="$(limactl shell "$NAME" -- sudo docker ps -q 2>/dev/null || true)"
    [ -z "$RUNNING" ] || { echo "installing gVisor restarts Docker in the VM, but containers are running there. Stop them first." >&2; exit 1; }
    "$HERE/install-gvisor.sh"
    # Restarting Docker leaves Lima's forwarded socket on the Mac dead; restarting the VM restores it.
    echo "restarting the VM to restore the Mac-side Docker socket"
    limactl stop "$NAME"
    limactl start "$NAME"
    ;;
esac

step "3/4 smoke test (the kernel the container sees must differ between runc and runsc)"
OUT="$("$HERE/gvisor-smoke.sh")"
echo "$OUT"
echo "$OUT" | grep -q gvisor || { echo "runsc did not report a gVisor kernel; gVisor is not working" >&2; exit 1; }

step "4/4 docker context '$CTX'"
[ -S "$SOCK" ] || { echo "no Docker socket at $SOCK (is the VM the docker-rootful template?)" >&2; exit 1; }
if docker context inspect "$CTX" >/dev/null 2>&1; then
  echo "context already exists"
else
  docker context create "$CTX" --docker "host=unix://$SOCK" >/dev/null
  echo "created (current context is still: $(docker context show))"
fi

if [ "$STACK" = 1 ]; then
  step "starting the dsh-cloud stack in the VM, sandboxes under runsc"
  # Port 443 being busy is expected when this VM's own stack is already up (Lima forwards it); only another listener is a problem.
  OWN="$(docker --context "$CTX" ps -q --filter label=com.docker.compose.project=dshcloud 2>/dev/null || true)"
  if [ -z "$OWN" ] && lsof -nP -iTCP:443 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port 443 on this Mac is in use, so the VM's forwarded 443 would fail. Stop the other stack first, e.g." >&2
    echo "  docker --context desktop-linux compose --env-file .env -f infra/docker-compose.gateway.yml down" >&2
    exit 1
  fi
  [ -f "$REPO/.env" ] || { echo "no $REPO/.env; copy .env.example and fill in the secrets" >&2; exit 1; }
  [ -f "$REPO/sandbox/.harness-dist/apps/cli/lib/bin.js" ] || "$REPO/scripts/build-harness.sh"
  DOCKER_CONTEXT="$CTX" SANDBOX_RUNTIME=runsc "$REPO/scripts/restart.sh"
  echo
  echo "Stack is up in the VM: https://localhost/  (Lima forwards port 443 to this Mac)"
else
  cat <<EOF

Ready. Next:
  scripts/lima/setup.sh --stack            start the stack in the VM with gVisor sandboxes
  scripts/lima/docker-context.sh lima      or point your shell's docker at the VM
EOF
fi
