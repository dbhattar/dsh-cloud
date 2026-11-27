# llm-proxy

Metering proxy between the sandboxes and the model provider (phase 3). It holds the only copy of the real
provider key. Zero npm dependencies; Node >= 24 (`node:sqlite`).

```
sandbox --Bearer <per-user token>--> llm-proxy:8081/v1 --Bearer <real key>--> provider
gateway --Bearer <ADMIN_SECRET>----> llm-proxy admin socket (/run/llm-admin/admin.sock)
```

## Behaviour

- **API for sandboxes:** OpenAI-compatible `POST /v1/chat/completions` (JSON and SSE streaming) and `GET /v1/models`. Anything else is 404.
- **Auth:** `Authorization: Bearer dshu_...`. Tokens are stored as SHA-256 hashes; one active token per user. Issuing a token for a user revokes the previous one.
- **Quota:** input + output tokens per UTC day and per UTC month, per user. An exhausted user gets `429` with `error.code = "quota_exceeded"`, a message with the reset time, and `Retry-After`; no provider request is made. Usage is read from the provider's `usage` field (streams get `stream_options.include_usage`); if the provider omits it, a byte-based estimate is charged. Failed provider calls are not charged; a client that disconnects mid-stream is charged for what was produced.
- **Global budget:** `GLOBAL_DAILY_TOKEN_BUDGET` caps all users together per UTC day. Once it is used up every request gets `429` with `error.code = "budget_exhausted"` and `Retry-After` until midnight UTC, before any provider call. One heavy user can use it up for everyone, so the per-user quotas are what stop that.
- **Limits:** per-user requests per minute and concurrent requests (`429` + `Retry-After`), request body size, output-token cap (`max_tokens` / `max_completion_tokens` is clamped, or set when absent), model allowlist, upstream timeout. A quota can be overshot by up to `MAX_CONCURRENT x MAX_OUTPUT_TOKENS`, because usage is only known after a call finishes.
- **Errors:** provider credential failures (401/403) are masked as `502 upstream_auth_failed`; provider detail is never forwarded for those. Other provider statuses pass through.
- **Logging:** one JSON line per call (user, model, status, tokens, latency). Prompts, completions, tokens and keys are never logged. `audit {json}` lines record token issue and revoke, `quota.hit` and `budget.exhausted` (the last two at most once per user per 10 minutes).

## Admin API (unix socket, `Authorization: Bearer $ADMIN_SECRET`)

Served only on a unix socket (`ADMIN_SOCKET`, default `/run/llm-admin/admin.sock`) on the `llm-admin` volume, which only the gateway and the proxy mount. The TCP listener (`:8081`, `/v1/*`) has no admin routes: the proxy is attached to every user network, so any TCP port would be reachable from every sandbox. A sandbox gets 404 for `/admin/*` even with the right secret.

| Route | Purpose |
| --- | --- |
| `POST /admin/tokens` `{userId}` | issue or rotate a user's token; the plaintext is returned once |
| `DELETE /admin/tokens/:userId` | revoke (model access stops immediately) |
| `GET /admin/usage/:userId`, `GET /admin/usage` | usage, limits and reset times |
| `GET /admin/activity` | `{ users: [{ userId, inflight, lastAt }] }`: users with a model request in flight or one that ended in the last 15 minutes (in memory; the gateway uses it to keep busy sandboxes running) |
| `GET /admin/policy`, `PUT /admin/policy/:key` `{value, confirm?}`, `DELETE /admin/policy/:key` | the settings an admin may change (`src/policy.js`): quotas, the shared budget, rate limits, the output cap. The environment value is the default; an override is stored in the proxy's database, applied at once and kept across restarts; `0` (off or unlimited) needs `confirm: true`. `DELETE` restores the default |
| `GET /admin/stats?days=N` | `{ days: [{ day, tokens, requests, users }], global }`: tokens, requests and distinct users per UTC day for the last N days (default 14, at most 90, zero days filled in), and the shared budget; the admin overview charts it |

The proxy has no published port; `/v1` is reachable from the compose network and from each user network. `scripts/usage.sh` prints per-user totals.

## Configuration (env)

| Variable | Default | |
| --- | --- | --- |
| `UPSTREAM_API_KEY` | required | real provider key |
| `ADMIN_SECRET` | required, >= 16 chars | shared with the gateway (`LLM_ADMIN_SECRET`) |
| `ALLOWED_MODELS` | required | comma-separated model ids sandboxes may use |
| `UPSTREAM_BASE_URL` | `https://openrouter.ai/api/v1` | any OpenAI-compatible endpoint (e.g. DeepSeek's) |
| `DAILY_TOKEN_QUOTA` / `MONTHLY_TOKEN_QUOTA` | 500000 / 5000000 | `0` = unlimited |
| `GLOBAL_DAILY_TOKEN_BUDGET` | 0 (compose: 5000000) | all users together per UTC day; `0` = unlimited |
| `RATE_LIMIT_PER_MINUTE` / `MAX_CONCURRENT` | 60 / 4 | per user |
| `MAX_OUTPUT_TOKENS` / `MAX_BODY_BYTES` | 16384 / 8 MiB | the harness's own limit is the runner's `MODEL_MAX_OUTPUT_TOKENS` (default 16384); keep it at or below this, see [plan-phase-5](../docs/plan-phase-5.md#output-limit-per-reply) |
| `UPSTREAM_TIMEOUT_SECONDS` / `DATA_DIR` / `PORT` | 600 / `/data` / 8081 | |
| `ADMIN_SOCKET` | `/run/llm-admin/admin.sock` | admin API socket path |

Single instance only: rate limits are in memory and usage is SQLite on the `llm-proxy-data` volume.
