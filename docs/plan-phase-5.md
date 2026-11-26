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
| **P5-1 Busy sandboxes stay up** (done, see "P5-1 result") | 18 | Today `reap()` in `gateway/src/sandbox.js` counts only browser sockets and proxied requests, so a long agent task with the tab closed is stopped after `IDLE_SECONDS`. Add activity signals: the llm-proxy's last model call per user (it already sees every call; expose it on the admin socket), and the runner's view of running processes in the container (to verify: what `docker top` or the cgroup reports under gVisor). Treat a sandbox as busy while either is recent, up to `MAX_BUSY_SECONDS` (new setting) after the last browser activity. | Unit tests for the policy with fake signals; Docker case: a sandbox running a long command and making model calls with no browser connected survives past the idle limit, and is stopped after the cap. |
| **P5-2 Designed states** (done, see "P5-2 result") | 7 | One state model in the gateway for every reason a sandbox is not running or a request is refused: idle stop, run-time stop, disk stop, personal quota, global budget, capacity, harness crash, start failure. Each has a code, a plain title, what happened, what to do, and an action. `/gw/api/status` returns it; the launching page and the shell render it. | Unit tests per state; browser check of each visible state. |
| **P5-3 Usage and limits panel, stop and restart** (done, see "P5-3 result") | 8, 9 | Extend `/gw/api/usage` with month tokens, storage used and limit (the runner's `/v1/usage`), time left in this run and idle time left. Shell panel with warnings at 80% and 95%; a Restart and a Stop button; a notice before a stop. | Unit tests for the numbers; browser check with a user near each limit. |

### Slice 2: a toolbox that does the job

| Task | Item | What and where | Verify |
| --- | --- | --- | --- |
| **P5-4 Developer toolbox** | 22 | First check what the harness build already provides. Then add to `sandbox/Dockerfile`: git, Python 3 with pip and venv, build-essential, curl, jq, ripgrep, unzip, ca-certificates. Keep the root read-only and the image reproducible; record size and build time. | A Docker case that runs `git`, `python3`, a compile and a `pip install` inside the confined shell. |
| **P5-5 Package caches that persist** | 23 | A per-user cache volume (npm, pip, cargo) with the cache variables set in the entrypoint. **Known pitfall:** the agent's shell can write only its session folder plus configured extra roots, so the cache directory must be added to `sandbox-policy`'s `additionalWritableRoots`; otherwise installs fail inside the confined shell. Add the volume to the runner's spec, the backup list and the disk accounting. | Docker case: install a package twice and see the second one hit the cache; cache survives a restart; backup and restore include it. |

### Slice 3: first-run and access

| Task | Item | What and where | Verify |
| --- | --- | --- | --- |
| **P5-6 Our welcome and a curated UI** (done, see "P5-6 result") | 11, 12 | A one-screen welcome (what this is, limits, how work is saved, how to get code out) shown once, delivered through the harness's own first-run slot or the gateway shell (to verify which is feasible by config alone). Hide the build-id string and the harness Sign-in item; relabel the "Preview" badge; friendly model names. Plugins and the terminal stay. | Browser check as a fresh user; entrypoint tests. |
| **P5-7 Invite links and clearer sign-up** (done, see "P5-7 result") | 1, 2 | `/gw/signup?invite=…`, links printed by `scripts/invite.sh`, redirect back after login, distinct invalid, used and expired messages, show-password. | Unit and browser tests. |
| **P5-8 Email via Mailgun** | 3, 19 | A mail provider interface in the gateway with a Mailgun implementation (HTTP API) and a `log` provider; password reset, emailed invites, and a "your task finished" notice that uses the P5-1 busy signal. Rate-limit sends per user and per address; never put content, tokens or invite codes in logs, and use single-use expiring reset links. Handle API errors without breaking the request that triggered the mail (queue and retry briefly, then give up and audit). Document the Mailgun setup (domain, DNS records, API key, region) and `.env` settings. | Tests against a fake Mailgun HTTP server (request shape, auth header, failures, retries, no secrets in logs); one real send through the owner's Mailgun domain is a manual step, recorded in the doc. |
| **P5-9 Waiting room** | 5 | When at capacity, show queue position and start automatically when a slot frees, instead of the refusal. | Docker case on the capacity suite. |
| **P5-10 Crash watchdog** (done, see "P5-10 result") | 21 | Restart a crashed harness at once and restore the open session; say what happened (uses P5-2). | Docker case: kill the harness and see recovery. |

### Slice 4: what a developer needs next (scope later)

Working with repositories with credentials injected at the egress proxy (24); previewing what the agent builds (25); scheduled tasks that wake the sandbox (20); per-user snapshots (26); GitHub sign-in (29); bring-your-own key (27); account page (4). These get task breakdowns after slice 1 and 2 are in and measured.

### Slice 5: operating it (the admin panel)

The owner can only run this service through shell scripts today (`scripts/invite.sh`, `audit.sh`, `usage.sh`, `backup.sh`, `restart.sh`) and by editing `.env` and restarting. That does not scale past one person who knows the commands, and every policy this phase added (idle, busy cap, run time, disk, capacity, quotas, crash loop) is a restart away. This slice adds an admin panel. The design is in "Admin panel (design)" below; the numbers follow the earlier tasks.

| Task | Item | What and where | Verify |
| --- | --- | --- | --- |
| **P5-11 Admin role and shell** (done, see "P5-11 result") | 16 | An `is_admin` flag on users, set only from the command line (`scripts/make-admin.sh`, audited), never by a request. `/gw/admin/*` routes behind a guard: a signed-in admin, same-origin, no sandbox proxying, every action audited with the acting admin. An admin page in the gateway web app with its own navigation and a link in the shell for admins only. No content of a user's workspace or sessions is ever readable here. | Unit tests: a non-admin and a signed-out request are refused on every admin route (a table of routes, so a new route without the guard fails); audit rows carry the admin. Browser check as an admin and as a normal user. |
| **P5-12 Overview and stats (read only)** (done, see "P5-12 result") | 16, 17 | One page of numbers from what is already recorded: users (total, new, active over 24 hours and 7 days), running sandboxes against capacity, model tokens today and this month (total, by user, by model), storage (total, largest users), refusals and crashes by kind, time-to-ready, quota near-misses, and service health (runner, llm-proxy, egress proxy, disk of the host). New read endpoints on the llm-proxy admin socket and the runner where a number is not in the gateway database. Charts only where they beat a table. | Unit tests for each aggregate against a seeded database; the page checked in a browser with seeded data and with an empty stack. |
| **P5-13a Users and sandboxes** (done, see "P5-13a result") | 16 | Search and list users with state, last seen, usage and storage; open one user's page: sandbox state, recent audit rows, usage, feedback. Actions: stop, restart, suspend and unsuspend (a suspended user cannot sign in or reach the sandbox), sign out everywhere. State-changing admin routes are POST only, need the page's CSRF token, and suspending needs the email typed back. | Unit tests for every action and refusal; browser test; Docker case on a live stack. |
| **P5-13b Delete a user's data** | 16 | Delete an account and everything of theirs: container, network, both volumes (needs a new runner route; the runner has none today), proxy token and usage, sessions, feedback and the account row, behind a typed confirmation, audited. Its own task because it is destructive and touches the runner. | Runner unit tests (the route cannot delete anything but that user's resources); Docker case: volumes, network, container, token and rows are gone and a neighbour is untouched. |
| **P5-14 Invites, feedback and audit** | 16 | Create (with note, expiry, link), list and revoke invites; the feedback inbox (the table exists, nothing reads it yet) with a read flag; audit search with the same filters as the CLI and an export. | Unit tests; the CLI and the page agree on the same data. |
| **P5-15 Policies you can change** | 16 | A settings store in the gateway database for the policies listed below, with defaults from the environment so nothing changes until an admin edits something. Each setting has a type, bounds, a plain description and where it applies (live, next start, or needs a runner restart). Edits are validated, audited (old and new value, who) and take effect without restarting the gateway. Show the effective value and where it came from. A "reset to default" per setting. | Unit tests per setting (bounds, live effect, audit row); a Docker case that changes the idle limit and sees a sandbox stopped under the new value; a bad value never reaches the running policy. |
| **P5-16 Per-user overrides** | 16 | A quota (day and month), storage and run-time override for one user, with an expiry and a reason, for the friend who needs more today; shown in the user's own usage panel as theirs. Needs the llm-proxy to accept an override over its admin socket. | Unit tests in the proxy and the gateway; a Docker case: raise one user's quota and see the other unchanged. |

