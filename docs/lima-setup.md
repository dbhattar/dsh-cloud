# Lima Linux VM for phase 4 isolation testing

Record of what was set up with Lima, why, what went wrong, and what the first spike found. All commands live in [scripts/lima/](../scripts/lima/); the raw spike output is in [lima-output/harness-spike-run1.txt](lima-output/harness-spike-run1.txt). Written 2026-11-21 for review.

## Why a VM

Phase 4 plans to run sandboxes under gVisor (`runsc`) instead of plain Docker (`runc`). gVisor has to be registered in the Docker daemon's runtime config, which Docker Desktop's built-in VM does not let you do. So a separate Linux VM with its own rootful Docker was created. Docker Desktop itself was not changed, and the VM is independent of the `dsh-cloud` compose stack.

## What was created

| Item | Value |
| --- | --- |
| Tool | Lima 2.2.1 (already installed), `vz` VM type (Apple Virtualization) |
| Instance | `dsh-linux`, stored in `~/.lima/dsh-linux` |
| Template | `docker-rootful` (Docker daemon running as root inside the VM) |
| Size | 4 CPUs, 6 GiB RAM, 40 GiB disk |
| Guest | Ubuntu 26.04 (aarch64), kernel 7.0.0-34-generic |
| Docker | 29.10.0 (inside the VM) |
| gVisor | `runsc` release-20261116.0, installed from gVisor's signed apt repo, registered as Docker runtime `runsc` |

Lima mounts your home directory into the VM read-only, which is how the VM builds `sandbox/` straight from this repo without copying it.

## Steps, in order

1. `scripts/lima/create-vm.sh`: `limactl start --name=dsh-linux --cpus=4 --memory=6 --disk=40 template:docker-rootful`. First boot downloads the Ubuntu cloud image and provisions Docker (a few minutes).
2. `scripts/lima/install-gvisor.sh`: adds gVisor's apt repository and signing key, installs `runsc`, runs `runsc install` (writes the runtime into `/etc/docker/daemon.json`), restarts Docker.
3. `scripts/lima/gvisor-smoke.sh`: runs an alpine container under both runtimes and prints the kernel it sees.
4. `scripts/lima/harness-spike.sh`: builds the real sandbox image in the VM and starts it under both runtimes with the gateway's hardening flags, then probes it.

## What went wrong

1. **Spurious "host agent process has exited".** I ran `limactl start` a second time while the first start was still downloading. The two host agents collided and the second command exited with a fatal error, but the first VM came up normally (status Running afterwards). Fix: start once and wait. `create-vm.sh` now says this and refuses to run if the instance exists.
2. **gVisor download URL returned 404.** My first `install-gvisor.sh` used `storage.googleapis.com/gvisor/releases/release/latest/<arch>/runsc`, the manual-install path in older docs. It now returns 404 for every file. gVisor's current docs recommend the apt repository, so the script was rewritten to use that. The failed first version was never committed.

Also, the first VM start was launched with its log redirected to `/tmp/lima-start.log` instead of the session scratchpad. That file is only a leftover log and nothing depends on it.

## Results

### gVisor smoke test (`gvisor-smoke.sh`)

