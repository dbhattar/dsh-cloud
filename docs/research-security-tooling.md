# Research: what security tooling can do inside a user sandbox

Date: 2026-11-26. Written for [plan-phase-6.md](plan-phase-6.md), which makes cybersecurity professionals the first users. Nothing here changes the product; it records what was measured, read, or only assumed, so the plan does not have to guess.

## Environment of the measurements

- **Host:** the Lima VM `dsh-linux` on an Apple Silicon Mac: **aarch64** (`uname -m` reports `aarch64` in the container). gVisor (`runsc`) is registered next to `runc`. A production host will probably be x86_64: tool availability differs by architecture (see "Architecture" below), so every availability and size figure below is for aarch64 Debian.
- **Image base:** `node:24.22.3-slim` (the pinned digest used by `sandbox/Dockerfile`), Debian 12 (bookworm).
- **How the probes ran:** a throwaway image (the base plus `bubblewrap` and the candidate tools), run with the same options the runner uses for a sandbox: `--runtime=runsc`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`, a `/tmp` tmpfs with `exec`, a writable `/workspace` volume, a non-root user (uid 1001), on an **internal** Docker network (no route off the host). The probe images, network and volume were removed afterwards. The probes ran as a plain shell script, not through the harness's own confined shell tool; the harness's bubblewrap layer sits on top of these limits and was not re-measured here (see "Not verified").

## Verified: what runs and what does not (aarch64, gVisor, sandbox options)

| Check | Result | What it means |
| --- | --- | --- |
| Non-root user | uid 1001 | Tools that insist on root fail by design. |
| `nmap -sT` (TCP connect scan) against loopback | **works** | Connect scans of things inside the sandbox work. |
| `nmap -sS` (raw SYN scan) | **fails**: "requires root privileges" | No raw scans. |
| Raw socket from Python (`SOCK_RAW`) | **fails** | No packet crafting (scapy-style tools, ICMP tricks). |
| `tcpdump -i lo` (live capture) | **fails**: no permission | Live capture is impossible; reading a capture file (`tcpdump -r`, `tshark -r`) was not run but needs no privileges (assumed). |
| `ping` | the `ping` binary is not in the base image (not tested further) | Irrelevant while there is no route. |
| `strace` | **works** (`strace -f -e trace=openat` shows the syscalls) | ptrace-based tracing of a child works under gVisor here. |
| `gdb` static analysis (`info files` on a binary) | **works** | Symbol and section inspection of a binary is fine. |
| `gdb` running a program (`run`) | **fails or hangs**: "Error disabling address space randomization: Invalid argument"; with randomisation left on the run did not finish in 12 s and was killed | **Dynamic debugging is not usable** here. Static reverse engineering is. |
| `curl` to a server on loopback | works (HTTP 200) | Local test targets (a vulnerable app run inside the sandbox) work. |
| `curl` to an external site | **fails** (no route) in these probes | Expected: the probe network had no egress proxy. In the product, HTTP(S) leaves only through the egress proxy (next section). |
| `python3 -m venv` in `/workspace` | works | Per-user Python environments are possible. |
| `yara`, `sqlmap` | run (`yara 4.2.3`, `sqlmap 1.7.2`) | Installed from Debian packages. |
| Write to `/etc` | refused (permission denied) | Read-only root as designed: **nothing can be installed at run time with `apt`**. |
| Write to `/tmp` | works | |
| `bwrap` (the harness's confinement) with a read-only bind of `/` | works | Confirms the shell-confinement mechanism still runs next to these tools. |

## Spike result (2026-11-27): the real agent's shell and the network

Step 1 of [plan-first-security-test.md](plan-first-security-test.md). The probe is `scripts/probe-agent-shell.sh`; rerun it after any change to the image, the entrypoint or the egress proxy.

**Method.** A throwaway account in the live local stack (Lima VM, gVisor, aarch64), its real sandbox created by the runner with its real entrypoint, policy patch and environment. The probe script ran two ways: **directly in the container** (control) and **through the agent**: `dsh --profile headless` with the sandbox's own patch, one real model call (the free router) asking the agent to run `sh /workspace/probe-shell.sh` with its bash tool, which executes under the harness's bubblewrap confinement. The egress proxy's own log was read afterwards as an independent record. Only `example.com` and two addresses that must be refused were contacted.

| Question | Result | How known |
| --- | --- | --- |
| What is in the image? | **Only `node` and `npm`** (Node 24). No `curl`, `wget`, `git`, `python3`, `pip`, `jq`, `rg`, `unzip`, `make`, `gcc`, `openssl`, `nc` or `dig` | measured, `command -v` in the image and again in the sandbox |
| Does the agent's confined shell have the proxy settings? | **Yes**: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lower-case), `NODE_USE_ENV_PROXY=1`. The harness adds `::1,[::1]` to `NO_PROXY` | measured through the agent |
| Does it reach the public internet? | **Yes, through the proxy**: `https://example.com/` and `http://example.com/` answered 200 | measured through the agent; the egress log shows `allow ... CONNECT example.com:443` and `:80` |
| What is refused? | Port 8080 on a public host (`port 8080 not allowed`), the metadata address `169.254.169.254` and `10.0.0.1` (`resolves to a non-public address`) | measured; each refusal is in the egress log with its reason |
| A tool that ignores the proxy? | A direct socket to a public address fails with `ENETUNREACH`: **no route** | measured |
| Is the model's token visible to the agent's shell? | **No.** In the container's own shell `LLM_PROXY_TOKEN` is visible; in the agent's shell **no credential-shaped name is visible** | measured through the agent; the harness's subprocess scrub removes names matching `KEY|PASSWORD|SECRET|TOKEN` (read in `packages/subprocess/subprocess/src/index.ts`) while `HOME`, locale and proxy variables survive |
| Does bubblewrap block the network? | **No.** The harness's confinement arguments contain no network namespace flag, and the harness's sandbox policy says network is "outside its vocabulary" (read in `packages/sandbox/sandbox-policy/README.md`) | read, and consistent with the measurements |

