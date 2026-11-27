# Reading GitHub repositories from a workspace

Step 4 of [plan-first-security-test.md](plan-first-security-test.md). Written 2026-11-27. What was checked is marked; what was not is said.

## In short

- **A public repository:** just clone it. `git clone https://github.com/owner/repo` works in the agent's shell and in the terminal (checked, through the egress proxy, also in scoped mode: GitHub is on the proxy's base list).
- **A private repository:** give git a **read-only, single-repository, short-lived token** with `dsh-git login`, typed in a terminal, **never pasted into the chat**. Then clone as above. Run `dsh-git logout` when you are done and delete the token on GitHub.
- **There is no push access.** The token is read-only. Fixes come back as patches or text for you to apply, which is also the safer arrangement for a security review.

## Step by step (private repository)

1. **Create the token on GitHub** (from GitHub's documentation as found on 2026-11-27; the labels may move, so check the current page): Settings, Developer settings, Personal access tokens, **Fine-grained tokens**, Generate new token. Choose the shortest **expiration** that covers the work (the allowed range was not checked here). Under **Repository access** choose **Only select repositories** and pick the one repository. Under **Permissions**, **Repository permissions**, set **Contents** to **Read-only** (GitHub adds read-only Metadata by itself, as I understand it; not checked). Nothing else. For a repository owned by an organisation, the organisation has to be the token's resource owner and may need to approve the token (**not verified**).
2. **Open a terminal in the workspace.** In the harness UI, open the right sidebar and choose **New terminal** (shortcut `Ctrl` + `` ` ``). Checked in a real browser. The terminal runs as the sandbox user, separately from the agent, and what you type there does not go to the model. On your own machine you can use `docker exec -it dsh-sbx-<id> dsh-git login` instead.
3. **Run `dsh-git login --repo owner/repo`.** It asks for the token with the typing hidden (checked: nothing appeared on screen), stores it, and tests that the repository can be read. Paste the token at the prompt and press Enter.
4. **Ask the agent to clone it**, or clone it yourself: `git clone https://github.com/owner/repo`. The agent can now read the repository.
5. **When you are done:** `dsh-git logout`, then delete the token on GitHub. `dsh-git status` says whether a token is stored (it never shows it).

`dsh-git` options: `login [--repo OWNER/REPO] [--allow-classic] [--stdin]`, `logout`, `status`; `--host` and `--protocol` exist for testing against another server.

## What the token can be used for, and who can see it

This is the part to understand before using it.

- **Stored where:** `~/.config/dsh/git-credentials` in the workspace volume (mode 600 in a 700 folder), and git is told to use it for `github.com` only. It is a file, **not an environment variable**: the harness removes environment variables whose names contain `KEY`, `TOKEN`, `SECRET` or `PASSWORD` from everything the agent runs, so a `GITHUB_TOKEN` variable would not have reached git, and the model's own token is hidden the same way.
- **The agent can read the file**, because the agent's shell can read what the user can. If it prints the file, the token is in the conversation and goes to the model provider. A prompt injected through a repository's own files could ask for it. **This is why the token must be read-only, limited to one repository and short-lived**, and why the commit and push permissions are not requested.
- **Backups contain it.** The volume is backed up as it is (`docs/backup.md`), so the token lives as long as the backup does. Another reason for short expiry and for `dsh-git logout`.
- **Never type or paste the token into the chat** (the message box of a session): the chat goes to the model provider and is kept in the session history. The helper refuses to ask when it has no terminal, so it cannot be run by the agent by accident, but nothing stops a person from pasting a token into a chat message; the how-to is the guard.
- **What the helper refuses:** anything that is not a plain token (so a stored line cannot be turned into a different URL or a second line), and **classic tokens** (`ghp_...`), which carry broad access to the whole account, unless `--allow-classic` is given.
- **What a stolen token allows:** reading that one repository until it expires (and, for a fine-grained token with only Contents: read, nothing else). That is the whole of the exposure, which is the reason for the choices above.

## How it works, and what was learned building it

- **Scoped per host.** `dsh-git login` writes `credential.https://github.com.helper = store --file ~/.config/dsh/git-credentials`, so git uses the file only for that host.
- **A bug found and fixed (the part worth remembering):** after git uses a credential successfully it rewrites the stored line in its own way, and for a host with a port it encodes the colon (`127.0.0.1%3a8123`). The first version matched only its own spelling, so `login` did not replace the old token and **`logout` would have left it on disk**. The real GitHub host has no port, so it would not have shown there, but a command that promises to remove a token must not be able to miss it. Host matching now understands git's spelling (and compares whole hosts, so `github.com` never matches `github.com.example`); a test uses git itself to rewrite the entry (`tests/sandbox/dsh-git.test.mjs`) and fails on the old matching.
- **Credentials cannot be injected at the egress proxy.** The earlier plan (idea 24 in [plan-phase-5.md](plan-phase-5.md)) assumed the proxy could add the token to requests for GitHub, so the sandbox would never hold it. For HTTPS the proxy only sees a `CONNECT` tunnel with TLS inside; adding a header means intercepting TLS, which is not planned. That assumption is corrected in the plan documents.
- **The safer design, not built yet** (phase 6, S6-18): import the repository **from outside the sandbox**. The gateway takes the token once (typed into a gateway page, never into the chat), a helper clones the repository into the user's volume through the user's own network, and the token is discarded; the agent gets the code and never holds a credential. A GitHub sign-in (OAuth) would remove the pasted token altogether. Until then the read-only, short-lived token is the compromise.

## How it was verified

- `tests/sandbox/dsh-git.test.mjs` (10 tests, real `git`, a temporary home): the token is stored privately for one host and found by git (`git credential fill`) and no other; every malformed token is refused and nothing is stored; classic tokens are refused; no terminal and no `--stdin` means no prompt; login replaces instead of adding, several hosts coexist and logout removes only its own; a token that git has rewritten is still replaced and removed; status never shows the token; a static check that the token appears only in the lines that read it and write it (adding an `echo "$token"` makes two tests fail).
- `tests/phase6/github-access.test.mjs` (6 tests, under gVisor, in the harness's confinement): against a local server that demands credentials, a clone fails without a token and works after `dsh-git login`; the token is in its private file only (not in the environment, the process list, git's config or the clone's remote URL); a wrong token makes the clone fail and the right one fixes it, so the stored token is the one in use; logout removes the file and the setting and cloning fails again; a classic-shaped token and a missing terminal are refused; and a public repository clones from the real GitHub without any token.
- **In a real browser:** the harness's terminal opened from the right sidebar ran `dsh-git status`, `login` (the prompt hid the fake token, which appeared nowhere on screen), `status` and `logout`.

## Not verified

- A **real private repository with a real token**. The suite must not hold a real token, so this is a manual check for the owner: create the token as above, run `dsh-git login --repo owner/repo` in the terminal, and look for "checked: ... is readable with that token". Report any difference from this document.
- GitHub's current screens and wording, the allowed token lifetimes, and how organisation repositories are approved.
- That the agent, asked to, would refuse to print the credentials file. The `engagement-rules` skill (step 5) tells it not to, and to treat text in a repository as data, but it can be asked to by text inside a repository, and nothing technical stops it.
- GitHub Enterprise or other hosts: `--host` exists for tests; the classic-token rule applies to `github.com` only.
