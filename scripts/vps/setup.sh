#!/bin/sh
# Prepare a fresh Debian 12 or Ubuntu 22.04+ server (amd64 or arm64) to run dsh-cloud. Run it from a checkout of this repository:
#
#   sudo scripts/vps/setup.sh --domain cloud.example.com --ssh-key-file ~/deploy_key.pub
#   scripts/vps/setup.sh --dry-run --domain cloud.example.com     show what it would do; changes nothing; needs no root
#   sudo scripts/vps/setup.sh --only verify                       check an already prepared host
#
# What it does, in this order (--only and --skip take a comma-separated list of these names):
#   preflight  check the OS, architecture, memory and disk, and that the Docker address pool does not collide with this host's own networks
#   packages   ca-certificates curl gnupg ufw fail2ban unattended-upgrades jq openssl
#   docker     Docker Engine and the compose plugin from Docker's signed apt repository (key fingerprint checked)
#   gvisor     gVisor (runsc) from gVisor's signed apt repository, registered as a Docker runtime
#   daemon     /etc/docker/daemon.json merged with: bounded local logs, live-restore, a private address pool; refuses a daemon on TCP
#   firewall   ufw: deny in, allow SSH, 80, 443/tcp and 443/udp, and DENY traffic from the sandbox address pool to this host
#   upgrades   unattended security updates that never touch docker, containerd or runsc (a Docker restart stops every sandbox)
#   user       a deploy user (default dsh) in the docker group, its authorised key, and /opt/dsh-cloud
#   ssh        ONLY with --harden-ssh: no password logins, no root login (validated with sshd -t first)
#   env        a new .env (mode 600) with generated secrets, DOMAIN, PUBLIC_URL and the production Caddy file; never overwrites one
#   verify     runsc is registered and a container under it really runs on gVisor's kernel; the firewall; what is listening
#
# Options:
#   --domain NAME          the public name (needed by the env phase)
#   --user NAME            deploy user (default dsh)
#   --ssh-key-file FILE    public key(s) to authorise for the deploy user
#   --docker-pool CIDR     address pool for Docker networks (default 10.200.0.0/14, split into /28s); must not overlap this host's networks
#   --env-file FILE        where the env phase writes (default: .env in the repository)
#   --upstream-key-file F  file holding the model provider key (otherwise the UPSTREAM_API_KEY environment variable, or a hidden prompt)
#   --harden-ssh           enable the ssh phase
#   --yes                  allow restarting Docker when its configuration changed (this STOPS running containers)
#   --dry-run              print what would be done
#   --only LIST / --skip LIST
#   --help
#
# Safe to run again: each phase checks before it acts, a changed file is backed up beside itself (.dsh-bak-<time>), and nothing is
# overwritten that it did not write. It does NOT start the stack: see docs/vps-setup.md for the next steps. Secrets are never put on a
# command line or printed; the provider key is read from a file, the environment or a hidden prompt.
set -eu

PHASES="preflight packages docker gvisor daemon firewall upgrades user ssh env verify"
DOMAIN=""
DEPLOY_USER="dsh"
SSH_KEY_FILE=""
DOCKER_POOL="10.200.0.0/14"
ENV_FILE=""
UPSTREAM_KEY_FILE=""
HARDEN_SSH=0
YES=0
DRY=0
ONLY=""
SKIP=""
# Test hook: with DSH_VPS_ROOT set, every file is read and written under that directory and the root check is skipped.
ROOT="${DSH_VPS_ROOT:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DOCKER_KEY_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
SMOKE_IMAGE="node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54"
DOCKER_CHANGED=0

usage() { sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
bad() { printf 'ERROR: %s\n' "$*" >&2; exit 2; } # a mistake in how the script was called, as the other scripts exit
need_arg() { [ $# -ge 2 ] || bad "$1 needs a value (try --help)"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) need_arg "$@"; DOMAIN="$2"; shift ;;
    --user) need_arg "$@"; DEPLOY_USER="$2"; shift ;;
    --ssh-key-file) need_arg "$@"; SSH_KEY_FILE="$2"; shift ;;
    --docker-pool) need_arg "$@"; DOCKER_POOL="$2"; shift ;;
    --env-file) need_arg "$@"; ENV_FILE="$2"; shift ;;
    --upstream-key-file) need_arg "$@"; UPSTREAM_KEY_FILE="$2"; shift ;;
    --harden-ssh) HARDEN_SSH=1 ;;
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --only) need_arg "$@"; ONLY="$2"; shift ;;
    --skip) need_arg "$@"; SKIP="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) bad "unknown option: $1 (try --help)" ;;
  esac
  shift
