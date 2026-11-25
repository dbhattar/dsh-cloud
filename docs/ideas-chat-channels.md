# Idea: talking to the agent outside the browser (SMS and other two-way channels)

Status: **idea, not designed.** Saved on 2026-11-25 to revisit later. Nothing here is built or decided. Facts about today's code are checked; everything about SMS providers and the harness's message interfaces is from memory and marked **to verify**.

## The idea

Let a user send a text to their agent and get an answer back, without opening the web app: start a task from a phone, check on a long run, answer an approval ("run this command? yes/no"), get a summary when it finishes. SMS was the first example; the same shape fits other channels.

## What happens today

- **There is no inbound path.** Everything reaches a sandbox through the gateway, in response to a signed-in browser request or WebSocket. Nothing accepts a message from outside.
- **A stopped sandbox cannot receive anything.** After the idle limit (`IDLE_SECONDS`, 30 min) the reaper stops the container (`docker stop`: SIGTERM, 10 s grace, then kill). Volumes survive (sessions in `$DSH_HOME`, files in `/workspace`); running commands, an in-progress turn and `/tmp` do not. The next browser request starts the same container (about 5 s) and the harness loads its sessions from disk.
- **P5-1 changed one thing:** a sandbox whose agent is busy (model calls in flight or recent, or CPU use) is kept for up to `MAX_BUSY_SECONDS` (2 h) after the user's last activity. So a task started from the browser keeps running with the tab closed. A message arriving later still needs a way in.
- So SMS would **not** work after the idle timeout today. It would need the pieces below.

## What a channel needs

1. **An inbound endpoint** on the gateway that the channel provider calls (a webhook), and verification that the call really came from the provider (for Twilio a request signature header; **to verify**).
2. **Identity:** a mapping from phone number (or chat id) to a user, created by the user proving they own it (send a code to the number, or a link from the signed-in app). Never trust a bare "From" number.
3. **Wake the sandbox:** if it is stopped, start it (`ensure` and the runner), wait for the harness to boot, and mark the user active so it is not stopped again straight away. The message must be queued meanwhile, in order, and not lost if the gateway restarts.
4. **Deliver the text to the user's session** without a browser. This is the main unknown: see "Open questions".
5. **Reply path:** the agent's answer goes back through the provider. It has to be shortened or split (SMS is small), and sent even if the sandbox slept in between.
6. **Approvals:** the harness asks before risky commands (approval policy `ask`). Over a channel that could be "reply YES to allow", or the task waits until the user opens the app. Either way it must say what is being approved, and expire.
7. **Limits and abuse controls:** per-user message rate limit, the same token quotas as the browser, a cost ceiling for outbound messages, opt-out keywords (STOP and HELP are mandatory for SMS), and an audit row per message (never the content, as everywhere else).

## Channel options

| Channel | For | Against |
| --- | --- | --- |
| **SMS** (Twilio or similar) | Everyone has it; no app to install | Per-message cost; carrier registration for sending in the US (A2P 10DLC, **to verify**); 160-character segments; not encrypted; SIM-swap risk if it becomes the only proof of identity |
| **Telegram or Slack bot** | Free or cheap, richer (long messages, buttons for approvals, files), easy bot APIs | Users need that app; Slack needs a workspace install |
| **WhatsApp** (Business API) | Wide reach | Approval process, templates, per-conversation fees |
| **Email in and out** (we already plan Mailgun in P5-8) | No new vendor; handles long text | Slow; threading and quoting are messy; spoofing needs DKIM or SPF checks on inbound |
| **Web push notifications** | Cheap, no phone number | Notify only; no reply |

Suggested order if we do this: a channel-neutral adapter interface (like the mail provider in P5-8), then one channel. Telegram or Slack is the cheapest way to prove the flow; SMS adds registration and cost on top of the same flow.

## Cheaper first steps (no way into the harness needed)

- **One-way notifications:** "your task finished", "you used 80% of today's tokens", "your workspace was stopped because ...". These reuse the P5-1 busy signal (finished means it stopped being busy) and the P5-8 mail provider, and could use the same adapter for SMS later. This is plan item 19 and delivers most of the "I can leave" value.
- **Reply by email** to continue a thread is a smaller version of two-way chat, with the same delivery problem as below.

## Open questions

- **How to hand a message to a harness session with no browser** (**to verify**, nothing here has been tried). Candidates: the gateway acts as a client of the same WebSocket interface the web UI uses (it already holds the sandbox auth cookie for each user); or the harness's headless, SDK (JSON-RPC) or ACP profiles; or a small plugin in the sandbox. Questions to answer by reading the harness and trying it: can a running web-profile harness accept a message into an existing session from a second client; does the UI show it live; how are approvals surfaced to a non-browser client; how is the final answer read back.
- **Which session** a text goes to (the latest, a pinned one, a new one each time) and how the user switches.
- **Long answers:** summarise automatically, send a link to the web transcript, or truncate with "reply MORE".
- **Cost and quota:** who pays for outbound messages; whether channel messages count against the same token quota (they should).
- **Privacy and consent:** what may be sent over an unencrypted channel; keep code, paths and secrets out of replies by default.
- **Failure behaviour:** the sandbox cannot start (capacity, disk stop, quota). The user should get a short reason by the same channel; this reuses the designed states of P5-2.

## Where it fits in the plan

- Builds on **P5-1** (done: busy agents stay up), **P5-2** (designed states give the short reasons to send), **P5-8** (the provider interface pattern and the one-way notices).
- Related ideas in [plan-phase-5.md](plan-phase-5.md): 19 (notify when done), 20 (scheduled tasks that wake the sandbox, which needs the same "wake and deliver" machinery), 30 (sharing).
- Effort: large (L). Revisit after slices 1 to 3, or earlier if users ask to leave long tasks running and be told when they finish.
