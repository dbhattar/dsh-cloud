# syntax=docker/dockerfile:1
#
# Builds the LOCAL deepseek-harness into a self-contained workspace tree (production dependencies only).
# Not run directly: scripts/build-harness.sh stages the source, builds the `dist` target and exports it to
# sandbox/.harness-dist/, which sandbox/Dockerfile then copies. Context is sandbox/.harness-src.
FROM node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS build
# Desktop/Electron are workspace members but irrelevant here; skip their binary downloads.
ENV CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 ELECTRON_SKIP_DOWNLOAD=1 npm_config_audit=false
RUN corepack enable
WORKDIR /src
COPY . ./
# corepack picks the pnpm version pinned by "packageManager" in package.json.
RUN --mount=type=cache,id=dsh-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# The staged source has no .git; the build embeds this commit hash in the client metadata instead.
ARG DSH_CLIENT_COMMIT_HASH
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH
RUN pnpm run build:artifacts
# Ship the workspace tree itself, not `pnpm deploy` output: the harness links its vendored libraries
# (vendor/*) with link: paths that `deploy` leaves dangling. Dropping every node_modules and reinstalling
# dependencies for just the dsh closure keeps all relative links valid and drops the root's dev tooling and
# unrelated workspace packages. Not --prod: packages such as app-boot declare @deepseek-ai/cordis as a peer
# that only their devDependencies entry links, so pruning dev dependencies breaks module resolution.
# The root postinstall only installs git hooks (needs the dev-only lefthook), so it is dropped in this copy.
RUN --mount=type=cache,id=dsh-pnpm-store,target=/root/.local/share/pnpm/store \
    find . -name node_modules -type d -prune -exec rm -rf {} + \
 && node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))" \
 && pnpm install --frozen-lockfile --filter "@deepseek-ai/dsh..."

FROM scratch AS dist
COPY --from=build /src /
