# Phase 5: a friendlier dsh-cloud

Status: **scope chosen (2026-11-25); not started.** The decisions are recorded below and the first slices are broken into tasks. The idea list that follows is the source for later slices. Builds on [plan-phase-4.md](plan-phase-4.md), which made the service safe for untrusted users. Parent plan: [plan.md](plan.md). Working rules: [../AGENTS.md](../AGENTS.md) (one topic branch and PR per task, tests written and run, findings documented, routine steps scripted).

## Context

Phase 4 made the service safe for untrusted users. The price was paid in user experience: limits, refusals and restarts exist, but most of them surface as a terse error on the launching page, a token counter in the bar, or nothing at all. Two first-login problems (a "Preview Notice" popup and "Unable to create default workspace") were found only by looking at the product in a browser; there are likely more of that kind. This phase is about what a new, non-expert user sees and feels from the invite to their tenth session.

What users see today (from `gateway/web/src/pages/*` and `gateway/src/*`):
- **Sign-in page:** one card with sign-in and sign-up forms; the invite is a plain text field; errors are generic ("A valid invite code is required"); no password reset, no email verification, no account deletion.
- **Launching page:** four stages and an elapsed timer. Failures map to a few sentences. When the service is full the user gets "at capacity, try again" and nothing else. Limit stops (run time, disk) appear only here, as an error.
- **App shell:** brand, "Today N / 500K tokens", email, sign out, and a banner only for the *personal* quota. No storage use, no time left, no stop button, no warning before a cutoff, and the *global* budget 429 shows up as a raw model error inside the harness.
- **Inside the harness:** the harness's own UI, unchanged apart from the policy patch: a "Preview" badge, "DSH Local Build 0.2.2-rc.5-2e39e70" in the sidebar, menus for plugins, automation and settings, and no explanation of what this product is, what the limits are, or how to get files in and out.

## Decisions (2026-11-25)

| Question | Decision | Consequences |
| --- | --- | --- |
| Who are the users? | **Developers** | Keep plugins and the terminal. The image needs real developer tooling. Explain limits and policy instead of hiding features. |
| Main task | **Build software** | Priorities: toolbox and package caches, working with repositories, seeing what the agent builds. File upload and zip export are lower priority (developers have git). |
| Agent keeps working with the tab closed | **Yes, with a cap** | Model traffic and running processes count as activity, up to a cap (default 2 hours of busy time after the last browser activity). Costs more compute per user; the cap is a setting. |
| Email | **Mailgun** | Send through Mailgun's HTTP API (`POST https://api.mailgun.net/v3/<domain>/messages`, HTTP basic auth with user `api` and the API key; EU accounts use `api.eu.mailgun.net`), using Node's built-in `fetch`, so the gateway keeps its no-runtime-dependencies rule and needs no SMTP client. Behind a small provider interface (`MAIL_PROVIDER`), with a `log` provider for development and tests. Mailgun needs a **sending domain with DNS records** (SPF and DKIM, verified in Mailgun) for real delivery; a Mailgun sandbox domain only sends to pre-authorised recipients, so it is good for the first manual test and not for users. Plan limits and pricing change: check the current Mailgun terms before launch (not verified here). Settings: `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_REGION` (`us` or `eu`), `MAIL_FROM`. |
| Identity | email and password; GitHub sign-in later | GitHub sign-in is a later slice and also unlocks private repositories. |
| Branding, domain, legal pages | open | Not blocking the first slices; needed before a public launch. |

## Task breakdown

Each task is one topic branch and one pull request, with tests and documentation as in [../AGENTS.md](../AGENTS.md). Item numbers refer to the idea list below. "To verify" marks things the plan assumes but has not yet been checked.

### Slice 1: no surprises (work that is not lost, states that explain themselves)

