# Pinned builds and CI

Phase 4, task E3. What is pinned, how to move a pin, and what CI runs.

## What is pinned

| Input | Pinned how | Where |
| --- | --- | --- |
| Node base image of gateway, runner, llm-proxy, egress-proxy and the sandbox | exact version and digest: `node:24.22.3-slim@sha256:…` | each `Dockerfile` |
| Harness build image | `node:24.22.3-bookworm@sha256:…` | `sandbox/harness.Dockerfile` |
| Caddy | `caddy:2.11.9@sha256:…` | both compose files |
| Backup helper image | the same Node digest | `scripts/backup.sh`, `scripts/restore.sh` |
| The harness inside the sandbox | commit, version and a content hash of the staged source | `sandbox/harness.lock` |
| pnpm (harness build) | the version in the harness's `packageManager`, installed by corepack, with `--frozen-lockfile` | the harness repo |
| gateway page dependencies | `gateway/web/package-lock.json`, installed with `npm ci` | CI and the gateway image |
| GitHub Actions in CI | full commit id, version in a comment | `.github/workflows/ci.yml` |

`scripts/pin-images.sh --check` fails on any image that is not `name:tag@sha256:…` (CI runs it, and so does `tests/sandbox/pins.test.mjs`).

### Moving a pin

- Base images: change the tag in the Dockerfile, run `scripts/pin-images.sh --update` (resolves the digest, needs Docker and network), review the diff, rebuild, run the suites. Dependabot proposes the same change weekly.
- Harness: check out the commit you want in `../deepseek-harness`, run `scripts/harness-lock.sh --update`, commit `sandbox/harness.lock`.

## The harness lock

The harness is built from a local checkout, so a commit id is not enough: the working tree can carry edits (the current one does, `dirty=yes`). The lock therefore records the commit, the version and a SHA-256 over every file that would be staged. `scripts/build-harness.sh --locked` refuses to build unless all three match, so a release build is either exactly what was locked or it fails loudly. Day-to-day builds do not use `--locked`; `scripts/restart.sh` already warns when the checkout changed since the last build. The built image carries `BUILD_INFO` (commit, hash, build time) under `/opt/dsh`.

A locked, dirty checkout reproduces the build only while the same uncommitted files exist. To make a release reproducible from a commit, commit the harness changes first and update the lock.

## Dependabot policy

`.github/dependabot.yml` proposes updates weekly, with these rules (learned from the first batch of pull requests):

- **Docker:** all Dockerfiles go in one grouped pull request, so the Node base never differs between services. Node **major** versions are ignored: moving to a new Node major is a deliberate change (every Dockerfile, `harness.Dockerfile`, the CI `node-version`, then the suites under gVisor). When a 24.x pull request arrives, also update `node-version` in `.github/workflows/ci.yml`; `tests/sandbox/pins.test.mjs` fails until the two match.
- **npm (gateway pages):** `react`, `react-dom` and their `@types` are one group, and `vite` with `@vitejs/plugin-react` is another. Each pair has a peer dependency on the other: Vite 8 alone, plugin-react 6 alone, React 19 alone and react-dom 19 alone each fail `npm ci` (checked), while each pair together installs and builds, as does React 19 with Vite 8. The build passing does not prove the pages render under React 19; look at them in a browser before merging that group.
- Open pull requests are capped per ecosystem to limit noise. `main` requires pull requests, so these arrive as ordinary reviews: merge when CI is green.

## What is not pinned

- **Debian packages** installed in the sandbox image (`bubblewrap`) resolve at build time from the pinned base image's Debian release. A security update can change the patch version between two builds. Pinning an exact version would instead break the build when Debian removes it; revisit if you need bit-for-bit images (build once, push the image, deploy the digest).
- **npm dependencies of the services**: gateway, runner, llm-proxy and egress-proxy have no runtime dependencies on purpose, so there is nothing to pin.
- **Image digests are per tag, not per architecture**: the pinned digest is the multi-architecture index, so arm64 and x64 hosts pull different but fixed images.

## CI

`.github/workflows/ci.yml`, no secrets needed:

| Job | Runs | Time budget |
| --- | --- | --- |
| `unit` | builds the gateway pages (`npm ci && npm run build`), then `tests/run.sh unit` on Node 24.22.3 | 15 min |
| `checks` | pin check, harness lock well-formed, `sh -n` on every script, `docker compose config` | 10 min |
| `images` | builds gateway, runner, llm-proxy and egress-proxy | 20 min |
| `acceptance` | manual (`workflow_dispatch`) on a self-hosted runner labelled `gvisor`: builds the harness `--locked`, runs the phase 2, 3 and 4 suites under `runsc` | 60 min |

The acceptance job exists because those suites need Linux, Docker with gVisor and the harness build; GitHub's hosted runners do not provide gVisor. It is untested until such a runner exists: the same commands ran green by hand on the Lima VM (see [plan-phase-4.md](plan-phase-4.md), G1).

## Verified

Run locally with the commands CI uses: the unit suites (114 tests), `pin-images.sh --check`, `sh -n` over all scripts, `docker compose config`, a clean `npm ci && npm run build` of the gateway pages from a copy of the repo, and a Docker build of each of the four service images from the pinned bases. The workflow file itself has not run on GitHub; its YAML parses and its structure is asserted by `tests/sandbox/pins.test.mjs`.
