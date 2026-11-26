# Idea: talking to the agent outside the browser (SMS and other two-way channels)

Status: **idea, not designed.** Saved on 2026-11-25 to revisit later, updated 2026-11-26 with what the harness does and does not provide (read in its source, not run) and how to develop this locally. Nothing here is built or decided. Facts about today's code and about what the harness's documentation says are checked by reading; everything about SMS providers, and whether the harness interfaces work for this purpose in practice, is from memory or untried and marked **to verify**.

## The idea

Let a user send a text to their agent and get an answer back, without opening the web app: start a task from a phone, check on a long run, answer an approval ("run this command? yes/no"), get a summary when it finishes. SMS was the first example; the same shape fits other channels.

## What happens today

- **There is no inbound path.** Everything reaches a sandbox through the gateway, in response to a signed-in browser request or WebSocket. Nothing accepts a message from outside.
- **A stopped sandbox cannot receive anything.** After the idle limit (`IDLE_SECONDS`, 30 min) the reaper stops the container (`docker stop`: SIGTERM, 10 s grace, then kill). Volumes survive (sessions in `$DSH_HOME`, files in `/workspace`); running commands, an in-progress turn and `/tmp` do not. The next browser request starts the same container (about 5 s) and the harness loads its sessions from disk.
- **P5-1 changed one thing:** a sandbox whose agent is busy (model calls in flight or recent, or CPU use) is kept for up to `MAX_BUSY_SECONDS` (2 h) after the user's last activity. So a task started from the browser keeps running with the tab closed. A message arriving later still needs a way in.
- So SMS would **not** work after the idle timeout today. It would need the pieces below.

## What the harness provides (read 2026-11-26 in `../deepseek-harness`, nothing run)

- **No messaging channel of any kind.** A search of the harness source for Twilio, SMS, Telegram, WhatsApp, Slack and Discord finds no channel code; the hits are unrelated (for example "slack" meaning spare time in a poll budget). Its scheduled-tasks package says in its README that due tasks arrive as ordinary follow-up messages in their target session, "not email, SMS, or push notifications". So there is no inbound path and no notification path to build on; both are ours to write.
- **Connector plugins go the other way.** `packages/connector` (Linear, Notion, and the CLI-account and upstream-skills services) lets the agent *use* an outside service as a tool. None lets an outside service message the agent.
- **Two ways for a program to drive a harness with no browser**, which is the part that matters for this idea (per their READMEs; **not tried here**):
  - **ACP server** (`packages/acp`): the standard Agent Client Protocol (JSON-RPC, normally over stdio, a standard for programs and editors to talk to coding agents; its origin outside this repo is from memory). The harness's server lets a client create, list, resume and close persistent sessions, attach MCP servers, select model options, send text and image prompts, receive updates, **answer permission prompts** and cancel work "without a human in the loop".
  - **SDK** (`packages/sdk`, plus the Python SDK): a client launches `dsh` with a named profile and talks newline-delimited JSON-RPC over stdio: open sessions, send prompts, observe session events, agent status changes and subagent completions.
- **Our sandboxes run the web profile** (`dsh --profile web`), not these. So today nothing in a sandbox speaks ACP or the SDK protocol, and what is not known is how a headless session relates to the one the browser shows.

## What a channel needs

1. **An inbound endpoint** on the gateway that the channel provider calls (a webhook), and verification that the call really came from the provider (for Twilio a request signature header; **to verify**).
2. **Identity:** a mapping from phone number (or chat id) to a user, created by the user proving they own it (send a code to the number, or a link from the signed-in app). Never trust a bare "From" number.
3. **Wake the sandbox:** if it is stopped, start it (`ensure` and the runner), wait for the harness to boot, and mark the user active so it is not stopped again straight away. The message must be queued meanwhile, in order, and not lost if the gateway restarts.
4. **Deliver the text to the user's session** without a browser. This is the main unknown: see "Open questions". The harness's ACP server and SDK are the candidates (above); the approvals in item 6 map onto ACP's permission prompts.
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

## Developing and testing it locally

