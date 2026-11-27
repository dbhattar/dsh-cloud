/**
 * Limits on how hard one sandbox can push through the proxy, keyed by the sandbox's source address (each user has a network of their
 * own, so the address is the user) and by the destination host. Four limits, each off at 0: concurrent connections per source and per
 * destination, and new connections (or plain-HTTP requests) per second per source and per destination.
 *
 * Over a limit a request is not refused at once: it waits for a slot or a token for up to `maxWaitMs`, so a tool just runs slower, and
 * only a request that would wait longer than that is refused (429, with Retry-After). Waiting counts against the proxy's overall
 * connection cap, which keeps the queue bounded.
 *
 * What this cannot see: inside an HTTPS tunnel the proxy sees one connection, not the requests a client sends down it, so a client that
 * reuses a connection is limited in how many tunnels it opens and how many run at once, not in requests per second. Plain-HTTP requests
 * are counted one by one. The tools' own rate options (nuclei -rl, ffuf -rate, httpx -rl) are the first line; this is the backstop.
 */
export class Limits {
  constructor({ perSourceRate = 0, perDestRate = 0, perSourceConcurrent = 0, perDestConcurrent = 0, maxWaitMs = 5000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { perSourceRate, perDestRate, perSourceConcurrent, perDestConcurrent, maxWaitMs, now, sleep });
    this.buckets = new Map(); // key -> { tokens, last }: tokens go negative while requests are queued behind the rate
    this.slots = new Map(); // key -> { n, queue: [resolve] }
  }

  /** Ask to start one connection from `source` to `dest` (a host name). Resolves { ok: true, release } or { ok: false, reason, retryAfter }. */
  async admit(source, dest) {
    const sk = `s:${source}`;
    const dk = `d:${source}|${String(dest).toLowerCase()}`;
    const taken = [];
    const drop = () => { for (const k of taken.reverse()) this.#release(k); };
    for (const [key, limit, what] of [[sk, this.perSourceConcurrent, 'from this sandbox'], [dk, this.perDestConcurrent, `to ${dest}`]]) {
      if (!limit) continue;
      if (!(await this.#acquire(key, limit))) {
        drop();
        return { ok: false, reason: `too many connections open ${what}`, retryAfter: 1 };
      }
      taken.push(key);
    }
    for (const [key, rate, what] of [[sk, this.perSourceRate, 'from this sandbox'], [dk, this.perDestRate, `to ${dest}`]]) {
      if (!rate) continue;
      const r = this.#reserve(key, rate);
      if (r.refuse) {
        drop();
        return { ok: false, reason: `rate limit: too many new connections ${what}`, retryAfter: r.retryAfter };
      }
      if (r.waitMs > 0) await this.sleep(r.waitMs);
    }
    let done = false;
    return { ok: true, release: () => { if (!done) { done = true; drop(); } } };
  }

  #reserve(key, rate) {
    const t = this.now();
    const burst = Math.max(1, rate * 2);
    const b = this.buckets.get(key) ?? { tokens: burst, last: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.last) / 1000) * rate);
    b.last = t;
    b.tokens -= 1;
    const waitMs = b.tokens < 0 ? Math.ceil((-b.tokens / rate) * 1000) : 0;
    if (waitMs > this.maxWaitMs) {
      b.tokens += 1; // not queued after all
      this.buckets.set(key, b);
      return { refuse: true, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    this.buckets.set(key, b);
    if (this.buckets.size > 5000) this.#prune(t);
    return { waitMs };
  }

  #prune(t) {
    for (const [k, b] of this.buckets) if (t - b.last > 120_000) this.buckets.delete(k);
  }

  #acquire(key, limit) {
    const s = this.slots.get(key) ?? { n: 0, queue: [] };
    this.slots.set(key, s);
    if (s.n < limit) {
      s.n++;
      return Promise.resolve(true);
    }
    if (this.maxWaitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = () => { clearTimeout(timer); resolve(true); }; // a releasing connection hands its slot straight to us
      const timer = setTimeout(() => {
        const i = s.queue.indexOf(waiter);
        if (i >= 0) s.queue.splice(i, 1);
        resolve(false);
      }, this.maxWaitMs);
      timer.unref?.();
      s.queue.push(waiter);
    });
  }

  #release(key) {
    const s = this.slots.get(key);
    if (!s) return;
    if (s.queue.length) s.queue.shift()();
    else {
      s.n--;
      if (s.n <= 0) this.slots.delete(key);
    }
  }
}
