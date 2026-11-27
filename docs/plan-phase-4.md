# Phase 4: hardening for untrusted users

Status: **implemented (2026-11-24)** for a Linux host running gVisor. Every task A1 to G2 is done; the suites for phases 2 to 4 pass under gVisor in the Lima VM (see "G1 result"). What is not done is listed under "What is left" below. Decisions D1, D4 and D5 were confirmed as recommended (Linux production host, filtered egress proxy, invite codes plus global budget); D2, D3 and D6 took the recommendations. Parent plan: [plan.md](plan.md). Inputs: [production-readiness.md](production-readiness.md) and [harness-production-gaps.md](harness-production-gaps.md).

Notes on how it ended up differing from the plan: the separate control network was dropped (sandboxes are never on the compose network, so the runner sits beside the gateway and stays unreachable from them; this also avoided a recurring Compose bug that attached services to only one of two networks). C2 used a unix socket instead of a second TCP port, because the llm-proxy is attached to every user network and any TCP listener would be reachable from every sandbox. gVisor sandboxes cannot use Docker's embedded DNS, so shared services have fixed addresses and `ExtraHosts` entries. The agent's shell needs gVisor: under `runc` the harness fails closed.

Where to read more, by task: A1 [lima-setup.md](lima-setup.md); A2 and F1 [research-harness-policy.md](research-harness-policy.md); B1 and B2 and C1 [../runner/README.md](../runner/README.md); C2 [design-admin-socket.md](design-admin-socket.md); C3 [../egress-proxy/README.md](../egress-proxy/README.md); D1 to D3 "Limits and signup control" below; E1 "Audit log" below; E2 [backup.md](backup.md); E3 [build-pinning.md](build-pinning.md); G1 "G1 result" below.

## What is left

Not done, in rough order of importance:
- **No formal sandbox-escape review**, and no microVM backend (Kata or Firecracker). gVisor is a second kernel, not a proof; the "Risks" section says what it does and does not cover.
- **Only `linux-arm64` and Docker 29 were exercised** (the Lima VM). `linux-x64` and a bare-metal Linux host were not; volume ownership for the admin socket has been seen on Docker Desktop and the VM only.
- **Disk limits are checked, not enforced.** A user can write past the limit between checks and restart after a stop. A hard bound needs filesystem quotas.
- **The browser UI of the locked-down policy** (preset selector, approval prompt, directory picker) has not been looked at. The directory picker was left enabled.
- **Under plain `runc` the agent has no shell tool** (user namespaces denied, Landlock launcher not built into the image).
- **The harness in a sandbox can exit under CPU starvation or a fork bomb**; the gateway restarts it. The cause was not investigated.
- **Backups are full copies** with no encryption or off-host step; workspaces are not crash-consistent.
- **The CI workflow has never run on GitHub**; its manual gVisor job needs a self-hosted runner that does not exist yet.
- **Account basics** (password reset, email verification, account deletion), monitoring and alerting, real TLS and domain configuration, and high availability are out of scope for this phase.

## Problem

Phases 1-3 give each user a container, a login and a metered model key. They do not contain a hostile user. Today a sandbox can reach every other sandbox, the gateway, the llm-proxy admin route, cloud metadata and the internet. It shares the host kernel, has no disk or wall-clock limit, and the gateway holds the Docker socket. Signup is open, and quotas are per account.

## Goal and non-goals

Goal: a malicious user with full shell access inside their sandbox cannot reach another user's data, the control plane, internal services or the host, and cannot consume unbounded host or provider resources.

Non-goals: billing, an admin UI, multi-host orchestration (Kubernetes), HA, and changes to the harness itself unless a spike (task F1) proves one is unavoidable.

