#!/bin/sh
# Check what the agent's shell can do inside one user's sandbox: which tools exist, whether the proxy variables are set, whether
# credential-shaped variables (the model token) are hidden, and what the egress proxy allows and refuses.
#
#   scripts/probe-agent-shell.sh dsh-sbx-11            run the probe in the container directly (the control)
#   scripts/probe-agent-shell.sh dsh-sbx-11 --agent    also have the real agent run it with its bash tool (one real model call,
#                                                      counted against that user's token allowance)
#
# Needs: the sandbox container running, and docker pointed at the right daemon (scripts/lima/docker-context.sh). It writes
# /workspace/probe-shell.sh in that sandbox and removes it again. It contacts example.com only (PROBE_HOST overrides it), plus
# two addresses it expects to be refused (the cloud metadata address and a private one). Use a throwaway account.
set -eu
usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  ""|-*) usage >&2; exit 2 ;;
esac
CONTAINER="$1"
AGENT=no
case "${2:-}" in
  "") ;;
  --agent) AGENT=yes ;;
  *) echo "unknown option: $2 (try --help)" >&2; exit 2 ;;
esac
HOST="${PROBE_HOST:-example.com}"

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
  echo "$CONTAINER is not a running container (start the workspace first, and check the docker context)" >&2
  exit 1
fi

# The probe itself: plain POSIX sh plus node (the only runtime the image is known to have).
probe_script() {
  cat <<EOF
echo "== whoami: \$(id -un) uid=\$(id -u)  cwd=\$(pwd)"
echo "== proxy-related variables (the proxy address, not secrets):"
env | grep -i -E '^(https?_proxy|no_proxy|node_use_env_proxy)=' | sort
echo "== credential-shaped names visible to this shell (names only):"
env | grep -i -E 'KEY|PASSWORD|SECRET|TOKEN' | sed 's/=.*//' | sort | tr '\n' ' '; echo "(end)"
echo "== tools:"; for t in curl wget git python3 pip jq rg unzip node npm httpx nuclei ffuf gobuster sqlmap sslscan testssl gitleaks osv-scanner bandit pip-audit; do printf "%s=%s " \$t "\$(command -v \$t || echo -)"; done; echo
probe() { node -e "
const [name,url]=process.argv.slice(1);
const t=setTimeout(()=>{console.log(name,'TIMEOUT');process.exit()},12000);
fetch(url,{redirect:'manual'}).then(r=>{console.log(name,'HTTP',r.status);clearTimeout(t)}).catch(e=>{console.log(name,'FAILED',e.cause?.code||e.message);clearTimeout(t)})" "\$1" "\$2"; }
echo "== through the proxy:"
probe "public https :443 " https://$HOST/
probe "public http  :80  " http://$HOST/
probe "public port 8080  " http://$HOST:8080/
probe "metadata address  " http://169.254.169.254/latest/meta-data/
probe "private 10.0.0.1  " http://10.0.0.1/
echo "== ignoring the proxy (a direct socket to a public address):"
node -e "
const s=require('net').connect({host:'93.184.216.34',port:443,timeout:5000});
s.on('connect',()=>{console.log('direct TCP CONNECTED');process.exit()});
s.on('timeout',()=>{console.log('direct TCP TIMEOUT (no route)');process.exit()});
s.on('error',e=>{console.log('direct TCP FAILED',e.code);process.exit()});"
EOF
}

cleanup() { docker exec -u dsh "$CONTAINER" rm -f /workspace/probe-shell.sh /workspace/agent-run.out >/dev/null 2>&1 || true; }
trap cleanup EXIT

probe_script | docker exec -i -u dsh "$CONTAINER" sh -c 'cat > /workspace/probe-shell.sh'
echo "### control: the script run directly in $CONTAINER"
docker exec -u dsh "$CONTAINER" sh /workspace/probe-shell.sh

if [ "$AGENT" = yes ]; then
  echo
  echo "### agent: the same script run by the agent's own bash tool (a real model call)"
  docker exec -u dsh -w /workspace "$CONTAINER" sh -c 'timeout 240 dsh --profile headless --patch /tmp/dsh-cloud-patch.yml "Use your bash tool to run exactly this one command: sh /workspace/probe-shell.sh   Then reply with the complete raw output of the command and nothing else." > /workspace/agent-run.out 2>&1; echo "dsh exit: $?"'
  # The final answer is the last block of the output; the reasoning before it is shown too, which is useful when the agent misbehaves.
  docker exec -u dsh "$CONTAINER" cat /workspace/agent-run.out
fi