**What this changes in the plan**

- **Step 2 needs the whole tool list**: the image has nothing but Node, so the agent can neither clone a repository nor run any scanner until the toolbox lands. `npm` and Node's `fetch` work today, which is enough for the agent to make HTTP requests but not for the tools the work needs.
- **Reachability is settled**: staging over HTTPS needs no network change. The operator scope list and rate limits (step 3) are the only network work, and they are about restraint, not reach.
- **Tools must honour the proxy variables, or they have no network.** Node (with the flag the runner sets), `curl`, `git` and Python's `requests` do. Go programs (`nuclei`, `httpx`, `ffuf`, `gobuster`, `gitleaks`, `trufflehog`) read the standard proxy variables by default (**assumed from the Go standard library, to verify per tool in step 2**).
- **A GitHub token cannot be an environment variable.** The scrub removes any name containing `TOKEN`, `KEY`, `SECRET` or `PASSWORD` from the agent's shell, so a `GITHUB_TOKEN` would not reach git. The credential-store file in the workspace (`~/.git-credentials`) is not an environment variable and is not scrubbed (**to verify in step 4**).
- **Good news for confidentiality:** the per-user model token is not exposed to anything the agent runs, so a prompt-injected command cannot read and send it.

**Not covered by this spike:** a tool other than `node` running in the confined shell (there is none yet); writable locations a tool needs beyond `/workspace` and `/tmp` (caches, step 2); how well the model behaves on real testing prompts (it followed this simple instruction exactly).

**Left behind:** the throwaway account `spike-shell@example.com` (user 11) and its sandbox in the local stack. There is no delete-user feature until P5-13b; suspend it from the admin panel or ignore it.

## Toolbox result (2026-11-27): what step 2 put in the image and how it was checked

