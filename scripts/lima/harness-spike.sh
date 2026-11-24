#!/bin/sh
# Phase 4 spike A1: does the sandbox image (deepseek-harness web profile) work under gVisor,
# with the same hardening the gateway applies (drop all caps, no-new-privileges, limits)?
#
# Builds sandbox/ inside the Lima VM (it reads the repo through the VM's read-only host mount),
# then for each runtime (runc, runsc) starts the container and reports:
#   1. whether dsh boots and prints its launch token,
#   2. whether the user-namespace / bwrap primitives the harness's Linux sandbox needs work.
# Needs sandbox/.harness-dist (scripts/build-harness.sh). Output goes to stdout; redirect to keep it.
set -eu
NAME="${DSH_VM_NAME:-dsh-linux}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMG=dsh-sandbox:spike
vm() { limactl shell "$NAME" -- "$@"; }

[ -f "$REPO/sandbox/.harness-dist/apps/cli/lib/bin.js" ] || { echo "run scripts/build-harness.sh first" >&2; exit 1; }
echo "==> building $IMG in the VM"
vm sudo docker build -q -t "$IMG" "$REPO/sandbox" >/dev/null

for rt in runc runsc; do
  c="dsh-spike-$rt"
  vm sudo docker rm -f "$c" >/dev/null 2>&1 || true
  echo; echo "=================== runtime: $rt"
  vm sudo docker run -d --name "$c" --runtime="$rt" \
    --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=256 --memory=1g --cpus=1 \
    -e DSH_PUBLIC_URL=https://localhost/ -e DSH_TRUSTED_HOST=localhost "$IMG" >/dev/null
  echo "-- boot (waiting up to 60s for the launch token)"
  i=0
  until vm sudo docker logs "$c" 2>&1 | grep -q 'token='; do
    i=$((i + 1)); [ "$i" -gt 30 ] && { echo "NO TOKEN; last logs:"; vm sudo docker logs --tail 15 "$c" 2>&1; break; }
    [ "$(vm sudo docker inspect -f '{{.State.Running}}' "$c")" = true ] || { echo "container exited; logs:"; vm sudo docker logs --tail 15 "$c" 2>&1; break; }
    sleep 2
  done
  vm sudo docker logs "$c" 2>&1 | grep -q 'token=' && echo "dsh booted (launch token printed)"
  echo "-- kernel seen by the container"
  vm sudo docker exec "$c" uname -sr
  echo "-- sandbox primitives (as the dsh user)"
  vm sudo docker exec "$c" sh -c '
    command -v bwrap >/dev/null 2>&1 && echo "bwrap: $(bwrap --version)" || echo "bwrap: not installed in image"
    unshare -Ur true 2>&1 && echo "user namespaces: OK" || echo "user namespaces: DENIED"
    if command -v bwrap >/dev/null 2>&1; then
      bwrap --ro-bind / / --dev /dev --unshare-pid true 2>&1 && echo "bwrap confine: OK" || echo "bwrap confine: FAILED"
    fi
    grep -E "Seccomp|NoNewPrivs|CapEff" /proc/self/status
  ' 2>&1 || true
  vm sudo docker rm -f "$c" >/dev/null
done
