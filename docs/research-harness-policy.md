# Research: harness policy and shell confinement (phase 4, task A2)

Status: research complete (A2); F1 implemented from it, see "F1 result" at the end. Closes the open follow-up from A1 ([lima-setup.md](lima-setup.md)). Related: [plan-phase-4.md](plan-phase-4.md).

Everything here was run against the harness build in `sandbox/.harness-dist` (the same one the sandbox image copies), on the Lima VM `dsh-linux` (Docker 29, Linux 7.0 aarch64, gVisor `runsc`) unless stated otherwise. "Verified" means observed running; "read" means taken from harness source or docs and not exercised.

## Questions

1. Which config keys set the default sandbox mode and approval preset, and can `--patch` alone lock them?
2. Can `danger-full-access` and the directory picker be removed without changing the harness?
3. (From A1) Does the model's shell tool actually work in our sandbox image, under `runc` and under `runsc`?

## Summary

| Question | Answer |
| --- | --- |
| Can config lock the defaults? | **Yes.** Three rows control it, and a `--patch` overlay replaces each row's config. The result boots under gVisor with no warnings. |
| Can `danger-full-access` be hidden? | **Yes for the preset table**; unknown presets are rejected by the server, not only hidden. One path remains by design: the model can ask for a **single-call escalation** that the user approves (see below). `approval: never` closes it. |
| Can the directory picker be removed? | The row can be disabled by patch and the harness boots. What the UI does without it was **not exercised**. |
| Does the shell tool work today? | **No, under neither runtime.** Under `runc` the Landlock launcher binary is missing from the image. Under `runsc` Landlock does not exist (syscall not implemented) and `bwrap` is not installed. |
| Is there a fix? | **Yes.** Under `runsc`, installing `bubblewrap` in the image makes confinement work (verified at primitive level). Under `runc` a Linux `landlock-run` binary has to be added to the image. |

The shell result is the important one. F1 as written in the plan (locked-down defaults) is a small config change. Making the agent's shell usable under gVisor needs an image change, which the plan did not anticipate.

## 1. Where the policy lives

Dumped with `dsh --profile web --dump-config` (any row it prints can be patched). Three rows decide the policy, all defined in the `dsh-base` bundle:

| Row id | Plugin | What it sets | Shipped value |
| --- | --- | --- | --- |
| `sandbox-policy` | `dsh-sandbox-policy` | default file-effect mode and the writable root | `mode: env DSH_PERMISSION_MODE ?? workspace-write`, `workspaceRoot: process.cwd()` |
| `approval` | `dsh-user-approval` | default approval policy: `ask` or `never` | `ask`, unless `DSH_PERMISSION_MODE` is `danger-full-access` |
| `permission` | `dsh-permission-presets` | the table of presets a user can pick: name to (sandbox mode, approval) | `read-only`, `workspace-write`, `danger-full-access` |

Related rows: `ui-permission` (the preset selector in the UI), `ui-agent-preset`, `directory-picker` (`dsh-host-directory-picker-auto`), `ui-approval` (the approval prompt).

Our deployment is therefore **already** `workspace-write` plus `ask` by default: the sandbox image's working directory is `/workspace`, so `process.cwd()` is the user's workspace. What is open is that the user can switch to the `danger-full-access` preset in the UI, and can pick another working directory.

### Patch semantics (verified)

- A patch targets a row by id and **replaces its whole `config`**, it does not merge ([architecture.md](../../deepseek-harness/docs/architecture.md)). Verified by diff of the two dumps: patching `permission` with two presets removed the third; patching `sandbox-policy` dropped the `process.cwd()` expression, so `workspaceRoot` must be restated.
- A patch row may carry `disabled: true` on its own (verified for `directory-picker`; the `name` is kept from the base row).
- `--patch` overlays apply last, after the profile's bundles and the user's own patch files, so they win.
- Plugin ids are stable names in the bundle files, not package names; they would be the thing to re-check when the harness is upgraded.

### Candidate patch for F1 (verified to apply and boot)

```yaml
- id: permission
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
- id: sandbox-policy
  config: { mode: workspace-write, workspaceRoot: /workspace }
- id: approval
  config: { policy: ask }
- id: directory-picker
  disabled: true
```

Booted under `runsc` with the gateway's hardening flags (read-only rootfs, no capabilities, `no-new-privileges`): the launch token printed and the log held no error or warning lines. `--dump-config` with the patch shows the rows as intended.

### Is hiding enough, or is it enforced? (read)