Step 2 of [plan-first-security-test.md](plan-first-security-test.md). Built on aarch64 (the Lima VM); `sandbox/Dockerfile`, `sandbox/tools.lock`, `sandbox/install-tools.sh`, `sandbox/pytools.txt`, `scripts/pin-tools.sh`.

| What | Version | Source |
| --- | --- | --- |
| `git`, `curl`, `jq`, `ripgrep`, `unzip`, `python3` with `pip` and `venv`, `ca-certificates` | Debian 12: git 2.39, curl 7.88, jq 1.6, ripgrep 13, Python 3.11, pip 23.0 | Debian packages |
| `sqlmap`, `ffuf`, `gobuster`, `sslscan`, `testssl` | sqlmap 1.7.2 (it warns it is outdated), ffuf 1.1.0, gobuster 3.5, sslscan 2.0.7, testssl 3.0.8 | Debian packages. The command is **`testssl`**, not `testssl.sh` |
| `httpx`, `nuclei`, `gitleaks`, `osv-scanner` | httpx 1.12.0, nuclei 3.11.1, gitleaks 8.30.1, osv-scanner 2.7.1 (osv-scalibr 0.5.3) | release binaries, pinned by SHA-256 for amd64 and arm64 in `sandbox/tools.lock` |
| `bandit`, `pip-audit` | 1.9.4, 2.10.1 | PyPI, in `/opt/pytools` (last on `PATH`, so `pip` and `python3` stay the system ones) |

**Cost:** the image went from 2.89 GB to **3.69 GB** (+0.8 GB); the build took 48 s with the harness layers cached. Licences of what was added: MIT (httpx, nuclei, gitleaks, ffuf), Apache-2.0 (osv-scanner, gobuster, bandit, pip-audit), GPL-2.0 or 3.0 (sqlmap, testssl, sslscan: separate programs in a hosted image, not redistributed, not linked).

**Left out on purpose:** **trufflehog** is AGPL-3.0, whose network-use clause makes hosting it for others a question for counsel, and gitleaks covers secret scanning; **semgrep** is heavy and its community rules carry a licence that restricts use inside a hosted service (**not read in full here; to verify**). `nmap`, `masscan` and `hydra` are not installed: they cannot work without raw sockets and a route. Both omissions are listed in the Dockerfile so nobody re-adds them by accident.

**Findings while building it**

- **No extra writable roots were needed.** `HOME` is `/workspace`, so every cache and config directory (`~/.cache`, `~/.config/nuclei`, `~/.local`) is already inside the one writable root of the harness's confinement. The pitfall recorded for the old P5-5 (adding cache directories to `additionalWritableRoots`) does not arise. Checked: `nuclei` created `/workspace/.config/nuclei`, `pip install` wrote under `/workspace/.local`, a virtualenv worked, all inside the confined shell.
- **`PIP_USER=1` breaks virtualenvs**, so it is not set. Pip falls back to a user install on its own when site-packages is read-only; `PIP_BREAK_SYSTEM_PACKAGES=1` only lets it past Debian's "externally managed" notice. Both `pip install x` and `python3 -m venv v && v/bin/pip install x` work (through the egress proxy).
- **gitleaks ignores the well-known documentation keys** (`AKIA…EXAMPLE`): a test that plants one proves nothing. The test plants a fake token-shaped string assembled at run time, so the repository never holds a complete secret-shaped value.
- **Go and Python tools honour the proxy variables**, as assumed: `httpx`, `curl`, `git`, `pip`, `pip-audit` and `osv-scanner` all went out through the egress proxy in the test, and the proxy log shows each destination; port 8080 and the metadata address stayed refused for the tools too.
- **A real agent run** (`scripts/probe-agent-shell.sh --agent` in a sandbox recreated from the new image) lists every tool on its `PATH`, with the proxy behaviour and the hidden model token unchanged.