done
[ -n "$ENV_FILE" ] || ENV_FILE="$REPO/.env"

# ---- validation of what the operator typed, before anything runs ----
case "$DEPLOY_USER" in *[!a-z0-9_-]*|'') bad "--user must be lower-case letters, digits, - or _" ;; esac
case "$DEPLOY_USER" in root) bad "--user must not be root" ;; esac
if [ -n "$DOMAIN" ]; then
  printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' || bad "--domain must be a lower-case host name such as cloud.example.com (no scheme, no path)"
fi
printf '%s' "$DOCKER_POOL" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/([0-9]|1[0-9]|2[0-4])$' || bad "--docker-pool must be an IPv4 network such as 10.200.0.0/14 (prefix 24 or shorter)"
for p in $(printf '%s' "$ONLY,$SKIP" | tr ',' ' '); do
  case " $PHASES " in *" $p "*) ;; *) bad "unknown phase '$p' (phases: $PHASES)" ;; esac
done

phase_on() {
  p="$1"
  [ -z "$ONLY" ] || case ",$ONLY," in *",$p,"*) ;; *) return 1 ;; esac
  case ",$SKIP," in *",$p,"*) return 1 ;; esac
  [ "$p" != ssh ] || [ "$HARDEN_SSH" = 1 ] || return 1
  return 0
}