| Task | Item | What and where | Verify |
| --- | --- | --- | --- |
| **P5-1 Busy sandboxes stay up** | 18 | Today `reap()` in `gateway/src/sandbox.js` counts only browser sockets and proxied requests, so a long agent task with the tab closed is stopped after `IDLE_SECONDS`. Add activity signals: the llm-proxy's last model call per user (it already sees every call; expose it on the admin socket), and the runner's view of running processes in the container (to verify: what `docker top` or the cgroup reports under gVisor). Treat a sandbox as busy while either is recent, up to `MAX_BUSY_SECONDS` (new setting) after the last browser activity. | Unit tests for the policy with fake signals; Docker case: a sandbox running a long command and making model calls with no browser connected survives past the idle limit, and is stopped after the cap. |
| **P5-2 Designed states** | 7 | One state model in the gateway for every reason a sandbox is not running or a request is refused: idle stop, run-time stop, disk stop, personal quota, global budget, capacity, harness crash, start failure. Each has a code, a plain title, what happened, what to do, and an action. `/gw/api/status` returns it; the launching page and the shell render it. | Unit tests per state; browser check of each visible state. |
| **P5-3 Usage and limits panel, stop and restart** | 8, 9 | Extend `/gw/api/usage` with month tokens, storage used and limit (the runner's `/v1/usage`), time left in this run and idle time left. Shell panel with warnings at 80% and 95%; a Restart and a Stop button; a notice before a stop. | Unit tests for the numbers; browser check with a user near each limit. |

### Slice 2: a toolbox that does the job

| Task | Item | What and where | Verify |
| --- | --- | --- | --- |
| **P5-4 Developer toolbox** | 22 | First check what the harness build already provides. Then add to `sandbox/Dockerfile`: git, Python 3 with pip and venv, build-essential, curl, jq, ripgrep, unzip, ca-certificates. Keep the root read-only and the image reproducible; record size and build time. | A Docker case that runs `git`, `python3`, a compile and a `pip install` inside the confined shell. |
| **P5-5 Package caches that persist** | 23 | A per-user cache volume (npm, pip, cargo) with the cache variables set in the entrypoint. **Known pitfall:** the agent's shell can write only its session folder plus configured extra roots, so the cache directory must be added to `sandbox-policy`'s `additionalWritableRoots`; otherwise installs fail inside the confined shell. Add the volume to the runner's spec, the backup list and the disk accounting. | Docker case: install a package twice and see the second one hit the cache; cache survives a restart; backup and restore include it. |

### Slice 3: first-run and access

| Task | Item | What and where | Verify |
| --- | --- | --- | --- |
| **P5-6 Our welcome and a curated UI** | 11, 12 | A one-screen welcome (what this is, limits, how work is saved, how to get code out) shown once, delivered through the harness's own first-run slot or the gateway shell (to verify which is feasible by config alone). Hide the build-id string and the harness Sign-in item; relabel the "Preview" badge; friendly model names. Plugins and the terminal stay. | Browser check as a fresh user; entrypoint tests. |
| **P5-7 Invite links and clearer sign-up** | 1, 2 | `/gw/signup?invite=…`, links printed by `scripts/invite.sh`, redirect back after login, distinct invalid, used and expired messages, show-password. | Unit and browser tests. |
| **P5-8 Email via Mailgun** | 3, 19 | A mail provider interface in the gateway with a Mailgun implementation (HTTP API) and a `log` provider; password reset, emailed invites, and a "your task finished" notice that uses the P5-1 busy signal. Rate-limit sends per user and per address; never put content, tokens or invite codes in logs, and use single-use expiring reset links. Handle API errors without breaking the request that triggered the mail (queue and retry briefly, then give up and audit). Document the Mailgun setup (domain, DNS records, API key, region) and `.env` settings. | Tests against a fake Mailgun HTTP server (request shape, auth header, failures, retries, no secrets in logs); one real send through the owner's Mailgun domain is a manual step, recorded in the doc. |
| **P5-9 Waiting room** | 5 | When at capacity, show queue position and start automatically when a slot frees, instead of the refusal. | Docker case on the capacity suite. |
| **P5-10 Crash watchdog** | 21 | Restart a crashed harness at once and restore the open session; say what happened (uses P5-2). | Docker case: kill the harness and see recovery. |

### Slice 4: what a developer needs next (scope later)

Working with repositories with credentials injected at the egress proxy (24); previewing what the agent builds (25); scheduled tasks that wake the sandbox (20); per-user snapshots (26); GitHub sign-in (29); bring-your-own key (27); account page (4); admin page (16). These get task breakdowns after slice 1 and 2 are in and measured.

## Order and dependencies

P5-1 first (it fixes lost work and P5-8 depends on its signal), then P5-2 and P5-3 (P5-2's states are what P5-3 and P5-10 display). P5-4 and P5-5 can go in parallel with slice 1, since they touch the image and the runner rather than the gateway. P5-6 and P5-7 are independent and small. P5-8 needs P5-1 and a Mailgun sending domain with its DNS records.

## Idea list (effort: S under a day, M a few days, L a week or more)

### A. Getting in
1. **Invite links** (S): `/gw/signup?invite=…` prefills the code; `scripts/invite.sh` prints full links. Redirect back to the page the user wanted after login.
2. **Clear sign-up errors** (S): say whether the invite is invalid, used or expired; point out a short password before submit; show/hide password.
3. **Password reset and email verification** (M, needs an email provider): magic link or reset link; invite delivery by email. A stopgap `scripts/reset-password.sh` is S.
4. **Account page** (M): change password, delete account and data (needs the runner to remove volumes and the network), export my data.

### B. Starting and waiting
5. **Waiting room instead of a dead end** (M): when full, show queue position and auto-start when a slot frees; the capacity refusal today is a dead end.
6. **Faster, more honest starts** (M): pre-start the sandbox while the user is on the login page or just after sign-in; show a real estimate from recorded start times (the audit log already stores `ms`); "resuming" skeleton copy.
7. **Every refusal is a designed state, not an error** (S to M): run-time stop, disk stop, personal quota, global budget, capacity, harness crash each get a plain title, what happened, what to do, and a button (Restart, Free up space, Try later). Show it in the shell as well as on the launching page. Attach the technical detail and a request id to the feedback form.

### C. Staying informed
8. **Usage and limits panel** (M): tokens today and this month, storage used of limit, time left in this run, reset times; warn at 80% and 95% before a cutoff; separate wording for the global daily budget.
9. **Stop, restart and "keep working"** (S to M): a Restart workspace button; a toast "stops in 5 minutes (idle or run-time limit)" with an extend action where policy allows.
10. **Files in and out** (M to L): download the workspace as a zip, upload files, show what uses the disk and offer "free up space". For a hosted agent this is probably the most valuable single feature, and today only the harness UI offers it.

### D. Inside the harness
11. **Our own short welcome** (S): replace the removed preview notice with a one-screen "what this is, what it can do, limits, how to get files out, privacy", shown once; starter prompts and a sample project in the empty state.
12. **Curate the UI for this audience** (S, config patches like F1): hide or relabel the "Preview" badge, the build-id string, the harness Sign-in item, and plugin management if users should not install plugins; give models friendly names (the only route is labelled "Free Models Router").
13. **Plain-language approval prompts** (S to M): the escalation prompt says what the command will do and why it is asked.

### E. Trust and polish
14. **Branding and basics** (S to M): product name, page titles and favicon, a real domain and TLS, terms and privacy links, branded 404 and 502 pages, a status page.
15. **Accessibility and mobile pass** (M): keyboard, contrast, screen reader labels, narrow screens on the gateway pages; automate with Playwright and axe.

### F. Operators
16. **Small admin page** (M to L): invites (create, copy link, revoke), users, usage, running sandboxes with a Stop button, audit search. Deferred as a non-goal in phase 4.
17. **Product metrics from what we already record** (S): time-to-ready, sign-up to first message, failure and refusal rates, from the audit table; a `scripts/` report first, dashboard later.

### G. Capabilities that make the work itself seamless (not UI)

These are gaps in what the product can do. Some come straight from code already read; those are marked **found**. They probably matter more than polish, because a user who cannot finish their task will not care that the page is pretty.

**Work that keeps running**
18. **Do not stop a sandbox that is busy** (M, **found**): the idle reaper (`gateway/src/sandbox.js`, `reap()`) looks only at browser sockets and proxied requests. An agent working on a long task with the tab closed is stopped after `IDLE_SECONDS` (30 min), mid-task. Count model traffic (the llm-proxy sees every call), running child processes, or the harness's own "running" state as activity, up to a cap, and say so in the usage panel.
19. **Notify when done** (M, needs email or a webhook): a message when a long task finishes, fails, or the quota is nearly gone, so the user can leave. Pairs with 18.
20. **Scheduled and automation tasks that actually fire** (M, **found**): the harness UI offers "Automation tasks", but a stopped sandbox cannot run a schedule. Either wake the sandbox at the scheduled time (the gateway owns the clock) or hide the feature until it works.
21. **Recover from a crash without losing the thread** (M, **found**): the harness can exit under load (seen in the G1 abuse tests) and is restarted on the next request. Add a watchdog that restarts it at once, restores the open session, and tells the user what happened.

**A usable toolbox**
22. **Real tooling in the image** (M, **found**): `sandbox/Dockerfile` is `node:24-slim` plus bubblewrap, so there is no git, Python, compiler or `make` unless the harness build bundles them (not checked). Decide a baseline for the audience (git, Python 3, build tools, common CLIs), keep the image reproducible, and keep the root read-only so installs go to the workspace volume.
23. **Package installs that stick and are fast** (M): the egress proxy already allows public hosts on 80/443, so registries work; add a per-user cache volume for npm, pip and similar so repeat installs are quick and survive restarts. Consider a registry mirror allowlist for speed and for reducing exposure.
24. **Working with real repositories** (M to L): clone from a URL or an uploaded zip; push to GitHub. Private repos need credentials the sandbox must not be able to leak: inject the token at the egress proxy for that host only, the same pattern as the model key, so it never sits in the sandbox environment or files.
25. **See what the agent builds** (L): a way to open a dev server the agent starts (for example port 3000) through the gateway, on a separate origin so it cannot read the user's session. For the "build me an app" use case this is the difference between a demo and a product.

**Continuity and control**
26. **Snapshots and restore for a user** (M): the backup scripts restore the whole installation; add per-user "restore my workspace to yesterday" and automatic checkpoints before risky steps.
27. **Bring your own key or model** (M): optional user-supplied provider key (held only by the llm-proxy, never in the sandbox) so heavy users are not bound by the shared budget; a wider list of models with friendly names and the cost of each.
28. **Fairer, clearer quotas** (S to M): tiers (trial, standard), a "request more" path, warnings before limits, and distinct handling of the global budget so one heavy user does not look like an outage to everyone.
29. **Easier sign-in and sessions** (M): sign in with GitHub or Google (also unlocks 24), passkeys or a second factor, "sign out everywhere", visible active devices.
30. **Sharing** (M): export a conversation, or share a read-only link to a transcript or result; team workspaces later.

**Reliability the user feels**
31. **Gateway restarts without dropping sessions** (M to L): a restart drops every WebSocket today; the harness UI reconnects, but graceful drain and a second gateway instance would make deploys invisible. Rate limits and idle timers also reset on restart.
32. **Faster cold start** (M): a pool of pre-created sandboxes, a smaller image, warm caches; measure first, since a start is about five seconds in the VM.
33. **Status and incident communication** (S to M): health checks per sandbox, a status page, and a banner when the model provider is failing, so users can tell "my fault" from "service problem".
34. **Privacy and data rights** (S to M): retention policy, delete-my-data, export, and a plain statement of what is logged (the audit log already excludes content).

## Open decisions

- **Branding, domain and legal pages** (needed before a public launch).
- **Busy-time cap value** (the default of two hours is a guess; measure real task lengths first).
- **How far to curate the harness UI** for developers (P5-6 starts conservative: hide only what is confusing, not features).
- **Sending domain for Mailgun:** a domain you control and can add DNS records to (SPF, DKIM). It blocks real delivery for P5-8 (not the other tasks), and it overlaps with the branding and domain decision above. Mailgun account region (US or EU) and the `MAIL_FROM` address also need choosing.

## How each item would be verified

- Browser checks with the Playwright and Chromium setup used for the preview-notice and default-workspace fixes (scripts that sign in as a fresh user and inspect the page; not yet in the repo); promote them to a `tests/ui/` suite so the first-login experience cannot regress silently.
- Unit tests for gateway states and messages (`tests/gateway/*`), entrypoint tests for harness patches (`tests/sandbox/entrypoint.test.mjs`).
- Phase 4 suites stay green; new behaviour (waiting room, restart, export) gets a Docker suite case.
- Measure time-to-ready and the share of sessions ending in a refusal before and after, using the audit table.

## Process

Work on topic branches and open PRs (`main` requires them), one task per branch, following [../AGENTS.md](../AGENTS.md). Keep the phase 4 suites green throughout; every task adds its own tests, and any user-visible change is checked in a real browser. Record findings in this document or a research note as tasks complete, and tick tasks off in the task tables.
