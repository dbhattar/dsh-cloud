# Regression tests

Zero-dependency suites (`node:test`, Node >= 24). Run from the repo root:

```
tests/run.sh unit     # gateway, runner, llm-proxy, egress-proxy and sandbox-entrypoint unit tests, no Docker (fast)
tests/run.sh phase1   # single sandbox behind Caddy (infra/docker-compose.yml)
tests/run.sh phase2   # gateway + per-user sandboxes (infra/docker-compose.gateway.yml), ~2 min
tests/run.sh phase3   # LLM proxy acceptance: real key isolation, metering, quotas (~3 min)
tests/run.sh phase4   # hostile-user isolation, resource abuse, egress, limits, signup control, audit (~8 min)
tests/run.sh all
```

Docker suites build and start their own stack on host port 443 and tear it down afterwards
(stop any other stack using 443 first). Each phase keeps its suite so earlier behaviour stays covered.
Add `tests/phaseN/` for each new phase and list it in `run.sh`.

| Suite | Covers |
| --- | --- |
| `gateway/` | password hashing, rate limiter, session store, config, startup stages, proxy token lifecycle through a fake runner, `/gw/api/usage` |
| `runner/` | container spec (volumes, limits, dropped caps, no real key), runner API auth, input validation, callers cannot set binds/caps/image, only the narrow routes exist |
| `llm-proxy/` | token store, quota windows (day/month rollover), rate/concurrency limits, usage parsing (JSON/SSE), passthrough and key swap, streaming, estimates, guards, admin API, log hygiene |
| `phase1/` | token auth, cookie flags, WebSocket upgrade through the TLS proxy |
| `phase2/` | signup/login/logout, unauthenticated refusal, CSRF origin check, per-user container + volume isolation, resource limits, sandbox cookie never reaches the browser, WS proxy auth, stop/resume persistence, idle-stop (active sockets exempt) |

| `phase3/` | acceptance, with a fake provider: the real key is absent from gateway/sandbox env, `docker inspect` and files; sandbox calls reach the provider with the real key; streaming; per-user metering; quota exhaustion returns 429 without a provider call and spares other users; model allowlist; user tokens are not admin credentials; usage survives a proxy restart; revocation and re-issue on sandbox recreation; legacy containers holding the key are replaced |

| `sandbox/pins` | base images pinned by digest (and the check fails on a floating tag), one Node base everywhere matching CI, the harness lock is well formed, CI actions pinned by commit and every job has a timeout |
| `gateway/busy` | busy-agent policy: model traffic and CPU keep an idle sandbox up, the cap stops it with the right audit rows, a returning browser resets the clock, failing signal sources fall back to the old behaviour, a busy sandbox is not evicted |
| `phase5/busy` | live: an idle sandbox is stopped at the idle limit while CPU-busy and model-busy ones survive with no browser attached, then both are stopped at the cap (`busy_cap`) and a returning user restarts normally |
| `egress-proxy/` | address filter (private, loopback, link-local, metadata, IPv6 forms), rebinding defence, CONNECT and plain HTTP forwarding, port and scheme limits, connection cap |
| `sandbox/` | the policy the entrypoint hands the harness: workspace-write rooted at /workspace, approval on, no danger-full-access preset |
| `phase4/isolation` | the gateway has no Docker socket; one internal network per user; sandbox A cannot reach sandbox B, the runner, the internet or metadata; web access only through the egress proxy (private and metadata destinations refused and logged); the agent shell is confined to /workspace (under gVisor); fork bomb, `/tmp` fill, CPU spin and memory hog stay inside their limits with the neighbour and host responsive; llm-proxy admin API unreachable from sandboxes and its socket mounted only by gateway and llm-proxy; the runner needs its secret; gateway, llm-proxy and egress proxy are re-attached after a recreate at the same addresses |
| `phase4/limits` | signup without a valid invite refused, a code works once; capacity cap refuses a second user without evicting; global token budget returns 429 and the provider is not called; an over-disk user is stopped with the reason and not restarted by an open tab; each action left an audit row and no password is in the trail |

| `phase4/backup` | `backup.sh` writes both databases, every user volume and a manifest and its restore check passes; a flipped byte or a missing archive fails the check; `restore.sh --yes` refuses while the stack runs; a real restore brings back accounts and a deleted workspace file and drops an account created after the backup |

Run the phase 4 and 5 suites under gVisor on the Lima VM (see `docs/lima-setup.md`):
`DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc tests/run.sh phase4`. Under plain `runc` the shell-confinement test skips itself (bubblewrap needs user namespaces, which hardened runc denies).

Not covered: microVM isolation, the browser UI of the locked-down policy, `linux-x64`.

## Safety guard

The Docker suites use the compose project, container (`dsh-sbx-N`) and volume (`dsh-data-N`, `dshcloud_*`) names of a local dev stack and delete them on cleanup. They refuse to start when such data exists (a dev stack with accounts, or leftovers of a failed run). Remove it deliberately (`scripts/restart.sh --wipe`) or set `DSH_TESTS_ALLOW_DESTRUCTIVE=1`.
