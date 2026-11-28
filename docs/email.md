# Email (P5-8)

Written 2026-11-28. What was checked is marked; what was not is said. Plan: [plan-phase-5.md](plan-phase-5.md), task P5-8.

## What it does

| Message | When | Where in the code |
| --- | --- | --- |
| **Password reset link** | Someone asks on `/gw/forgot` (linked from the sign-in page) | `gateway/src/mail-flows.js` `requestReset`, routes in `server.js` |
| **"Your password was changed"** | After a reset | `passwordChanged` |
| **Invite by email** | An admin types an address in the Invites page, or `scripts/invite.sh create --email ADDRESS` | `admin-records.js`, `cli.js` |
| **Waitlist confirmation**, then **the invitation** | A visitor with no invite joins on `/gw/waitlist` ("No invite? Join the waitlist" on the sign-in page); an admin invites them from the Waitlist page | `server.js`, `admin-records.js` `waitlist`, `AdminWaitlist.tsx` |
| **"Your workspace finished working"** | An agent that was kept running after the user left (the P5-1 busy signal) goes quiet and the sandbox is stopped | `sandbox.js` `onAgentFinished`, `taskFinished` |

Mail is **off until you set `MAIL_PROVIDER`**. With the default (`log`) nothing is sent, the sign-in page has no "Forgot your password?" link, `/gw/forgot` says reset by email is not set up, the Invites page has no email box, and no notice goes out.

## Setting it up with Mailgun

From Mailgun's documentation as I know it (**not re-read for this change; check their current pages**): add a sending domain in Mailgun (a subdomain such as `mg.example.com` is usual), publish the DNS records Mailgun shows (SPF, DKIM, and the tracking and MX records it asks for) and wait until the domain shows verified, then create a **sending key** for that domain. A new account's sandbox domain only sends to addresses you have authorised in the dashboard. The key belongs in `.env` and nowhere else.

```
MAIL_PROVIDER=mailgun
MAIL_FROM="dsh-cloud <noreply@mg.example.com>"
MAILGUN_DOMAIN=mg.example.com
MAILGUN_API_KEY=...            # never in the chat, a commit or a document
MAILGUN_REGION=us              # eu if the domain was created in Mailgun's EU region
```