What needs no public address, and so can be built and tested on a laptop and in the Lima VM:
- **The delivery spike** (the main unknown, independent of any channel): can a second process give a message to a user's session and read the answer, through ACP, the SDK, or a gateway-side WebSocket client of the web interface? Try it in the VM first.
- **Waking a stopped sandbox, queuing messages in order, the identity step, rate limits, STOP and HELP, reply splitting and the approval question.** All of it is gateway logic.
- **A fake channel** behind the provider adapter, like the `log` mail provider planned for P5-8: a page or CLI where you type "a text" and read the replies. The same flow and tests a real provider would need, with no vendor account.

What a real provider adds:
- **SMS inbound needs a public URL** for the provider's webhook. Locally that means a tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) in front of **only the webhook path**, not the whole gateway. Twilio-style signatures are computed over the exact public URL, so the tunnel address must be the configured one (a changing free-tier address is a nuisance). **To verify** against the provider's current documentation.
- **Trial accounts** usually send only to verified numbers and prefix messages; fine for development. **US carrier registration** for sending at scale (A2P 10DLC) is a launch question, not a local one (**to verify**).
- **The machine must be awake**: a text sent while the laptop or VM sleeps is lost or delayed.
- **Telegram bots can poll for messages** instead of receiving a webhook, so they need no tunnel and work from a laptop: the cheapest real channel to prove the flow.

Suggested order: the delivery spike, then the adapter with the fake channel, then Telegram by polling, then SMS with a tunnel.

### Tunnel options and provider limits (web search 2026-11-26; documentation pages, not tried; limits change, re-check before relying on any number)