| Runtime | Kernel the container sees |
| --- | --- |
| `runc` | `Linux 7.0.0-34-generic` (the VM's real kernel) |
| `runsc` | `Linux 4.19.0-gvisor` (gVisor's own kernel) |

So under `runsc` the container's system calls go to gVisor's user-space kernel, not the host kernel. That is the isolation property phase 4 wants.

### Harness spike (`harness-spike.sh`, plan task A1)

Both runs used the gateway's flags: all capabilities dropped, `no-new-privileges`, 256 pids, 1 GiB, 1 CPU.

| Check | runc | runsc |
| --- | --- | --- |
| `dsh --profile web` boots and prints its launch token | yes | yes |
| User namespaces for the `dsh` user | **denied** | OK |
| `bwrap` in image | not installed | not installed |
| Seccomp filter | active (mode 2) | none reported (gVisor does its own filtering) |
| `NoNewPrivs`, effective capabilities | 1, none | 1, none |

What this means:

- **The harness runs under gVisor.** The main risk in the plan (that it would not boot) did not happen.
- **The bwrap path is already dead under hardened runc.** User namespaces are denied there and bwrap is not in the image. The harness's Linux runner chain is bwrap, then Landlock, and fails closed with `SANDBOX_UNAVAILABLE` if neither works. This spike did not test Landlock, so it is still unknown whether the model's shell tool works today at all.
- **Update:** the shell question was followed up in [research-harness-policy.md](research-harness-policy.md): the Linux Landlock launcher is missing from the image, gVisor has no Landlock, and `bwrap` works under gVisor once installed.
- **Not yet tested: the shell tool itself.** The probes above check primitives, not a real `bash` tool call through the harness under each runtime. Landlock may or may not be available under gVisor. This is the next follow-up before D1 (isolation runtime) is final.

## One-command setup

`scripts/lima/setup.sh` runs the steps above in order and skips what is already done: create or start the VM, install gVisor (only if `runsc` is not registered), run the smoke test, and create the `lima-<name>` Docker context (without making it current). `scripts/lima/setup.sh --stack` then starts the whole dsh-cloud stack in the VM with `SANDBOX_RUNTIME=runsc`, targeting the VM through `DOCKER_CONTEXT` for that one command, so your global context is untouched. It needs host port 443 free, so stop any stack on Docker Desktop first.

Things learned the hard way:
- Installing gVisor restarts Docker in the VM. That kills running containers and leaves Lima's forwarded Docker socket on the Mac dead until the VM itself is restarted (`limactl stop`, then `limactl start`). The script refuses to install while containers are running, and restarts the VM after installing.
- Do not run `setup.sh` (or anything that restarts Docker in the VM) while a build is running against it: the build fails with `error reading from server: EOF`.

## Results of running the stack under gVisor

See "What has and has not been verified" in [plan-phase-4.md](plan-phase-4.md): the sandbox boots and is isolated under `runsc`, and Docker's embedded DNS does not work inside a gVisor sandbox, which the runner works around with fixed addresses and `ExtraHosts` (details there).

## Choosing the runtime (and what happens under the wrong one)

Sandboxes run under the runtime in `SANDBOX_RUNTIME` (`runsc` is gVisor, `runc` is plain Docker). The compose default is `runc`, and the runtime is fixed when the runner container is created.

**What goes wrong under runc.** The harness's shell tool refuses to run commands unconfined. Under runc user namespaces are denied (so bubblewrap cannot work) and the Landlock launcher is not in the image, so the model gets "Error: sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel...". The page itself works, so the failure only shows when the agent tries to run a command. Seen on 2026-11-25: after a restart of the VM stack without `SANDBOX_RUNTIME=runsc`, the runner created sandboxes under runc and the shell tool failed. Another sign: `docker inspect -f '{{.HostConfig.Runtime}}' dsh-sbx-<id>` says `runc`, and `uname -r` inside says the VM's kernel (for example `7.0.0-43-generic`) instead of `4.19.0-gvisor`.

**How it is chosen now.** `scripts/restart.sh` decides, first match wins: `--runtime`; the `SANDBOX_RUNTIME` environment variable; `SANDBOX_RUNTIME` in `.env`; otherwise automatic, which means `runsc` if the current Docker daemon has it registered, else `runc` with a warning. It follows the Docker context, so the VM gets gVisor and Docker Desktop gets runc without any edit. A runtime the daemon does not have is refused before anything is touched (`restart.sh --runtime runsc` on Docker Desktop says so and points here). `restart.sh --print-runtime` prints the choice and the reason and changes nothing. The runner also logs a `WARNING` at startup when it runs under runc, so a stack started some other way (a bare `docker compose up`) is still obvious: `docker logs dshcloud-sandbox-runner-1 | head`.

**To fix a stack that is on the wrong runtime:** `scripts/restart.sh` in the VM context (or `scripts/lima/setup.sh --stack`). Existing sandboxes are removed and recreated on the user's next visit; accounts, files and sessions are kept.

Checked: against the real Lima and Docker Desktop contexts `--print-runtime` reports `runsc` and `runc` respectively; a bare `restart.sh` in the VM context produced a runner with `SANDBOX_RUNTIME=runsc` and no warning; the runner's warning appears under runc and not under runsc. The decision logic is covered by `tests/scripts/restart-runtime.test.mjs` (precedence, `.env` parsing, refusal of an unregistered runtime, no side effects) and the warning by a runner unit test.

## Using the VM's Docker from the Mac

`scripts/lima/docker-context.sh lima` creates a Docker context (`lima-dsh-linux`) for the VM's socket and makes it current; `desktop` switches back; `status` shows where `docker` points. Lima forwards ports published inside the VM to `localhost` on the Mac, so a stack started this way is reachable at the same URLs. Tested with throwaway containers on ports 81 and 18080.

## Reuse and cleanup

```
limactl list                                   # status
limactl stop dsh-linux                         # stop (keeps the disk)
limactl start dsh-linux                        # start again
limactl shell dsh-linux -- sudo docker ps      # run commands in the VM
limactl delete dsh-linux                       # remove the VM and its 40 GiB disk
```

The scripts honour `DSH_VM_NAME`, `DSH_VM_CPUS`, `DSH_VM_MEMORY_GB` and `DSH_VM_DISK_GB`. The spike leaves the `dsh-sandbox:spike` image in the VM's Docker and removes its containers.

## Open items

- Test a real shell tool call under `runc` and `runsc` (Landlock availability).
- Pick the production sandbox runtime based on that result (plan decision D1).
- Decide whether `sandbox-runner` (task B1) should be developed against this VM or the Docker Desktop daemon. The runtime is a config value, so either works.
