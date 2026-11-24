# Design: llm-proxy admin API on a unix socket

Status: implemented in phase 4, task C2 (commit `faa8163`). Related: [plan-phase-4.md](plan-phase-4.md), [../llm-proxy/README.md](../llm-proxy/README.md).

## Summary

The llm-proxy has two APIs with very different audiences. The model API (`/v1/*`) is used by sandboxes. The admin API (`/admin/*`) issues and revokes user tokens and reports usage, and only the gateway should call it. The model API listens on TCP port 8081. The admin API listens on a unix socket file, `/run/llm-admin/admin.sock`, on a Docker volume that only the gateway and the llm-proxy mount. A sandbox has no network path and no filesystem path to it. The admin secret is still required on every call, as a second layer.

## Problem

Phase 4 gives every user their own internal network, `dsh-net-<id>`. The sandbox needs the llm-proxy for model calls, so the runner attaches the llm-proxy to every user network. That has a consequence: any TCP port the llm-proxy opens is reachable from every sandbox, because the proxy has an interface on each user's network and listens on all of them.

Before C2 the proxy served `/admin/*` on the same port as `/v1/*`. A user with a shell in their sandbox could therefore reach the admin routes. Only `LLM_ADMIN_SECRET` stood between that user and minting tokens for any user id, revoking other users' tokens, or reading everyone's usage. A single shared secret is a weak boundary for the one component that holds the real provider key.

Goal: take the admin API out of the sandbox's reach without depending on the secret alone.

## Options considered

| Option | How it isolates | Why not |
| --- | --- | --- |
| Second TCP port, bound to one network's address | Admin listens only on the llm-proxy's address on a control network | The proxy's addresses are assigned by Docker when networks are attached. The bind address must be found at startup, and user networks are attached later and re-attached after recreates, so the interface set changes under a running process. A wrong bind silently exposes the port. |
| Second TCP port on `0.0.0.0` plus a firewall rule | iptables or network policy drops sandbox traffic to that port | Needs host firewall management, differs between Docker Desktop and Linux, and a missed rule fails open. |
| Separate control network, llm-proxy attached to it | Admin port reachable only on that network | Puts the llm-proxy on two compose networks. Compose has repeatedly attached only one of two networks to a service (phase 2, and again in B1 with the gateway). Isolation would depend on that being reliable. |
| Admin as a separate service | Own container, own network | More moving parts: it would need the usage database and token store, which belong to the proxy process. |
| **Unix socket on a private volume** | The socket exists only in containers that mount the volume | Chosen. |

## Design

```
gateway container                    llm-proxy container
  /run/llm-admin/ ──┐             ┌── /run/llm-admin/
                    └─ volume ────┘      admin.sock  (srw-rw---- node node)
                       llm-admin
                                     :8081 TCP  /v1/*   <── sandboxes (user networks)
sandbox containers: no llm-admin volume, no /run/llm-admin
```

- **Two servers, one process.** `createProxy` in `llm-proxy/src/server.js` returns `{ user, admin }`. They share the store and the config but not a listener. The `user` server's request handler has no `/admin` branch, so those paths fall through to a generic 404. The `admin` server serves only `/admin/*`. It checks the secret first, so a request without it gets 401 whatever the path; with the secret, anything other than a known admin route (including `/v1/*` and `/healthz`) gets 404.
- **Creation.** At startup `index.js` creates the directory if needed, removes any stale socket file, and calls `admin.listen(path)`. Passing a path instead of a port makes Node bind a unix socket, which creates the file. It then runs `chmod 0660`. Only after the admin server is listening does it open TCP port 8081. The compose healthcheck probes 8081, so the gateway never starts while the admin socket is missing.
- **Volume ownership.** Both Dockerfiles `mkdir /run/llm-admin` and `chown node:node` it. Docker copies that ownership into the new named volume when the first container mounts it, whichever image that is. The llm-proxy runs as `node` and must be able to create the file.
- **Client.** `gateway/src/llm.js` uses `http.request({ socketPath })`. Node's built-in `fetch` has no unix-socket option, and the gateway deliberately has no runtime dependencies. The client opens one connection per request, so a restarted proxy needs no reconnect logic.
- **Enablement.** The gateway enables metering when `LLM_ADMIN_SOCKET` is set. It no longer has `LLM_PROXY_URL`; the model base URL given to sandboxes is the runner's setting.

## Access control layers

1. **Reachability.** A process can only connect if it can see the socket path. In a container, that means mounting the `llm-admin` volume. Only `gateway` and `llm-proxy` do. The `phase4` test asserts the exact set of mounters.
2. **File permissions.** The socket is `0660 node:node`. The gateway runs as root, so permissions do not restrict it today. They matter for any future non-root consumer.
3. **Admin secret.** Every admin request needs `Authorization: Bearer $ADMIN_SECRET`, compared by hash with `timingSafeEqual`.

Layers 1 and 2 are not network-based, so they do not drift when networks are created, attached or recreated.

## Failure modes

| Situation | Result |
| --- | --- |
| llm-proxy killed, socket file left behind | Clients get `ECONNREFUSED`, not a hang. The next start removes the stale file before binding. |
| Stale file not removed | `bind` fails with `EADDRINUSE`. This is why `index.js` removes it first. |
| llm-proxy restarted | The new process recreates the file. The gateway reconnects on its next request, since it keeps no connection. Verified live. |
| Volume missing or not mounted in the gateway | Token issue fails, so a sandbox cannot start. Fail-closed: the sandbox never gets a container without a proxy token. |
| Gateway compromised | The attacker has the secret and the socket, so can use the admin API. This is unchanged by the design and accepted: the gateway is the admin client. It is the reason the Docker socket was moved out of the gateway (B1). |
| Sandbox compromised | No path to the socket. The network listener returns 404 for `/admin/*` even with the correct secret. |

## What was verified

On the live stack (Docker Desktop, macOS):
- From a sandbox, `GET /admin/usage/<id>` and `DELETE /admin/tokens/<id>` with the real admin secret both return 404.
- A sandbox cannot list `/run/llm-admin`.
- Only port 8081 is listening in the proxy container.
- Only the gateway and llm-proxy containers mount `dshcloud_llm-admin`.
- `/gw/api/usage` works through the socket, including after an llm-proxy restart.

Automated: `tests/llm-proxy/unit.test.mjs` checks that the user listener has no admin routes for any credential, that a refused `DELETE` revokes nothing, and that the admin server serves no model routes. `tests/phase4/isolation.test.mjs` repeats the sandbox-side checks against real containers.

## Not verified, and limits

- **Linux host.** Everything above ran on Docker Desktop. Volume ownership initialisation and socket permissions should behave the same on a Linux Docker engine, but this has not been run there. The phase 4 suite should be run on Linux (or in the Lima VM) before relying on it.
- **Docker suites.** `phase3` and `phase4` were updated for this change but not run, because the dev-data guard refuses to run over existing local accounts.
- **Window between `bind` and `chmod`.** The file briefly has the process umask's mode. Only the gateway and proxy can reach the directory, so no untrusted process can connect in that window.
- **One shared volume, one secret.** Any new container that mounts `llm-admin` gains the same reachability. Do not mount it anywhere else.
- **Unix sockets are single-host.** If the gateway and llm-proxy ever run on different hosts, this must become an authenticated network call on a private network.
- **Rotation.** `ADMIN_SECRET` is still a static shared secret. Rotating it means restarting both services.
