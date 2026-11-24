#!/bin/sh
# Base images are pinned by digest, so a rebuild next month gets the same bytes and an upstream tag move cannot
# change what ships. This script checks the pins and refreshes them.
#
#   scripts/pin-images.sh --check     fail if any FROM or compose image is not pinned as name:tag@sha256:...
#   scripts/pin-images.sh --update    re-resolve every pinned image's digest from its tag (needs Docker and network)
#
# To move to a new version: edit the tag in the Dockerfile (for example node:24.22.3-slim to node:24.23.0-slim),
# run --update, review the diff, and rebuild. Dependabot (.github/dependabot.yml) proposes the same change.
# Not pinned, and why: the distro packages the images install (bubblewrap) follow the pinned base image's Debian
# release and resolve at build time; the harness is pinned separately, by sandbox/harness.lock.
set -eu
cd "$(dirname "$0")/.."
FILES="$(ls */Dockerfile sandbox/harness.Dockerfile infra/docker-compose*.yml 2>/dev/null | sort -u)"
MODE="${1:---check}"

refs() { # every image reference in the files: Dockerfile FROM lines and compose `image:` lines
  for f in $FILES; do
    case "$f" in
      *Dockerfile) sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' "$f" ;;
      *.yml) sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]#]\{1,\}\).*/\1/p' "$f" ;;
    esac | sed "s|^|$f |"
  done
}

case "$MODE" in
  --check)
    bad=0
    refs | while read -r file ref; do
      case "$ref" in
        scratch|dsh-sandbox:latest) continue ;; # no registry image / the locally built sandbox image
        *:*@sha256:????????????????????????????????????????????????????????????????) ;;
        *) echo "not pinned by tag and digest: $file: $ref" >&2; echo bad >> /tmp/pin-bad.$$ ;;
      esac
    done
    if [ -f /tmp/pin-bad.$$ ]; then rm -f /tmp/pin-bad.$$; exit 1; fi
    echo "all $(refs | grep -vc ' scratch$\| dsh-sandbox:latest$') images are pinned by digest"
    ;;
  --update)
    refs | while read -r file ref; do
      case "$ref" in *:*@sha256:*) ;; *) continue ;; esac
      tag="${ref%@*}"
      docker pull -q "$tag" >/dev/null
      new="$(docker image inspect -f '{{index .RepoDigests 0}}' "$tag")"
      new="${tag}@${new#*@}"
      if [ "$new" != "$ref" ]; then
        echo "$file: $ref -> $new"
        sed -i.bak "s|$ref|$new|g" "$file" && rm -f "$file.bak"
      fi
    done
    ;;
  *) echo "usage: scripts/pin-images.sh --check | --update" >&2; exit 2 ;;
esac