`PermissionPresetService.resolve(name)` throws `unknown preset` for any name outside the configured table, and `set` goes through it, so a client that sends `danger-full-access` to the Remote is refused by the server, not just missing from the menu. `auto` (a fixed `danger-full-access` + `ask` bundle) exists only when the experimental Auto review integration is mounted; it is not in the web profile's dump.

### The one remaining route to `danger-full-access`: per-call escalation (read)

With `ask`, the model can add `sandbox_permissions` to a tool call to request a strictly wider mode for that single call (`workspace-write` to `danger-full-access`). The harness asks the user, and only an approval runs it; it applies to that call only. With `never`, every ask is rejected deterministically and the model is told not to request escalation. So:

- `ask` keeps a human decision in the loop, and the human is the account holder.
- `never` plus `workspace-write` is the strictest combination and also removes every prompt. It would need its own preset entry (for example `workspace-write: { sandbox: workspace-write, approval: never }`), and the UI then never asks anything. That is a product choice, listed under open questions.

## 2. What this policy is, and is not, protecting

The harness policy is **not a security boundary against the user**. The user already has an interactive shell in their own container; the boundary against them is the container (gVisor, read-only root, dropped capabilities, internal network, egress proxy). Even `danger-full-access` can only write the two volumes and `/tmp`, because the root filesystem is read-only.

What it protects is the user's own session and the agent's blast radius:

- an agent (or a prompt-injected page it fetched) deleting or corrupting the user's own `/data/dsh` state, other projects in `/workspace`, or credentials the harness keeps;
- the agent reading or writing outside the project it was asked to work on.

That is worth having, and it is why the confinement result below matters more than the preset menu. It also means hiding the menu is a UX and defence-in-depth measure, not something to rely on.

## 3. Does the shell tool work? (the A1 follow-up)

### Background: bwrap, Landlock and the Landlock launcher

Both tools do the same job: run one command with less filesystem access than the process that started it. They get there differently, and that difference decides where each can work.

**bwrap (Bubblewrap)** builds a private view of the system for one command, using Linux namespaces (a namespace gives a process its own copy of something, such as the mount table or the process list). The harness's profile mounts the whole filesystem read-only, binds only the workspace and `/tmp` as writable, gives the command a fresh `/dev`, and runs it in a private PID namespace so it cannot see or signal host processes. A write outside the workspace fails with "Permission denied" because the command is looking at a read-only copy. It needs the kernel to allow unprivileged user namespaces, which lets a normal user create those private views without root. Hardened Docker (`runc`) blocks that; gVisor allows it.

**Landlock** is a kernel security feature. A process tells the kernel "from now on I may only write to these directories", and the kernel enforces that on the process and all its children; it cannot be undone. Nothing is mounted or hidden: the command sees the normal filesystem, but writes outside the allowed paths are refused. It needs no user namespaces, so it works under hardened `runc`, provided the host kernel supports it (any recent Linux does; the VM reported ABI version 8). The kernel cannot be asked to "run this command under Landlock" directly, so something must first apply the rules and then exec the command.

**The Landlock launcher** (`landlock-run` in the harness) is that something: a small static executable that applies the Landlock rules for the chosen mode and workspace and then execs the command. The harness ships it as a prebuilt per-platform binary in `native/system/packages/<platform>/bin/landlock-run`; consumers never build it, but building it from source needs `musl-gcc` on Linux. The harness also uses the launcher to probe whether Landlock works (`probe` returns `unusable` when the binary is missing or the kernel refuses it).

| | bwrap | Landlock (via the launcher) |
| --- | --- | --- |
| Mechanism | mount and PID namespaces | kernel rule set on the process |
| What the command sees | a read-only copy of the filesystem plus writable binds | the normal filesystem, with writes refused outside the allowed paths |
| Kernel requirement | unprivileged user namespaces | a kernel with Landlock |
| Extra binary | `bwrap` (an OS package, `bubblewrap`) | `landlock-run` (shipped with the harness) |
| Works under hardened `runc` | no (user namespaces denied) | yes, if the launcher is present |
| Works under gVisor | yes | no (syscall not implemented) |

### How the harness chooses

Linux confinement in the harness is a chain: `bwrap`, then Landlock, and if neither is usable the call fails closed with `SANDBOX_UNAVAILABLE` rather than running unconfined ([sandbox-local README](../../deepseek-harness/packages/sandbox/sandbox-local/README.md)).

Observed in the current image, with the gateway's hardening flags:

