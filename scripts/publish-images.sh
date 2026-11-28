#!/bin/sh
# Build the five images from this checkout and push them to a registry, then print their digests. The harness inside the
# sandbox image must come from the commit in sandbox/harness.lock (scripts/build-harness.sh --locked): this script refuses
# anything else, and the sandbox Dockerfile refuses it again (REQUIRE_CLEAN_HARNESS). Used by .github/workflows/images.yml.
#
#   scripts/publish-images.sh --registry ghcr.io/OWNER/dsh-cloud --tag TAG [--out images.env] [--dry-run] [--no-push]
#
#   --registry   image name prefix; the images are PREFIX-gateway, PREFIX-sandbox-runner, PREFIX-llm-proxy,
#                PREFIX-egress-proxy and PREFIX-sandbox
#   --tag        a tag for humans (the pipeline uses sha-<commit>); servers deploy by the digest, not the tag
#   --out        write GATEWAY_IMAGE=...@sha256:... lines for .env or --env-file (default images.env)
#   --dry-run    print what would be built and pushed; build and push nothing
#   --no-push    build only, so a dry local check needs no registry (no digests, so no --out file)
#
# Needs: Docker logged in to the registry (docker login), sandbox/.harness-dist built with --locked, a checkout with no
# uncommitted changes to tracked files. Not run on your Mac for real releases: the pipeline does it, from a clean checkout.
set -eu
cd "$(dirname "$0")/.."
REGISTRY=""; TAG=""; OUT=images.env; DRY=0; PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-push) PUSH=0; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
[ -n "$REGISTRY" ] && [ -n "$TAG" ] || { echo "usage: scripts/publish-images.sh --registry PREFIX --tag TAG (try --help)" >&2; exit 2; }
# Lower case, no scheme, no trailing slash, no spaces: a registry reference, not a command.
echo "$REGISTRY" | grep -Eq '^[a-z0-9][a-z0-9._:/-]*[a-z0-9]$' && ! echo "$REGISTRY" | grep -q '//' || { echo "--registry must look like ghcr.io/owner/name (lower case, no scheme)" >&2; exit 2; }
echo "$TAG" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$' || { echo "--tag has characters Docker does not allow in a tag" >&2; exit 2; }

# 1. The harness inside the image is the locked, committed one.
scripts/harness-lock.sh --check >/dev/null || { echo "the harness lock does not check out; see scripts/harness-lock.sh --help" >&2; exit 1; }
LOCKED="$(sed -n 's/^commit=//p' sandbox/harness.lock)"
INFO=sandbox/.harness-dist/BUILD_INFO
[ -f "$INFO" ] || { echo "no $INFO: run scripts/build-harness.sh --locked first" >&2; exit 1; }
[ "$(sed -n 's/^dirty=//p' "$INFO")" = no ] || { echo "the built harness is from a dirty tree; rebuild with scripts/build-harness.sh --locked" >&2; exit 1; }
[ "$(sed -n 's/^commit=//p' "$INFO")" = "$LOCKED" ] || { echo "the built harness is not the locked commit ($LOCKED); rebuild with scripts/build-harness.sh --locked" >&2; exit 1; }
# 2. The services come from committed files.
if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  echo "tracked files have uncommitted changes; publish from a clean checkout" >&2; exit 1
fi

run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@"; fi; }
: > "$OUT.tmp"
build() { # service-name context env-var [extra docker build args...]
  name="$1"; ctx="$2"; var="$3"; shift 3
  ref="$REGISTRY-$name"
  echo "==> $name"
  run docker build "$@" -t "$ref:$TAG" "$ctx"
  [ "$PUSH" = 1 ] || return 0
  run docker push "$ref:$TAG"
  if [ "$DRY" = 1 ]; then echo "$var=$ref@sha256:<digest>" >> "$OUT.tmp"; return 0; fi
  digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$ref:$TAG")"
  case "$digest" in "$ref"@sha256:*) ;; *) echo "no registry digest for $ref:$TAG (got '$digest'); was the push refused?" >&2; exit 1 ;; esac
  echo "$var=$digest" >> "$OUT.tmp"
}
build gateway gateway GATEWAY_IMAGE --build-context common=common
build sandbox-runner runner RUNNER_IMAGE --build-context common=common
build llm-proxy llm-proxy LLM_PROXY_IMAGE --build-context common=common
build egress-proxy egress-proxy EGRESS_PROXY_IMAGE
build sandbox sandbox SANDBOX_IMAGE --build-arg REQUIRE_CLEAN_HARNESS=1
if [ "$PUSH" = 1 ]; then mv "$OUT.tmp" "$OUT"; echo "==> wrote $OUT"; sed 's/^/   /' "$OUT"; else rm -f "$OUT.tmp"; fi
