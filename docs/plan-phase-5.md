# Phase 5: a friendlier dsh-cloud

Status: **draft, scope not yet chosen.** This is the idea list and a suggested first slice; the decisions under "Decisions needed" have to be made before it becomes a task breakdown. Builds on [plan-phase-4.md](plan-phase-4.md), which made the service safe for untrusted users. Parent plan: [plan.md](plan.md).

## Context

Phase 4 made the service safe for untrusted users. The price was paid in user experience: limits, refusals and restarts exist, but most of them surface as a terse error on the launching page, a token counter in the bar, or nothing at all. Two first-login problems (a "Preview Notice" popup and "Unable to create default workspace") were found only by looking at the product in a browser; there are likely more of that kind. This phase is about what a new, non-expert user sees and feels from the invite to their tenth session.

What users see today (from `gateway/web/src/pages/*` and `gateway/src/*`):
- **Sign-in page:** one card with sign-in and sign-up forms; the invite is a plain text field; errors are generic ("A valid invite code is required"); no password reset, no email verification, no account deletion.
- **Launching page:** four stages and an elapsed timer. Failures map to a few sentences. When the service is full the user gets "at capacity, try again" and nothing else. Limit stops (run time, disk) appear only here, as an error.
- **App shell:** brand, "Today N / 500K tokens", email, sign out, and a banner only for the *personal* quota. No storage use, no time left, no stop button, no warning before a cutoff, and the *global* budget 429 shows up as a raw model error inside the harness.
- **Inside the harness:** the harness's own UI, unchanged apart from the policy patch: a "Preview" badge, "DSH Local Build 0.2.2-rc.5-2e39e70" in the sidebar, menus for plugins, automation and settings, and no explanation of what this product is, what the limits are, or how to get files in and out.

## Ideas, grouped (effort: S under a day, M a few days, L a week or more)

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

## Suggested first slice (highest value for least effort)

Two kinds of work belong together: the cheap UI fixes that remove obvious friction, and the capability gaps that stop users finishing a task.

1. **Stop killing busy sandboxes** (18) and **designed states for every refusal and stop**, shown in the shell with usage and storage warnings (7, 8, 9). These fix the two worst surprises: losing work, and not knowing why.
2. **A baseline toolbox** (22) and **package cache** (23), after checking what the harness build already bundles. Without git and Python the agent fails on ordinary tasks.
3. **Welcome screen, curated harness UI, friendly model names** (11, 12), as entrypoint patches with browser verification like the last two fixes.
4. **Invite links, clearer sign-up errors, redirect after login** (1, 2).
5. **Waiting room for capacity** (5) and **crash recovery** (21).
6. Then the larger items, chosen by audience: files in and out (10), repositories (24), app preview (25), automation that fires (20), notifications (19). Password reset, the account page and social sign-in (3, 4, 29) once an email or identity provider is chosen.

## Decisions needed before committing to a scope

- **Who the users are** (developers, students, internal staff, general public): decides how much to hide, how much to explain, and whether the terminal and plugins stay.
- **Email:** is an SMTP provider available? It gates password reset, verification and emailed invites.
- **What the main task is:** build apps, analyse data, write documents, work on existing repositories? That decides the toolbox (22), repositories (24), app preview (25) and file handling (10).
- **Long-running work:** should an agent keep working with the tab closed (18, 19, 20)? It costs more compute per user; set a cap.
- **Identity:** email and password only, or also GitHub or Google sign-in (29)? GitHub sign-in also makes private repositories (24) much easier.
- **Files in and out:** worth a larger investment now, or after the first slice?
- **Plugins and the terminal:** should users be able to install plugins or open a terminal, or should the UI be a smaller, guided product?
- **Branding:** product name, domain and legal pages.

## How each item would be verified

- Browser checks with the Playwright and Chromium setup used for the preview-notice and default-workspace fixes (scripts that sign in as a fresh user and inspect the page; not yet in the repo); promote them to a `tests/ui/` suite so the first-login experience cannot regress silently.
- Unit tests for gateway states and messages (`tests/gateway/*`), entrypoint tests for harness patches (`tests/sandbox/entrypoint.test.mjs`).
- Phase 4 suites stay green; new behaviour (waiting room, restart, export) gets a Docker suite case.
- Measure time-to-ready and the share of sessions ending in a refusal before and after, using the audit table.

## Process

Work on topic branches and open PRs (`main` requires them). Once the decisions above are made, record them at the top of this document, turn the first slice into a task breakdown (as phase 4 did), and keep the phase 4 suites green throughout.
