# egress-proxy

The only way out of a user network (plan D4, task C3). Sandboxes sit on internal Docker networks with no route off the host; this proxy is attached to every one of them by the sandbox-runner (role `egress-proxy`, a fixed address and an `ExtraHosts` entry, like the gateway and llm-proxy) and also sits on the compose network, which has internet.

- **What it serves.** `CONNECT host:port` (HTTPS) and absolute-URI `http:` requests. No SOCKS, no other schemes, no content inspection.
- **What it refuses.** Any name or literal that resolves to a non-public address: loopback, RFC 1918 (which covers Docker networks), CGNAT, link-local and the metadata address `169.254.169.254`, multicast and reserved ranges, and the IPv6 equivalents (including IPv4-mapped, NAT64 and 6to4 forms). If any answer for a name is private, the name is refused. Ports other than `ALLOWED_PORTS` (default `80,443`) are refused.
- **Rebinding.** It resolves once, checks the answer, and connects to that address, never to the name.
- **Limits.** `MAX_CONNECTIONS` (256), connect timeout and idle timeout (`CONNECT_TIMEOUT_SECONDS`, `IDLE_TIMEOUT_SECONDS`).
- **Log.** One line per request: `egress allow|deny src=<ip> <METHOD> <host:port> (reason)`. The source address identifies the user network.
- **Sandbox side.** The runner sets `HTTP(S)_PROXY`, `NO_PROXY` (gateway, llm-proxy, localhost) and `NODE_USE_ENV_PROXY=1` when `EGRESS_PROXY_URL` is set. Leave it unset, and drop the service, for sandboxes with no web access.

Limits of the design: it filters where the agent connects, not what it sends, and a process that ignores the proxy variables simply has no network (the networks are internal).
