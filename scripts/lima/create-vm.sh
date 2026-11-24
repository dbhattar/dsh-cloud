#!/bin/sh
# Creates and starts the Linux VM used to validate phase 4 isolation (gVisor).
# Docker Desktop's VM cannot host gVisor, so this is a separate rootful-Docker VM.
# Run once. Do NOT run `limactl start` a second time while the first is still booting:
# the two host agents collide and the second reports "host agent process has exited" even
# though the first VM comes up fine (this happened on the first run; see docs/lima-setup.md).
set -eu
NAME="${DSH_VM_NAME:-dsh-linux}"
if limactl list -q 2>/dev/null | grep -qx "$NAME"; then
  echo "instance $NAME already exists; use: limactl start $NAME" >&2
  exit 1
fi
limactl start --name="$NAME" --cpus="${DSH_VM_CPUS:-4}" --memory="${DSH_VM_MEMORY_GB:-6}" \
  --disk="${DSH_VM_DISK_GB:-40}" --tty=false template:docker-rootful
