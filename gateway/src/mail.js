import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RateLimiter } from './auth.js';

/**
 * Outgoing mail (docs/email.md): one small interface, three providers.
 *
 *   mailer.send({ kind, to, subject, text, userId })  ->  { queued: true } | { queued: false, reason }
 *
 * `send` decides at once (limits, queue room) and delivers in the background, so the request that caused a message never waits
 * for, or fails because of, the mail service. A temporary failure (network error, timeout, 429, 5xx) is retried a few times with
 * a short delay, a permanent one (any other 4xx, such as a wrong key) is not. After the last attempt the message is dropped
 * and `mail.failed` is audited. The audit rows and logs hold the kind, provider, attempts and the reason, and never the
 * address, subject, text, link, token or key.
 */
const QUEUE_MAX = 100;

class Permanent extends Error {}

/** Mailgun's HTTP API: POST /v3/<domain>/messages, basic auth `api:<key>`. Tracking is off so links are not rewritten. */
export function mailgunProvider({ apiBase, mailgunKey, mailgunDomain, from, timeoutMs }, fetchImpl = fetch) {
  const auth = `Basic ${Buffer.from(`api:${mailgunKey}`).toString('base64')}`;
  return {
    name: 'mailgun',
    real: true,
    async deliver({ to, subject, text }) {
      const body = new URLSearchParams({ from, to, subject, text, 'o:tracking': 'no', 'o:tracking-clicks': 'no', 'o:tracking-opens': 'no' });
      let res;
      try {
        res = await fetchImpl(`${apiBase}/v3/${mailgunDomain}/messages`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new Error(e?.name === 'TimeoutError' ? 'timeout' : 'network');
      }
      if (res.ok) return;
      // Mailgun answers with {"message": "..."}; a short plain reason helps the operator and holds no recipient data.
      const message = await res.json().then((j) => String(j?.message ?? '').replace(/[^\x20-\x7e]/g, ' ').slice(0, 120), () => '');
      const err = new (res.status === 429 || res.status >= 500 ? Error : Permanent)(`http_${res.status}${message ? `: ${message}` : ''}`);
      throw err;
    },
  };
}

/** Writes each message to a file. For one machine only: the files hold the links and tokens. */
export function outboxProvider({ outboxDir }) {
  mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  return {
    name: 'outbox',
    real: true,
    async deliver({ to, subject, text, kind }) {
      writeFileSync(join(outboxDir, `${Date.now()}-${kind}-${randomBytes(3).toString('hex')}.txt`), `To: ${to}\nSubject: ${subject}\n\n${text}`, { mode: 0o600 });
    },
  };
}

/** Sends nothing. The default, so a gateway without mail settings never tries to. */
export function logProvider() {
  return { name: 'log', real: false, async deliver() {} };
}

export function createMailer({ cfg, audit, log = console.log, fetchImpl = fetch, provider, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const mc = cfg.mail;
  const impl = provider ?? (mc.provider === 'mailgun' ? mailgunProvider(mc, fetchImpl) : mc.provider === 'outbox' ? outboxProvider(mc) : logProvider());
  const perAddress = new RateLimiter(mc.perAddressPerHour, 3600_000, now);
  const total = new RateLimiter(mc.perHour, 3600_000, now);
  const queue = [];
  let working = false;
  let idle = Promise.resolve();

  async function attempt(msg) {
    let last = 'unknown';
    for (let n = 1; n <= mc.attempts; n++) {
      try {
        await impl.deliver(msg);
        audit.record('mail.sent', { userId: msg.userId, kind: msg.kind, provider: impl.name, attempts: n });
        return;
      } catch (e) {
        last = String(e?.message ?? e).slice(0, 160);
        if (e instanceof Permanent || n === mc.attempts) break;
        await sleep(mc.retryDelaysMs[Math.min(n - 1, mc.retryDelaysMs.length - 1)] ?? 1000);
      }
    }
    audit.record('mail.failed', { userId: msg.userId, kind: msg.kind, provider: impl.name, attempts: mc.attempts, reason: last });
    log(`mail ${msg.kind} not delivered (${impl.name}): ${last}`);
  }
  function pump() {
    if (working) return;
    working = true;
    idle = (async () => {
      while (queue.length) await attempt(queue.shift()).catch((e) => log(`mail worker: ${e.message}`));
      working = false;
    })();
  }

  return {
    provider: impl.name,
    /** True when a message really leaves the gateway; with the log provider the pages that rely on mail say it is not set up. */
    enabled: impl.real,
    send({ kind, to, subject, text, userId = null }) {
      if (!impl.real) {
        audit.record('mail.skipped', { userId, kind, reason: 'no_provider' });
        return { queued: false, reason: 'disabled' };
      }
      const address = String(to).toLowerCase();
      if (perAddress.blocked(address) || total.blocked('all')) {
        audit.record('mail.skipped', { userId, kind, reason: 'rate_limited' });
        return { queued: false, reason: 'rate_limited' };
      }
      if (queue.length >= QUEUE_MAX) {
        audit.record('mail.skipped', { userId, kind, reason: 'queue_full' });
        return { queued: false, reason: 'queue_full' };
      }
      perAddress.fail(address);
      total.fail('all');
      queue.push({ kind, to, subject, text, userId });
      pump();
      return { queued: true };
    },
    /** Resolves when everything queued so far has been tried (for the command line and tests). */
    flush: () => idle,
  };
}