Then `scripts/restart.sh` and **`scripts/mail-test.sh you@example.com`**, which sends one real message and prints `mail.sent` or `mail.failed` with the reason (a wrong key shows `http_401: Forbidden`, an unverified domain a 4xx with Mailgun's own wording). All settings are in `.env.example`; the limits (`MAIL_MAX_PER_ADDRESS_HOUR`, `MAIL_MAX_PER_HOUR`, `MAIL_RESET_MINUTES`, `MAIL_TASK_NOTICES`, `MAIL_TASK_NOTICE_HOURS`) have safe defaults.

Other providers: `outbox` writes each message to the folder `MAIL_OUTBOX_DIR` as a file, to try the flows on one machine with no account. **The files hold working reset links, so it is for local use only.** Nothing else (SMTP, other APIs) is implemented; the interface is the three-method object in `gateway/src/mail.js`.

## Design

- **Sending never blocks or fails a request.** `send` decides at once (limits, queue room) and delivers in the background. A temporary failure (network error, timeout after 10 s, 429, 5xx) is retried twice more after 1 s and 4 s; a permanent one (any other 4xx, such as a wrong key) is not retried. After the last attempt the message is dropped and `mail.failed` is audited. The queue holds at most 100 messages; more are refused (`mail.skipped`, `queue_full`).
- **Limits.** Per recipient address (default 5 an hour) and for the whole gateway (default 100 an hour), counted when a message is accepted; a refusal is audited and nothing is sent. Reset requests are also limited per caller (5 an hour, every request counted) and looks at reset links per caller (20 an hour).
- **No secret in a trail.** The audit rows and logs hold the kind, the provider, the attempt count, a short reason (`http_401: Forbidden`, `network`, `timeout`) and the user id when known. They never hold an address (except the sign-in failures that already did), subject, text, link, token, password or key. The key is a non-enumerable property of the configuration, so printing or copying the configuration does not carry it. Tested by looking through every audit row and log line after a full reset.
- **Reset links.** 32 random bytes, only the SHA-256 is stored, valid 60 minutes (`MAIL_RESET_MINUTES`), single use (one `UPDATE ... RETURNING` decides, so two requests cannot both win), and a newer request makes the older link stop working. Using one **ends every session of the account** and sends "your password was changed". A typo in the new password does not use the link up. The reset pages send `Referrer-Policy: strict-origin`, so the token never leaves in a `Referer`.
- **No account enumeration.** `/gw/forgot` gives the same page and status for a known and an unknown address (tested byte for byte), mails only an existing, not suspended account, and audits `password.reset_request` with `known` but no address.
- **Click and open tracking are off** on every message (`o:tracking`, `o:tracking-clicks`, `o:tracking-opens`), because a rewritten link is unreliable and a tracked link is a leak.
- **The "finished" notice** goes at most once per user per `MAIL_TASK_NOTICE_HOURS` (6), only for a sandbox that was kept running because the agent was busy and then stopped for being idle (not for an ordinary idle stop, a limit or the busy cap), and never after an opt-out. Every notice carries a signed opt-out link (HMAC of the user id with the runner secret, no stored token). Opening the link only asks; the button does it. A forged or altered link does nothing. It can be undone from the same page.
- **Invites by email** need mail to be on, one invite per address, and a valid address; the checks run before anything is created, so a refusal leaves no stray invite. The link is in the message and in the admin's answer (which still shows it, so a failed delivery can be worked around); the code is never in the audit trail.

## The waitlist

Sign-up here is by invitation (`ALLOW_SIGNUP=false`), so someone without an invite had no way to ask. The sign-in page now says "No invite? Join the waitlist" (only where an invite is required; with open sign-up there is no waitlist and nothing is stored).

- **Joining:** an email address, nothing else. The page answers the same to a new address, a repeat and an address that already has an account (tested), and an account holder is not added. Limited to 5 requests an hour per caller; the list holds at most 5,000 addresses, so it cannot be used to fill the database.
- **Confirmation:** with mail on, a new address is sent a confirmation link (and a repeat of an address that never confirmed is sent another, up to the per-address mail limit: found when a first try was made while mail was off and the second one sent nothing) (signed with the runner secret, nothing stored); opening it only asks, the button confirms. **Only a confirmed address can be invited**, so nobody can have a third party mailed an invitation by typing their address. With mail off there is no confirmation and no mailing; the admin page says so and the list is a plain record to follow up by hand (create an invite on the Invites page and send it).
- **Inviting:** the admin's Waitlist page lists people oldest first with joined, confirmed and invited times. "Invite" creates one invite (7 days by default, note "waitlist"), mails it and marks the entry; it is marked invited only when the message was accepted for sending. "Remove" takes someone off. A person who signs up is taken off the list.
- **Records:** audit rows `waitlist.join` (result new or exists), `waitlist.confirm`, `admin.waitlist_invite`, `admin.waitlist_remove`; none holds an address. The list itself holds addresses, so it is personal data to include in whatever you tell users about their data and to delete on request (no automatic expiry yet).
- **Not built:** automatic invitations when capacity frees up (this is not the capacity "waiting room", P5-9), an expiry for old entries, an export, and a count on the overview page.

## Two things found while building it

1. **A real browser caught what the HTTP tests missed.** The reset pages first sent `Referrer-Policy: no-referrer`. With it, browsers send `Origin: null` on the form post, and the gateway's same-origin check (`sameOrigin` in `server.js`) answered 403 to the password change. The tests had posted with no `Origin` header at all. The fix is `strict-origin`, and the tests now send a real `Origin` and have a case for `null`.
2. **A wiring gap a unit test caught.** The admin invite code asked the mail object whether mail was enabled, but the object handed over had no such property, so every emailed invite would have said "mail is not set up". The test that goes through the real admin route covers it now.

## How it was verified

- `tests/gateway/mail.test.mjs` (11 tests): against a fake Mailgun HTTP server, the exact request (path, basic auth with the key, form fields, tracking off, the address as given), background delivery, retries and their delays, a permanent failure not retried, a dead server and a hung one, limits and their one-hour memory, the bounded queue, the log provider, configuration errors, and that no key, address, subject or token reaches the trail.
- `tests/gateway/mail-flows.test.mjs` (24 tests, the last seven for the waitlist: where it is offered, identical answers, no mail without a provider, signed confirmation that only asks first, abuse limits and the cap, inviting only confirmed addresses and leaving the list on sign-up, admin-only routes): the whole reset (links, new password, old password and sessions end, single use, notice), typos not using the link, expiry and replacement, atomic use, unknown tokens, abuse limits, identical answers for known and unknown addresses, suspended accounts, no secrets in the trail, the `Origin` cases, invites by email (API and the real admin route), the finished notice and its window, the signed opt-out and undo, and the sandbox manager's hook (kept busy then idle yes; plain idle no; a throwing listener does not break the reaper).
- `tests/ui/recovery.test.mjs` (5 tests, including the waitlist from the sign-in page to the admin's Invite button; real Chromium, the outbox provider): forgot password to a new sign-in, the mismatch message, the old password refused, the used link; the page without mail; an invalid link; the admin email box.
- **Checked to fail:** each of these mistakes makes a test fail: a different answer for known addresses, a reusable token, sessions surviving a reset, tracking left on, retrying a permanent error, an unsigned opt-out link, adding account holders to the waitlist, inviting an unconfirmed address, keeping a person on the list after sign-up, mailing suspended accounts, a notice for a plain idle stop, no "password changed" message, and `no-referrer`.
- `tests/run.sh unit`: 385 tests pass (2026-11-28). The Docker suites of phases 2 to 4 were **not run** (they delete data and need your approval); the change adds a table and columns that are created on start, and routes, but touches no sandbox code except the reaper's new hook.

## Not verified

- **A real send through Mailgun.** Nothing here has talked to Mailgun: the tests use a fake server written from Mailgun's documented request shape. Run `scripts/mail-test.sh` once the key and domain are in `.env`, and report what it prints. Deliverability (spam folders, the From domain's DNS) is a property of the Mailgun domain and cannot be tested from here.
- Mailgun's current dashboard wording, the key types, and the sandbox-domain rules (from memory, above).
- The `eu` base address (`api.eu.mailgun.net`) is as documented, not exercised.
- The "finished" notice end to end with a real model: the hook is tested with a fake runner and model activity. In the live stack it needs `MAX_BUSY_SECONDS` above 0 (off by default), otherwise no sandbox is ever kept running for the agent and no notice is ever due.
- **Gaps:** no HTML mail (plain text only), no queue that survives a restart (messages queued at that moment are lost and the user can ask again), no bounce handling, no per-user mail history page, and no admin overview line for mail health (the audit log shows `mail.sent` and `mail.failed`).
