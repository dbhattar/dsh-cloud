# Phase 6: a workspace for security professionals

Status: **design and task breakdown (2026-11-26); nothing here is built.** The first users are cybersecurity professionals. This document records that decision, what it changes, the risks it adds, the plugins it needs, and the tasks, in the order they should be done. Facts about the sandbox, the tools and the harness were measured or read in source and are in [research-security-tooling.md](research-security-tooling.md); anything not checked is marked **to verify**. Builds on [plan-phase-5.md](plan-phase-5.md) (the experience work and the admin panel, most of which is done; email, the waiting room, per-user overrides and deleting a user's data are still open there) and [plan-phase-4.md](plan-phase-4.md) (isolation). Parent plan: [plan.md](plan.md). Working rules: [../AGENTS.md](../AGENTS.md).

The shortest route to a first real use (testing the owner's own two staging web apps and reading their GitHub repositories) is in [plan-first-security-test.md](plan-first-security-test.md); it takes a subset of the tasks below in a different order.

## Context

Phase 5 assumed developers who build software and deferred the toolbox (tasks P5-4 and P5-5). The first real audience is different: security professionals who analyse, review and test, and who handle other people's confidential material. Two things follow.

1. **The workspace has to contain the tools of the trade**, and many of them make assumptions the sandbox deliberately breaks (raw sockets, root, arbitrary ports, a debugger that can run programs).
2. **The product's biggest risk changes.** For developers, the risk was a user hurting the platform or other users; Phase 4 closed that. For this audience the new risks are the platform being used to **attack third parties**, and **leaking what users entrust to it** (client logs, findings, credentials, malware samples).

The design below keeps the isolation model unchanged and builds the audience's needs around it, rather than loosening it.

## Decisions

| Question | Decision | Consequences |
| --- | --- | --- |
| Who are the first users? | **Security professionals** (decided 2026-11-26) | Supersedes "Developers" in [plan-phase-5.md](plan-phase-5.md). Developers stay a supported secondary audience: the developer toolbox is a subset of this one. |
| What work does v1 serve? | **Recommended: defensive analysis, application-security review, detection engineering, incident triage, threat intelligence and reporting; then scoped web-application testing.** Network penetration testing, red-team operations, internal-network work and running malware are **not** v1 | Each of these fits the sandbox as it is (no raw network needed) or needs only a controlled HTTP(S) path. See "What fits" below. To confirm with the owner. |
| Raw network access (scans, arbitrary ports, VPN into a client) | **No, in tenant sandboxes** | Fixed by the isolation design (internal networks, dropped capabilities, no root). A trusted scanner service (task S6-13) or a customer-side runner (later) are the ways in, not a looser sandbox. |
| Model for confidential material | **The free router is not acceptable for client data** until its data handling is understood; the llm-proxy enforces a privacy setting on every call | Task S6-4. A paid zero-retention default model and bring-your-own-key follow. |
| Authorisation and conduct | **Explicit acceptance of an acceptable-use policy; scope declared before active testing** | Tasks S6-5 (acceptance) and S6-14 to S6-16 (scope). The policy text is the owner's (and counsel's) to write. |
| Branding, domain, legal pages | open (as in phase 5) | Now blocking an invitation to outside professionals: the acceptable-use policy is a legal page. |

## Who the users are and what fits

| Persona | Typical jobs | Needs from the workspace | Fit today |
| --- | --- | --- | --- |
| **AppSec engineer** | Code review, dependency and secret scanning, infrastructure-as-code review, threat modelling, fix verification | git, Python and Go toolchains, `semgrep`, `bandit`, `gitleaks`, `trufflehog`, `trivy`/`osv-scanner`, repository access over HTTPS | **Fits** the sandbox as is (HTTPS through the proxy reaches GitHub and package registries). Needs tools and caches (S6-1, S6-2). |
| **SOC analyst / incident responder** | Triage alerts, read logs and exports, build timelines, extract indicators, write reports | `jq`, `ripgrep`, DuckDB or similar for big logs, `tshark -r`, `yara`, Windows event-log tools (Chainsaw, Hayabusa), a place to put evidence, a report template | **Fits**; analysis needs no network. Large files need upload (see below). |
| **Detection engineer** | Write and test Sigma, YARA and similar rules against sample data | `sigma-cli`/pySigma, `yara`, sample-log fixtures, a test loop | **Fits.** |
| **Threat-intelligence analyst** | Research actors and techniques, map to ATT&CK, summarise reports, defang and hash indicators | knowledge lookups (ATT&CK, CVE, KEV, EPSS, CWE), document summarisation (vid2doc turns conference talks into documents) | **Fits.** The lookups are the plugin in S6-7. |
| **Web-application tester** (authorised) | Recon, fuzzing, injection testing, TLS checks against targets they are authorised to test | `httpx`, `nuclei`, `ffuf`, `sqlmap`, `testssl.sh`, a proxy, reach to the target over HTTP(S) | **Partly**: HTTP(S) on 80 and 443 to public targets already works through the egress proxy; other ports, internal staging and any scope control **do not exist**. Slice C. |
| **Penetration tester / red team (network)** | Port scans, protocol attacks, lateral movement, C2 | raw sockets, arbitrary ports, internal reach | **No** (by design). A trusted scanner service gives constrained scans; the rest needs a customer-side runner (later). |
| **Reverse engineer / malware analyst** | Static and dynamic analysis of binaries | `binutils`, `radare2`/`ghidra`, `yara`, `binwalk`, a debugger that runs programs | **Static only.** `gdb` cannot run programs under gVisor here (measured); running unknown malware in a shared multi-tenant service is not a v1 goal. |

## What the sandbox can and cannot do (measured; details in the research note)

- **Works:** a non-root user, `nmap -sT` against loopback, local servers on loopback to practise against, `strace`, static `gdb`, `yara`, `sqlmap`, Python virtual environments in the workspace, the harness's own bubblewrap confinement beside these tools.
- **Does not work, by design:** raw sockets and SYN scans, live packet capture, running programs under `gdb`, installing anything with `apt` at run time (read-only root), reaching any port other than 80 and 443, reaching any private address.
- **The path out:** only the egress proxy (HTTP `CONNECT` and plain HTTP, public addresses, ports 80 and 443). **It has no host allowlist, no per-user rate limit and keeps no per-user record in a database.** Any user can already aim `curl`, `sqlmap`, `ffuf` or `nuclei` at any public website through our egress address. This is the first thing to address, before the audience is invited (S6-11 and S6-12).
- **Cost:** a security toolset adds about 640 MB to the image (to about 3.5 GB) and 30 s to a build on this machine. The VM is aarch64; production will probably be x86_64.

## New risks this audience brings

1. **Misuse against third parties.** A hosted multi-tenant service whose users run exploitation tools becomes, in the eyes of the internet, an attacker: abuse reports, blocked address ranges, a suspended hosting account. Mitigations are layered: terms and attestation (who agreed to what), scope enforcement at the network edge (what can be reached), rate limits (how hard), accountability (who did what, from the egress record), and a kill switch (admin suspend already stops a workspace; egress needs its own view and switch).
2. **Confidential data.** Users will put client logs, findings, credentials and samples into the workspace and into prompts. Everything the agent reads goes to the model provider. Volumes are not encrypted at rest and backups are plain copies ([backup.md](backup.md)). The audit log never holds content (kept), but that also means an admin cannot see what a user did, only metadata.
3. **Malicious material.** Samples and exploit code are stored in volumes we back up and host. Static handling only in v1; no execution of samples; a rule that nothing from a workspace is ever opened by an admin (already true: the admin panel shows no content).
4. **Model behaviour.** Models may refuse routine defensive work or write poor exploit code; provider policies may restrict security content. **To verify** with representative prompts before promising anything (research note, "Not verified").
5. **Hosting and legal.** The host's acceptable-use policy, export rules for security tools, and the legal framing of "authorised testing" are the owner's to settle with counsel. This document does not give legal advice.
6. **One workspace per person.** Consultants work for several clients; mixing their material in one workspace is a confidentiality problem. See "Engagements".

## Design

### D1. What v1 serves, and what it does not

v1 serves the first five personas fully and the web tester partly (slice C). It does not serve network pentesting, internal testing, or malware execution, and says so plainly in the welcome text and the terms, rather than appearing to. The reasons are structural (see "What the sandbox can and cannot do"), not temporary gaps.

### D2. Network posture, in tiers

| Tier | What a sandbox can reach | Who it is for | Status |
| --- | --- | --- | --- |
| **0: research egress (today)** | any public host on 80 and 443 through the proxy; nothing else | analysis, code review, package and repository access, CVE lookups | exists; **must gain rate limits, an accountability record and an admin view before the audience is invited** (S6-11, S6-12) |
| **1: scoped testing** | only the targets the user has **declared and proved they control (or been authorised to test)**, on the ports they declare, at limited rates; the general research allowlist stays for registries and knowledge sources | the authorised web-application tester | slice C (S6-10 to S6-12) |
| **2: constrained scanning service** | a trusted component (not the sandbox) runs a limited `nmap -sT`-style scan **of verified scope only**, with rate limits, and returns the result as a file | testers who need ports and service detection | later (S6-13) |
| **3: customer-side runner** | a small runner in the customer's own network connects out to the gateway; the workspace's tools run against internal targets through it | internal and network testing | not planned in this phase; noted so nothing is built that prevents it |

Tools that speak HTTP through a proxy (`curl`, `httpx`, `nuclei`, `ffuf`, `sqlmap`, `testssl.sh` through `CONNECT`, `mitmproxy`) work in tiers 0 and 1. Tools that open their own sockets (`nmap`, `masscan`, `hydra`) do **not** work in tenant sandboxes and are not shipped for that purpose.

**Scope enforcement belongs in the egress proxy, not in the agent.** A model or a plugin asked to "stay in scope" can be talked out of it; a proxy that refuses is not. The scope record is held by the gateway (the sandbox cannot write it) and the proxy asks the gateway for the allowlist of each user network. Targets are accepted after **ownership verification** (a DNS TXT record or a file at a well-known path, the usual way hosted scanners do it) or from a short published list of intentionally vulnerable training targets. Nothing about this is built yet; it is the largest piece of the phase.

### D3. The toolbox, in packs

One image for v1 (the runner takes one image setting; per-user images would need a runner change, noted as later). Packs keep the choices reviewable:

- **Core** (every user): `git`, `python3` with `pip` and `venv`, `build-essential`, `jq`, `ripgrep`, `unzip`/`7z`, `curl`, `openssl`, `file`, `binutils`, `sqlite3`. This is the old P5-4 list.
- **Analysis**: `yara`, `binwalk`, `exiftool`, `tshark`/`tcpdump` (for reading capture files), `sigma-cli`/pySigma, `volatility3`, `pefile`/`lief`/`capstone` (pip), a log-query tool (DuckDB), Chainsaw and Hayabusa (release binaries), `radare2` (release; no Debian package).
- **AppSec**: `semgrep`, `bandit`, `checkov` (pip), `gitleaks`, `trufflehog`, `trivy`, `osv-scanner` (release binaries, pinned by checksum per architecture), `npm audit`/`pip-audit`. Vulnerability databases are fetched into the user's volume on first use through the proxy.
- **Web testing** (useful only with tier 0 or 1 egress): `httpx`, `nuclei` and its templates, `ffuf`, `gobuster`, `sqlmap`, `testssl.sh`/`sslscan`, `mitmproxy`, `whatweb`.
- **Not shipped, on purpose:** exploitation frameworks (Metasploit), C2 frameworks, password crackers (CPU-limited anyway), and anything whose point is raw network access. `nmap` and `masscan` are in Debian but are not installed in the tenant image: they would only mislead (no raw sockets, no route). A connect-scan `nmap` against loopback is the one use that works; that does not justify shipping it.

Rules that keep the image trustworthy: release binaries are pinned by version and SHA-256 **per architecture** and fetched by a script (`scripts/pin-tools.sh`, in the style of `pin-images.sh`), verified at build, and their licences checked before inclusion (**to verify per tool**). Nothing is installed at run time except into the user's own volume (`pip install --user`, `go install`, `npm`), which works because the home directory is writable and the proxy reaches the registries (caches: S6-2).

### D4. Plugins

"Plugin" means three different things in the harness; the plan uses each where it is cheapest. Mechanisms are in the research note.

| # | Name | Kind | What it does | Why it is needed | Where it lives and how it ships | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Methodology skills** | skill bundle (markdown, no code) | `secure-code-review`, `web-app-testing` (scope first, OWASP-style), `incident-triage`, `log-analysis`, `detection-engineering` (write, test, tune Sigma and YARA), `threat-modelling`, `cvss-scoring`, `malware-static-triage` (safe handling), `passive-recon`, `report-writing`, and an `engagement-rules` skill (read the engagement file, stay in scope, stop conditions) | Turns a general agent into one that follows professional method and the platform's rules; cheapest and highest value | `sandbox/skills/<name>/SKILL.md` in this repository, copied to `/opt/dsh-skills` and pointed at by `DSH_BUNDLED_SKILL_DIR` (a documented option of the harness's skill provider) | S |
| 2 | **`dsh-security-kb`** | local MCP server (stdio) | Tools: CVE lookup, CISA KEV membership, EPSS score, CWE and ATT&CK technique lookup, OSV package vulnerabilities, a deterministic **CVSS v3.1 and v4 calculator**, indicator **defang/refang** and hashing | Models get CVSS maths and identifiers wrong; lookups must be exact. An offline snapshot of ATT&CK and CWE makes the common queries work with no network; fresh data goes through the proxy and is cached in the workspace | A small Python or Node program in `sandbox/mcp/security-kb/`, configured as a `dsh-mcp-client` stdio entry by the entrypoint patch | M |
| 3 | **`engagement`** | harness plugin (TypeScript) | Reads the engagement file (scope, authorisation reference, rules, out-of-scope, contacts) and adds it to the system prompt; a `scope_check(target)` tool that tests a host, URL or address against the declared scope deterministically | Makes the agent scope-aware and gives it a reliable check before it runs a tool. **Advisory only**: enforcement is the egress proxy (D2); the plugin reads a copy of the gateway-held scope | Needs harness code (see "to verify" below) | M |
| 4 | **`findings`** | harness plugin (TypeScript) | Tools to add, update, list and remove findings (title, severity from the CVSS calculator, affected asset, description, steps, evidence file paths with hashes, status, remediation); exports a report (Markdown, then Word or PDF) from a template | The core deliverable of the work. Free-form chat does not keep findings consistent; structured tools do. Evidence hashing gives integrity | Needs harness code; a page in the harness UI is a later, separate step | L |
| 5 | **Integration connectors** | connector plugins (MCP, hosted) | Jira and Linear (a Linear plugin already exists in the harness), GitHub, later DefectDojo and a SIEM connector; export findings, open tickets | Findings leave the workspace into the team's tracker | Hosted MCP servers reached through the egress proxy; credentials in the sandbox are a risk, so a credential-injection path in the proxy is a prerequisite for anything beyond OAuth | M each; later |
| 6 | **Egress awareness (not a plugin)** | gateway and proxy feature | The user sees what they have contacted and what was refused (so the agent's "it failed" can be explained) | Reduces confusion when scope blocks something | Admin and user pages in the gateway | S |

**To verify before plugins 3 and 4 are committed to:** whether a plugin built **outside** the harness repository can be baked into the image as an external bundle and enabled by an entrypoint patch (the Plugin Manager can install bundles by path, so it reads as possible); if not, the plugins go into the harness repository (upstream or a fork), which conflicts with the rule that harness behaviour is changed by configuration, and would need an explicit decision. Plugins 1 and 2 need no harness change and should come first.

### D5. Model privacy for confidential work

- **Enforce at the proxy.** The llm-proxy adds the provider's data-handling request fields (OpenRouter's `provider.data_collection: deny`, and `zdr: true` where available) to every upstream call, controlled by a setting on the Policies page (P5-15) so it can be changed without a restart. **To verify** whether the free router accepts it and which free endpoints remain; if none qualify, calls fail, which is the correct outcome for confidential work, and the default model for this audience is a paid one.
- **Say what is sent.** The welcome text states that the agent's reads and prompts go to a third-party model provider and under which setting. A banner appears while the privacy setting is off.
- **Bring your own key** (idea 27 in the phase 5 list) moves up: a firm with its own zero-retention agreement should be able to use it.
- **Secrets hygiene.** A skill tells the agent to search for and redact credentials before quoting material; `gitleaks` is in the image. This reduces, and does not remove, what reaches the provider.
- **At rest.** Volume and backup encryption is host-level work (disk encryption, encrypted backup target) and is recorded as a deployment requirement in the operations docs, not built in this repository.

### D6. Engagements

A consultant works on several clients. Recommended v1: an **engagement** is a folder in the workspace with an `ENGAGEMENT.md` (client, scope, authorisation reference, dates, rules) and its own harness workspace entry, and the gateway holds the matching scope record for enforcement. Separate sandboxes or volumes per client would isolate better and need runner and gateway changes (a user would own several sandboxes); that is listed as a later option, and the limitation (one volume per person) is stated in the terms and welcome text.

### D7. Accountability, conduct and the kill switch

- **Terms and attestation.** The user accepts an acceptable-use policy (test only what you own or have written authorisation to test; no denial of service; no malware deployment; no targeting of third parties; contact for abuse reports) at first sign-in and again when its version changes. Acceptance is recorded (`user.terms_accepted`, version, time) and shown on the account page in the admin panel. **The policy text is the owner's.**
- **Egress record.** The egress proxy keeps, per user network, a record of destinations: counts per day of `host:port` allowed and denied, never content. The admin panel gets an **Egress** page: top destinations per user, denials, and anomalies. Existing audit rules hold: no content, no secrets.
- **Anomaly rules and the kill switch.** Thresholds (distinct hosts per hour, requests per minute, many distinct ports, many denials) raise an audit event and, if the admin chose it in Policies, hold the user's egress automatically. An admin can cut one user's egress without stopping their workspace.
- **Abuse reports.** A short runbook: how to find which user used an address at a time (from the egress record), what to do, whom to tell.

## Task breakdown

Each task is one topic branch and one pull request, with tests, documentation and scripts for anything repeatable, as in [../AGENTS.md](../AGENTS.md). Numbers continue the phase 5 style with an `S6-` prefix. Effort: S under a day, M a few days, L a week or more.

### Slice A: before anyone outside is invited (conduct and accountability)

| Task | What and where | Verify |
| --- | --- | --- |
| **S6-11 Egress limits** (M; **done 2026-11-27** with an operator scope list added; see [../egress-proxy/README.md](../egress-proxy/README.md). The limits are env settings; making them settings on the Policies page is not done) | Per-user connection cap and request-rate limit, and a per-destination rate limit, in the egress proxy (`egress-proxy/src/server.js`); the source address already identifies the user network. Limits as settings on the Policies page. Refusals are logged with the reason and shown to the agent as a clear proxy error | Unit tests for each limit; a Docker case: a loop of requests from one sandbox is throttled and a neighbour is not |
| **S6-12 Egress record and admin page** (M) | The proxy sends per-user daily counts of `host:port`, allow and deny, to the gateway (a small internal endpoint, not reachable from sandboxes) which stores them; an **Egress** admin page; anomaly rules raising audit events; an admin **hold egress** action per user | Unit tests for aggregation and rules; browser check; Docker case: traffic from a user appears under that user and nowhere else |
| **S6-5 Acceptable use and attestation** (S to M) | `users.terms_accepted_version/at`, a terms page and a blocking acceptance step at sign-in when the version is behind, the audit event, the admin account page shows it. The text is a placeholder file the owner replaces | Unit and browser tests; a user who has not accepted cannot reach the workspace; changing the version asks again |
| **S6-17 Copy for the audience** (S) | The welcome text, the blank-session headline (set in `gateway/web/src/pages/Shell.tsx`: "What would you like to build?") and the welcome's limits and "getting your work out" sections are written for developers who build software. Rewrite them for analysis, review and authorised testing: what the workspace is for, what it will not do (no raw network, no scans of arbitrary hosts, no running samples), what is sent to the model provider, and where the terms are | Browser check as a fresh user; the welcome tests updated |
| **S6-4 Model privacy** (M) | The llm-proxy adds the provider privacy fields to upstream calls, as a policy setting; the welcome and a banner say what is sent; a decision on the default model for this audience | Unit tests on the request the proxy sends; **to verify** against the real free router and a paid model with a handful of real calls |

### Slice B: a toolbox that does the job (supersedes P5-4 and P5-5)

| Task | What and where | Verify |
| --- | --- | --- |
| **S6-1 Toolbox in the image** (M; **first part done 2026-11-27**: the Core and Web testing packs and `gitleaks`, `osv-scanner`, `bandit`, `pip-audit`; the Analysis pack and `semgrep` and `trufflehog` are not done, see [research-security-tooling.md](research-security-tooling.md) for why those two were left out) | The Core, Analysis and AppSec packs in `sandbox/Dockerfile`; release binaries by `scripts/pin-tools.sh` (version and SHA-256 per architecture, in the style of `scripts/pin-images.sh`, listed in CI); record image size and build time; the harness `--dump-config` unchanged | A Docker case that runs one command from each pack inside the harness's confined shell under gVisor; the pin script fails correctly on a wrong checksum; licences listed in the doc |
| **S6-2 Caches and user-installed tools** (S to M; **done as a side effect of S6-1**: no extra writable roots are needed because `HOME` is under `/workspace`, and `pip` and virtualenvs work; the disk accounting of caches and the backup of them are unchanged because they live in the workspace volume) | pip, npm, Go and tool-database caches in the user's volume with the cache variables set in the entrypoint; the cache and install directories added to the shell policy's extra writable roots (the known pitfall from P5-5); disk accounting includes them | Docker case: `pip install --user` and `go install` work in the confined shell, the second install hits the cache, files survive a restart, backup and restore include them |
| **S6-3 Methodology skills** (S) | The ten skills in `sandbox/skills/`, shipped to `/opt/dsh-skills`, `DSH_BUNDLED_SKILL_DIR` set by the entrypoint patch | A test that every skill has valid frontmatter and a body within a size budget; the live harness lists them (checked with `--dump-config` and in the browser) |
| **S6-6 Web-testing pack** (S) | The Web testing pack (`httpx`, `nuclei`, `ffuf`, `gobuster`, `sqlmap`, `testssl.sh`, `mitmproxy`) added after S6-11 and S6-12 are in, so the pack is not shipped before its limits | As S6-1 for these tools, through the proxy, against a local target and a refusal for a private address |

### Slice C: plugins

| Task | What and where | Verify |
| --- | --- | --- |
| **S6-7 `dsh-security-kb`** (M) | The stdio MCP server in `sandbox/mcp/security-kb/` with an offline ATT&CK and CWE snapshot, KEV, EPSS, OSV and NVD lookups through the proxy with a cache, the CVSS calculator, defang and hash tools; configured by the entrypoint patch | Unit tests with known CVSS vectors and fixtures; a Docker case that the harness lists and calls its tools; offline queries work with no egress; lookups respect the proxy |
| **S6-8 External-plugin spike** (S) | Build a trivial plugin outside the harness repository, bake it into the image and enable it by patch, to settle D4's open question. Write the result into the research note | Works or does not, recorded either way; decides where S6-9 and S6-10 live |
| **S6-9 `engagement` plugin** (M) | System-prompt context from `ENGAGEMENT.md` and the `scope_check` tool; the file is a copy of the gateway-held scope (S6-14) | Unit tests of the scope matcher (domains, wildcards, CIDR, ports, redirects to out-of-scope hosts); live check in the harness |
| **S6-10 `findings` plugin** (L) | The findings tools, evidence hashing, report export from templates; a UI page is a later step | Unit tests; a Docker case that a finding with evidence exports a report; a deliberately corrupted evidence file is flagged |

### Slice D: scoped active testing (the risky slice; needs the owner's decisions on terms first)

| Task | What and where | Verify |
| --- | --- | --- |
| **S6-14 Engagement and scope record** (M) | A gateway page and API to declare an engagement: client name, scope entries (domains, address ranges up to a size limit, ports), the authorisation reference, dates; a copy written read-only into the workspace for the plugin | Unit tests of validation (size limits, overlap with our own ranges and private ranges refused); audit rows |
| **S6-15 Ownership verification** (M) | DNS TXT and well-known file challenges for each target, run by the gateway; a short list of intentionally vulnerable training targets accepted without it | Unit tests with a fake resolver and fake web server; a target is refused until verified |
| **S6-16 Scope enforcement at the proxy** (L) | The egress proxy fetches each user network's allowlist from the gateway and, in testing mode, refuses everything outside the verified scope except the research allowlist (registries, knowledge sources); extra ports only for verified targets; every decision logged | Docker cases: an in-scope request passes, out-of-scope and unverified hosts are refused, a changed DNS answer pointing into scope from outside is refused, a redirect to an out-of-scope host is refused |

### Later

- **S6-13 Constrained scanning service:** a trusted component running a limited scan of verified scope with its own rate limits.
- **Customer-side runner** for internal testing (tier 3).
- **Per-engagement sandboxes** with their own volumes; encrypted per-engagement export and delete.
- **Credential injection at the proxy** for SIEM and ticketing connectors, and the connector plugins (D4 plugin 5).
- **A UI page for findings** in the harness.
- **x86_64 tooling:** native debugging and exploit-development workflows, once the production architecture is known; **dynamic analysis of samples** in a separate, purpose-built, single-tenant service rather than in the shared sandbox.
- **File upload and download** for large evidence sets (the phase 5 welcome text still says "being built").

## Order and dependencies

1. **S6-5 and S6-11, then S6-12, S6-4 and S6-17, before any outside invitation.** They are about conduct, limits and confidentiality; none of the tools matter if these are missing. S6-11 is also the cheapest large risk reduction, because the open egress is the gap that exists today.
2. **S6-1, S6-2, S6-3 in parallel** with the above (they touch the image, the runner and a skills folder, not the gateway), with S6-3 and S6-8 first because they are small and settle the plugin question.
3. **S6-7**, then **S6-9 and S6-10** once S6-8 has decided where they live.
4. **S6-6** after S6-11 and S6-12.
5. **S6-14 to S6-16** only after the owner has decided the terms and the verification method, and only when users ask for authorised active testing.

## Open decisions (the owner's)

- **Scope of v1:** is the recommendation (defensive and appsec first, scoped web testing next, no network pentesting) right for the people you have in mind?
- **Terms:** who writes the acceptable-use policy and the engagement terms, and what must a user attest? Does the hosting provider's policy allow outbound security testing traffic at all (no production host is chosen)?
- **Model:** which paid, zero-retention model is the default for this audience, and who pays? Is bring-your-own-key needed for the first customers?
- **Architecture:** is the production host x86_64 or arm64? It decides tool availability and the debugging story.
- **Plugins:** is a plugin that lives outside the harness repository acceptable if S6-8 shows it works, and if not, is a change to the harness itself acceptable for `engagement` and `findings`?
- **Engagements:** is one workspace volume per person acceptable for the first users, with the limitation stated, or are separate volumes per client required from the start?
- **Evidence:** how long are logs and backups kept, and may an admin ever be given access to a user's workspace content (the current design says never)?
- **Invitation policy:** are first users vetted individually (invites as now), and is a human review of each new account wanted before egress is enabled?

## How each item is verified

- **Tools run:** one command from each pack, through the harness's confined shell, under gVisor, in a Docker case; tools that need raw sockets are not shipped, so there is nothing to claim.
- **Limits and scope:** Docker cases in `tests/phase4`-style suites for the egress proxy (a neighbour is untouched, refusals are logged, changing DNS cannot move a target into scope).
- **Plugins:** unit tests of the pure parts (CVSS maths, scope matching), a harness run that lists and calls the tools, a skill lint.
- **Privacy:** unit tests of the request the proxy sends, then a handful of real calls recorded in the research note (the only way to learn what the free router does).
- **Everything a user sees:** a look in a real browser, as in the earlier phases.
- **Security properties stay tests:** nothing in this phase weakens the isolation, the shell confinement, the admin socket or the audit rules; if a property must change, the doc and the test change together and say so.
