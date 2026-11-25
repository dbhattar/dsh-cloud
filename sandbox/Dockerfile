# Sandbox image: the pre-built local deepseek-harness plus the entrypoint. Fast to build.
# The harness is built separately (and only when needed) by scripts/build-harness.sh,
# which fills sandbox/.harness-dist/.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
COPY .harness-dist/ /opt/dsh/
RUN test -f /opt/dsh/apps/cli/lib/bin.js \
 && ln -s /opt/dsh/apps/cli/lib/bin.js /usr/local/bin/dsh && chmod +x /opt/dsh/apps/cli/lib/bin.js

# The harness shows a versioned "Preview Notice" to every new user until they click Continue. Our users are not
# harness developers, so the entrypoint records that version as acknowledged (ui-settings-general). The version is
# read from the harness source here, so a harness upgrade that changes it is picked up on rebuild, and a harness
# that moves or renames it fails this build instead of quietly bringing the popup back.
RUN v="$(sed -n "s/^export const WELCOME_NOTICE_VERSION = '\([^']*\)'.*/\1/p" /opt/dsh/packages/client/ui-settings-models/src/onboarding-copy.ts)" \
 && test -n "$v" && printf '%s\n' "$v" > /opt/dsh/WELCOME_NOTICE_VERSION

# bubblewrap confines the agent's shell commands to the workspace (the harness tries bwrap, then Landlock, and
# refuses to run a command unconfined). It works under gVisor, which allows the unprivileged user namespaces
# that hardened runc forbids; see docs/research-harness-policy.md.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN useradd --home-dir /workspace --no-create-home --shell /bin/bash dsh \
 && mkdir -p /data/dsh /workspace \
 && chown -R dsh:dsh /data /workspace
USER dsh
# HOME is the persisted workspace volume, so projects created under ~ survive container recreation.
ENV DSH_HOME=/data/dsh HOME=/workspace
WORKDIR /workspace

# Model access is a per-user llm-proxy token, supplied at run time via LLM_PROXY_TOKEN and LLM_BASE_URL.
# Never bake the real provider key into the image.
# entrypoint.sh binds the container IP (dsh rejects 0.0.0.0) and sets --public-url/--trusted-host.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
