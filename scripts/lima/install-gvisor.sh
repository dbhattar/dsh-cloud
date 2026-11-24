#!/bin/sh
# Installs gVisor (runsc) in the Lima VM from gVisor's signed apt repository and registers it
# as a Docker runtime named "runsc". The direct-download URL
# (storage.googleapis.com/gvisor/releases/release/latest/<arch>/runsc) returns 404 now; the
# gVisor install docs recommend the apt repo, whose packages are signed by gvisor.dev/archive.key.
set -eu
NAME="${DSH_VM_NAME:-dsh-linux}"
limactl shell "$NAME" -- sudo sh -s <<'VM'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq apt-transport-https ca-certificates curl gnupg
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list
apt-get update -qq
apt-get install -y -qq runsc
runsc install                  # adds the runsc runtime to /etc/docker/daemon.json
systemctl restart docker
docker info --format '{{range $name, $rt := .Runtimes}}runtime: {{$name}}{{println}}{{end}}'
runsc --version | head -1
VM
