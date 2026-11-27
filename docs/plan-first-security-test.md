# Path to a first security test of the owner's two web apps, from the local setup

Status: **plan approved (2026-11-27); steps 1 (the spike), 2 (the toolbox), 3 (the safety limits) and 4 (GitHub) done, results in [research-security-tooling.md](research-security-tooling.md) and [github-access.md](github-access.md); step 5 (skills) next. One manual check remains for step 4: a real private repository with a real token.** This is the shortest route through [plan-phase-6.md](plan-phase-6.md) to a first real use, written before any of it was built. Facts it relies on are in [research-security-tooling.md](research-security-tooling.md); anything not checked is marked **to verify**. Working rules: [../AGENTS.md](../AGENTS.md).


## Context

[plan-phase-6.md](plan-phase-6.md) designs a whole workspace for security professionals. The owner asked for the shortest route from what exists now (dsh-cloud running locally in the Lima VM under gVisor, the owner as the only user) to a **first real use: black-box testing of the owner's two web apps, plus reading their GitHub repos**. The owner's answers:

- The apps run at **public HTTPS URLs**, and it is acceptable to test **staging or a local copy only** (not production).
- First test type: **black-box web testing**, and the owner wants to **connect the GitHub repo**; code arrives by **git clone over HTTPS**.

So reachability needs no new network path (the egress proxy already reaches public hosts on 80 and 443), and the risky parts of phase 6 (per-user scope with ownership verification, attestation, multi-tenant conduct) are **not needed yet** because the only user is the owner. What is missing is tools, a few safety limits for pointing tools at a live site, the repo connection, and a method.

## What exists and what does not (read or measured earlier; two items still to verify)

