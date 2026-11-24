/**
 * Audit trail: who did what and when, for sign-in, accounts, sandbox lifecycle and token issue.
 * Each event is one row in the gateway database and one JSON line on stdout (`audit {...}`), so it survives
 * in whichever of the two you keep. Never records passwords, tokens, prompts or any model content.
 * Recording is best effort: a failure here must never fail the request it describes.
 */
export class Audit {
  constructor({ store, log = console.log, now = Date.now }) {
    this.store = store;
    this.log = log;
    this.now = now;
  }

  /** record('login.fail', { userId, ip, reason: 'bad_credentials', email }) — everything but userId and ip goes into detail. */
  record(event, { userId = null, ip = null, ...fields } = {}) {
    const ts = this.now();
    const detail = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));
    try {
      this.log(`audit ${JSON.stringify({ ts: new Date(ts).toISOString(), event, userId, ip, ...detail })}`);
      this.store.addAudit({ ts, event, userId, ip, detail });
    } catch (e) {
      try {
        this.log(`audit write failed for ${event}: ${e.message}`);
      } catch {
        /* nothing left to do */
      }
    }
  }
}

/** Parse "90m", "24h", "7d" into milliseconds; null if not in that form. */
export function parseSpan(text) {
  const m = /^(\d+)([mhd])$/.exec(text ?? '');
  return m ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] : null;
}
