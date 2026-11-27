# egress-proxy

The only way out of a user network (plan D4, task C3). Sandboxes sit on internal Docker networks with no route off the host; this proxy is attached to every one of them by the sandbox-runner (role `egress-proxy`, a fixed address and an `ExtraHosts` entry, like the gateway and llm-proxy) and also sits on the compose network, which has internet.

- **What it serves.** `CONNECT host:port` (HTTPS) and absolute-URI `http:` requests. No SOCKS, no other schemes, no content inspection.
- **What it refuses.** Any name or literal that resolves to a non-public address: loopback, RFC 1918 (which covers Docker networks), CGNAT, link-local and the metadata address `169.254.169.254`, multicast and reserved ranges, and the IPv6 equivalents (including IPv4-mapped, NAT64 and 6to4 forms). If any answer for a name is private, the name is refused. Ports other than `ALLOWED_PORTS` (default `80,443`) are refused.
- **Rebinding.** It resolves once, checks the answer, and connects to that address, never to the name.
- **Overall limits.** `MAX_CONNECTIONS` (256), connect timeout and idle timeout (`CONNECT_TIMEOUT_SECONDS`, `IDLE_TIMEOUT_SECONDS`).
- **Scope (optional).** With `EGRESS_ALLOW_HOSTS` set, only those hosts plus a base list are reachable; see "Scope" below.
- **Per-sandbox limits.** Concurrent connections and new connections per second, per sandbox and per destination; see "Limits" below.
- **Log.** One line per request: `egress allow|deny src=<ip> <METHOD> <host:port> (reason)`. The source address identifies the user network.
- **Sandbox side.** The runner sets `HTTP(S)_PROXY`, `NO_PROXY` (gateway, llm-proxy, localhost) and `NODE_USE_ENV_PROXY=1` when `EGRESS_PROXY_URL` is set. Leave it unset, and drop the service, for sandboxes with no web access.

Limits of the design: it filters where the agent connects, not what it sends, and a process that ignores the proxy variables simply has no network (the networks are internal).

## Scope: which hosts a sandbox may reach

By default any public host on the allowed ports is reachable. Set `EGRESS_ALLOW_HOSTS` (in `.env`, passed through compose) and the proxy is in **scoped mode**: only the listed hosts, plus the **base list**, are reachable, and everything else is refused with HTTP 403 and the reason `not in scope: <host> is not on the allowed list` (in the status text and `X-Egress-Reason` header for a tunnel, the same header and the body for a plain request, and the log). Use it when the sandbox is being pointed at specific sites, so a mistaken command or a crawler following a link cannot touch anyone else.

- **Entries**, comma separated: `example.com` (that host only), `*.example.com` (any subdomain, **not** the apex: list both to allow both) or an IPv4 address. A wildcard needs at least two labels after the `*` (`*.com` is refused when the proxy starts); the public-suffix list is not consulted, so `*.co.uk` would be accepted: write what you mean. Case is ignored.
- **Base list** (`EGRESS_BASE_HOSTS`, empty means the built-in list in `src/scope.js`, `none` means no base list): GitHub (`github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`), packages (`pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`, `proxy.golang.org`, `sum.golang.org`), and vulnerability and knowledge sources (`api.osv.dev`, `osv-vulnerabilities.storage.googleapis.com`, `services.nvd.nist.gov`, `nvd.nist.gov`, `www.cisa.gov`, `api.first.org`). In `tests/phase6/egress-limits.test.mjs`, `git clone`, `pip install`, `osv-scanner` and `pip-audit` worked in scoped mode and reached only `github.com`, `pypi.org`, `files.pythonhosted.org` and `api.osv.dev`; the other entries are for tools not exercised there.
- **Order of checks:** the name against the scope (no DNS is done for a refused name), then the port and the address filter, then the limits. An allowed name that resolves to a private address is still refused; a name that is not listed is refused whatever it resolves to. A redirect to an unlisted host is a new request and is refused.
- **Changing it:** `scripts/egress-scope.sh --show | --set a.example.org,*.api.example.org | --clear` edits only that line of the env file and recreates the proxy; sandboxes lose web access for about 15 seconds while the runner attaches the new one (checked on the local stack).
- **Not per user.** The list is global for now; per-user scope held by the gateway, with ownership verification, is phase 6 (S6-14 to S6-16).

## Limits: how hard one sandbox can push

Keyed by the sandbox's source address (each user has a network of their own) and by the destination host, each off at 0:

| Setting (compose name) | Default | Meaning |
| --- | --- | --- |
| `RATE_PER_SOURCE` (`EGRESS_RATE_PER_SOURCE`) | 100 | new connections or plain-HTTP requests per second from one sandbox, a burst of twice that |
| `RATE_PER_DESTINATION` (`EGRESS_RATE_PER_DESTINATION`) | 20 | the same, to one destination host |
| `MAX_CONNECTIONS_PER_SOURCE` (`EGRESS_MAX_CONNECTIONS_PER_SOURCE`) | 64 | connections open at once from one sandbox |
| `MAX_CONNECTIONS_PER_DESTINATION` (`EGRESS_MAX_CONNECTIONS_PER_DESTINATION`) | 16 | connections open at once to one destination |
| `LIMIT_WAIT_SECONDS` (`EGRESS_LIMIT_WAIT_SECONDS`) | 5 | how long a request may wait for a slot or a token before it is refused |

Over a limit a request **waits** (a tool just runs slower) and is refused only if the wait would exceed the cap: HTTP 429 with `Retry-After` and the reason (`rate limit: too many new connections to <host>`, `too many connections open to <host>`). Waiting counts against `MAX_CONNECTIONS`, so the queue is bounded. In the live test (rate 5 a second, 4 open, a 2 s cap) 40 simultaneous connections from one sandbox gave 24 served and 16 refused with 429, while its neighbour's three requests took 0.5 s.

**What the limits cannot see:** inside an HTTPS tunnel the proxy sees one connection, not the requests sent down it. A client that reuses a connection is limited in how many tunnels it opens and how many are open at once, not in requests per second. Plain-HTTP requests are counted one by one. The tools' own rate options (`nuclei -rl`, `ffuf -rate`, `httpx -rl`) are the first line of control; the proxy is the backstop.

## Robustness

A client that resets its connection (straight after a refusal, while queued, or mid-request) must never take the proxy down: it is shared by every sandbox. The CONNECT socket has an error listener from the first moment, and a client that leaves while it is being vetted or queued does not get a connection dialled for it and gives its slot back. History: before 2026-11-27 a refused CONNECT followed by a client reset emitted an unhandled socket error and the proxy exited, which cut web access for every sandbox until the stack was restarted. The full account (mechanism, how it was found, reproduction against the old code, impact, fix, tests, follow-ups) is in [../docs/finding-egress-proxy-crash.md](../docs/finding-egress-proxy-crash.md); the regression tests are in `tests/egress-proxy/scope-limits.test.mjs`.
