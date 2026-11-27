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

# The toolbox (docs/plan-first-security-test.md, step 2; docs/research-security-tooling.md for what was measured). The root is read-only at
# run time, so everything the agent can run without installing it has to be here; it can add more under /workspace (see PIP_USER below).
#  - Debian packages (versions follow the pinned base image's release): repository and scripting basics, and the web-testing tools
#    that are packaged (sqlmap, ffuf, gobuster, sslscan, testssl.sh). Nothing that needs raw sockets is installed: the sandbox has no
#    route for them, so they would only mislead. trufflehog (AGPL-3.0) and semgrep (rules licence) are left out on purpose.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl git jq ripgrep unzip python3 python3-pip python3-venv \
      sqlmap ffuf gobuster sslscan testssl.sh \
 && rm -rf /var/lib/apt/lists/*
#  - Release binaries with no Debian package (httpx, nuclei, gitleaks, osv-scanner), pinned by version and SHA-256 per architecture.
COPY tools.lock install-tools.sh /tmp/tools/
RUN /tmp/tools/install-tools.sh /tmp/tools/tools.lock && rm -rf /tmp/tools
#  - Python tools without a Debian package, in their own environment (bandit, pip-audit), versions pinned in sandbox/pytools.txt.
COPY pytools.txt /tmp/pytools.txt
RUN python3 -m venv /opt/pytools && /opt/pytools/bin/pip install --no-cache-dir -r /tmp/pytools.txt && rm /tmp/pytools.txt

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN useradd --home-dir /workspace --no-create-home --shell /bin/bash dsh \
 && mkdir -p /data/dsh /workspace \
 && chown -R dsh:dsh /data /workspace
USER dsh
# HOME is the persisted workspace volume, so projects created under ~ survive container recreation.
ENV DSH_HOME=/data/dsh HOME=/workspace
# The agent's own installs go to the persisted workspace volume. The system site-packages is read-only, so `pip install` falls back to a
# user install under ~/.local on its own; PIP_BREAK_SYSTEM_PACKAGES only lets it past Debian's "externally managed" notice, which is about
# the system site (virtualenvs are unaffected, and PIP_USER is deliberately not set because it breaks them). ~/.local/bin is on PATH. The
# environment holding bandit and pip-audit is last on PATH, so `pip` and `python3` stay the system ones.
ENV PIP_BREAK_SYSTEM_PACKAGES=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PATH=/workspace/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/pytools/bin
WORKDIR /workspace

# Model access is a per-user llm-proxy token, supplied at run time via LLM_PROXY_TOKEN and LLM_BASE_URL.
# Never bake the real provider key into the image.
# entrypoint.sh binds the container IP (dsh rejects 0.0.0.0) and sets --public-url/--trusted-host.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
