# infra

Phase 1 prototype: one `dsh --profile web` sandbox container behind Caddy (TLS).

```
docker compose up -d --build
docker compose logs sandbox | grep token=   # launch URL with token
```

Open the logged URL (`https://localhost/?token=...`). Caddy uses its internal CA,
so the browser will warn about the certificate.

Verified: token login sets the auth cookie, authenticated requests return 200,
and `wss /api/remote.mux` upgrades (101) through Caddy.

Set `DSH_PUBLIC_URL` / `DSH_TRUSTED_HOST` in docker-compose.yml for a real domain.
No DeepSeek key is passed yet; model calls come with the llm-proxy in phase 3.

## Phase 2 stack

`docker compose -f docker-compose.gateway.yml up -d --build` runs Caddy -> gateway -> per-user sandboxes
(created by `sandbox-runner`, the only service with the Docker socket, on the `dsh-sandboxes` network). Open https://localhost/
and sign up. See [../gateway/README.md](../gateway/README.md). Both stacks bind host port 443; run one at a time.

Services in the gateway stack: `proxy` (Caddy), `gateway`, `sandbox-runner`, `llm-proxy`, `egress-proxy`, and `sandbox-image` (a build-only service that produces `dsh-sandbox:latest`). All of them share the compose network `dsh-sandboxes`; user sandboxes are never on it. Each gets its own internal network from the runner, with the gateway, llm-proxy and egress proxy attached.

Settings with defaults (`.env`; the full list is in `../.env.example`): `SANDBOX_RUNTIME` (`runc`; `runsc` for gVisor), `ALLOW_SIGNUP` (`false`), `MAX_RUNNING_SANDBOXES` (20), `MAX_RUN_SECONDS` (28800), `MAX_DISK_MB` (2048), `GLOBAL_DAILY_TOKEN_BUDGET` (5000000), `AUDIT_RETENTION_DAYS` (90), `EGRESS_ALLOWED_PORTS` (80,443). Base images are pinned by digest (`scripts/pin-images.sh --check`). Compose files are validated in CI; the stack itself needs a Linux Docker host (gVisor for the agent shell) and the built harness (`scripts/build-harness.sh`).

Phase 3 adds an `llm-proxy` service to this stack. Set `UPSTREAM_API_KEY` (or the older `OPENROUTER_API_KEY`) and
`LLM_ADMIN_SECRET` and `RUNNER_SECRET` (`openssl rand -hex 24` each) in `.env`; see `../.env.example` and `../llm-proxy/README.md`.
The real key reaches only the proxy container.