| | `runc` (dev) | `runsc` (gVisor, production) |
| --- | --- | --- |
| Kernel seen by the container | host 7.0 | 4.19.0-gvisor |
| `bwrap` installed in the image | no | no |
| User namespaces for a non-root user | **denied** | OK (A1) |
| `bwrap` once installed (probe image, non-root user, all caps dropped, read-only root) | **fails**: "no permissions to create new namespace" | **works**: ran a command inside, `/etc` not writable, `/tmp` writable |
| Landlock in the kernel (`landlock_create_ruleset` ABI query) | **available, ABI 8** | **`ENOSYS` (not implemented)** |
| Landlock launcher binary `…/linux-arm64/bin/landlock-run` in the image | **missing** | **missing** |
| Harness Landlock probe result | `unusable` | `unusable` |

Conclusions:

1. **Today the shell tool fails closed in both runtimes.** Not because of gVisor: the Linux `landlock-run` executable is not in the image at all. The harness is built on Linux in Docker (`scripts/build-harness.sh`), but that build image has no `musl-gcc`, which the package needs to compile the static launcher; the flock addon was built (`glibc/system.node` is in the dist) and the launcher was not. The probe is `unusable` even under `runc`, where the kernel supports Landlock.
2. **Under gVisor, Landlock is not an option.** gVisor does not implement the syscall, so adding the launcher would not help in production.
3. **Under gVisor, `bwrap` is the working path.** It needs `bubblewrap` installed in the image (a normal `apt-get install`). The probe confines correctly as a non-root user with every capability dropped. This works because gVisor allows user namespaces for the unprivileged user that hardened `runc` forbids.
4. **Under `runc` (dev), Landlock is the only path**, and it needs the launcher binary added. Without it, developers on `runc` get a working UI with no shell tool, which is fail-closed and safe but surprising.

So a sensible F1 has two halves: the config patch above, and an image change that adds `bubblewrap` (production) and optionally the Linux `landlock-run` (dev parity).

### Caveats on this result

- The bwrap probe used a command shaped like the harness's profile (read-only root bind, fresh `/dev` and `/proc`, private PID namespace, writable `/tmp`). It is **not** the harness's own `probeBwrap`, and it is **not** a real `bash` tool call through the harness with a model in the loop. F1 must run one real call under `runsc` before this is called done.
- Only `linux-arm64` was checked (the VM). `linux-x64`, the likely production architecture, is untested; the same reasoning applies but it was not observed.
- Landlock under `runc` was checked at the syscall level only; the launcher is absent, so the end-to-end path was not exercised.

## 4. Recommendations

1. **F1, config:** ship the candidate patch above from `sandbox/entrypoint.sh`, restating `workspaceRoot: /workspace` explicitly. Decide the `ask` versus `never` question first (below).
2. **F1, image:** add `bubblewrap` to `sandbox/Dockerfile`, then run a real shell tool call under `runsc` and under `runc` and record both. Treat "bash tool works under runsc" as a release criterion for D1 (isolation runtime), since otherwise gVisor ships an agent with no shell.
3. **Dev parity (optional):** build `landlock-run` for linux into the harness dist so `runc` development matches. If the cost is high, document that the shell tool needs `runsc` and accept it.
4. **Tests:** a phase 4 check that fails if the preset table contains `danger-full-access`, and one that asserts the shell tool is not `SANDBOX_UNAVAILABLE` under the configured runtime.
5. **Re-verify on upgrade:** the row ids (`permission`, `sandbox-policy`, `approval`, `directory-picker`) are not a public contract. A cheap guard is a CI step that runs `dsh --dump-config` with our patch and checks the resulting rows.

## 5. Open questions for you

- **`ask` or `never`?** `ask` means the account holder can approve a single unconfined command. `never` removes that and every prompt, which suits unattended use but gives the user no way past a confinement denial (a build that needs to write outside the workspace simply fails).
- **Directory picker:** should it go? Its effect without it was not tested here. With a read-only root the picker cannot widen what is writable, so the case for removing it is mostly UX and surface area.
- **How much does the shell tool matter for the product?** If the agent can do useful work with file tools only, F1 could ship with the shell disabled and the image change deferred.

## Not covered

- The web UI behaviour of the locked-down patch (what the selector, approval prompt and picker look like when rows are disabled or the table is reduced). Needs a browser run.
- Preset catalog served to a live client; checked from source and the config dump, not from a running session.
- Other writable-root grants (`additionalWritableRoots`, `registerWritableRoot`): not configured by us, so not examined beyond noting they exist.
- The `read-only` preset's behaviour with the model's tools.

## F1 result

Implemented after the research above, with the defaults recommended there: approval stays `ask`, the directory picker is left alone (its effect without it was never tested and it cannot widen what a read-only root lets anyone write), and the shell is made to work under gVisor first.

