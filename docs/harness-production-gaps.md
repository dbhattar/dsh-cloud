# deepseek-harness: gaps for production use

> **Status (2026-11-24):** these are properties of the harness itself and none were changed. Phase 4 contains them from outside (gVisor, per-user networks, the egress proxy, limits) and locked the agent's policy by configuration only: see [research-harness-policy.md](research-harness-policy.md). Statements below about the harness remain as originally assessed.

Companion to [production-readiness.md](production-readiness.md), which covers the `dsh-cloud` wrapper. This file covers the harness itself (`/Users/dipeshbhattarai/Projects/deepseek-harness`).

**Method and limits.** Based on the harness's own docs and package READMEs (`SAFETY.md`, `docs/subsystems/*`, and the "Known Limitations" sections of the web-server, connection, authentication-token, web-app, credentials-local, sandbox-local, web-fetch-http and subprocess packages). I did not audit the source line by line or run anything. Items marked **(unverified)** are inferences that need a test.

## 1. The project says it is not production-ready

`SAFETY.md`: experimental developer-preview software, "not undergone a security audit", must not be treated as "secure or production-ready", and must not be "the sole security control for untrusted workloads." It recommends running in a disposable VM or container, which is what `dsh-cloud` does. Everything below follows from the harness being designed as a single-user local tool.

## 2. Isolation: the harness cannot contain a hostile user or agent

| Gap | Detail | Source |
|---|---|---|
| Sandbox covers file writes only | `SandboxMode` "governs filesystem effects only". Network and process visibility are "outside this vocabulary". | `docs/subsystems/sandbox.md` |
| Reads are not denied | The file-effect modes do not deny reads, so a confined command can read any file the OS user can. | `credentials-local/README.md` |
| Shared kernel and filesystem | `dsh-sandbox-local` confines commands "while sharing the host kernel and filesystem". | `sandbox-local/README.md` |
| Confinement can be switched off | `danger-full-access` bypasses confinement entirely. It is a normal mode that the permission flow can offer, not a build-time exclusion. | `sandbox.md` |
| Partial enforcement exists | Older Landlock ABIs report `partial` enforcement. Whether a given consumer rejects `partial` is up to the consumer. | `sandbox.md` |
| Web fetch reaches internal addresses | "loopback, private-network, and cloud metadata addresses are fetched like any other host." The README says to use a `tools/pre-execute` policy, network confinement or no fetch tool. | `web-fetch-http/README.md` |
| No per-process resource limits found | The subprocess layer caps captured output (`maxBytes`, spill files). I found no CPU, memory, disk or process-count limits at the harness level. Also, "root exit does not terminate surviving descendants" when opted in. | `subprocess-local/README.md` |

**(unverified) bwrap inside a hardened container.** On Linux the runner chain is bwrap, then Landlock. It fails closed with `SANDBOX_UNAVAILABLE` rather than running unconfined. The `dsh-cloud` sandboxes drop all capabilities and run under Docker's default seccomp profile, where bwrap often cannot create user namespaces. Test what `dsh-sandbox-local` selects inside the real container. If it fails closed, shell tools will not work. If it works, the container still shares the host kernel (see `production-readiness.md` item 2).

## 3. Secrets: nothing can be hidden from the agent

- The credential store is a file readable by the same OS user the agent's tools run as. The README says it "cannot isolate secrets from the agent" and that an OS-keychain provider is "deferred". KMS or helper-command providers are possible but none ships.
- Any secret placed in the sandbox is readable by the model. `dsh-cloud` handles this correctly by giving the sandbox only a per-user proxy token (`LLM_PROXY_TOKEN`). That token is still visible to the agent, which is acceptable only because it is per-user and revocable.

## 4. Identity and access: a single-owner design

- **One owner per process.** Browser cookies authenticate to "one shared Peer". There are no user accounts, roles or per-user permissions in the harness. The plan to run one process per user exists because of this.
- **Launch token and cookies.** The launch token appears in the printed URL, which `dsh-cloud` has to read back out of container logs. Browser cookie lifetime defaults to 30 days (`cookieMaxAgeDays`). I found no per-cookie revocation for browser cookies. Revocation "belongs to its Provider", and the browser cookies share one Peer, so ending that Peer ends all of them together.
- **Plain HTTP leaks the cookie.** Without TLS the cookie cannot be marked `Secure`. TLS is opt-in and unmanaged: no certificate provisioning, renewal or watching, and a changed certificate needs a restart.
- **Memory-based denial of service.** Buffered `/api` routes keep each request body in memory, with `maxRequestBodyBytes` defaulting to 300 MiB. Unused API Peers "may remain until Host shutdown", with no connect deadline or idle collection.
- **Host and Origin fence.** The harness checks Host and Origin against the bind address and `--trusted-host`. The docs say this does not protect the listening port itself, so the port must be reachable only by the trusted proxy. In `dsh-cloud` that depends on the Docker network, which has no isolation between sandboxes.
- **Bind constraints.** A wildcard bind address is rejected, so a container must discover its own IP (the entrypoint uses `hostname -i`).

## 5. State and scaling

- Sessions are stored as per-session JSONL files (default), or optionally SQLite, on the local filesystem. The writer lease is enforced "cross-process" on one machine. I found no shared or remote storage backend, so a harness process cannot move between machines without moving its volume.
- No retention, quota or cleanup policy for session logs or workspaces was found. Disk use grows without bound per user.
- Crash recovery is good: checksummed frames, per-batch `fsync` and torn-tail truncation. This is a strength, not a gap.

## 6. Maintenance and operational maturity

- **Large experimental surface.** There is an `experimental/` package tree with many plugins, plus stale or unsettled pieces: the E2B backend was removed, `packages/host/apiproxy` is stale build output, and no container execution backend exists.
- **Build from source.** The web frontend must be built first (`pnpm run build`); there is no source-serving fallback. `dsh-cloud` copies a local, unpinned checkout into the image.
- **Runtime version mismatch (unverified).** The harness documents Node ^22.19. The sandbox image uses `node:24-slim`. Confirm that it is supported.
- **Telemetry.** The product telemetry plugin defaults to an external collector, but "ordinary Web does not" mount it, so the web profile should not send product analytics. Confirm in a run with network capture.
- **Observability not assessed.** I did not review runtime diagnostics, logging or metrics.

## 7. What the harness already gets right

- Fails closed when no sandbox runner is usable.
- Credential file refuses to load if other users can read it (`chmod 600` check on POSIX).
- Credentials re-resolved per request, so key rotation needs no restart.
- Web fetch is bounded: no credentials sent, same-origin redirects only, 5 MB and 30 s caps, and binary content rejected.
- Wildcard bind rejected by design.
- Durable, crash-safe session persistence.

## 8. What this means for `dsh-cloud`

The harness cannot be hardened from the inside for hostile multi-tenant use. Its own docs push these controls to the deployment, which matches the phase 4 list in `production-readiness.md`:

1. Network egress policy (also closes the web-fetch internal-address gap).
2. VM-grade isolation (gVisor, Kata or Firecracker) instead of relying on bwrap or shared-kernel containers.
3. Per-sandbox CPU, memory, disk and wall-clock limits.
4. A `tools/pre-execute` policy to block private destinations and to hide or deny `danger-full-access`.
5. Keep real provider keys out of the sandbox, as the llm-proxy already does.
6. Pin the harness version and Node version in the image build.

Before relying on any of this, test the unverified items in sections 2 and 6.