# ---- helpers: nothing changes the host except through run, put_file and the few direct writes below ----
p() { printf '%s%s' "$ROOT" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
run() {
  # With the test hook (DSH_VPS_ROOT) commands are only printed, never run: the files are written under that directory, the host is not touched.
  if [ "$DRY" = 1 ] || [ -n "$ROOT" ]; then printf '    would run: %s\n' "$*"; else "$@"; fi
}
# put_file PATH MODE: the new content on stdin. Unchanged content is left alone; a changed file is backed up first.
put_file() {
  target="$(p "$1")"; mode="$2"; tmp="$(mktemp)"; cat > "$tmp"
  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then note "unchanged: $1"; rm -f "$tmp"; return 1; fi
  if [ "$DRY" = 1 ]; then note "would write $1 (mode $mode)"; sed 's/^/        | /' "$tmp"; rm -f "$tmp"; return 0; fi
  mkdir -p "$(dirname "$target")"
  [ ! -f "$target" ] || cp -p "$target" "$target.dsh-bak-$(date +%Y%m%d-%H%M%S)"
  cat "$tmp" > "$target"; chmod "$mode" "$target"; rm -f "$tmp"
  note "wrote $1"
  return 0
}
apt_install() { run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"; }

# ---- address arithmetic for the pool collision check (awk only, so it needs nothing installed) ----
overlaps() { # overlaps CIDR_A CIDR_B -> exit 0 when the two IPv4 networks share addresses
  awk -v a="$1" -v b="$2" 'function ip(s,  o){ split(s,o,"."); return ((o[1]*256+o[2])*256+o[3])*256+o[4] }
    function span(c,  x){ split(c,x,"/"); n=x[2]+0; sz=2^(32-n); lo=int(ip(x[1])/sz)*sz; return lo "," lo+sz-1 }
    BEGIN { split(span(a),A,","); split(span(b),B,","); exit !(A[1] <= B[2] && B[1] <= A[2]) }'
}

# ================================================================== phases
phase_preflight() {
  say "preflight"
  [ -f "$(p /etc/os-release)" ] || die "no /etc/os-release: this does not look like Debian or Ubuntu"
  # shellcheck disable=SC1090
  . "$(p /etc/os-release)"
  case "${ID:-}" in
    debian) [ "${VERSION_ID:-0}" -ge 12 ] 2>/dev/null || die "Debian 12 or newer is needed (this is ${PRETTY_NAME:-unknown})" ;;
    ubuntu) [ "${VERSION_ID%%.*}" -ge 22 ] 2>/dev/null || die "Ubuntu 22.04 or newer is needed (this is ${PRETTY_NAME:-unknown})" ;;
    *) die "only Debian and Ubuntu are supported (this is ${PRETTY_NAME:-${ID:-unknown}})" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported architecture $(uname -m) (amd64 and arm64 only: gVisor and the sandbox tools are built for those)" ;;
  esac
  note "${PRETTY_NAME:-$ID} on $ARCH"
  [ -d "$(p /run/systemd/system)" ] || [ -n "$ROOT" ] || die "systemd is required"
  [ ! -f /.dockerenv ] || warn "this looks like a container: Docker and gVisor need a real or virtual machine"
  if [ -r "$(p /proc/meminfo)" ]; then
    mem_mb=$(awk '/^MemTotal:/ { printf "%d", $2/1024 }' "$(p /proc/meminfo)")
    note "memory: ${mem_mb} MB"
    [ "$mem_mb" -ge 1800 ] || warn "under 2 GB of memory: the stack runs, but not many sandboxes (each may use 1 GB)"
  fi
  free_gb=$(df -Pk "$(p /)" 2>/dev/null | awk 'NR==2 { printf "%d", $4/1024/1024 }')
  [ -z "${free_gb:-}" ] || { note "free disk: ${free_gb} GB"; [ "$free_gb" -ge 20 ] || warn "under 20 GB free: sandboxes may use 2 GB each (MAX_DISK_MB) plus images and logs"; }
  # The pool must not overlap anything this host already routes (a provider's private network is often 10.x): the firewall step drops
  # sandbox traffic to the host by source address, so a collision would cut off legitimate traffic.
  if have ip; then
    for net in $( { ip -4 -o route show 2>/dev/null | awk '{print $1}'; ip -4 -o addr show 2>/dev/null | awk '{print $4}'; } | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$' | sort -u); do
      case "$net" in */*) ;; *) net="$net/32" ;; esac
      case "$net" in 0.0.0.0/0|169.254.*) continue ;; esac
      if overlaps "$DOCKER_POOL" "$net"; then die "the Docker address pool $DOCKER_POOL overlaps $net, which this host uses. Choose another with --docker-pool (for example 10.220.0.0/14)"; fi
    done
    note "address pool $DOCKER_POOL does not overlap this host's networks"
  fi
  if [ "$DRY" != 1 ] && [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo), or add --dry-run to only look"; fi
}

phase_packages() {
  say "packages"
  run apt-get update -qq
  apt_install ca-certificates curl gnupg ufw fail2ban unattended-upgrades jq openssl
}

phase_docker() {
  say "docker"
  if have docker && docker info >/dev/null 2>&1; then note "Docker is already installed and running: $(docker --version)"; return 0; fi
  # shellcheck disable=SC1090
  . "$(p /etc/os-release)"
  ! dpkg -s docker.io >/dev/null 2>&1 || warn "the distribution's docker.io package is installed; Docker's own packages replace it"
  run install -m 0755 -d /etc/apt/keyrings
  if [ "$DRY" = 1 ] || [ -n "$ROOT" ]; then
    note "would download https://download.docker.com/linux/$ID/gpg to /etc/apt/keyrings/docker.asc and REFUSE to go on unless its fingerprint is $DOCKER_KEY_FPR"
  else
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    got="$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '/^fpr:/ { print $10; exit }')"
    [ "$got" = "$DOCKER_KEY_FPR" ] || die "Docker's signing key has fingerprint $got, expected $DOCKER_KEY_FPR. Stopping: check https://docs.docker.com/engine/install/ before trusting it"
  fi
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$ARCH" "$ID" "${VERSION_CODENAME:-}" | put_file /etc/apt/sources.list.d/docker.list 0644 || true
  run apt-get update -qq
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run systemctl enable --now docker
}

phase_gvisor() {
  say "gvisor"
  if have runsc; then note "runsc is already installed: $(runsc --version 2>/dev/null | head -1)"; return 0; fi
  run install -m 0755 -d /usr/share/keyrings
  if [ "$DRY" = 1 ] || [ -n "$ROOT" ]; then
    note "would download https://gvisor.dev/archive.key into /usr/share/keyrings/gvisor-archive-keyring.gpg (its fingerprint is printed so you can compare it with gVisor's documentation)"
  else
    curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
    note "gVisor key fingerprint: $(gpg --show-keys --with-colons /usr/share/keyrings/gvisor-archive-keyring.gpg | awk -F: '/^fpr:/ { print $10; exit }')"
  fi
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' "$ARCH" | put_file /etc/apt/sources.list.d/gvisor.list 0644 || true
  run apt-get update -qq
  apt_install runsc
  run runsc install # adds the runsc runtime to /etc/docker/daemon.json
  DOCKER_CHANGED=1
}

phase_daemon() {
  say "daemon"
  conf="$(p /etc/docker/daemon.json)"
  wanted="$(printf '{"log-driver":"local","log-opts":{"max-size":"20m","max-file":"5"},"live-restore":true,"default-address-pools":[{"base":"%s","size":28}]}' "$DOCKER_POOL")"
  if [ -f "$conf" ]; then
    # A daemon listening on TCP is root for anyone who can reach the port.
    if jq -e '(.hosts // []) | any(test("^tcp://"))' "$conf" >/dev/null 2>&1; then die "$conf makes the Docker daemon listen on TCP (hosts: tcp://...). Remove that first: the daemon must be reachable by its unix socket only"; fi
    merged="$(jq -S -s '.[0] * .[1]' "$conf" - <<EOF
$wanted
EOF
)"
  else
    merged="$(printf '%s' "$wanted" | jq -S .)"
  fi
  if printf '%s\n' "$merged" | put_file /etc/docker/daemon.json 0644; then DOCKER_CHANGED=1; fi
  if [ "$DOCKER_CHANGED" = 1 ]; then
    if [ "$YES" = 1 ]; then
      say "restarting Docker (--yes): running containers stop"
      run systemctl restart docker
    else
      warn "Docker's configuration changed and Docker was NOT restarted. Restart it when nothing important is running: systemctl restart docker (or run this script again with --yes). Networks already created keep their old addresses; new ones use the pool."
    fi
  fi
}

ssh_port() {
  port="$(sshd -T 2>/dev/null | awk '/^port / { print $2; exit }')"
  printf '%s' "${port:-22}"
}

phase_firewall() {
  say "firewall"
  port="$(ssh_port)"
  note "SSH is on port $port: it is allowed before the firewall is switched on"
  # Order matters. The deny for the sandbox pool goes in FIRST (position 1), so the allow rules below never match sandbox traffic. Docker's
  # published ports (80 and 443, Caddy only) bypass ufw by design, and are what we want open; this rule is for traffic from a sandbox to
  # the host itself (SSH on the bridge address, anything listening on 0.0.0.0).
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw insert 1 deny from "$DOCKER_POOL" comment 'dsh-cloud: sandboxes may not reach this host'
  run ufw allow "$port/tcp" comment 'ssh'
  run ufw allow 80/tcp comment 'http (certificate challenge, redirect)'
  run ufw allow 443/tcp comment 'https'
  run ufw allow 443/udp comment 'http/3'
  run ufw --force enable
  note "Docker publishes only Caddy's ports; nothing else should answer from outside. Check from another machine after the stack is up."
}

phase_upgrades() {
  say "upgrades"
  put_file /etc/apt/apt.conf.d/52dsh-cloud-unattended 0644 <<'EOF' || true
// Security updates install themselves, but never the packages whose upgrade restarts Docker (which stops every sandbox), and never reboot.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Package-Blacklist {
  "docker-ce";
  "docker-ce-cli";
  "containerd.io";
  "docker-buildx-plugin";
  "docker-compose-plugin";
  "runsc";
};
EOF
  run systemctl enable --now unattended-upgrades
  put_file /etc/fail2ban/jail.d/dsh-cloud.local 0644 <<EOF || true
[sshd]
enabled = true
port = $(ssh_port)
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  run systemctl enable --now fail2ban
  note "kernel and docker upgrades are yours to schedule: apt list --upgradable, then a planned restart"
}

phase_user() {
  say "user"
  if id "$DEPLOY_USER" >/dev/null 2>&1; then note "user $DEPLOY_USER exists"; else run useradd --create-home --shell /bin/bash "$DEPLOY_USER"; fi
  run usermod -aG docker "$DEPLOY_USER"
  warn "$DEPLOY_USER is in the docker group, which is root-equivalent on this host. Give it only to a key that is used for deploying and nothing else (docs/security-review.md)."
  home="$(p "/home/$DEPLOY_USER")"
  if [ -n "$SSH_KEY_FILE" ]; then
    [ -r "$SSH_KEY_FILE" ] || die "cannot read --ssh-key-file $SSH_KEY_FILE"
    grep -Eq '^(ssh-(ed25519|rsa)|ecdsa-sha2-[a-z0-9]+|sk-ssh-ed25519@openssh.com) ' "$SSH_KEY_FILE" || die "$SSH_KEY_FILE does not look like a public key (it must start with ssh-ed25519, ssh-rsa or ecdsa-sha2-)"
    if grep -q 'PRIVATE KEY' "$SSH_KEY_FILE"; then die "$SSH_KEY_FILE holds a PRIVATE key. Give the .pub file and keep the private key off the server"; fi
    if [ "$DRY" = 1 ]; then note "would authorise the key(s) in $SSH_KEY_FILE for $DEPLOY_USER"; else
      mkdir -p "$home/.ssh"; chmod 700 "$home/.ssh"; touch "$home/.ssh/authorized_keys"
      while IFS= read -r line; do [ -n "$line" ] && ! grep -qxF "$line" "$home/.ssh/authorized_keys" && printf '%s\n' "$line" >> "$home/.ssh/authorized_keys"; done < "$SSH_KEY_FILE"
      chmod 600 "$home/.ssh/authorized_keys"
      [ -n "$ROOT" ] || chown -R "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh"
      note "authorised the key(s) for $DEPLOY_USER"
    fi
  else
    note "no --ssh-key-file: $DEPLOY_USER has no key yet (needed before --harden-ssh)"
  fi
  run install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /opt/dsh-cloud
}

phase_ssh() {
  say "ssh (--harden-ssh)"
  keys="$(p "/home/$DEPLOY_USER/.ssh/authorized_keys")"
  [ -s "$keys" ] || [ "$DRY" = 1 ] || die "refusing to disable password logins: $DEPLOY_USER has no authorised key ($keys). Run with --ssh-key-file first, and test that you can log in as $DEPLOY_USER"
  put_file /etc/ssh/sshd_config.d/50-dsh-cloud.conf 0644 <<'EOF' && changed=1 || changed=0
# Written by scripts/vps/setup.sh --harden-ssh: keys only, no root.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
MaxAuthTries 3
EOF
  if [ "$changed" = 1 ] && [ "$DRY" != 1 ] && [ -z "$ROOT" ]; then
    if ! sshd -t; then rm -f "$(p /etc/ssh/sshd_config.d/50-dsh-cloud.conf)"; die "sshd rejects the configuration; the new file was removed and nothing was reloaded"; fi
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    warn "SSH now accepts keys only and no root login. KEEP THIS SESSION OPEN and log in as $DEPLOY_USER from another terminal to check before you close it."
  fi
}

phase_env() {
  say "env"
  [ -n "$DOMAIN" ] || die "the env phase needs --domain (or skip it with --skip env)"
  want="RUNNER_SECRET LLM_ADMIN_SECRET UPSTREAM_API_KEY DOMAIN PUBLIC_URL CADDYFILE"
  if [ -f "$ENV_FILE" ]; then
    note "$ENV_FILE exists and is left alone"
    for k in $want; do grep -Eq "^[[:space:]]*$k=." "$ENV_FILE" || warn "$ENV_FILE has no value for $k"; done
    return 0
  fi
  key=""
  if [ -n "$UPSTREAM_KEY_FILE" ]; then
    [ -r "$UPSTREAM_KEY_FILE" ] || die "cannot read --upstream-key-file $UPSTREAM_KEY_FILE"
    key="$(head -n 1 "$UPSTREAM_KEY_FILE")"
  elif [ -n "${UPSTREAM_API_KEY:-}" ]; then
    key="$UPSTREAM_API_KEY"
  elif [ "$DRY" != 1 ] && [ -t 0 ]; then
    printf 'Model provider API key (typing is hidden; leave empty to add it later): ' >&2
    stty -echo 2>/dev/null || true; read -r key || true; stty echo 2>/dev/null || true; printf '\n' >&2
  fi
  [ -n "$key" ] || warn "no provider key given: UPSTREAM_API_KEY stays empty in $ENV_FILE and the stack will not start until you set it"
  if [ "$DRY" = 1 ]; then
    note "would create $ENV_FILE (mode 600) with RUNNER_SECRET and LLM_ADMIN_SECRET generated, UPSTREAM_API_KEY ($([ -n "$key" ] && echo given || echo empty)), DOMAIN=$DOMAIN, PUBLIC_URL=https://$DOMAIN/, CADDYFILE=Caddyfile.production, ALLOW_SIGNUP=false"
    return 0
  fi
  have openssl || die "openssl is needed to generate secrets (install it, or run the packages phase)"
  umask 077
  {
    printf '# Created by scripts/vps/setup.sh. Mode 600. Do not commit, paste or copy it into a CI secret store; see docs/production-config.md.\n'
    printf 'RUNNER_SECRET=%s\n' "$(openssl rand -hex 24)"
    printf 'LLM_ADMIN_SECRET=%s\n' "$(openssl rand -hex 24)"
    printf 'UPSTREAM_API_KEY=%s\n' "$key"
    printf 'DOMAIN=%s\nPUBLIC_URL=https://%s/\nCADDYFILE=Caddyfile.production\n' "$DOMAIN" "$DOMAIN"
    printf 'ALLOW_SIGNUP=false\n'
    printf '# Set before opening sign-ups: the hosts users may reach (otherwise any public host on 80 and 443).\n# EGRESS_ALLOW_HOSTS=\n'
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  [ -n "$ROOT" ] || ! id "$DEPLOY_USER" >/dev/null 2>&1 || chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE" 2>/dev/null || true
  note "created $ENV_FILE (mode 600); the secrets were generated here and are not shown"
}

phase_verify() {
  say "verify"
  fail=0
  if have docker && docker info >/dev/null 2>&1; then
    runtimes="$(docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null)"
    case " $runtimes" in *" runsc "*) note "runsc is registered with Docker" ;; *) warn "runsc is NOT registered with Docker (runtimes: $runtimes)"; fail=1 ;; esac
    if [ "$DRY" != 1 ] && [ -z "$ROOT" ] && case " $runtimes" in *" runsc "*) true ;; *) false ;; esac; then
      out="$(docker run --rm --runtime=runsc --network none "$SMOKE_IMAGE" sh -c 'head -c 200 /proc/version' 2>&1 || true)"
      case "$out" in *gVisor*|*4.4.0*) note "a container under runsc runs on gVisor's kernel: $(printf '%s' "$out" | head -c 90)" ;; *) warn "the runsc smoke test did not show gVisor's kernel: $out"; fail=1 ;; esac
    fi
    docker info --format '{{.LoggingDriver}}' 2>/dev/null | grep -q local && note "Docker logs use the local driver" || warn "Docker's log driver is not 'local' (restart Docker after the daemon phase)"
    if ss -ltn 2>/dev/null | grep -Eq ':(2375|2376)\b'; then warn "something listens on the Docker TCP port 2375/2376"; fail=1; fi
  else
    warn "Docker is not running or not installed"; fail=1
  fi
  if have ufw; then ufw status 2>/dev/null | head -12 | sed 's/^/    /'; else warn "ufw is not installed"; fail=1; fi
  if have ss; then note "listening on TCP (should be only SSH, and 80 and 443 once the stack runs):"; ss -ltnH 2>/dev/null | awk '{print $4}' | sort -u | sed 's/^/        /'; fi
  [ "$fail" = 0 ] && say "verify: ok" || warn "verify found problems (above)"
}

# ================================================================== run
[ "$DRY" != 1 ] || say "DRY RUN: nothing will be changed"
for ph in $PHASES; do
  phase_on "$ph" || continue
  "phase_$ph"
done
cat <<EOF

Next (docs/vps-setup.md): log in as $DEPLOY_USER, clone the repository to /opt/dsh-cloud, put the harness build in place, point DNS for ${DOMAIN:-your domain} at this host,
check the firewall from outside, then start the stack with  docker compose --env-file .env -f infra/docker-compose.gateway.yml up -d
EOF
