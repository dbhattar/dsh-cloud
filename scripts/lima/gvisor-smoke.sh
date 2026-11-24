#!/bin/sh
# Smoke test: the same container under runc and under gVisor. Under runsc the kernel
# reported is gVisor's, not the VM's, which shows the sandbox no longer talks to the host kernel.
set -eu
NAME="${DSH_VM_NAME:-dsh-linux}"
for rt in runc runsc; do
  echo "== runtime: $rt"
  limactl shell "$NAME" -- sudo docker run --rm --runtime="$rt" alpine:3 sh -c 'uname -sr; head -c 200 /proc/version; echo'
done
