# runner

`sandbox-runner` (phase 4, task B1). The only service that mounts the Docker socket. The gateway used to; now a compromised gateway can no longer ask Docker for arbitrary containers. Zero npm dependencies; Node >= 24.

It builds the one container spec itself ([src/spec.js](src/spec.js)) from a user id and that user's llm-proxy token. Callers cannot choose the image, binds, capabilities, devices or privileged mode.

API on the compose network, which sandboxes never join (`Authorization: Bearer RUNNER_SECRET`, compared in constant time; `/healthz` is open):

| Route | Effect |
| --- | --- |
| `GET /v1/sandboxes` | `[{ userId, running }]` |
| `GET /v1/sandboxes/:id` | `{ running, startedAt, llmManaged }` or 404 |
| `POST /v1/sandboxes/:id` `{ llmToken? }` | create, 409 if it exists |
| `POST /v1/sandboxes/:id/start` | start, 409 `stale_network` if its network was recreated |
| `POST /v1/sandboxes/:id/stop` | stop |
| `DELETE /v1/sandboxes/:id` | remove the container, keep the volumes and the user network; `?network=1` also removes the network |
| `GET /v1/sandboxes/:id/logs?tail=N` | `{ logs }`, N at most 500 |
| `GET /v1/sandboxes/:id/activity` | `{ cpuNs, memBytes }`: cumulative CPU time and memory of the running container, one Docker stats sample; the gateway differences two samples to see whether the sandbox is busy; 404 if there is no such container |
| `GET /v1/usage` | `[{ userId, bytes }]`: disk used by each user's `dsh-data-<id>` and `dsh-ws-<id>` volumes (Docker computes sizes on demand, so it can take seconds) |

Config (env): `PUBLIC_URL`, `RUNNER_SECRET` (min 16 chars) required; `SANDBOX_IMAGE`, `SHARED_ROLES`, `RECONCILE_SECONDS`, `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`, `SANDBOX_PIDS`, `SANDBOX_TMP_MB`, `SANDBOX_NOFILE`, `SANDBOX_RUNTIME`, `EGRESS_PROXY_URL` (sets `HTTP(S)_PROXY` and `NODE_USE_ENV_PROXY` in the sandbox; unset means no web access), `LLM_PROXY_URL`, `DEFAULT_MODEL`, `MODEL_MAX_OUTPUT_TOKENS` (most one model reply may produce, default 16384; keep it at or below the llm-proxy's `MAX_OUTPUT_TOKENS`), `MODEL_DISPLAY_NAME` (the model's name in the picker; a friendly default for the free router), `SHOW_HARNESS_SIGN_IN`, `DOCKER_SOCKET`, `PORT`.

Known gap: the runner container runs as root to use the Docker socket. Its API is narrow and builds every spec itself, but a bug in it is still a path to the Docker daemon.

Container hardening (B2): read-only rootfs with a 256 MB `/tmp` tmpfs (`exec` is needed because the harness loads its native binding from `/tmp`), no swap, `nofile` ulimit, Docker's default seccomp profile, `SANDBOX_RUNTIME` (default `runc`, `runsc` for gVisor). There is no `nproc` ulimit: it is counted per host UID and all sandboxes share one, so `PidsLimit` bounds processes per container. User-namespace remap is a daemon setting (`userns-remap`), not part of the spec.

## Networks (C1)

Each user gets an internal bridge network `dsh-net-<id>` (no default route, no published ports). The sandbox joins only that one. The runner also attaches the gateway and llm-proxy to it, found by the `dsh-cloud.role` label (set in compose) and given their role as a DNS alias, so `llm-proxy` still resolves inside the sandbox. Compose gives those two services new container ids whenever it recreates them, which drops them off every user network, so the runner re-attaches them at startup, every `RECONCILE_SECONDS` (15) and on every sandbox start.

**Fixed addresses and `ExtraHosts`.** gVisor sandboxes cannot use Docker's embedded DNS (`127.0.0.11`; the sandbox's own network stack does not see it), so names cannot come from DNS. The runner pins each shared service at a fixed IPv4 address on every user network: the top usable addresses of the network's subnet, counting down in the order of `SHARED_ROLES` (for `172.19.0.0/16`: gateway `172.19.255.254`, llm-proxy `172.19.255.253`). Docker hands out dynamic addresses from the bottom, so a sandbox never lands on one, whatever order things attach in. At creation the sandbox gets `ExtraHosts` for those names, which works under both runtimes. A recreated service returns at the same address, so existing sandboxes keep a valid `/etc/hosts`; a service found at a different (dynamic) address is moved. Subnets smaller than a /29, or IPv6-only, get no pinning. After recreating llm-proxy, a running sandbox may be unable to reach it for up to `RECONCILE_SECONDS` (15 s) until the runner re-attaches it.

The egress proxy (`SHARED_ROLES` includes `egress-proxy` in compose) is attached the same way and is the only path out. A sandbox can reach the gateway, llm-proxy and egress proxy on its network; the gateway is public anyway, and the llm-proxy serves no admin routes on the network (its admin API is a unix socket shared only with the gateway).

Scale: Docker's default address pool allows roughly 30 networks. For more, set a wider pool in `/etc/docker/daemon.json`, for example `{"default-address-pools":[{"base":"10.200.0.0/16","size":28}]}` (4096 networks of 14 usable addresses each), and restart Docker.
