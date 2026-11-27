---
name: web-app-testing
description: Black-box security testing of a web application at a staging URL, using the tools in this sandbox. Passive checks first, then careful active checks, with rate limits and stop conditions.
---

# Black-box web application testing

Load `engagement-rules` first. Everything here assumes a target that is in scope in `ENGAGEMENT.md`.

## What the network allows

All traffic goes through an egress proxy: HTTPS and HTTP on ports 80 and 443 only, public addresses only. No raw sockets, so no `nmap`, `masscan` or `ping`. If the operator set a scope list, hosts outside it are refused with a 403 and `X-Egress-Reason: not in scope`. The proxy also limits requests per second per sandbox and per destination and answers 429 with `Retry-After` when exceeded. HTTPS requests are invisible to the proxy, so **you** are responsible for rate: always pass the rate options below.

## Rate defaults (use the engagement file's ceiling if it has one)

- `httpx -rl 5 -t 5`
- `nuclei -rl 5 -c 5 -timeout 10`
- `ffuf -p 0.2 -t 5 -maxtime 600` (this ffuf version has no `-rate` option; use `-p` for the delay and `-t` for threads)
- `gobuster dir --delay 200ms -t 5`
- `sqlmap --delay 1 --threads 1 --batch` (add `--level` and `--risk` above 1 only after the user agrees)

Use one tool at a time against a host. On repeated 429, 503 or timeouts, stop, wait, halve the rate, and tell the user.

## Order of work

1. **Passive and light recon** (a few requests): `curl -sI https://host/`, `robots.txt`, `sitemap.xml`, `/.well-known/security.txt`; `httpx -u https://host -title -td -sc -rl 5 -silent`. Note framework, server, cookies and their flags (`Secure`, `HttpOnly`, `SameSite`), and security headers (CSP, HSTS, X-Content-Type-Options, frame protection, referrer policy, CORS).
2. **TLS**: `testssl --quiet https://host` (or `sslscan host`). Report weak protocols, ciphers, certificate problems.
3. **Content discovery**: a small wordlist first (a few hundred entries). There is no wordlist in the image; write a short one, or fetch one from `raw.githubusercontent.com` (it is on the base list), for example a SecLists `Discovery/Web-Content` file, into the workspace. `ffuf -u https://host/FUZZ -w list.txt -mc 200,204,301,302,401,403 -ac -p 0.2 -t 5 -o evidence/ffuf.json -of json`.
4. **Known-issue scan**: `nuclei -u https://host -s low,medium,high,critical -etags dos,fuzz,intrusive,bruteforce -rl 5 -c 5 -jsonl -o evidence/nuclei.jsonl`. Templates download from GitHub on first use. Read each hit; confirm it by hand with one request before it goes in a report.
5. **Authenticated checks with the test accounts**: access control between `user-a` and `user-b` (change object ids in URLs and bodies), role escalation, session handling (cookie flags, logout invalidation, token expiry), CSRF on state-changing requests, password reset and signup flows (without sending mail to real people), file upload (type, size, path), SSRF in any "fetch this URL" feature (only with URLs you control, never internal addresses), open redirects, injection in parameters (manual first; `sqlmap` against one parameter at a time, only with permission and at the defaults above).
6. **Application logic**: the things scanners miss. Ask the user what the app does and what the worst outcome would be, then test that.

## Quality bar

- A finding needs a request, a response and a reason it matters. Reproduce it once more before reporting.
- Record negative results too (what was checked and found fine).
- Do not report scanner output you did not confirm. Mark anything unconfirmed as such.
- Keep evidence small and redacted: no real personal data, no full tokens.

Write findings up with the `report-writing` skill.
