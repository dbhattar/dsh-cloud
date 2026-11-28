# Pinned builds and CI

Phase 4, task E3. What is pinned, how to move a pin, and what CI runs.

## What is pinned

| Input | Pinned how | Where |
| --- | --- | --- |
| Node base image of gateway, runner, llm-proxy, egress-proxy and the sandbox | exact version and digest: `node:24.22.3-slim@sha256:…` | each `Dockerfile` |
| Harness build image | `node:24.22.3-bookworm@sha256:…` | `sandbox/harness.Dockerfile` |
| Caddy | `caddy:2.11.9@sha256:…` | both compose files |
| Backup helper image | the same Node digest | `scripts/backup.sh`, `scripts/restore.sh` |
| Release binaries in the sandbox image (httpx, nuclei, gitleaks, osv-scanner) | version and SHA-256 per architecture (amd64 and arm64), each hash cross-checked against the project's own published checksums when it is written | `sandbox/tools.lock`, managed by `scripts/pin-tools.sh`, installed and verified at build by `sandbox/install-tools.sh` |
| Python tools in the sandbox image (bandit, pip-audit) | exact versions (not hashes) in their own environment | `sandbox/pytools.txt` |
| The harness inside the sandbox | one commit (clean, pushed), version and a content hash of what that commit stages | `sandbox/harness.lock` |
| pnpm (harness build) | the version in the harness's `packageManager`, installed by corepack, with `--frozen-lockfile` | the harness repo |
| gateway page dependencies | `gateway/web/package-lock.json`, installed with `npm ci` | CI and the gateway image |
| GitHub Actions in CI | full commit id, version in a comment | `.github/workflows/ci.yml` |

`scripts/pin-images.sh --check` fails on any image that is not `name:tag@sha256:…` (CI runs it, and so does `tests/sandbox/pins.test.mjs`).

### Moving a pin

- Base images: change the tag in the Dockerfile, run `scripts/pin-images.sh --update` (resolves the digest, needs Docker and network), review the diff, rebuild, run the suites. Dependabot proposes the same change weekly.
- Release binaries: change the version in the tool's `url` and `checksums-url` in `sandbox/tools.lock`, run `scripts/pin-tools.sh --update` (downloads each artifact and refuses it unless its hash matches the project's published checksums file), review the diff, rebuild the image and run `tests/phase6/toolbox.test.mjs`. `scripts/pin-tools.sh --check` is offline and runs in CI; `--verify` re-downloads everything and compares (run it before a release). The installer fails the image build on any hash difference.
- Not pinned by hash, and why: the Debian packages in the sandbox image (git, curl, sqlmap, ffuf and the rest) follow the pinned base image's Debian release, like `bubblewrap`; the Python tools are pinned by version only (`pip --require-hashes` would need a generated, per-architecture requirements file).
- Harness: commit and push the change in the harness repository, check out that commit in `../deepseek-harness`, run `scripts/harness-lock.sh --update` (it refuses uncommitted changes and unpushed commits), commit `sandbox/harness.lock`. See [deploy-images.md](deploy-images.md).

## The harness lock

The lock pins **one commit** of the harness repository: `repo=`, `commit=`, `dirty=no`, `version=` and `source_hash=`, a SHA-256 over every file that commit stages. `scripts/build-harness.sh --locked` runs `harness-lock.sh --check` (which stages the locked commit with `git archive` and recomputes the hash, ignoring the working tree) and builds from exactly that commit, so a release build is what was locked or it fails loudly. A lock with `dirty=yes`, which earlier versions allowed (the committed lock said `dirty=yes` until 2026-11-28), is refused: it pinned a hash of uncommitted local edits that nothing else could rebuild. Day-to-day builds do not use `--locked` and still stage the working tree; `scripts/restart.sh` warns when the checkout changed since the last build. The built image carries `BUILD_INFO` (commit, hash, `dirty=`, build time) under `/opt/dsh`. How CI builds and publishes it: [deploy-images.md](deploy-images.md).

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
| `checks` | pin check, harness lock well-formed and clean (`dirty=no`, `repo=`), `sh -n` on every script, `docker compose config` | 10 min |
| `images.yml` (own workflow, manual or `v*` tag) | harness from the locked commit, `build-harness.sh --locked`, `publish-images.sh`: five images pushed, digests out | 60 min, never run yet |
| `images` | builds gateway, runner, llm-proxy and egress-proxy | 20 min |
| `acceptance` | manual (`workflow_dispatch`) on a self-hosted runner labelled `gvisor`: builds the harness `--locked`, runs the phase 2, 3 and 4 suites under `runsc` | 60 min |

The acceptance job exists because those suites need Linux, Docker with gVisor and the harness build; GitHub's hosted runners do not provide gVisor. It is untested until such a runner exists: the same commands ran green by hand on the Lima VM (see [plan-phase-4.md](plan-phase-4.md), G1).

## Verified

Run locally with the commands CI uses: the unit suites (114 tests), `pin-images.sh --check`, `sh -n` over all scripts, `docker compose config`, a clean `npm ci && npm run build` of the gateway pages from a copy of the repo, and a Docker build of each of the four service images from the pinned bases. The workflow file itself has not run on GitHub; its YAML parses and its structure is asserted by `tests/sandbox/pins.test.mjs`.
