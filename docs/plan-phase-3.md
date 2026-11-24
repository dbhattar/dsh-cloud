# Phase 3: LLM proxy with per-user metering and quotas

Status: implemented (decisions D1-D6 took the recommendations). See `llm-proxy/README.md` and `tests/phase3/`. Parent plan: [plan.md](plan.md).

## Status of earlier phases

- Phase 1 (done): sandbox container behind Caddy TLS. `tests/phase1` covers token auth, cookie flags and WebSocket upgrade.
- Phase 2 (done): `gateway/` has login, per-user container and volumes, idle-stop/resume, and an HTTP/WS reverse proxy. Unit tests pass (11/11). The Docker suites were not re-run here because the dev stack is holding host port 443.

## Problem

Today the gateway passes the real key straight into every sandbox ([sandbox.js:68](../gateway/src/sandbox.js#L68), `OPENROUTER_API_KEY` from `LLM_API_KEY`). The agent can read its own environment, so any user can extract the operator's key. There is also no metering, quota or rate limit. Phase 3 removes the real key from sandboxes and puts a metering proxy in front of the model provider.

## Goal and non-goals

Goal: sandboxes only ever hold a revocable per-user token. The proxy holds the real key, counts usage per user, and refuses calls once a quota is exhausted.

Non-goals (phase 4): egress firewalling, microVM/gVisor, admin UI, billing/payments.

## Decisions to confirm before starting

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Upstream provider. The current wiring uses OpenRouter through `llm-pi-ai` (`openrouter/free`), but plan.md says DeepSeek. | Make the upstream base URL and key env-configurable. Keep OpenRouter as the dev default, and verify DeepSeek with the same code path. |
| D2 | Where the proxy runs. | Separate `llm-proxy/` container, not inside the gateway. It keeps the real key out of the process that has the Docker socket. |
| D3 | Usage store. | SQLite file owned by the proxy, as in the gateway. A single instance is fine for now. |
| D4 | Quota unit and window. | Tokens (input + output), daily and monthly caps per user, defaults set by env. Cost in currency is out of scope. |
| D5 | Token lifetime. | One long-lived token per user, rotated whenever the sandbox container is created. Revocable by the gateway. |
| D6 | Streaming. | Must be supported (SSE passthrough with usage parsed from the final chunk). |

## Design

```
sandbox (token as API key) ──> llm-proxy:8081 ──> provider (real key)
                                   │
                                   └─ SQLite: tokens, usage, quotas
gateway ──(admin API, shared secret)──> llm-proxy   (issue/revoke token, read usage)
```

- The proxy exposes an OpenAI-compatible surface (`/v1/chat/completions`, `/v1/models`) because both `llm-pi-ai` and the DeepSeek SDK speak it. It authenticates `Authorization: Bearer <user token>`, swaps in the real key, and streams the response back.
- Tokens are stored hashed (same approach as gateway sessions in [db.js](../gateway/src/db.js)).
- The proxy is on the `dsh-sandboxes` network only, with no published port. The admin API requires a shared secret known only to the gateway.
- Zero runtime npm dependencies, Node >= 24, like the gateway.

## Task breakdown

Each task is sized to land as one commit, with tests.

### A. Proxy core
1. **A1 Scaffold `llm-proxy/`**: `package.json`, `Dockerfile`, `src/{config,server,db,index}.js`, healthcheck. Config: `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, `ADMIN_SECRET`, `DATA_DIR`, quota defaults. Fail fast if the key or the admin secret is missing.
2. **A2 Token store**: tables `tokens(user_id, token_hash, revoked_at)` and `usage(user_id, day, input_tokens, output_tokens, requests)`. Constant-time compare on lookup.
3. **A3 Passthrough**: authenticate, strip client auth headers, add the real key, forward to the upstream, and return the status and headers. Handle client abort by cancelling upstream. Never log bodies or keys.
4. **A4 Streaming and usage accounting**: parse `usage` from the JSON response or the final SSE chunk. If the upstream omits it, request `stream_options.include_usage` and fall back to a conservative estimate from the byte length. Record usage after the response completes, including when the client disconnects midway.

### B. Quotas and limits
5. **B1 Quota enforcement**: before forwarding, return 429 with an OpenAI-style error body when the daily or monthly cap is reached. Cap `max_tokens` per request so one call cannot overshoot far.
6. **B2 Rate limit**: per-user requests per minute and max concurrent requests (in-memory token bucket). Return 429 with `Retry-After`.
7. **B3 Request guards**: body size limit, model allowlist (reject others), and upstream timeout.

### C. Gateway integration
8. **C1 Admin API on the proxy**: `POST /admin/tokens` (issue or rotate for a user), `DELETE /admin/tokens/:userId`, `GET /admin/usage/:userId`. Shared-secret auth.
9. **C2 Gateway client**: issue a token when a sandbox is created, and rotate and recreate on stale or revoked state. Replace `LLM_API_KEY` and `LLM_BASE_URL` in `spec()` ([sandbox.js:64-72](../gateway/src/sandbox.js#L64-L72)) with the per-user token and the proxy URL. After this task no sandbox env contains the real key.
10. **C3 Entrypoint wiring**: update [entrypoint.sh](../sandbox/entrypoint.sh) so `llm-pi-ai` uses the proxy base URL and the token env var. It should no longer depend on the key name `OPENROUTER_API_KEY`.
11. **C4 Compose and config**: add the `llm-proxy` service with its own volume to `docker-compose.gateway.yml`. Move the real key to `.env` for the proxy only (update `.env.example`) and remove it from the gateway's environment.

### D. Visibility
12. **D1 Usage surfaced to the user**: gateway endpoint `/gw/api/usage` and a small usage line in the app shell (tokens used vs. cap, reset time). Show a clear message in the UI when a quota is exhausted.
13. **D2 Operational logging**: structured per-request log (user id, model, tokens, status, latency) without content. A CLI or script `scripts/usage.sh` to print per-user totals.

### E. Tests and docs
14. **E1 Unit tests** (`tests/llm-proxy/`): token hashing and revocation, quota math across the day boundary, rate limiter, usage parsing for JSON and SSE, and the key never appearing in logs or errors. Use a fake upstream server.
15. **E2 `tests/phase3/` (Docker)**:
    - Real key absent from the sandbox environment, filesystem and `docker inspect` output.
    - Sandbox call succeeds through the proxy, and streaming works.
    - Usage increments for the right user only.
    - Quota exhausted returns 429 and no upstream call is made.
    - Revoked token is rejected; a second user's token cannot read the first user's usage.
    - A sandbox cannot reach the proxy admin API without the secret.
16. **E3 Docs**: fill in `llm-proxy/README.md`, and update the root README status, `tests/README.md`, and the gateway "Known gaps" list (remove the LLM key item).

## Suggested order and dependencies

A1 → A2 → A3 → A4 → B1/B2/B3 (parallel) → C1 → C2/C3/C4 → D1/D2 → E1 (alongside A–B) → E2 → E3.

Milestone M1 (after A3 and C1–C4 with passthrough only): real key removed from sandboxes. This closes the main security gap, and quotas follow on top.

## Acceptance criteria

- `docker inspect` of any sandbox, and a shell inside it, never show the real key.
- Quota exhaustion stops model calls for that user only, and the user sees why.
- Streaming responses work end to end through gateway, sandbox and proxy.
- `tests/run.sh all` passes with the new `phase3` suite listed in `run.sh`.

## Risks

- **Usage accuracy with streaming.** Some providers omit usage in streams. Mitigated by `include_usage` and an estimate fallback (A4).
- **Harness provider config.** `llm-pi-ai` may need the proxy as a custom `baseURL` plus a dummy key name. Check this early in C3, since it decides whether any harness patch is needed.
- **Single instance.** In-memory rate limits and SQLite assume one proxy process. This is acceptable until scale-out is required.
- **Token on a shared network.** Until phase 4 egress policy, sandboxes can reach each other and the proxy. A token only grants that user's quota, and the admin API needs a separate secret.
