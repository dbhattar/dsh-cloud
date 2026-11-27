# Finding: a client reset could crash the egress proxy

Found 2026-11-27 while building the egress scope and limits ([plan-first-security-test.md](plan-first-security-test.md), step 3). It was in the code since phase 4 (task C3) and is fixed in the same change as step 3. Related: [../egress-proxy/README.md](../egress-proxy/README.md), [plan-phase-4.md](plan-phase-4.md).

## Summary

If a client opened a `CONNECT` tunnel through the egress proxy to a destination the proxy refuses, and then reset its TCP connection, the proxy process **exited**. The egress proxy is shared by every sandbox and nothing restarts it, so one connection from one sandbox could cut web access for all users until the stack was restarted. Model traffic is unaffected (it goes through the llm-proxy, not the egress proxy).

## The mechanism

For a `CONNECT` request, Node's HTTP server does not give the handler a request/response pair. It emits a `'connect'` event with the **raw TCP socket** (`client`), and the handler owns that socket from then on. In the original handler (`egress-proxy/src/server.js`) the sequence was:

1. read the target from the request line;
2. check the global connection budget, vet the destination (port, DNS, address filter);
3. if refused: `client.end("HTTP/1.1 403 Forbidden ...")`, and return;
4. only if allowed: dial upstream, **then** attach `client.on('error', close)` and the other socket listeners.

So on every refusal path (and during the awaits in step 2) the socket had **no `'error'` listener**. A socket error without a listener is an uncaught exception in Node, and since Node 15 an uncaught exception ends the process. A client that sends a reset (RST) gives the proxy's socket `ECONNRESET` on read, or `EPIPE` on write if the reset arrives before the proxy has answered. Either one reached the missing listener and the proxy exited.

Plain-HTTP requests (absolute-URI `GET` and the like) go through the HTTP server's own request and response objects, which the server's `clientError` handling covers; they were not affected (probed, below).

## How it was found

Not by a test written for it. The new Docker test for the scope list (`tests/phase6/egress-limits.test.mjs`) refuses requests with a longer response (a reason in a header and a body), and `curl` closes the connection abruptly after reading it. The first run failed with `curl: (28) Connection timed out` on the second request, then `Failed to connect to egress-proxy port 3128`: the proxy was gone (a stopped container's address on the internal network simply times out). Reproduced in seconds locally:

```
$ PORT=3999 node egress-proxy/src/index.js &        # scoped to example.com
$ curl -x http://127.0.0.1:3999 https://www.wikipedia.org/    -> curl: (56) CONNECT tunnel failed, response 403
$ curl -x http://127.0.0.1:3999 https://example.com/          -> curl: (7) Failed to connect ... Couldn't connect to server
(proxy log)  Error: read ECONNRESET ... Emitted 'error' event on Socket instance ... Node.js v24
```

## It was already there

I first assumed my new response text caused it. To be sure, the committed code from before the change was run with a raw TCP client (`/tmp`-only script, not kept) against refusals that need no scope list:

| Old code, `CONNECT` refused because of | Client | Result |
| --- | --- | --- |
| a private address (`10.0.0.1:443`) | resets after reading the 403 | **proxy exited**, `read ECONNRESET` |
| a private address | resets before the answer | **proxy exited**, `write EPIPE` |
| a port that is not allowed (`example.com:8080`) | resets after reading the 403 | **proxy exited**, `read ECONNRESET` |

So the longer response only made the case easy to hit with `curl`; any reset after a refusal was enough.

## Impact

- **Who can trigger it:** any process in a sandbox. The egress proxy is, by design, reachable from every user network (it is the only way out), and the bytes needed are one `CONNECT` line to a refused destination followed by a reset. This was reproduced with a raw client against the committed code on the host, **not** from inside a sandbox; nothing in the sandbox's confinement prevents the same bytes.
- **What breaks:** web access for **all** sandboxes (git, package installs, scanners, anything through the proxy). Existing connections through the proxy die with it. The gateway, runner, llm-proxy and model access keep working.
- **For how long:** until someone restarts it. **None of the compose services has a restart policy** (`restart:` appears once, on the build-only `sandbox-image` entry), so an exited egress proxy stays down. The proxy has a health check, which only reports; the runner re-attaches a running proxy to user networks but does not start a stopped one. Nothing in the admin overview shows the egress proxy's state.
- **Not data loss, not a sandbox escape:** the proxy fails closed (no route out), so this is an availability problem, and it is cheap for one user to cause for everyone.

## The fix

Three changes in the `CONNECT` handler (`egress-proxy/src/server.js`):

1. **Listen first.** `client.on('error', () => client.destroy())` is the first thing the handler does, before any `await` and before any `refuse(...)`. A reset at any moment is now an ordinary closed connection.
2. **Do not dial for nobody.** After the awaits (vetting, queueing for a slot) the handler checks `client.destroyed`; if the client left, it gives back its slot in the global budget and in the per-sandbox and per-destination limits and returns, instead of opening an upstream connection that would sit there until the idle timeout.
3. **Give everything back on every path.** Every refusal and the early return decrement the active count, and the limit slots are released when the tunnel closes (`release()` is idempotent).

## How it is tested

`tests/egress-proxy/scope-limits.test.mjs`, "a client that resets its connection after a refusal, or while queued, does not crash the proxy or leak its budget":

- ten rounds of: a refused `CONNECT` whose client resets after the answer, and one whose client resets before the answer (using `resetAndDestroy()`, which sends a real RST);
- the proxy must still answer afterwards (a tunnel to an allowed host succeeds);
- a client that gives up while queued behind a held slot must not take that slot when it is freed, and the connection budget (set to 4) must still have room.

Without the fix in `server.js` this test fails; with it, it passes. The plain-HTTP path was probed separately (resets while the upstream was slow, mid-body, and after a scope refusal, with a one-connection limit): the proxy kept serving and the slots were freed. The Docker test (`tests/phase6/egress-limits.test.mjs`) now runs the refusals through real `curl` and `httpx` from sandbox containers and the proxy stays up.

## Why the earlier suites missed it

The Phase 4 abuse and isolation tests (`tests/phase4/isolation.test.mjs`, `limits.test.mjs`) check that refused destinations get a 403 and are logged, using clients that read the answer and close politely. None of them reset a connection after a refusal, and the process-level behaviour "the proxy is still up afterwards" was not asserted. The lesson is general: every test that provokes a refusal should also assert that the service survives a client that disappears at the worst moment.

## What was deliberately not done

- **No process-wide `uncaughtException` handler** that swallows errors. It would keep the proxy up but hide this class of bug (and leave state, like the connection counters, wrong). The fix is the missing listeners, with tests.
- **No restart policy, health surfacing or fuzzing yet**: see below.

## Follow-ups (not done; each is small)

1. **Restart policies.** Add `restart: unless-stopped` to the long-running services (gateway, sandbox-runner, llm-proxy, egress-proxy, Caddy) so a crash of any of them is a blip, not an outage. Check it against `scripts/restart.sh` and the Docker suites, which stop and recreate services.
2. **Show the egress proxy in the admin overview's Services list.** The gateway shares a network with it and the proxy answers `/healthz`.
3. **Audit the other services for the same pattern**: raw sockets handed to a handler with no `'error'` listener (the gateway's WebSocket proxying in `gateway/src/proxy.js` and the llm-proxy's streaming path are the places to read first), and add a "reset at the worst moment" case to each service's abuse tests.
4. **Add the reset case to the Phase 4 abuse suite** so the egress proxy's survival is asserted there too.
