#!/bin/sh
# Starts dsh on the container's own IP (dsh rejects 0.0.0.0) and advertises the
# browser-facing URL. DSH_PUBLIC_URL and DSH_TRUSTED_HOST are required.
set -eu
: "${DSH_PUBLIC_URL:?DSH_PUBLIC_URL is required}"
: "${DSH_TRUSTED_HOST:?DSH_TRUSTED_HOST is required}"
IP="$(hostname -i | awk '{print $1}')"

# Runtime config patch. Feedback opens the gateway's own form instead of the
# upstream questionnaire; DSH_SHOW_SIGN_IN=true restores the "Sign in" menu item; DSH_PUBLIC_URL ends with "/".
PATCH=/tmp/dsh-cloud-patch.yml
{
  echo "- id: ui-settings-account"
  echo "  config: { contactFormUrl: \"${DSH_PUBLIC_URL%/}/gw/feedback\", showSignIn: ${DSH_SHOW_SIGN_IN:-false} }"
} > "$PATCH"
# Harness policy (phase 4 F1, docs/research-harness-policy.md). Every session starts confined to the workspace
# with approval prompts on, and users can only pick the presets listed here: no danger-full-access. A patch
# replaces a row's whole config, so the workspace root is restated (the default would be the process cwd).
# The container (gVisor, read-only root, internal network) is the real boundary; this limits what the agent
# can do to the user's own /workspace and /data/dsh, and what a prompt-injected page can steer it into.
{
  echo "- id: sandbox-policy"
  echo "  config: { mode: workspace-write, workspaceRoot: /workspace }"
  echo "- id: approval"
  echo "  config: { policy: ask }"
  echo "- id: permission"
  echo "  config:"
  echo "    presets:"
  echo "      read-only: { sandbox: read-only, approval: ask }"
  echo "      workspace-write: { sandbox: workspace-write, approval: ask }"
} >> "$PATCH"
# Default workspace: a new user's first session needs a folder. The harness looks up the OS Documents folder with
# `xdg-user-dir`, which the slim image does not have, so it failed ("Unable to create default workspace") and the
# user had to pick a folder by hand. Point it at the persisted workspace volume instead; the harness creates
# /workspace/deepseek-harness/default-workspace there on first use.
{
  echo "- id: workspace-controller"
  echo "  config: { documentsDirectory: /workspace }"
} >> "$PATCH"
# First-run "Preview Notice": mark the current notice version as acknowledged, so new users go straight to the app.
# The version file is written at image build (sandbox/Dockerfile); without it the notice simply shows.
WELCOME_VERSION_FILE="${DSH_WELCOME_VERSION_FILE:-/opt/dsh/WELCOME_NOTICE_VERSION}"
if [ -r "$WELCOME_VERSION_FILE" ]; then
  WELCOME_VERSION="$(tr -d '\n' < "$WELCOME_VERSION_FILE")"
  case "$WELCOME_VERSION" in
    *[!A-Za-z0-9._-]*|"") ;; # not a plain version string: leave the notice on rather than write odd YAML
    *)
      {
        echo "- id: ui-settings-general"
        echo "  config: { welcomeNoticeVersion: \"$WELCOME_VERSION\" }"
      } >> "$PATCH"
      ;;
  esac
fi
# Scheduled tasks need the workspace to be running at the scheduled time, and a stopped workspace is not (phase 5 plan, idea 20), so
# the Automation tasks entry is hidden rather than offering something that would silently not run.
{
  echo "- id: ui-schedule"
  echo "  disabled: true"
} >> "$PATCH"
# Model routing: the harness talks to llm-proxy (LLM_BASE_URL) with this user's token (LLM_PROXY_TOKEN).
# The real provider key is never present in the sandbox.
if [ -n "${LLM_PROXY_TOKEN:-}" ] && [ -n "${LLM_BASE_URL:-}" ]; then
  MODEL="${DSH_DEFAULT_MODEL:-openrouter/free}"
  {
    echo "- id: agent-default-model"
    echo "  config: { provider: openrouter, model: \"$MODEL\" }"
    echo "- id: llm-pi-ai"
    echo "  config:"
    echo "    providers:"
    echo "      openrouter:"
    echo "        apiKeyEnv: LLM_PROXY_TOKEN"
    echo "        baseURL: \"$LLM_BASE_URL\""
    echo "        models:"
    echo "          - id: \"$MODEL\""
    # Declare the output limit: an unlisted model otherwise gets 4096 and a long file write is cut off mid-call ("Expected ',' or '}'").
    case "${DSH_MODEL_MAX_TOKENS:-}" in
      ""|*[!0-9]*|0*) ;;
      *) echo "            maxTokens: $DSH_MODEL_MAX_TOKENS" ;;
    esac
    # A friendly name in the model picker (config: the model's `name`). Plain words only, so it cannot break the YAML.
    case "${DSH_MODEL_NAME:-}" in
      ""|[!A-Za-z0-9]*|*[!A-Za-z0-9\ ._\(\)+/-]*) ;;
      *) echo "            name: \"$DSH_MODEL_NAME\"" ;;
    esac
  } >> "$PATCH"
fi
set -- --patch "$PATCH"
# Launcher options (--patch) must precede app options such as --no-open.
exec dsh --profile web "$@" --no-open \
  --host "$IP" --port 3080 \
  --public-url "$DSH_PUBLIC_URL" \
  --trusted-host "$DSH_TRUSTED_HOST"
