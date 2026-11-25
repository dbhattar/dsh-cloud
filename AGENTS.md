# Instructions for agents working in dsh-cloud

These apply to every change, however small. They exist because each one was learned the hard way during phases 1 to 4. When this file and a habit disagree, follow this file; when something here is wrong or out of date, fix it in the same pull request.

## The four rules

### 1. Always work on a new topic branch. Never work on `main`.

- Before touching a file, run `git switch main && git pull --ff-only origin main`, then `git switch -c <type>/<short-name>`. Types in use: `feature/`, `fix/`, `docs/`, `chore/`, `phaseN/`.
- This includes docs, one-line fixes and changes to this file.
- `main` requires a pull request. Never push to `main`, and never force-push anything without the owner saying so explicitly in that conversation.
- One topic per branch and per pull request. Push the branch (`git push -u origin <branch>`) and give the owner the compare link; they merge on GitHub. Merges are squashed, so after one, switch to `main`, pull, and delete the local branch with `git branch -D` (a plain `-d` refuses after a squash).
- Commit only when asked. Do not commit `.env`, backups, built harness output (`sandbox/.harness-dist`, `sandbox/.harness-src`) or anything holding a secret; check `git status` before every commit.

### 2. Write tests, and run the existing ones.

- Every behaviour change gets a test in the same pull request. A bug fix gets a test that fails without the fix.
- Run the relevant suites before saying a change is done, and report what you ran and what you did not run. Never claim a pass you did not see.

  | Command | What it covers | Needs |
  | --- | --- | --- |
  | `tests/run.sh unit` | gateway, runner, llm-proxy, egress-proxy, sandbox entrypoint and pins | Node 24, `gateway/web` built (`cd gateway/web && npm ci && npm run build`) |
  | `tests/run.sh phase2`, `phase3`, `phase4` | the live stack: signup, metering, isolation, abuse, limits, backups | Docker on Linux; gVisor for the shell test. See below |

- Run the unit suites on every change. Run the phase suites when you touch the gateway, runner, llm-proxy, egress proxy, sandbox image or compose files. The suites are described in `tests/README.md`; add new ones there.
- **The Docker suites delete data.** They use the real compose project and volume names and refuse to start over existing data. Do not set `DSH_TESTS_ALLOW_DESTRUCTIVE=1` unless the stack you are pointing at holds nothing the owner wants (check with `docker ps -a` and `docker volume ls` first, and say what you are about to wipe). Target the Lima VM with `DOCKER_CONTEXT=lima-dsh-linux SANDBOX_RUNTIME=runsc`; never run them against the owner's Docker Desktop stack.
- Anything a user sees needs a look in a real browser, not only a unit test. The first-login problems found in phase 4 (a popup, a failed default workspace) passed every test. Sign in as a fresh user with Playwright and inspect the page; keep the script if it is reusable.
- Tests must be able to fail: check that a new test fails against the old behaviour, or against a deliberately broken input.

### 3. Save important findings in documents.

- Anything a future reader would otherwise have to rediscover goes in `docs/` in the same pull request: what you measured, what surprised you, why you chose one option over the others, what you tried that did not work, and what is still unverified.
- Where it goes: a design decision or feature in its phase plan (`docs/plan-phase-N.md`) or a short `docs/<topic>.md`; research or a spike in `docs/research-<topic>.md`; operations in the topic's own doc (`docs/backup.md`, `docs/build-pinning.md`, `docs/lima-setup.md`). Update the component README (`gateway/`, `runner/`, `llm-proxy/`, ...) when its behaviour or settings change, and `tests/README.md` when you add a suite.
- Write what is true and say what was checked. Separate "verified" from "read in source" from "assumed", record the environment (runtime, architecture, versions), and list known gaps. Do not leave a stale statement behind: search the docs for the old claim and fix it.
- Link related documents to each other and check that every relative link resolves.

### 4. Turn routine tasks into scripts.

- If you ran a multi-step command sequence twice, or expect anyone to run it again, put it in `scripts/` instead of leaving it in a chat or a doc. Examples already here: `scripts/restart.sh`, `backup.sh`, `restore.sh`, `invite.sh`, `audit.sh`, `usage.sh`, `pin-images.sh`, `harness-lock.sh`, `lima/setup.sh`.
- A script is POSIX `sh` with `set -eu`, starts with a comment that says what it does, how to call it and what it needs, takes `--help`, is idempotent where possible, and refuses clearly when a precondition fails. Make destructive options explicit (`--yes`, `--wipe`) and say what they delete.
- Work through the `docker` CLI so a script follows the current Docker context (Docker Desktop, the Lima VM, a server). Do not hardcode the host.
- Test a script like code: a unit or Docker test for what it does, plus a run that shows it failing correctly (`tests/phase4/backup.test.mjs` is the pattern). Add `sh -n` coverage by listing it under `scripts/` (CI parses every `scripts/*.sh`) and mention it in the doc for its topic.
- Browser check scripts (sign in as a fresh user, look for a popup) belong here too once they are used a second time.

## Working in this repository

- **Layout:** `gateway/` (login, routing, limits, audit), `runner/` (the only holder of the Docker socket), `llm-proxy/`, `egress-proxy/`, `sandbox/` (image, entrypoint with the harness policy patch), `infra/` (compose, Caddy), `scripts/`, `tests/`, `docs/`. Start with `README.md`, `docs/plan.md` and the current phase plan.
- **The harness** is built from a local checkout (`../deepseek-harness`) and pinned by `sandbox/harness.lock`. Changes to how the harness behaves for users are made by config patches in `sandbox/entrypoint.sh`, verified with `dsh --profile web --dump-config`, not by editing the harness. Row ids in those patches are not a public contract; re-check them after a harness upgrade.
- **Security properties are tests.** Isolation, the egress filter, the admin socket, limits, the shell confinement and the audit log each have a test in `tests/phase4/`. Do not weaken one to make a change pass; if a property must change, change the doc and the test deliberately and say so.
- **Never put a secret, token, password, invite code or model content** in code, tests, logs, the audit trail, commit messages or docs. `.env` stays untracked.
- **Base images are pinned by digest** (`scripts/pin-images.sh --check`). Change a pin deliberately, with `--update`.
- **Ask before** anything destructive or outward-facing: force-pushing, deleting remote branches, wiping volumes or the VM stack, changing the Docker daemon, pushing images, or touching the owner's Docker Desktop data. Approval for one such action does not carry over to the next.
- **Report faithfully.** Say what you ran, what passed, what failed and what you skipped. If a run was flaky or you do not understand a result, say so instead of rounding it to "works".

## Definition of done for a change

1. On a topic branch cut from an up-to-date `main`.
2. New tests written; `tests/run.sh unit` passes; the phase suites that the change can affect were run (or the reason they were not is stated).
3. User-visible changes checked in a browser.
4. Findings and changed behaviour documented, stale statements removed, links valid.
5. Any repeatable procedure is a script, tested and documented.
6. Branch pushed, compare link given, nothing committed to `main`.