**How it was verified:** `tests/phase6/toolbox.test.mjs` (7 checks, under gVisor, each tool run in the harness's exact bubblewrap confinement in a container with the sandbox's options, on a throwaway internal network with its own egress proxy; it does not touch the compose stack or any user's data): every tool answers with the pinned version; nothing that needs raw sockets is shipped and the root is read-only; git, `jq`, `rg` and `unzip` do real work; `httpx`, `ffuf`, `gobuster` and `nuclei` (with a template of our own) find what a local target holds; `gitleaks` finds a planted token and `bandit` an `eval`, and neither reports clean files; a virtualenv and the writable places; and, through the proxy, `curl`, a `git clone` over HTTPS, `pip`, `httpx`, and `osv-scanner` and `pip-audit` both finding `requests==2.19.0`'s known vulnerabilities, with the refusals still in the proxy log. `tests/sandbox/tools-lock.test.mjs` (6) covers the lock, the installer and `--update`. The first run of the Docker test failed three checks for reasons in the test itself (quoting, a banner line, the documentation-key allowlist), which is also the evidence that the checks can fail.

**A gap this exposed:** a sandbox container keeps the image it was created from. Rebuilding `dsh-sandbox:latest` changes nothing for an existing workspace until its container is removed (`docker rm dsh-sbx-<id>`; the volumes stay, and the next start creates a new one from the current image). The runner does not recreate a container whose image is out of date. For one local user that is a one-line step; before more users exist the runner should do it (compare the container's image to the current one on start, recreate when they differ, audit it).

**Not verified:** x86_64 (the lock covers amd64 and its hashes were checked against the projects' own checksums, but nothing amd64 was built or run); the interactive tools in the harness UI; nuclei's own template download (`nuclei -update-templates` goes to GitHub through the proxy and was not run, to avoid downloading a large template set in a test); `sqlmap` against a vulnerable target (version only).

## Egress limits and scope result (2026-11-27)

Step 3 of [plan-first-security-test.md](plan-first-security-test.md); details and settings in [../egress-proxy/README.md](../egress-proxy/README.md).

- **Built:** an optional operator scope list (`EGRESS_ALLOW_HOSTS`, plus a base list), per-sandbox and per-destination rate and concurrency limits that wait before they refuse, and `scripts/egress-scope.sh` to change the list on a running stack.
- **Measured (under gVisor, real tools, a throwaway proxy with the scope `example.com` and low limits):** `curl` and `httpx` to an unlisted host are refused (`CONNECT tunnel failed, response 403`; plain HTTP gets a 403 with `X-Egress-Reason`), and the log says `not in scope`; `www.example.com` is refused when only `example.com` is listed; `git clone`, `pip install`, `osv-scanner` and `pip-audit` all worked with the default base list and the proxy let through **only** `github.com`, `pypi.org`, `files.pythonhosted.org`, `api.osv.dev` and the listed host; 40 simultaneous connections from one sandbox gave 24 served and 16 refused with 429 (rate 5 a second, 4 open, a 2 s cap) while its neighbour's three requests took 0.5 s.
- **Live on the local stack:** `scripts/egress-scope.sh --set example.com` recreated the egress proxy, the runner re-attached it to the user network within 20 s, `example.com` and `github.com` answered 200 and `www.wikipedia.org` was refused with the reason; `--clear` returned to open mode. A temporary copy of the env file was used, so the real `.env` was not touched.
- **A bug in the existing proxy, found on the way (the finding that matters most; full write-up in [finding-egress-proxy-crash.md](finding-egress-proxy-crash.md)):** a refused `CONNECT` followed by a client reset emitted an unhandled socket error and **the whole egress proxy exited**. Any sandbox could have done this to every user. It is fixed (an error listener from the first moment; no connection is dialled for a client that has left; slots are returned) and has regression tests that fail without the fix. The Phase 4 abuse suites never reset a connection after a refusal. A probe of the plain-HTTP path (resets while the upstream is slow, mid-body, and after a scope refusal) showed no crash.
- **Limits of the limits:** an HTTPS tunnel hides the requests inside it, so these limits bound tunnel churn and parallelism, not requests per second on a reused connection. The tools' own rate options and the methodology skills are the first line of control (step 5).
- **Not exercised:** the base-list hosts for npm, Go modules, NVD, CISA, EPSS, osv-scanner's offline database and nuclei's template download (they are there because the tools use them, not because a test reached them); a per-user scope; x86_64.

## Verified from the source: the network path out of a sandbox

Read in `egress-proxy/README.md` and `egress-proxy/src/*.js`, and `runner/src/spec.js`:

- A sandbox is on an **internal** network. The only way out is the egress proxy (HTTP `CONNECT` and absolute-URI `http:`). A process that ignores the proxy variables has no network.
- The proxy refuses any destination that resolves to a non-public address (loopback, RFC 1918, link-local, metadata, and their IPv6 forms) and any port outside `ALLOWED_PORTS` (default 80 and 443). It resolves once and connects to that address.
- **There is no host allowlist, no per-user or per-destination rate limit, and no per-user connection cap.** The only limits are a global `MAX_CONNECTIONS` (256) and timeouts. Every request is logged to the proxy's standard output as one line (`allow|deny`, source address, method, `host:port`, reason); nothing is stored per user in a database and no admin page shows it.
- **So any user can already point `curl`, `sqlmap`, `ffuf` or `nuclei` (all of which can use an HTTP proxy) at any public website on ports 80 and 443 through our egress address.** Private networks, other ports and non-HTTP protocols are out of reach. For developers this was a minor point; for security professionals it is the central risk (plan-phase-6 D2).
- What cannot work, by construction: raw or UDP scans, ICMP, SSH or database ports, anything on a port other than 80 or 443, and any internal network of a client.

## Verified: packages in Debian 12 (aarch64) that matter here

Installed or checked with `apt-cache policy` against the pinned base image. "Yes" means a Debian package exists at the version shown; versions are the Debian ones and are older than upstream releases.

- **Yes:** `nmap 7.93`, `tcpdump 4.99`, `tshark 4.0.17`, `whois`, `dnsutils`, `jq 1.6`, `git 2.39`, `python3 3.11` with `pip` and `venv`, `yara 4.2.3`, `binutils 2.40`, `file`, `binwalk 2.3.4`, `gdb 13.1`, `ltrace`, `strace 6.1`, `sqlmap 1.7.2`, `hydra 9.4`, `john 1.9.0`, `libimage-exiftool-perl` (exiftool 12.57), `ripgrep 13`, `p7zip-full`, `unzip`, `openssl 3.0`, `netcat-openbsd`, `socat`, `curl 7.88`, `wget`, `golang-go 1.19`, `ffuf 1.1.0`, `gobuster 3.5`, `masscan 1.3.2`, `sslscan 2.0.7`, `testssl.sh 3.0.8`, `whatweb 0.5.5`.
- **No Debian package:** `radare2`, `semgrep`, `gitleaks`, `trufflehog`, `nuclei`, `trivy`, `osv-scanner`, `zaproxy`, `nikto`. These come from PyPI (semgrep, bandit, checkov, mitmproxy), from upstream release binaries (gitleaks, trufflehog, nuclei, trivy, osv-scanner, a newer ffuf), or are skipped. Release binaries must be pinned by version and checksum **per architecture**, in the way [build-pinning.md](build-pinning.md) already does for the base images.
- **Not measured:** which of the release binaries exist for both aarch64 and x86_64, and their licences (a few of these tools have restrictive terms for commercial hosting; check each before shipping).

## Verified: cost of a toolset

- The base plus `bubblewrap` is **350 MB**. The same base plus `bubblewrap, nmap, strace, gdb, tcpdump, curl, netcat, python3 (pip, venv), yara, binutils, file, git, jq, ripgrep, unzip, sqlmap, ffuf, exiftool, tshark, ca-certificates` is **990 MB**: about **+640 MB** and **32 s** to build on this machine (with the layer cache cold for that step).
- The shipped sandbox image (`dsh-sandbox`) is **2.89 GB** today, almost all of it the harness. A toolset of this size makes it about 3.5 GB. Toolsets with Java (ZAP) or large databases (vulnerability scanners keep theirs on first run, in the user's volume, not in the image) would add more; not measured.

## Verified from sources: model privacy

From OpenRouter's documentation (found by search; the pages were summarised, not read in full; the official privacy and logging page should be re-read before relying on this):

- OpenRouter's request field `provider.data_collection` defaults to `allow`; `deny` routes only to providers that do not store prompts non-transiently or train on them, and **the request fails if no provider qualifies**. A separate field `provider.zdr: true` routes only to endpoints with a zero-data-retention policy.
- OpenRouter states it does not retain prompts unless the account opts in to prompt logging. The risk is the **upstream provider behind a model**: documentation says some providers may train on prompts unless the account or request opts out, and some retain data for a safety period.
- A (third-party mirror of the) documentation lists a free variant of one model as retaining data and "may train" while the paid variant does not. **Whether the `openrouter/free` router honours `data_collection: deny`, and which free endpoints would remain, was not tested** (it would need real model calls).
- Consequence for the plan: the free router must not be the default for client-confidential security work until this is understood, and the llm-proxy is the place to enforce a privacy setting for every call.

## Verified from the harness source and docs: how plugins reach a sandbox

Read in `../deepseek-harness` (`packages/skill`, `packages/mcp`, `packages/connector`, `packages/boot/plugin-manager`, `docs/config-catalog.md`):

- **Skills** (instruction bundles loaded only when needed): the filesystem provider scans project, user and **custom directories** for a `SKILL.md` folder (or a flat `<name>.md`) with YAML frontmatter, watches them, and has the options `customSkillDirs` and `bundledSkillDir` (default from `$DSH_BUNDLED_SKILL_DIR`). So a skills bundle can ship **in the image** and appear in every user's catalog with no harness change.
- **MCP servers:** `dsh-mcp-client` supports a **stdio** server (a spawned child process, with `command`, `args`, `env`) and a Streamable HTTP server with OAuth. So a security-knowledge server can ship in the image as a local process. `mcp-manager` runs a settings-driven fleet of them.
- **Plugins:** the harness's own plugins (TypeScript, Cordis) are enabled or disabled through the Plugin Manager and a profile's `cordis.patch.yml`; the Manager can also **install external bundles** (a registry name, an absolute path, or a `link:` path). The connector plugins (Linear, Notion) show the shape: they register an MCP server and add guidance to the system prompt.
- **Not verified:** that a plugin built outside the harness repository and baked into the image as a bundle can be enabled by our entrypoint patch (the mechanism reads as if it can; nothing was built to test it); how a plugin adds its own tools and a page to the UI beyond the connector examples (`docs/cookbook/adding-a-tool.md` describes tools).

## Architecture note

The probes ran on aarch64. Several things change on x86_64 production hosts: exploit-development and many reverse-engineering workflows are x86-centric (a native debugger on aarch64 will not run x86 binaries; emulation under gVisor was not tried), some release binaries are published for one architecture first, and image sizes differ. The plan treats the build host's architecture as an explicit decision (phase 6, open decisions).

## Not verified

- Each security tool running in the harness's confined shell (the network and environment were checked in the spike above, with only `node` available), and which extra writable roots a tool needs (relevant for caches, plan task S6-2).
- Real model behaviour on security tasks: whether the models behind `openrouter/free`, or a paid default, refuse routine defensive and authorised-testing requests, or produce poor results. This needs a small set of representative prompts run against the chosen model before the audience is promised anything.
- The hosting provider's acceptable-use policy for outbound security testing traffic (no production host is chosen yet).
- Legal questions about hosting security tools and about users' authorisation. These are for counsel, not for this repository.