## Decisions to confirm before starting

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Isolation runtime. gVisor and Kata need a Linux host with the runtime installed. Local dev is macOS Docker Desktop. | Make the runtime configurable (`SANDBOX_RUNTIME`, default `runc` for dev). Production uses gVisor (`runsc`) on a Linux host. Kata or Firecracker only if gVisor fails the harness spike (A1). |
| D2 | Docker socket. | Move it out of the gateway into a small `sandbox-runner` service with a fixed, hardened container spec and a narrow API (ensure, stop, inspect, logs). A compromised gateway can then no longer create privileged containers. A socket proxy is the cheaper fallback but cannot validate container specs. |
| D3 | Network model. | One internal Docker network per user (`dsh-net-<id>`, `Internal: true`, so no default route). The gateway and llm-proxy attach to it. Sandboxes cannot see each other. Web access goes through an egress proxy (D4). |
| D4 | Web access for the agent. | Allow it through a filtering forward proxy that denies private ranges, link-local and metadata addresses, with no SOCKS. The harness honours `HTTP(S)_PROXY`. If you want no web access, drop the proxy and the sandbox network stays fully internal. |
| D5 | Signup control. | Invite codes plus a global daily token budget in the llm-proxy, with signup off by default. Email verification needs SMTP and can follow. |
| D6 | Disk limits. | The enforcement method depends on the host filesystem (xfs project quotas versus none). Portable default: the reaper reads per-volume usage from the Docker API and stops and flags users over the limit. Use `StorageOpt` quotas where the host supports them. |

## Design

```
Browser ─> Caddy ─> gateway ──(narrow API)──> sandbox-runner ──> Docker daemon
                       │  │                         │
                       │  └─ unix socket ──> llm-proxy admin API   (volume llm-admin, gateway + llm-proxy only)
                       │                            │
                       │                  creates per user: network dsh-net-<id> (internal),
                       │                  container (runtime=runsc, read-only rootfs, tmpfs /tmp, limits)
                       │
   compose network:  caddy, gateway, sandbox-runner, llm-proxy        (sandboxes never attached)
   dsh-net-<id>:     gateway, llm-proxy (/v1 only), egress-proxy (C3), sandbox-<id>
```

- The llm-proxy serves its user API (`/v1/*`) over TCP on the compose and per-user networks, and its admin API only on a unix socket shared with the gateway. A TCP admin port would be reachable from every sandbox, because the proxy is attached to every user network. See [design-admin-socket.md](design-admin-socket.md).
- The egress proxy is the only path out of a user network. It resolves the destination itself and refuses private, loopback, link-local and metadata addresses, which also closes the harness web-fetch gap.
- The sandbox-runner builds the container spec itself from `userId` only, so the caller cannot pass binds, capabilities or privileged flags.

## G1 result

`tests/phase4/isolation.test.mjs` and `tests/phase4/limits.test.mjs` ran green on the Lima VM (Linux 7.0 aarch64, Docker 29, `SANDBOX_RUNTIME=runsc`): 21 of 21. Together with the unit suites, every bullet of G1 has a test.

What the first runs found (all fixed):
- **A real bug**: `scripts/audit.sh --json` as the first flag was ignored, because the CLI took the first flag as an action. Found by the limits suite; now covered by a unit test.
- **Stale test** from C3: the per-user network membership list lacked the egress proxy.
- **Tests that assumed runc**: under gVisor `spawn` throws `ENOMEM` at the process limit instead of failing asynchronously.
- **Found later (2026-11-27), not by these suites:** a refused `CONNECT` followed by a client reset made the CONNECT socket emit an error with no listener, which is an uncaught exception, so **the egress proxy, shared by every sandbox, exited**. Any sandbox could have done it on purpose. Fixed in the egress-proxy, with regression tests (`tests/egress-proxy/scope-limits.test.mjs`). Full write-up, including the impact and the follow-ups (no service has a restart policy): [finding-egress-proxy-crash.md](finding-egress-proxy-crash.md). The abuse suite did not reset a connection after a refusal.

What abuse does, observed:
- **Fork bomb**: the process limit holds (about 250 of 700 spawns succeed, the rest fail), the neighbour answers `docker exec` within seconds. The harness in the abused sandbox sometimes exits.
- **CPU spin** at four busy loops on a one-CPU limit: CPU stays at the limit, the neighbour is unaffected, and the harness in the abused sandbox exited in the suite run (exit code 2). This is not the OOM killer and not a platform stop (a graceful stop exits 0).
- **Memory hog**: killed at the limit, no swap; the kernel's OOM kill is scoped to that container under both `runc` and `runsc` (checked with a standalone container). The neighbour is untouched.
- **`/tmp` fill** stops at the tmpfs size (`No space left on device`), the root filesystem stays read-only.
- **Recovery**: when the harness exits, the gateway restarts the sandbox on the user's next request; the suite asserts that.

