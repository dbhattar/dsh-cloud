#!/bin/sh
# Point this machine's `docker` / `docker compose` at the Lima VM's daemon (where gVisor is registered)
# or back at Docker Desktop. The setting is Docker's "current context", so it applies to every shell and
# to scripts/restart.sh and tests/run.sh until you switch back.
#
#   scripts/lima/docker-context.sh lima      use the Lima VM's daemon (creates the context if missing)
#   scripts/lima/docker-context.sh desktop   use Docker Desktop again
#   scripts/lima/docker-context.sh status    show the current context and which daemon it reaches
#
# The two daemons share nothing: containers, images and volumes (including your accounts) live in one or
# the other. Both want host port 443, so stop the stack on one before starting it on the other.
set -eu
NAME="${DSH_VM_NAME:-dsh-linux}"
CTX="lima-$NAME"
SOCK="$HOME/.lima/$NAME/sock/docker.sock"
DESKTOP_CTX="${DSH_DESKTOP_CONTEXT:-desktop-linux}"

status() {
  echo "current context: $(docker context show)"
  echo "daemon:          $(docker info --format '{{.Name}}, runtimes: {{range $k,$v := .Runtimes}}{{$k}} {{end}}, {{.Containers}} containers' 2>&1 | head -1)"
}

case "${1:-}" in
  lima)
    command -v limactl >/dev/null || { echo "limactl not found; install Lima first (docs/lima-setup.md)" >&2; exit 1; }
    limactl list --format '{{.Status}}' "$NAME" 2>/dev/null | grep -q Running \
      || { echo "VM '$NAME' is not running. Start it: limactl start $NAME (or scripts/lima/create-vm.sh)" >&2; exit 1; }
    [ -S "$SOCK" ] || { echo "no Docker socket at $SOCK; is this the docker-rootful template?" >&2; exit 1; }
    if ! docker context inspect "$CTX" >/dev/null 2>&1; then
      docker context create "$CTX" --docker "host=unix://$SOCK" >/dev/null
      echo "created context $CTX"
    fi
    docker context use "$CTX" >/dev/null
    status
    # Both daemons publish 443 on this machine.
    if lsof -nP -iTCP:443 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "note: something on this machine already listens on port 443 (Docker Desktop's stack?). Stop it before starting the stack in the VM." >&2
    fi
    ;;
  desktop)
    if docker context inspect "$DESKTOP_CTX" >/dev/null 2>&1; then docker context use "$DESKTOP_CTX" >/dev/null; else docker context use default >/dev/null; fi
    status
    ;;
  status) status ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