| Change | Where |
| --- | --- |
| Patch rows `sandbox-policy` (`workspace-write`, root `/workspace`), `approval` (`ask`) and `permission` (`read-only` and `workspace-write` only), appended to the entrypoint's patch. They replace the base rows, so `DSH_PERMISSION_MODE` can no longer widen anything. | `sandbox/entrypoint.sh` |
| `bubblewrap` installed in the image | `sandbox/Dockerfile` |
| Unit test running the real entrypoint with a stub `dsh`: mode, root, approval, no `danger-full-access` anywhere, no preset with approval off, model rows intact | `tests/sandbox/entrypoint.test.mjs` |
| Live test: the harness's own bwrap profile confines a shell command (skipped under `runc`, where it cannot work) | `tests/phase4/isolation.test.mjs` |

Checked live in the Lima VM, sandbox created through the runner with a proxy token, under `runsc` and the gateway's full hardening:

- **Real shell tool call through the harness.** `dsh --profile headless` with the entrypoint's patch, driven by the model through llm-proxy: the model called its `bash` tool; `echo f1-ok > /workspace/f1.txt && cat /workspace/f1.txt` returned `f1-ok` and the file exists. A second call, `echo bad > /data/dsh/should-fail.txt`, was denied: `Read-only file system`, `[sandbox: file access denied under workspace-write mode]`, and the harness offered the approval-gated escalation (expected under `ask`). The file was not created. This closes the "no real shell call" caveat from A1 for `runsc` on `linux-arm64`.
- **The harness's exact bwrap arguments** (`--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind /workspace /workspace`) in the same container: `/workspace` and `/tmp` writable; `/data/dsh` read-only, so the agent shell cannot damage the harness's own sessions and settings; the root filesystem not writable.
- The stack was rebuilt from the changed image and started with `SANDBOX_RUNTIME=runsc` (`scripts/restart.sh`).

Not done, and why:

- **`runc` (dev) still has no shell tool.** User namespaces are denied there, so bwrap cannot work, and the Landlock launcher is not in the image. Adding it means installing `musl-tools` in `sandbox/harness.Dockerfile` and building `native/system` there; optional, not attempted. Until then, developers who want the shell tool use the Lima VM (`scripts/lima/setup.sh --stack`). Under `runc` the harness fails closed with `SANDBOX_UNAVAILABLE` rather than running commands unconfined.
- **The escalation path.** The model can still ask, and the user can approve, a single unconfined command. That is a deliberate consequence of keeping `ask`; switching to `never` is a one-line change in the entrypoint.
- **`linux-x64`.** Only `linux-arm64` was exercised.
- **The approval prompt and preset selector in a browser** were not looked at.
- **The new Docker-suite test** is syntax-checked, not run (dev-data guard), like the other phase 4 additions.

## First-run "Preview Notice" (follow-up)

A new user saw the harness's versioned "Preview Notice" popup until they clicked Continue. It comes from `dsh-client-ui-settings-models`; the acknowledgement is the `welcomeNoticeVersion` field of the `ui-settings-general` row, so a patch can pre-acknowledge it. `sandbox/entrypoint.sh` does that, with the version read at image build from the harness source (`sandbox/Dockerfile` writes `/opt/dsh/WELCOME_NOTICE_VERSION` and fails the build if the harness moves or renames it). Checked in a real browser (Playwright, Chromium) against the stack in the Lima VM: before the change a new account got the popup; after it, a new account went straight to the app. If the harness changes the notice's copy it bumps the version, and a rebuild picks the new one up.

The harness's separate "Add an API key" first-run step does not appear: it ends as soon as any provider can serve requests, and the llm-proxy route counts. The small "Preview" badge next to the title is the harness's own branding and was left alone.

## First-run default workspace (follow-up)

A new user also saw a toast, "Unable to create default workspace. Use Choose workspace to select a folder.", and had no workspace or session until they picked a folder. On Linux the harness finds the folder by running `xdg-user-dir DOCUMENTS`, which the slim image does not have. The `workspace-controller` row has a `documentsDirectory` override for exactly this, and `sandbox/entrypoint.sh` sets it to `/workspace`, so the first-use workspace is created at `/workspace/deepseek-harness/default-workspace` on the persisted volume. Checked in a browser against the Lima VM stack: before, the toast appeared and the composer had no workspace; after, the new user lands in "Default workspace" with a New Session and a ready composer, in "Workspace Write" mode, with no toast. Each session's `workspace-write` root is its working directory, so the agent's shell is now confined to that folder rather than all of `/workspace`.