| | Cloudflare Tunnel | ngrok | Tailscale Funnel |
| --- | --- | --- | --- |
| Quick start | "Quick Tunnel": a random `trycloudflare.com` address, **no account or domain needed** | Free account, one **automatically assigned dev domain** (the only domain on the free plan; choosing or reserving a domain is paid) | Account plus the `funnel` attribute in the tailnet policy (the CLI sets it up); a fixed `<machine>.<tailnet>.ts.net` name |
| Stable address | Quick Tunnel addresses are temporary. Named tunnels on your own domain give a stable one (**from memory**: needs a domain on Cloudflare; not confirmed in this search) | The dev domain is assigned once and stays | The `ts.net` name; **only** `ts.net` names work |
| Limits found | A Quick Tunnel handles **200 requests in flight**, more get HTTP 429; **no uptime guarantee**; **no Server-Sent Events**; not supported while a `config.yaml` exists in `~/.cloudflared`. These are Quick Tunnel limits, not named-tunnel ones | Free plan: monthly quotas, rate limits and concurrency limits; **1 GB outgoing a month** on one page (a third-party blog says 20k requests a month, not found in ngrok's docs); up to 3 online endpoints on the dev domain (another page says 1: the sources disagree); the exact per-minute rate was not found, see the dashboard's usage page | Public ports are only **443, 8443 and 10000**; **bandwidth limits that are not published and cannot be configured**; certificates come from Let's Encrypt, whose rate limits can lock a name out for about a day and a half if certificates are requested too often. Whether Funnel is fully available on the free plan was **not confirmed** |
| Browser warning page | Not mentioned | An **interstitial page** is added to HTML traffic from browsers on the free tier (a click sets a cookie for 7 days); it does **not** affect API or programmatic traffic, so webhooks are unaffected | Not mentioned |
| Fit for a webhook | Fine for development; use a named tunnel for anything that should stay up | Fine for development; the stable dev domain helps with signatures | Fine when you already use Tailscale, and it can keep everything else private; watch the ports and bandwidth |

Sources: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [ngrok free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits), [ngrok licensing FAQ](https://ngrok.com/docs/guides/licensing/), [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), [a third-party guide to Funnel's ports and limits](https://www.ssdnodes.com/learn/tailscale-funnel-limits-and-ports).

What the providers of the channel itself say:
- **Twilio webhook signatures:** each request carries `X-Twilio-Signature`, an HMAC-SHA1 over the **exact webhook URL configured in Twilio plus all the request parameters**, keyed with the account auth token (an `X-Twilio-Signature-Settings` header, when present, means a different signing key is in use). Twilio recommends its SDK's validation helper rather than a hand-written one. The URL must match byte for byte: a proxy or tunnel that changes the scheme, host, port or encoding breaks validation, so the gateway has to rebuild the public URL from configuration, not from the incoming request. Source: [Twilio webhooks security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).
- **Twilio trial accounts:** messages only to verified numbers (up to 5 verified recipients per account on one page), one trial phone number, messages start with "Sent from a Twilio trial account", no alphanumeric sender ID, custom content limits; US toll-free numbers need Toll-Free Verification to send SMS, and the sources disagree on whether that can be done during the trial. Upgrading removes the trial restrictions. Source: [Twilio trial account](https://www.twilio.com/docs/usage/trials).
- **US registration (A2P 10DLC):** only a secondary guide was found: registration of a brand and campaign is described as required for application-to-person texting over US long numbers at scale, with unregistered traffic possibly filtered or blocked. **Not verified against Twilio's own pages.**
- **Telegram:** receiving updates is either long polling (`getUpdates`, at most 100 unconfirmed updates, confirmed by passing the next `offset`) or a webhook (`setWebhook`, public HTTPS on port 443, 80, 88 or 8443), and the two are **mutually exclusive** (a set webhook makes `getUpdates` fail until it is deleted). Polling needs no public address. Sending rate limits were quoted inconsistently (about one message a second per chat, 30 a second overall) and were **not verified** against Telegram's own pages. Source: [Telegram webhooks guide](https://core.telegram.org/bots/webhooks) and [Bots FAQ](https://core.telegram.org/bots/faq).

**What this changes about the design:** the gateway needs the public URL as a setting (for signature checks), the webhook route must pass the raw parameters to the validator unchanged, a provider's retries on a 5xx mean the handler must be idempotent, and the channel adapter should hide whether updates arrive by webhook or by polling.

## Cheaper first steps (no way into the harness needed)

- **One-way notifications:** "your task finished", "you used 80% of today's tokens", "your workspace was stopped because ...". These reuse the P5-1 busy signal (finished means it stopped being busy) and the P5-8 mail provider, and could use the same adapter for SMS later. This is plan item 19 and delivers most of the "I can leave" value.
- **Reply by email** to continue a thread is a smaller version of two-way chat, with the same delivery problem as below.

## Open questions

- **How to hand a message to a harness session with no browser** (**to verify**, nothing here has been tried). Candidates: the gateway acts as a client of the same WebSocket interface the web UI uses (it already holds the sandbox auth cookie for each user); or the harness's SDK (JSON-RPC) or ACP server, which exist (see above) but are not what a web-profile sandbox runs; or a small plugin in the sandbox. Questions to answer by trying it: can a running web-profile harness accept a message into an existing session from a second client; does the UI show it live; how are approvals surfaced to a non-browser client; how is the final answer read back.
- **Which session** a text goes to (the latest, a pinned one, a new one each time) and how the user switches.
- **Long answers:** summarise automatically, send a link to the web transcript, or truncate with "reply MORE".
- **Cost and quota:** who pays for outbound messages; whether channel messages count against the same token quota (they should).
- **Privacy and consent:** what may be sent over an unencrypted channel; keep code, paths and secrets out of replies by default.
- **Failure behaviour:** the sandbox cannot start (capacity, disk stop, quota). The user should get a short reason by the same channel; this reuses the designed states of P5-2.

## Where it fits in the plan

- Builds on **P5-1** (done: busy agents stay up), **P5-2** (designed states give the short reasons to send), **P5-8** (the provider interface pattern and the one-way notices).
- Related ideas in [plan-phase-5.md](plan-phase-5.md): 19 (notify when done), 20 (scheduled tasks that wake the sandbox, which needs the same "wake and deliver" machinery), 30 (sharing).
- Effort: large (L). Revisit after slices 1 to 3, or earlier if users ask to leave long tasks running and be told when they finish.