Not investigated: why the harness exits under CPU starvation (it did not exit in a manual single run, so it depends on timing). It only affects the abusing user and recovers, so it is accepted, but a user doing a heavy build could see the same, which is a product question for the CPU limit rather than a security one.

## Limits and signup control

All defaults below are what compose sets; the code defaults every limit to off (0) so unit tests and bare runs are unaffected.

| Setting | Compose default | Where | Behaviour |
| --- | --- | --- | --- |
| `MAX_RUNNING_SANDBOXES` | 20 | gateway | A start is checked against the runner's list under a lock, so two newcomers cannot both take the last slot. When full, the longest-idle sandbox with no open sockets and at least `EVICT_AFTER_IDLE_SECONDS` (300) of idle time is stopped to make room; if none qualifies the start fails with "at capacity" on the launching page. A sandbox that is already running is never refused. |
| `MAX_RUN_SECONDS` | 28800 (8 h) | gateway reaper | A sandbox running longer is stopped, whether or not it is in use. Files are kept. |
| `MAX_DISK_MB` | 2048 | gateway reaper + runner `GET /v1/usage` | Every `DISK_CHECK_SECONDS` (300) the runner reports bytes per user over both volumes (Docker's volume sizes); running sandboxes over the limit are stopped with their usage in the message. |
| `ALLOW_SIGNUP` | `false` | gateway | Sign-up needs an invite code unless `true`. Codes are single use, optionally expiring, stored hashed, created with `scripts/invite.sh create [n] [--note T] [--days N]`. The account and the spent code are one transaction, a duplicate email does not burn a code, and every sign-up attempt counts toward the per-address rate limit. |
| `GLOBAL_DAILY_TOKEN_BUDGET` | 5000000 | llm-proxy | Tokens for all users together per UTC day. When used up every request gets 429 `budget_exhausted` with a `Retry-After` until midnight UTC, before any provider call. |

A sandbox stopped by a limit is **held**: requests from an open browser tab do not restart it (that would defeat the limit); only the launching page's explicit start does, which clears the hold and the clock. The launching page shows the reason.

Limits of the design:
- **Disk is checked, not enforced.** A user can write past the limit for up to `DISK_CHECK_SECONDS`, and after a stop can start again and fill the disk again. For a hard bound use `StorageOpt` quotas on a filesystem that supports them (xfs project quotas) or a per-user size-limited volume; that is host specific and not done here.
- **Docker computes volume sizes on demand**, which can take seconds with many volumes; the check runs off the request path.
- **Eviction is by gateway memory.** After a gateway restart "last seen" is reset, so nothing is evictable until `EVICT_AFTER_IDLE_SECONDS` has passed.
- **The budget is a blunt instrument.** One heavy user can use it up for everyone until midnight UTC; the per-user quotas are what stop that.
- **Run time and holds are not persisted.** A gateway restart forgets holds (the run-time clock comes from the container's start time, so it is re-applied at the next reap, and disk at the next check).

Checked live in the Lima VM under gVisor: invite flow (no code, wrong code, valid, reused: 400, 400, 303, 400; second code 303), capacity (cap 1 refused a second sandbox with the message), run time (stopped at the limit and held, an explicit start cleared it), disk (a 3 MB file against a 1 MB limit stopped the sandbox with the usage message).

## Audit log

Gateway events are rows in the `audit` table (`ts`, `event`, `user_id`, `ip`, `detail` JSON) and also one `audit {json}` line each on the gateway's stdout, so either copy survives. Read them with `scripts/audit.sh [--user ID] [--event NAME|PREFIX.] [--since 24h|7d] [--limit N] [--json]`. Rows older than `AUDIT_RETENTION_DAYS` (90, 0 = keep) are purged hourly.

| Events | Detail |
| --- | --- |
| `signup.ok`, `signup.fail` | `viaInvite`; `reason`: `invalid_email`, `weak_password`, `invite_invalid`, `email_taken`, `rate_limited` |
| `login.ok`, `login.fail`, `logout` | `reason`: `bad_credentials`, `rate_limited`; a failure is tied to the real account's id when the email exists |
| `sandbox.create`, `sandbox.recreate`, `sandbox.start`, `sandbox.start_failed`, `sandbox.stop`, `sandbox.evicted`, `sandbox.refused` | `by`: `user`, `idle`, `evicted`, `limit:run_time`, `limit:disk`; `reason`: `capacity`, `held`, `pre_proxy`, `stale_network`; start time in ms |
| `token.issue` | the user only, never the token |
| `admin.invite_create` | count and note, written by the CLI |

The llm-proxy writes its own `audit {json}` lines to its stdout: `token.issue`, `token.revoke`, `quota.hit` (window, used, limit) and `budget.exhausted`. Quota and budget hits are throttled to one line per user per 10 minutes, since every blocked request would otherwise add one.

What is deliberately not recorded: passwords (typed or attempted), session and proxy tokens, invite codes, prompts and model output. An email is stored on a failed sign-in or sign-up only if it parses as an email, so a password typed into the wrong field is not kept.

Limits: recording is best effort (a database error is logged and never fails the request), so the trail can have gaps if the disk is full. The rows live in the gateway database next to the accounts, so anyone who can tamper with that can tamper with the trail; ship the stdout lines to an external store if you need tamper evidence. Reads of the admin API by the gateway (usage lookups) are not audited. `ip` is the address Caddy forwards (`X-Forwarded-For`); behind Docker's port forwarding it can be the bridge address.

## Isolation runtime: where gVisor and Lima fit

Two different things that are easy to mix up: **gVisor** is part of the product design (what sandboxes run on in production). **Lima** is only development tooling (a way to get a Linux machine with gVisor on a Mac). Nothing in production uses Lima.

### gVisor: a second kernel between the sandbox and the host

Plain Docker (`runc`) puts a container in namespaces and cgroups, but its processes make system calls straight into the **host kernel**. A kernel bug reachable from a syscall is then a path from a hostile user's shell to the host. gVisor (`runsc`) is an alternative OCI runtime that interposes its own kernel, written in Go and running in user space, so the sandbox's syscalls never reach the host kernel directly.

```
 runc (default)                                runsc (gVisor)

 ┌─────────────────────────┐                   ┌─────────────────────────┐
 │ sandbox process (user)  │                   │ sandbox process (user)  │
 └────────────┬────────────┘                   └────────────┬────────────┘
              │ syscalls, directly                          │ syscalls
              │                                ┌────────────▼────────────┐
              │                                │ gVisor "Sentry"         │  user-space kernel
              │                                │ (implements ~Linux ABI) │  uname: 4.19.0-gvisor
              │                                └────────────┬────────────┘
              │                                             │ small, filtered set of host calls
 ┌────────────▼────────────┐                   ┌────────────▼────────────┐
 │ HOST KERNEL             │                   │ HOST KERNEL             │
 │ (whole syscall surface) │                   │ (narrow surface)        │
 └─────────────────────────┘                   └─────────────────────────┘
```

What it buys: a kernel exploit has to break the Sentry first, then the Sentry's narrow host interface. What it costs: some syscall and I/O overhead, and some Linux features behave differently or are missing. That cost is why task A1 checked that the harness still works.

### Where it applies in our stack

Only the **sandbox containers** run under gVisor. The runner sets `Runtime` in the container spec from `SANDBOX_RUNTIME`. Everything else stays on `runc`: Caddy, gateway, sandbox-runner and llm-proxy are our code, not a hostile user's, and the runner needs the real Docker socket.

```
 Linux production host
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Docker daemon  (runtimes registered: runc [default], runsc)              │
 │                                                                          │
 │   runtime = runc                          runtime = runsc (gVisor)       │
 │   ┌─────────┐ ┌─────────┐ ┌──────────┐    ┌───────────┐ ┌───────────┐    │
 │   │ caddy   │ │ gateway │ │ llm-proxy│    │ sandbox-1 │ │ sandbox-2 │ .. │
 │   └─────────┘ └─────────┘ └──────────┘    └─────┬─────┘ └─────┬─────┘    │
 │   ┌───────────────┐                             │ dsh-net-1   │ dsh-net-2│
 │   │ sandbox-runner│── Docker API ── creates ────┴─────────────┘          │
 │   │ (holds socket)│   (Runtime: runsc, read-only rootfs, limits)         │
 │   └───────────────┘                                                      │
 └──────────────────────────────────────────────────────────────────────────┘
```

gVisor is one layer, not the only one. The per-user internal networks, the runner's fixed spec, dropped capabilities, `no-new-privileges`, the read-only rootfs and the resource limits all apply under either runtime. gVisor covers the case where those fail and the attacker has code execution in a sandbox and a kernel vulnerability.

### Lima: a Linux machine with gVisor, on a Mac

gVisor only runs on Linux, and it has to be registered in the Docker daemon's config. A Mac developer's Docker Desktop runs a hidden Linux VM that does not let you do that. Lima gives a separate, ordinary Ubuntu VM with its own Docker, where `runsc` can be installed and registered. Docker Desktop is untouched.

```
 macOS laptop
 ┌────────────────────────────────────────────────────────────────────────┐
 │ Repo (dsh-cloud/)  ◄── mounted read-only into the Lima VM              │
 │                                                                        │
 │  Docker Desktop VM                       Lima VM  "dsh-linux"          │
 │  (day-to-day dev, scripts/restart.sh)    (Ubuntu, rootful Docker)      │
 │  ┌───────────────────────────┐           ┌─────────────────────────┐   │
 │  │ runtimes: runc only       │           │ runtimes: runc + runsc  │   │
 │  │ full stack, port 443      │           │ built from the mount    │   │
 │  └───────────────────────────┘           │ scripts/lima/*.sh       │   │
 │   can't test gVisor here                 └─────────────────────────┘   │
 │                                           can test gVisor and a real   │
 │                                           Linux kernel here            │
 └────────────────────────────────────────────────────────────────────────┘
```

| Environment | Runtime | Used for | Isolation property tested |
| --- | --- | --- | --- |
| Docker Desktop (macOS) | `runc` | everyday development, unit and Docker suites | networks, runner, admin socket, read-only rootfs; **not** gVisor, **not** Linux volume and permission behaviour |
| Lima VM `dsh-linux` | `runc` and `runsc` | spike A1, gVisor and Linux checks | harness boots under each runtime; the same checks as above on a real Linux kernel |
| Production Linux host | `runsc` | real users | all of it |

The runtime is a config value (`SANDBOX_RUNTIME`, default `runc`), so the same code and the same compose file run in all three. Switching is one environment variable, not a code change.

### What has and has not been verified

Verified (spike A1, [lima-setup.md](lima-setup.md)): the harness boots under `runsc` with the gateway's hardening flags; the container sees `Linux 4.19.0-gvisor` instead of the host's kernel; user namespaces work under gVisor and are denied under hardened `runc`.

Verified later, by running the whole stack in the Lima VM with `SANDBOX_RUNTIME=runsc` (2026-11-22; see [lima-setup.md](lima-setup.md)):
- The sandbox boots under `runsc` with the current spec (read-only rootfs, exec tmpfs `/tmp`, `nofile` 4096, per-user internal network) and the gateway serves it. Inside, `uname` reports `Linux 4.19.0-gvisor` while the VM kernel is `7.0.0-43-generic`.
- `/tmp`, `/workspace` and `/data/dsh` are writable. Isolation holds: sandbox A cannot reach sandbox B, the runner, the internet or the metadata address. Lima forwards the VM's port 443 to the Mac, so `https://localhost/` works.
- **Found: Docker's embedded DNS does not work inside a gVisor sandbox.** `llm-proxy:8081` and `gateway:8080` are reachable by IP (172.19.0.3, 172.19.0.2 in that run) but `lookup llm-proxy` fails with `EAI_AGAIN`, so the model path fails. The same lookup under `runc` on the same network works. Names are resolved by `127.0.0.11`, which Docker serves from inside the container's network namespace; gVisor runs its own network stack and does not see it. **Fixed** (2026-11-23): the runner pins each shared service at a fixed address on every user network (the top usable addresses of the subnet, counting down, so a sandbox's dynamic address can never collide) and gives the sandbox those names as `ExtraHosts`. Re-run in the VM under `runsc`: `llm-proxy` and `gateway` resolve and connect by name and `/v1/models` returns 200; other sandboxes, the runner, the internet and the metadata address are unreachable (`ENETUNREACH`). Force-recreating the gateway and llm-proxy brings them back at the same addresses, so running sandboxes keep a valid `/etc/hosts`. The egress proxy (C3) joins the same mechanism as another role.

Settled since (see [research-harness-policy.md](research-harness-policy.md) and "G1 result"):
- **The shell tool.** A real `bash` tool call through the harness works under `runsc` once `bubblewrap` is in the image, and is confined to `/workspace`. Under hardened `runc` it fails closed (user namespaces are denied there and the Landlock launcher is not built into the image); Landlock does not exist under gVisor.
- **The Linux host path** is still seen only in the Lima VM (a real Linux kernel with Docker 29), not on bare metal.

Kata or Firecracker remain the fallback if gVisor is judged insufficient; they are chosen the same way, through `SANDBOX_RUNTIME`.

### How to run the stack under gVisor (Lima)

```
scripts/lima/create-vm.sh        # once: Ubuntu VM with rootful Docker (a few minutes)
scripts/lima/install-gvisor.sh   # once: installs runsc, registers it with Docker
scripts/lima/gvisor-smoke.sh     # alpine under runc vs runsc, prints each kernel
scripts/lima/harness-spike.sh    # builds the sandbox image, boots it under both, probes it

scripts/lima/docker-context.sh lima      # make this machine's docker/compose use the VM's daemon
scripts/lima/docker-context.sh desktop   # switch back to Docker Desktop
```

With the `lima` context active, `scripts/restart.sh` and `tests/run.sh` run against the VM's daemon, and Lima forwards the VM's published ports (443 included) to `localhost` on the Mac. The two daemons share nothing, and both need host port 443, so stop the stack on one before starting it on the other.

`scripts/lima/setup.sh` does all of the above in one idempotent command, and `scripts/lima/setup.sh --stack` also starts the whole stack in the VM with `SANDBOX_RUNTIME=runsc`. The first build is slow (the sandbox image's build context is about 1.7 GB, mostly the built harness).

## Task breakdown

Each task is sized to land as one commit, with tests.

### A. Spikes (do first; the results change later tasks)
1. **A1 Runtime and harness spike**: run the sandbox image under `runsc` (Linux host or VM) and check that the harness boots, that its bwrap or Landlock runner is usable or fails closed with `SANDBOX_UNAVAILABLE`, and that shell tools work. Record the result in `docs/`.
2. **A2 Harness policy spike (F1 below)** (done, see [research-harness-policy.md](research-harness-policy.md)): find which config keys set the default sandbox mode and the approval preset, and whether `danger-full-access` and the directory picker can be hidden through `--patch` alone.

### B. Control plane
3. **B1 `sandbox-runner` service**: move `docker.js` and the container spec out of the gateway. Narrow HTTP API on the control network with its own shared secret. The gateway no longer mounts the socket.
4. **B2 Hardened container spec**: configurable runtime (D1), read-only root filesystem with tmpfs `/tmp`, ulimits (`nofile`, `nproc`), `MemorySwap` equal to `Memory`, a seccomp profile no weaker than the default, and an optional user-namespace remap.

### C. Network
5. **C1 Per-user internal networks**: the runner creates `dsh-net-<id>` (internal), attaches the gateway and llm-proxy, and removes the network when the user's data is deleted. Replace the single shared `dsh-sandboxes` network.
6. **C2 llm-proxy listener split**: user API on one port, admin API on a separate port reachable only from the control network.
7. **C3 Egress proxy** (done; per D4): filtering forward proxy on each user network, denying private ranges and metadata, with logging. Sandbox gets `HTTP_PROXY`/`HTTPS_PROXY` and no direct route.

### D. Resource and abuse limits
8. **D1 Capacity cap** (done): `MAX_RUNNING_SANDBOXES`. When full, `ensure()` fails with a clear "at capacity" status shown on the launching page, and the reaper may evict the longest-idle sandbox first.
9. **D2 Wall-clock and disk limits** (done): maximum continuous run time per sandbox, and per-volume size enforcement in the reaper (D6) with a visible message to the user.
10. **D3 Signup control** (done; D5): invite codes table, `ALLOW_SIGNUP` default `false`, plus a global daily token budget in the llm-proxy that returns 429 for everyone when exhausted.

### E. Audit and operations
11. **E1 Audit log** (done): gateway `audit` table and JSON log lines for signup, login success and failure, sandbox start, stop and recreate, token issue and revoke, quota hits and admin actions. No prompts or content.
12. **E2 Backups** (done, see [backup.md](backup.md)): script that takes a SQLite `.backup` of both databases and archives the user volumes, with a restore check.
13. **E3 Pinning and CI** (done, see [build-pinning.md](build-pinning.md)): pin the Node and harness versions in the image build, and add a CI workflow that runs `tests/run.sh` unit suites.

### F. Harness policy
14. **F1 Locked-down defaults** (done): apply the A2 findings in `entrypoint.sh` (default `workspace-write` plus approval, hide `danger-full-access`). If config cannot do it, write up the minimal harness change instead of patching blindly.

### G. Verification (adversarial)
15. **G1 `tests/phase4/` (Docker, Linux)** (done; 21 tests pass under gVisor in the Lima VM, see "G1 result" below):
    - Sandbox A cannot connect to sandbox B, the gateway, the runner, the llm-proxy admin port or Docker.
    - Direct internet and metadata addresses fail; the egress proxy blocks private ranges and allows a public test host.
    - Gateway container has no Docker socket and cannot create containers.
    - Fork bomb, large file write and CPU spin stay inside the limits and the host stays responsive.
    - Over-disk user is stopped and told why; capacity cap holds.
    - Signup without an invite is refused; global budget exhaustion returns 429.
    - Audit rows exist for each tested action.
16. **G2 Docs** (done): update `plan.md` (diagram and status), the gateway and infra READMEs, `tests/README.md`, and remove the fixed items from the known-gaps lists.

## Suggested order and dependencies

A1 and A2 first (parallel) → B1 → B2 → C1 → C2 → C3 → D1/D2/D3 (parallel) → E1 → F1 → G1 → E2/E3 → G2.

Milestone M1 (after B1, C1 and C2): no Docker socket in the gateway, sandboxes isolated from each other and from the admin API. This closes the largest holes. Egress filtering, limits and abuse controls follow.

## Acceptance criteria

Result, checked in the Lima VM under gVisor (2026-11-24):

- [x] From a shell inside any sandbox, no other sandbox, control-plane service, Docker or metadata endpoint is reachable. (`phase4/isolation`)
- [x] Compromising the gateway process does not give host or container-creation access: it has no Docker socket and only a narrow, authenticated runner API that builds the container spec itself. (`phase4/isolation`, `runner/`)
- [x] One user cannot exhaust host disk, CPU, memory or the provider budget for others: pids, memory, CPU and `/tmp` limits hold, the capacity cap, run-time and disk limits and the global budget work. Disk is checked rather than enforced; see "What is left". (`phase4/isolation`, `phase4/limits`)
- [x] `tests/run.sh all` includes the `phase4` suites. Phases 2, 3 and 4 and the unit suites pass under gVisor on the VM; `phase1` (the single-container prototype) was not re-run.

## Risks

- **gVisor and the harness.** (Settled.) The harness runs under `runsc`; its shell confinement works there with `bubblewrap` installed and fails closed under `runc`.
- **Per-user networks at scale.** Docker's default address pool limits the number of networks (roughly 30 with default settings). The address pool must be widened, or sandboxes grouped, before large user counts.
- **Compose and multiple networks.** Phase 2 hit a Compose bug where services attached to only one of two networks, and it recurred when B1 put the gateway on a second (control) network. C1 removed that network. The runner creates user networks through the Docker API, which avoids the bug, and re-attaches the gateway and llm-proxy to every user network after a recreate.
- **Egress proxy and HTTPS.** A CONNECT-based proxy filters by destination address only. It cannot inspect content, so it limits where the agent connects, not what it sends.
- **Local development.** macOS Docker Desktop cannot run gVisor, so the isolation runtime is only exercised on Linux or in a VM.