## Order and dependencies

P5-11 first, then P5-12 (it is read only, so it is safe to ship early and tells us what to build next). P5-13a, P5-13b and P5-14 and P5-15 can follow in any order; P5-15 is the largest and touches the llm-proxy and the runner. P5-16 needs P5-15's store.

Earlier tasks:

P5-1 first (it fixes lost work and P5-8 depends on its signal), then P5-2 and P5-3 (P5-2's states are what P5-3 and P5-10 display). P5-4 and P5-5 can go in parallel with slice 1, since they touch the image and the runner rather than the gateway. P5-6 and P5-7 are independent and small. P5-8 needs P5-1 and a Mailgun sending domain with its DNS records.

## P5-1 result: busy sandboxes stay up

Implemented on `feature/p5-1-busy-sandboxes`. A sandbox with no browser attached used to be stopped after `IDLE_SECONDS` (30 min) even if its agent was mid-task. Now it is kept while the agent looks busy, up to a cap.

**How it decides.** Each reap (every `REAP_INTERVAL_SECONDS`, 30 s) the gateway samples every running sandbox that has no browser socket and no start in flight, and marks it busy if either signal fires:
- **Model traffic:** the llm-proxy tracks, per user, requests in flight and the end time of the last one (in memory, `llm-proxy/src/activity.js`) and serves them on the admin socket at `GET /admin/activity` (users with a request in flight or one in the last 15 minutes). A request in flight, or one that ended within `BUSY_SIGNAL_SECONDS` (300), counts.
- **CPU use:** the runner serves `GET /v1/sandboxes/:id/activity` (cumulative CPU nanoseconds and memory from Docker's one-shot stats). The gateway differences two samples; at or above `BUSY_CPU_PERCENT` (5) of one CPU over the interval counts.

A busy signal stays valid for `BUSY_SIGNAL_SECONDS` (300). A sandbox past the idle limit is kept while it is busy and `MAX_BUSY_SECONDS` (7200 in compose, 0 = feature off) has not passed since the user's last activity; after that it is stopped and audited as `sandbox.stop` with `by: busy_cap`. The first keep of an episode is audited once as `sandbox.kept_busy` with the signal (`model` or `cpu`). A busy sandbox is also never chosen for eviction when the service is full. A returning user restarts a capped sandbox normally (it is not a hold). The other limits (`MAX_RUN_SECONDS`, the disk limit) still apply on top.

**Measured** (Lima VM, Docker 29, `runsc` and `runc`, `linux-arm64`, one-shot stats):

| | idle harness | CPU-bound command | process count |
| --- | --- | --- | --- |
| `runc` | about 0.06 s of CPU per 5 s (about 1%) | about 1 s per second (100%) | 11 idle, 18 busy: moves |
| `runsc` | about 0.05 s per 5 s (about 1%) | about 1 s per second (100%) | **43 constant: useless** |

So CPU is the usable signal under gVisor; the process count Docker reports does not move, which is why it is not used. The 5% default sits well above an idle harness (about 1%) and well below any real build or test run.

**Known gaps.**
- **A busy agent that is only waiting is not detected unless it is calling the model.** A long download, a command blocked on the network, or `sleep` use no CPU and make no model call, so such a sandbox is stopped at the idle limit. Longer `IDLE_SECONDS` or a future signal (open connections, process state) is the remedy.
- **Model traffic that bypasses the proxy** does not exist today (the proxy is the only route), but any future second route would need to report here too.
- The activity maps are in memory: a gateway restart forgets the CPU baseline (the first sample after it cannot compute a rate) and an llm-proxy restart forgets recent calls, so for up to a reap or a few minutes a busy sandbox can look idle. The other signal usually covers it; if neither does, the worst case is the old behaviour.
- The 2 hour default cap is a guess; measure real task lengths and adjust. Each kept sandbox keeps its memory and CPU allocation, which is the cost of the feature; `MAX_RUNNING_SANDBOXES` still bounds the total.
- Failures of either signal source are logged once and treated as "no signal".

Tests: `tests/gateway/busy.test.mjs` (policy with a mocked clock and fake signals, including a mutation check that they fail when the policy is broken), activity cases in `tests/llm-proxy/unit.test.mjs` and `tests/runner/runner.test.mjs`, and the live suite `tests/phase5/busy.test.mjs` (idle limit 20 s, cap 90 s: an idle sandbox is stopped, CPU-busy and model-busy sandboxes survive, both stop at the cap with the audit rows).

## P5-2 result: designed states

Every reason a workspace is unavailable, and every pause of model access, is now one designed state with a stable code, a plain title, what happened and what to do, a severity (`info`, `warning`, `error`) and an action (`retry`, `restart` or `none`). The wording lives in one place, `gateway/src/states.js`; the pages render what the gateway sends and carry no wording of their own (a test checks that the old "token allowance" copy is gone from the bundle).

| Code | When | Action |
| --- | --- | --- |
| `capacity` | the service is full and nobody is idle long enough to evict | Try again |
| `stopped_run_time` | the continuous run-time limit stopped the workspace | Start my workspace |
| `stopped_disk` | the storage limit stopped it (the message gives MB used and the limit) | Start my workspace |
| `start_timeout`, `harness_exited`, `sandbox_unreachable`, `service_unavailable`, `model_unavailable`, `start_failed` | a start failed; untyped errors are classified from the raw message, most specific first | Try again |
| `quota_day`, `quota_month` | the personal token allowance is spent (banner in the app) | none |
| `budget` | the shared daily budget is spent (banner in the app; wins over a personal quota, because the user cannot fix it) | none |
| `resumed_idle`, `resumed_busy_cap`, `resumed_evicted` | notices (not problems) shown while a stopped workspace starts again, saying why it had stopped | none |

**API.** `/gw/api/status` returns `problem` (when the state is `error`) and `notice` (when starting or stopped after an unrequested stop), next to the unchanged raw `error` string, which the page shows under "Technical details". `/gw/api/usage` returns `problem` and a reduced `global` (`exhausted`, `resetsAt`; the shared totals and limit are not exposed to users). The llm-proxy's admin usage now includes the shared budget state. Typed errors (`SandboxProblem`) carry their numbers (the limit, the MB used); anything else is classified by `classifyFailure`.

**Pages.** The launching page shows the problem's title and message with the action's button (no button for `none`), the notice as its subtitle while resuming, and the raw message under details. The app shell shows the usage problem as a banner. The model's own refusals inside the harness (HTTP 429 from the llm-proxy) already carry a clear message with the reset time and were left alone.

**Known gaps.**
- The notice after an idle stop is lost if the gateway restarts, since it is kept in memory; the user then just sees "resuming".
- A harness crash is the generic `harness_exited` state; a better one (restart at once, restore the open session) is P5-10.
- Copy is English only and has had no usability testing. The wording was written once and checked by test for leaks of internals, not by users.
- Warnings before a limit (80% and 95%), a Restart or Stop button in the app, and storage and time-left numbers are P5-3.

Tests: `tests/gateway/states.test.mjs` (every state's text, numbers, classification, notices, `usageProblem` priority, `status()` wiring), a gateway case for `/gw/api/usage`, a llm-proxy case for the budget state, and the live suite `tests/phase5/states.test.mjs`, which reaches each state on a real stack (capacity, run-time stop with the button restarting it, disk stop, personal quota then budget, idle notice) through the API and, when Playwright is found, in a browser (`tests/ui/browser.mjs`: a small helper that looks for Playwright and Chromium on the machine and skips browser checks if absent).

## P5-3 result: usage and limits panel, Stop and Restart

The top bar's usage text is now a button that opens a panel with what the user needs to know before a limit bites, and the two actions people reach for when something is stuck.

**Panel.** Model tokens today and this month (with reset times), storage used of the limit, time left in this run, any early warnings, and **Restart workspace** and **Stop workspace**, each asking twice (the first click arms the button for five seconds). A banner under the bar shows the spent-allowance problem if there is one, otherwise the most urgent early warning. The page polls `/gw/api/limits` every 30 s and after each action; Escape closes the panel; meters carry `role="meter"` and the chip has `aria-expanded`.

**Warnings** (`usageWarnings` in `gateway/src/states.js`, so the wording stays in one place): tokens at 80% ("You have used 80% of today's model allowance") and 95% ("almost used"); storage at 80%, 95% and over the limit (still a warning, because the workspace is only stopped at the next storage check); and the last 15 minutes of the run-time limit ("Your workspace will stop in 12 minutes", urgent in the last five). A meter that has reached its limit is not repeated as a warning for tokens; that is the problem state from P5-2. Order: errors before warnings, then closest to the limit first.

**API.**
- `GET /gw/api/limits` returns `{ workspace, tokens, storage, run, problem, warnings }`. Parts that cannot be known are null: no metering, runner unreachable, no limit configured, not running. Storage comes from the runner's `/v1/usage` through a one-minute cache, because Docker computes volume sizes on demand. The shared budget is reduced to `exhausted` and `resetsAt`. `/gw/api/usage` still exists, unchanged.
- `POST /gw/api/stop?hold=1` is what the Stop button calls: the workspace stays stopped (new state `stopped_user`, "Your workspace is stopped", with a Start button) until the user starts it or visits the app again. Plain `POST /gw/api/stop` is unchanged, so scripts and the earlier suites still see a stopped workspace wake on the next request.
- `POST /gw/api/restart` stops the container, audits `sandbox.restart` (the stop is recorded as `by: user_restart`), clears any hold and starts again. It answers once the old container is down and the new start is under way, so the reloading page finds a start in flight, not a half-stopped container.

**Why a hold.** Any request used to wake a stopped workspace, so a Stop button on a page that stays open would be undone by the page's own next request. The hold is released by an explicit Start, or by a top-level page load of the app (the user coming back); it is not released by the open frame's requests, and limit stops (time, storage) are never released this way. It is in memory, so a gateway restart ends it.

**Known gaps.**
- No warning is shown for idle or busy-cap stops, because they only happen with no browser open; the user is told on return (P5-2 notices).
- The run-time warning counts from the container's start, and a restart resets it.
- The usage panel has had no usability testing, and no narrow-screen or screen-reader pass beyond roles and keyboard.
- Restarting does not restore an in-progress agent turn (that is the crash-recovery task, P5-10).
- Storage numbers lag by up to a minute (cache) and the stop check by up to `DISK_CHECK_SECONDS`.

Tests: `tests/gateway/states.test.mjs` (every warning threshold, text and ordering), `tests/gateway/limits-panel.test.mjs` (the payload, the cache, hold, release, restart, and the HTTP surface), and the live suite `tests/phase5/panel.test.mjs` (real numbers, warnings as limits near, the panel in a browser, Restart with its container actually restarting and files kept, Stop staying stopped while the page keeps asking, and a page load releasing the hold).

## P5-7 result: invite links and clearer sign-up

- **Invite links.** `scripts/invite.sh create 3 --link` prints sign-up links (`https://<host>/gw/signup?invite=inv_...`, built from the gateway's `PUBLIC_URL`); the plain form still prints only the codes, because the Docker suites and scripts read them. Opening a link shows the sign-up form first, with the code filled in and "You have been invited" for a usable code. `/gw/login?invite=` leads with sign-up too.
- **Distinct invite messages.** The gateway tells the four states apart (`inviteStatus`: valid, used, expired, unknown): on the link page above the form, and on submit ("Enter your invite code", "not valid, check it for typos", "already been used", "has expired"), each with its own audit reason (`invite_missing`, `invite_invalid`, `invite_used`, `invite_expired`). Codes are 12 random bytes, so saying which state a code is in reveals nothing guessable; checking links is rate limited to 30 per address per hour, and past that no state is revealed.
- **Back to where you were.** A signed-out visit to a page is sent to `/gw/login?next=<that page>` (page navigations only, never the workspace frame's own requests or API calls) and sign-in or sign-up returns there. `safeNext` accepts only same-origin paths (one leading slash, no scheme, host, backslash or control characters, never the sign-in pages), so it cannot be used as an open redirect.
- **Form details.** Show and Hide for passwords (a real button with `aria-pressed`, label tied by id), "At least 10 characters" shown before submit, the email is kept after a failed attempt (never the password), the email field has focus on load, and the form that leads depends on how you arrived.
- **Not done:** emailing the link (P5-8, needs Mailgun), password reset, email verification, and closing the gap that the invite code field is still visible when the link already carries one (it is editable on purpose, so a mistyped code can be fixed).

Tests: `tests/gateway/signup.test.mjs` (11: `safeNext` matrix, invite states, link page, lookup limit, messages and what is kept, redirects, signed-in behaviour, the CLI), and `tests/ui/signup.test.mjs` (4, real browser against a gateway started in the test: the invite link flow landing on the requested page, a used link and a wrong code, Show and Hide plus keyboard order, sign-in returning to the remembered page). A mutation of `safeNext` (accepting `//host`) was caught by three tests.

## P5-6 result: our welcome and a curated UI

**Welcome.** A one-screen dialog shown once to each new user, in the gateway shell (not in the harness). It says what the workspace is, how work is saved and when it pauses, the limits that apply, privacy and safety, and getting work out. The numbers come from the live configuration (`policy` in `/gw/api/limits` plus the user's token limits), and only limits that are actually set are mentioned. The server remembers it (`users.welcomed_at`, added by an in-place migration; `GET /gw/api/me` returns `welcomed`, `POST /gw/api/welcome` records it, the first time wins), so it does not come back on another device. It can be reopened from the usage panel ("About this workspace"). Focus starts on the button, Escape closes it. Why the shell and not the harness: the harness's own first-run slot is the "Preview Notice" we already pre-acknowledge, and its copy is code, not config; the shell is ours, testable and the same for every harness version.

**Curated harness, by configuration where the harness allows it** (`sandbox/entrypoint.sh`, `runner/`):
- The model picker shows "Free models (automatic)" instead of the catalog's "Free Models Router": the model's `name` in the `llm-pi-ai` row, set from `DSH_MODEL_NAME` (runner setting `MODEL_DISPLAY_NAME`, with a friendly default for the free router; plain words only so it cannot break the YAML).
- The Automation tasks entry is switched off (`ui-schedule` disabled), because a stopped workspace cannot run a schedule (plan idea 20). The agent's own scheduling tool is untouched.
- Plugins, More and the terminal stay, as decided for developers.

**Curated harness, by small edits in the shell** (`gateway/web/src/curate.ts`), because the harness's labels are compiled-in text with no setting: the "DSH Local Build" label becomes `WORKSPACE_NAME` (default "Workspace"), the build id under it and the "Preview" badge are hidden, and the blank-session headline "Into the Unknown" becomes "What would you like to build?". The frame is same-origin, so the shell injects one style rule and a small observer into the harness document. It works from the harness's rendered class names (`hash_name`, matched on the readable part) and one text value; if the harness changes either, the edits stop applying and the harness's own wording shows (nothing breaks). `tests/phase5/welcome.test.mjs` notices.

**What was found and left alone.** The sidebar label and version come from code (`brand.localBuild`, `DSH_CLIENT_VERSION`, which the harness build always sets), so a build-time environment variable cannot remove them; `DSH_CLIENT_TITLE` only affects the page title. The "deepseek HARNESS" wordmark in the top bar and the login page is the harness's brand and was kept (see its `BRAND_GUIDELINES.md` before changing it). "Preview" was removed as a badge only; the harness is still labelled preview upstream.

**Known gaps.**
- The welcome says Git push and download "are still being built"; update it when P5-4 (tools) and files-out land.
- English only. The curation edits are English text matches.
- `curate.ts` depends on the harness's markup; there is no contract with the harness for it.
- A fresh user sees the welcome before the workspace has finished loading; that is intended (they read while it starts).

Tests: `tests/gateway/welcome.test.mjs` (5: the stored flag, migration of an old database, the endpoints, the policy payload, the shell's name), `tests/ui/welcome.test.mjs` (3, real browser: the welcome sentences, the curation on a mock harness page including re-renders and applying twice, and the welcome flow in the shell: once, "Got it", not again, reopened), entrypoint and runner cases for the model name and the disabled entry, and the live suite `tests/phase5/welcome.test.mjs` against the real harness (patch contents, the welcome once, and the curated page). Also fixed in passing: the browser helper's `signIn` broke when P5-7 added the Show button to the form.

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
16. **Admin panel** (L, now slice 5, P5-11 to P5-16): invites, users, usage, running sandboxes, audit search, feedback, and policies that can be changed without a restart. Deferred as a non-goal in phase 4; the design is in "Admin panel (design)".
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
35. **Two-way chat channels, SMS first** (L, idea only): message the agent from a phone and get answers and approvals back, waking a stopped sandbox. Notes and open questions in [ideas-chat-channels.md](ideas-chat-channels.md); the cheap first step is one-way notices (items 19 and 28).

## P5-11 result

**What exists:** `users.is_admin` (added to older databases in place, nobody becomes an admin by the migration); `scripts/make-admin.sh EMAIL` / `--revoke` / `--list` through `node src/cli.js admin ...` in the gateway container (refuses an unknown account, audited as `admin.grant` / `admin.revoke` only when something changed); the route table and guard in `gateway/src/admin.js`; the panel page (`gateway/web/src/pages/Admin.tsx`) with its navigation and the log of admin actions; an Admin link in the workspace bar for admins (`/gw/api/me` now carries `admin`).

**Decisions taken while building it:**
- **One guard, one table.** Every `/gw/admin` request goes through `createAdminHandler`, which checks the session and the role first and only then looks up the route. A new route is added to `adminRoutes()` and cannot bypass the guard; the unit test walks the table, so a route that answers a signed-out visitor or an ordinary user fails it.
- **Ordinary users get 404, not 403.** The panel does not confirm its own existence to them; the attempt is audited (`admin.denied`, with the path, never content). A signed-out visitor gets the sign-in redirect for the page (with `?next=`) and 401 for the API. An admin asking for a path that is not in the table gets 404 as well.
- **Never framed.** Admin responses carry `frame-ancestors 'none'` and `X-Frame-Options: DENY`, stricter than the rest of the gateway (which allows same-origin framing for the workspace).
- **Viewing is not audited, changing is.** Looking at the panel writes nothing; grants, revokes and (from the next tasks) every state-changing action do. State-changing admin routes do not exist yet. When they do, they are POST only, covered by the gateway's same-origin check, and need the CSRF token and typed confirmations the design calls for; that is part of P5-13 and not built here.
- **The shell learns the role from the server** (`/gw/api/me`), only to show the link; the routes check again on every request.

**Verified:** `tests/gateway/admin.test.mjs` (9 tests; with the role check removed two of them fail), `tests/ui/admin.test.mjs` in a real browser (3 tests, screenshot looked at), and live on the Lima VM through Caddy with a throwaway account: 404 before the grant, 200 and the right headers after, a signed-out visitor redirected, the unknown account refused, and the rows in the audit log; the grant was revoked afterwards.

**Not done or not verified:** no second factor (open decision); a revoked admin loses access on their very next request (the role is read from the database each time, not kept in the session), which is by construction and not covered by a test of its own; the panel has no pages beyond the log yet; the live Docker suites were not run (nothing here touches the runner, the sandboxes or compose, and the VM stack was only rebuilt, not wiped).

## P5-12 result

**What exists:** the overview at `/gw/admin`, read only: five tiles (users, running sandboxes against capacity, tokens today, storage, time to ready), a chart of model tokens per day for 14 days with a table view and hover details, the top users by tokens today and this month, users close to an allowance (80% or more), the biggest workspaces, a table of what happened in the last 24 hours and 7 days (starts, failed starts, refusals and stops by reason, crashes, sign-ins and sign-ups with failures), the median and slowest 5% of time to ready (and the split between waking a stopped workspace and a first start), the health of the runner, the model proxy and the gateway's data disk, and the latest admin actions. `GET /gw/admin/api/overview` serves it (`gateway/src/stats.js`); the llm-proxy gained `GET /admin/stats?days=N` on its admin socket (tokens, requests and distinct users per UTC day, zero days filled in, at most 90 days; `UsageStore.dailySeries`).

**Where each number comes from (so nothing new is tracked):** accounts and the audit table in the gateway database (new read queries in `db.js`: user counts, distinct active users, counts by event and reason, start times); the llm-proxy's usage table for tokens; the runner's list and `/v1/usage` (cached for a minute) for sandboxes and storage. Counts and totals only; emails appear in the top-user and storage tables, and nothing reads workspace, session or prompt content.

**Decisions:**
- **Each section is gathered on its own.** A source that is down (runner, proxy) shows "Unavailable right now (reason)" for its part and the rest of the page works; tested with a failing runner and a failing proxy.
- **"Active" means a sign-in, sign-up or workspace start**, counted once per user in the window. An `admin.denied` row or a page view is not activity.
- **The month's tokens are the sum of every user's month** from the proxy, not the sum of the 14 days shown (which would be wrong in the middle of a month).
- **No per-model breakdown.** The proxy stores tokens by user and day only, and only one model is allowed today; adding the model to the usage table is a change for when a second model exists.
- **The chart follows the dataviz rules for one series:** a single colour from the design tokens, no legend (the heading names it), thin bars with rounded tops from the baseline, a quiet baseline, a hover and keyboard-focus tooltip, a summary label for screen readers, and a table view with every number. It is as wide as its bars so a short series is not stretched.
- **Refresh:** the page reloads its numbers every minute and has a Refresh link; the server has no push.

**Verified:** unit tests for the proxy series (zero days, window, bounds, secret required), the store aggregates, every overview section from seeded data, the failure isolation, metering off, an empty stack (no NaN or undefined), and that no hash or feedback text leaks into the output; browser tests (seeded numbers, hover, table view, a failing runner) with the screenshot looked at twice; and live on the Lima VM with the real data (tokens, top users, storage, 52 starts with a median of 4.9 s, runner and proxy ok, 20.5 GB free), with a throwaway admin account that was revoked afterwards.

**Known gaps:**
- **"Refused: held" is inflated.** Every background request of a stopped (held) workspace is audited as a refusal, so one idle browser tab can add hundreds. The overview shows the raw count (70 in the live data). The proper fix is to throttle that audit row per user, the way the proxy already throttles `budget.exhausted`; not done here.
- The audit counts scan the table for the window on every load (cheap at this size; there is no cache and the 90-day retention bounds it). Worth a look if the table grows into the millions.
- Only the latest 10 admin actions show; the full audit search is P5-14.
- The data-disk figure is the gateway container's volume, not the host's other disks.
- The live Docker suites were not run (the runner, sandboxes and compose are unchanged; the llm-proxy only gained a read route).

## P5-13a result

**What exists:** `Users` in the admin navigation. A searchable list (25 to a page; search is a part of an email, case-insensitive, and `%` and `_` are plain text) with state, last active, tokens today and storage per account. One account's page: account, workspace state and whether it is held and why, usage, storage, the feedback it sent, its last 30 audit rows, and the actions. Routes: `GET /gw/admin/api/users[?q=&page=]`, `GET /gw/admin/api/users/:id`, and `POST /gw/admin/api/users/:id/{stop,restart,signout,suspend,unsuspend}` (`gateway/src/admin-users.js`, the route table in `admin.js` now takes `:id`).

**The actions, and what each does:**
- **Stop** stops the workspace and holds it with a new designed state (`stopped_admin`, "Your workspace was stopped by an administrator", with a Start button): the open page does not restart it, the person can.
- **Restart** goes through the same path as the user's own Restart; refused for a suspended account.
- **Sign out everywhere** deletes every session of the account.
- **Suspend** (type the email back): the account is marked suspended and signed out first, so from that moment it cannot sign in or use any session (`userBySession` ignores a suspended account), then the workspace is stopped and held and the model token is revoked at the proxy. If the revoke fails the account is still suspended and the answer says what is left (`partial`, audited). Sign-in says "This account has been suspended" only after the right password, so it does not reveal which addresses have accounts. **Unsuspend** lifts it and removes the old container (the volumes stay), because that container carries the revoked token; the next start creates one with a new token.
- **An admin cannot be suspended**, themselves included: take the role away with `scripts/make-admin.sh --revoke` first. That keeps a suspension from ever locking out the last admin.

**Safety, as designed:** every state-changing route is POST, passes the gateway's same-origin check, and needs the `x-csrf-token` the admin page was served with (an HMAC of the session under a per-process secret: another session's token or a stale one is refused, audited as `admin.denied` with `reason: csrf`, and nothing happens). Every action is audited as `admin.user_<action>` with the account as the row's user and the acting admin as `by`. Responses are never framed.

**Decisions and findings:**
- **Split from P5-13b (delete data).** Deleting needs a new runner route that removes volumes, which is the riskiest thing in the panel; it gets its own review and Docker case.
- **Storage "unavailable" is now honest.** The first version showed 0 bytes for everyone when the runner was down, because the cache swallowed the error; `storageByUser()` now fails until a load has succeeded, and the pages show a dash.
- Accounts and sandboxes are listed from the runner in one call; the page says plainly when the runner or the proxy could not be reached and leaves those columns blank.
- **What an admin sees of an account:** state, usage, audit rows (with the address of each request) and the feedback it sent to us. Not workspace, session or prompt content; there is no "sign in as".

**Verified:** `tests/gateway/admin-users.test.mjs` (12: list and search, unreachable runner, detail, CSRF cases, each action, wrong confirmation, admin target, partial suspension, unsuspend, bad body) and the route-table guard test now covering the account routes and POSTs; `tests/ui/admin.test.mjs` in a browser (search, open an account, a stray click arms but does nothing, Stop, Suspend with a partial then the full email, lift it, no Suspend on an admin, an unknown account; screenshot looked at); live suite `tests/phase5/admin-users.test.mjs` against real containers and the real model proxy token (see the run notes below).

**Not done or not verified:** deleting data (P5-13b); no second factor; no bulk actions; no paging beyond next and previous; "last active" counts sign-ins and workspace starts only, not time spent in a workspace. A suspension does not kill a model request already in flight (the proxy refuses the next one).

## Admin panel (design)

**Why it was missing:** it was listed as idea 16 and deferred to a vague "slice 4" line, so no task carried it and the policies added in P5-1 to P5-10 shipped with environment variables as their only control. This section and slice 5 put it on the plan.

**Who is an admin.** A column on users, set only by `scripts/make-admin.sh <email>` run on the host (audited, refuses an unknown user). No page or request can grant it, so an attacker who takes over a normal account cannot become an admin. Start with the owner only; more than one admin is allowed. Whether admin sign-in needs more than a password (a second factor) is an open decision.

**Where it lives.** In the gateway web app under `/gw/admin`, on the same origin and session as everything else, behind a guard that checks the admin flag on every request (not only when the page loads). It is not proxied to a sandbox and sandboxes cannot reach it (they have no route to the gateway except through their own proxy path). Option left for later: serve it on a second port bound to a private network or VPN only.

**What an admin can see, and never see.** Accounts, state, usage, storage, audit rows, feedback and system health. Never the content of a workspace, a session, a prompt or a model reply (the same rule as the audit log), and there is no "log in as this user". An admin who needs to see what a user sees asks the user.

**Stats and where each number comes from** (so the panel adds no new tracking):
- Users, sign-ups, last seen, activity: `users`, `sessions` and the audit table.
- Running sandboxes and capacity: the runner's list against `MAX_RUNNING_SANDBOXES`.
- Tokens by day, month, user and model: the llm-proxy's usage tables, through new read-only routes on its admin socket.
- Storage by user: the runner's `/v1/usage` (already cached for the limits panel).
- Refusals, stops, crashes and time-to-ready: audit events (`sandbox.refused`, `sandbox.stop` with `by`, `sandbox.crashed`, `sandbox.start` with `ms`).
- Health: the same checks the stack's health endpoints and `restart.sh` use, plus host disk.

**Policies that can be edited** (each an existing setting; the environment value stays the default): idle limit, busy cap, busy signals, run-time limit, disk limit and check interval, running-sandbox capacity and eviction age, watchdog and crash-loop limits, whether sign-up is open or invite only, session lifetime, the daily and monthly quota defaults, the global daily budget, per-minute request and concurrency limits, the output limit and the allowed models. **Not editable from the panel on purpose:** secrets, the upstream key, image names and digests, the sandbox runtime, network ranges, egress rules and the security properties tested in `tests/phase4/`. Sandbox resource limits (memory, CPU, processes) are runner settings applied when a sandbox is created, so they are shown with their value and "applies to sandboxes created from now on", and changing them is a later step, not part of P5-15.

**How changes take effect.** Gateway policies are read from the store on each use (a short cache), so they apply at once. Llm-proxy policies are pushed over its admin socket and applied live. A setting that cannot apply live says so next to the field. Every change is an audit row with the admin, the setting and the old and new values, and the panel shows the last few changes.

**Safety:** every state-changing route is POST with the same-origin check and a CSRF token; destructive actions (delete data, suspend) need a typed confirmation; the admin routes are rate limited; bounds on every value stop a typo from turning a limit off by accident (a 0 meaning "unlimited" needs an explicit confirmation).

**Out of scope for now:** billing, roles other than admin, an API for other programs, alerting and paging (a webhook or email alert on thresholds can follow P5-8), and editing the harness configuration.

## Open decisions

- **Admin panel:** who the admins are (owner only, or a few people); whether admin sign-in needs a second factor before the panel is exposed to the internet; whether to also serve it on a private-only port; whether per-user overrides (P5-16) are wanted in the first release.

- **Branding, domain and legal pages** (needed before a public launch).
- **Busy-time cap value** (the default of two hours is a guess; measure real task lengths first).
- **How far to curate the harness UI** for developers (P5-6 starts conservative: hide only what is confusing, not features).
- **Sending domain for Mailgun:** a domain you control and can add DNS records to (SPF, DKIM). It blocks real delivery for P5-8 (not the other tasks), and it overlaps with the branding and domain decision above. Mailgun account region (US or EU) and the `MAIL_FROM` address also need choosing.

## P5-10 result

**Before:** a harness that exited (seen under load in the phase 4 abuse tests) was only noticed when the next request found its container gone, and then the user saw "starting", with nothing said about why.

**Now** (`gateway/src/sandbox.js`, `states.js`; the runner's `GET /v1/sandboxes/:id` also returns `exitCode` and `oomKilled`):
- A **watchdog** (`WATCHDOG_SECONDS`, default 5, 0 = off) compares the runner's list with what the gateway believes is running. A sandbox that exited on its own is recorded (`sandbox.crashed` with exit code, `oom`, and the number of recent exits) and, if the user is still around (a browser socket is open, or they were seen within `IDLE_SECONDS`), started again at once (`sandbox.auto_restart`). A user who left is not restarted for; their next visit says it stopped while they were away (`noticeFor('crashed')`). A deliberate stop (idle, limits, user) clears the cache first, so it is never mistaken for a crash.
- The two other ways a crash shows up go through the same record: a request that finds the container gone (`ready()`), and a proxied request or socket that fails (`invalidate()`). **The second one matters:** with a browser open, the page's reconnect reached the dead container before the watchdog looked and dropped the cache entry, so my first version restarted the sandbox but recorded no crash. Found in the live check, now covered by a test.
- **Crash loop:** more than `CRASH_MAX_RESTARTS` (3) exits within `CRASH_WINDOW_SECONDS` (600) is held as the designed state `crash_loop` ("Your workspace keeps stopping", with a hint when the cause was memory) and the sandbox stays stopped until the user restarts it, which starts the count again.
- **Telling the user:** for 15 minutes after an automatic restart `/gw/api/limits` puts an info notice first in `warnings`, and the shell shows it in its banner: what happened, files and sessions kept, and that an agent turn that was running ended so the message should be sent again.

**Verified** (Lima VM, gVisor): killing the container of a user with a page open brought the harness back within about five seconds, the page reconnected by itself to the harness (screenshot checked), the audit rows and the banner appeared; four kills in a row gave three restarts then `crash_loop` with the container left stopped, and the Restart action brought it back. Unit tests cover the decisions with a fake runner (the restart call removed makes six of eleven fail); the live suite is `tests/phase5/watchdog.test.mjs`.

**Not done or not verified:**
- **Restoring an in-progress turn is not possible**: the harness restarts empty-handed, so the turn that was running ends. Sessions and files are kept (they live on the volumes); the notice tells the user to send the message again. Resuming the turn itself would need harness support.
- An out-of-memory kill under gVisor was not reproduced (the kill used was `docker kill`, exit 137, `oomKilled` false); the `oom` path is covered only by unit tests and by reading Docker's `State.OOMKilled`.
- A crash that happens while the gateway itself is down is not seen as a crash (its cache is empty after a restart); that sandbox is simply started on the next visit.
- The watchdog polls the runner every few seconds for all sandboxes; fine at tens of sandboxes, worth a look beyond that.

## Output limit per reply

**Symptom (found by a user, 2026-11-26):** a research task failed with `MALFORMED_RESPONSE`: `Tool call "write": Expected ',' or '}' after property value in JSON at position 100`, the arguments ending right after `file_path`. The model was cut off partway through a long file write.

**Cause (measured, then read):** the llm-proxy log showed the last two calls ending at exactly `"output":4096`, status 200, while the proxy's own cap is 16384 (it only lowers what the client sends). The sandbox declared the model with `id` and `name` only; the harness catalog also takes `maxTokens`, and for a model it has no catalog entry for (`openrouter/free`) the request limit was 4096. That the harness default is 4096 is inferred from the log, not read in the harness source.

**Fix:** the model entry in the harness patch now declares `maxTokens` from the runner's `MODEL_MAX_OUTPUT_TOKENS` (default 16384, only digits accepted). Verified: a freshly created sandbox on the Lima VM (gVisor) has `DSH_MODEL_MAX_TOKENS=16384` and `dsh --dump-config` shows `maxTokens: 16384`. Unit tests cover the runner setting, the environment and the patch rows.

**Not verified / limits:** I did not reproduce a long write end to end against the free router (its real limit per reply, and whether it honours 16384, are provider-side). A reply is now limited to the lower of this value and the proxy's `MAX_OUTPUT_TOKENS`, so a very long file can still be cut off and the agent must write it in parts. Existing sandboxes pick the setting up when they are next created (a stopped one on its next start after the runner restarts; a running one after it stops).

## How each item would be verified

- Browser checks with the Playwright and Chromium setup used for the preview-notice and default-workspace fixes (scripts that sign in as a fresh user and inspect the page; not yet in the repo); promote them to a `tests/ui/` suite so the first-login experience cannot regress silently.
- Unit tests for gateway states and messages (`tests/gateway/*`), entrypoint tests for harness patches (`tests/sandbox/entrypoint.test.mjs`).
- Phase 4 suites stay green; new behaviour (waiting room, restart, export) gets a Docker suite case.
- Measure time-to-ready and the share of sessions ending in a refusal before and after, using the audit table.

## Process

Work on topic branches and open PRs (`main` requires them), one task per branch, following [../AGENTS.md](../AGENTS.md). Keep the phase 4 suites green throughout; every task adds its own tests, and any user-visible change is checked in a real browser. Record findings in this document or a research note as tasks complete, and tick tasks off in the task tables.
