# Configuration for a public host

Written 2026-11-28 with the container hardening and the production Caddy file ([security-review.md](security-review.md), SEC-10 and SEC-11). This is what the stack needs on a server that is not a developer's machine, and what is **not yet verified** there. The deployment pipeline is the next step and should read this first.

`scripts/vps/setup.sh` automates the host side of this page and writes the `.env` below ([vps-setup.md](vps-setup.md)); the tables say what it sets.

## What to put in `.env` (once, by hand, on the server)

Create the file on the server itself, mode 600, owned by the user that runs the stack. Do not generate it from CI.

| Setting | Value | Why |
| --- | --- | --- |
| `RUNNER_SECRET`, `LLM_ADMIN_SECRET` | from `scripts/gen-secrets.sh` (48 characters each) | The services refuse anything under 24 characters or under 10 different ones |
| `UPSTREAM_API_KEY` | the model provider's key | Held by the llm-proxy only |
| `DOMAIN` | `cloud.example.com` | Caddy's site address; with it unset production Caddy refuses to start |
| `PUBLIC_URL` | `https://cloud.example.com/` | What the gateway uses in cookies and links; must match `DOMAIN` (https, trailing slash) |
| `CADDYFILE` | `Caddyfile.production` | The default is the development file (`localhost`, a local certificate) |
| `SANDBOX_RUNTIME` | leave **unset** (gVisor) | The runner refuses `runc` or an empty value; do not set `ALLOW_INSECURE_RUNTIME` |
| `ALLOW_SIGNUP` | leave `false` | Invites and the waitlist only |
| `EGRESS_ALLOW_HOSTS` | the hosts users may reach, before sign-ups open | Otherwise any public host on 80 and 443 (SEC-16) |
| `MAX_DISK_MB`, `MAX_TOTAL_DISK_MB` | per-user and total storage limits | `MAX_DISK_MB` is on by default (2048); the total is off until set |
| `MAIL_*`, `MAILGUN_*` | see [email.md](email.md) | Optional |

`scripts/gen-secrets.sh` prints values and writes nothing. Keep them out of the chat, tickets and commit messages.

## What the compose file now does

- **Ports:** only Caddy publishes any: 80 (certificate challenge and redirect), 443 and 443/udp (HTTP/3). No other service has a `ports:` entry; the gateway has no TCP port at all (unix socket shared with Caddy).
- **Every long-running service** drops all capabilities, cannot gain privileges, has a read-only root filesystem and a small `/tmp`, a rotated log, a memory limit, a process limit and a restart policy.
- **Who runs as whom** (checked on the Lima stack, from `/proc/1/status` of each container):

| Service | User | Capabilities kept | Why |
| --- | --- | --- | --- |
| gateway | `node` (uid 1000), after a root start that drops everything | none | it starts as root with CHOWN, SETUID and SETGID only to take over volumes made by older versions, then runs `setpriv` to become `node` with an empty bounding set |
| sandbox-runner | root | `DAC_OVERRIDE` | to open the Docker socket whatever owns it (on a Lima VM it belongs to the Lima user; on most hosts to `root:docker`) |
| llm-proxy, egress-proxy | `node` | none | |
| Caddy | root | `NET_BIND_SERVICE` | to listen on 80 and 443; it reaches the gateway's socket through group 1000, not through a capability |

- **The Docker socket** is still root-equivalent on the host. The runner's API cannot be steered into a privileged container (the container specification is built from a user id and a token only), and the runner now has a minimal capability set and a read-only filesystem, but a bug in the runner would still be a bug in a process holding the socket. A socket-filtering proxy in front of Docker, or running the runner as a non-root user in the socket's group (`group_add` with the socket's gid, no capability at all), would reduce that further and was **not** done.

## Not verified on a real server

- **Certificate issuance.** `Caddyfile.production` was validated with `caddy validate` (and refuses to start without `DOMAIN`), but it has not been run on a public name: no certificate has been requested, and the redirect, HSTS and body limit were not seen working. Rate limits on repeated issuance apply while testing (use Let's Encrypt's staging CA first).
- **HTTP/3** (443/udp) published but not tested.
- **The firewall.** Docker publishes ports around `ufw`; a host rule in the `DOCKER-USER` chain is needed, and a check from outside that only 22, 80 and 443 answer (SEC-20, the pipeline checklist in [security-review.md](security-review.md)).
- **The runner on a host whose Docker socket is `root:docker`.** It should work with `DAC_OVERRIDE` as on Lima; only Lima was tried.
- **Docker data-root quotas and `daemon.json`** (`log-opts`, `default-address-pools`): host settings, not in this repository.