- **Reach:** sandbox to any public host on ports 80 and 443 through the egress proxy; private addresses, other ports and non-HTTP protocols refused (measured, [research-security-tooling.md](research-security-tooling.md)).
- **No limits on that path:** no host allowlist, no per-user or per-destination rate limit, no stored per-user record (`egress-proxy/src/server.js`, `filter.js`, `config.js`).
- **The agent's confined shell and the network:** **verified in the step 1 spike** with the real agent: the shell has the proxy variables, reaches public hosts on 443 and 80 through the proxy, is refused on port 8080 and for private and metadata addresses, and has no route when it ignores the proxy. The model token is not visible to it.
- **Tools:** **verified: the image has only `node` and `npm`.** No `curl`, `git`, `python3`, `jq` or compiler, so step 2 needs the whole list.
- **Model:** the free router; quality on security prompts and its data handling are unverified (fine for the owner's own staging apps, weak for client work).

## The path, in order (each is one branch and one pull request, per AGENTS.md)

### 1. Spike: can the agent's shell reach staging? (S, no feature code) — done 2026-11-27
The real agent ran a fixed probe through its confined shell in a throwaway account of the local stack. Result: reachability works as designed, nothing but Node is installed, and the model token is hidden from the agent's shell; details in [research-security-tooling.md](research-security-tooling.md). The probe is now `scripts/probe-agent-shell.sh` (with a test) so it can be rerun after the toolbox and the egress limits land.

### 2. Toolbox for web testing and repo work (M; subset of phase 6 S6-1 and S6-6, replaces P5-4/P5-5 for now) — done 2026-11-27
*Built as described below, with these changes, all recorded in [research-security-tooling.md](research-security-tooling.md): `trufflehog` (AGPL-3.0) and `semgrep` (heavy, rules licence) left out; `whatweb` left out (it pulls in Ruby; `httpx` fingerprints); `bandit` and `pip-audit` added as the Python tools; no extra writable roots were needed because `HOME` is already under `/workspace`; the image is 3.69 GB (+0.8 GB).*

- `sandbox/Dockerfile`: apt packages measured to exist on Debian 12 (aarch64): `git`, `curl`, `ca-certificates`, `python3` with `pip` and `venv`, `jq`, `ripgrep`, `unzip`, `sqlmap`, `ffuf`, `gobuster`, `sslscan`, `testssl.sh`, `whatweb`.
- Release binaries with no Debian package, **pinned by version and SHA-256 per architecture** by a new `scripts/pin-tools.sh` (same pattern as `scripts/pin-images.sh`, listed in CI via the existing `sh -n` rule): `httpx`, `nuclei`, and for repo review `semgrep` (pip), `gitleaks`, `trufflehog`, `trivy`/`osv-scanner`. Check each licence before including.
- Caches and `pip install --user` working in the confined shell: add the cache and install directories to the shell policy's extra writable roots (the known pitfall; patch in `sandbox/entrypoint.sh`, verify with `dsh --profile web --dump-config`), so tool databases (nuclei templates, trivy DB) persist in the user's volume.
- Record image size and build time (expected: about +0.7 GB, about 30 s per cold layer).
- **Tests:** new `tests/phase6/toolbox.test.mjs` (Docker, gVisor): one command from each tool runs as the sandbox user inside the confined shell; the pin script fails on a wrong checksum; a unit test for the pin file format.

### 3. Safety limits before any tool is aimed at a live site (M; phase 6 S6-11, plus a small operator scope list) — done 2026-11-27
*Built as described below, plus `scripts/egress-scope.sh` to change the list, and a fix for a crash in the existing proxy found on the way ([finding-egress-proxy-crash.md](finding-egress-proxy-crash.md)). To aim the tools at the staging apps: `scripts/egress-scope.sh --set <staging-host-1>,<staging-host-2>`. Results and the limits of the limits are in [research-security-tooling.md](research-security-tooling.md) and [../egress-proxy/README.md](../egress-proxy/README.md).*

- **Rate and connection limits** per user network and per destination in `egress-proxy/src/server.js` (source address already identifies the user network): defaults conservative for staging, configurable by env now and by the Policies page later (P5-15 pattern in `llm-proxy/src/policy.js` / `gateway/src/policy.js`).
- **Operator scope list (recommended):** an env setting `EGRESS_ALLOW_HOSTS` (exact and `*.domain` suffix entries) plus a small default base list the work needs (GitHub hosts, package registries, the template and database hosts nuclei and trivy use, knowledge sources). When set, the proxy refuses every other host with the reason "not in scope". With the two staging domains listed, a mistaken command or a crawler following a link **physically cannot** touch a third-party site. Global for now, not per user; per-user scope with ownership verification stays in phase 6 (S6-14 to S6-16).
- Compose and `.env.example` pass the new settings; `egress-proxy/README.md` updated.
- **Tests:** unit tests in `tests/egress-proxy/` (each limit, allowlist matching including wildcard and look-alike names, no bypass by IP literal or by a name that resolves into scope from outside, deny reasons logged); Docker case extending `tests/phase4/isolation.test.mjs`: a loop of requests from one sandbox is throttled while a neighbour is not, an out-of-scope host is refused and logged.

### 4. Connect the GitHub repos (S to M) — done 2026-11-27
*Built as described below with `dsh-git` (login, logout, status) and a how-to in [github-access.md](github-access.md), which also records the risks plainly, a bug found in the first version (git rewrites a used credential, so a naive `logout` could leave the token), and the safer later design (S6-18). The terminal the how-to uses was checked in a real browser. The private-repository path is verified against a local server that demands credentials; the one manual check left is a real repository with a real token.*

- **Public repo:** works as soon as step 2 lands (`git clone https://...` through the proxy).
- **Private repo, first version:** a **fine-grained, read-only, single-repository token with a short expiry**, given to git through the workspace's credential store (`HOME` is the persisted workspace volume, so `~/.git-credentials` and `~/.gitconfig` persist). Documented how-to plus the risks stated plainly: the agent can read it and anything the agent reads can reach the model provider, so use a throwaway read-only token and revoke it after. No push access.
- **Finding to record in the docs:** the earlier idea of injecting credentials at the egress proxy does not work for HTTPS, because a `CONNECT` tunnel is opaque TLS and the proxy cannot add a header without intercepting TLS. A later "Connect GitHub" feature would instead keep the token in the gateway and hand it to a git credential helper over the user's internal network (never on disk), with audit; not part of this path.
- **Tests:** a live case cloning a public repo through the proxy in the confined shell; the private-repo path is a documented manual check (needs a real token, never committed).

### 5. Methodology skills (S; phase 6 S6-3 subset) — done 2026-11-27
*Built as described below: four skills and an engagement template in `sandbox/skills/`, shipped by `COPY skills/ /opt/dsh-skills/` and `ENV DSH_BUNDLED_SKILL_DIR=/opt/dsh-skills`. **No patch row was needed** (the variable alone is enough; verified in a real browser: all four appear in the composer's `/` menu). Details, and what was learned (ffuf 1.1.0 has no `-rate`; no wordlists in the image), in [research-security-tooling.md](research-security-tooling.md#methodology-skills-result-2026-11-27). Not verified: how well the free model follows them.*
`sandbox/skills/` with `web-app-testing` (scope first, passive then active, rate-aware, stop conditions), `secure-code-review`, `report-writing`, and `engagement-rules` (read the engagement file, stay in scope, never test production, never use real user data). Shipped to `/opt/dsh-skills`; the harness skill provider reads `$DSH_BUNDLED_SKILL_DIR` (documented option; **to verify** it needs no patch row). Test: every skill has valid frontmatter and a size budget; the live harness lists them.

### 6. The first engagement: calibrate, then the apps (M, mostly running, little code)
1. **Calibrate on a published, intentionally vulnerable public target** (whose owner invites testing; check it is still up and its rules) to prove the tools, the limits and the agent's method find known issues. This is the check that the whole chain works before it touches the apps.
2. Write `ENGAGEMENT.md` in the workspace (the two staging URLs, rules, rate ceiling, test accounts, stop conditions); list the same two domains in `EGRESS_ALLOW_HOSTS`.
3. Run the playbook per app: passive recon (headers, TLS with `testssl.sh`, fingerprint with `httpx`/`whatweb`), content discovery with `ffuf` (a small wordlist shipped or fetched from GitHub into the volume), `nuclei` with intrusive and denial-of-service tags excluded, authenticated checks with test accounts (access control between users, session and token handling), and repo review (`semgrep`, `gitleaks`, dependency scan). App-specific checks once the stacks are known.
4. Output: a Markdown findings report with severity and evidence in the workspace. Structured findings and the CVSS calculator (phase 6 S6-7 and S6-10) come later.
5. **Model check:** run the same short prompt set against the free router and, if results are poor or refused, a paid model; record the outcome (also feeds phase 6 S6-4).
6. Write what happened (what worked, what the agent got wrong, what to improve) into `docs/`, as AGENTS.md requires.

## Not on this path (needed before anyone else is invited, per phase 6)
Acceptable-use acceptance and attestation (S6-5), persisted egress record and admin Egress page (S6-12), model privacy enforcement (S6-4), per-user scope and ownership verification (S6-14 to S6-16), the `engagement`, `findings` and `dsh-security-kb` plugins (S6-7 to S6-10), copy for the new audience (S6-17).

## Critical files
`sandbox/Dockerfile`, `sandbox/entrypoint.sh` (writable roots, skills dir), new `scripts/pin-tools.sh`, `egress-proxy/src/{server,filter,config}.js`, `infra/docker-compose.gateway.yml`, `.env.example`, `egress-proxy/README.md`, new `sandbox/skills/`, new `tests/phase6/`, `tests/egress-proxy/`, `docs/plan-phase-6.md` and `docs/research-security-tooling.md` (results). Reuse: the pin pattern in `scripts/pin-images.sh`, the settings pattern in `gateway/src/policy.js`, the Docker-suite helpers in `tests/lib/helpers.mjs`, the backup, run, restore routine for destructive suites.

## Verification, end to end
- Unit: `tests/run.sh unit` (pin file, egress limits and allowlist, skill lint).
- Docker, in the Lima VM under gVisor (`DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc`): the toolbox, egress and clone cases. These wipe the VM stack, so back up and restore each time and ask first.
- Browser: sign in, open the workspace, run a tool from the agent's shell.
- Live: step 6.1 on the calibration target, then the two staging URLs; the egress log shows only listed hosts, the rate limit holds, a report is produced.

## Open items for the owner (do not block step 1)
- The two staging URLs and the stacks (I only know vid2doc's from earlier: FastAPI, Next.js, nginx; its URL-import and upload endpoints deserve targeted checks).
- Whether to use the free router or a paid model for the real run.
- Which GitHub repos, and whether a short-lived read-only token is acceptable (step 4).
- Whether staging sits behind a WAF or provider rate limiting that could block the owner's home address (the sandbox's traffic leaves through the Mac's connection).
