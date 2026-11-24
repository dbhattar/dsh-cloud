/**
 * Per-user request rate and concurrency limits (in memory; single proxy instance).
 * acquire() returns {ok, release} or {ok:false, retryAfter, reason}.
 */
export class Limiter {
  constructor({ perMinute, maxConcurrent, now = Date.now }) {
    this.perMinute = perMinute;
    this.maxConcurrent = maxConcurrent;
    this.now = now;
    this.stamps = new Map(); // userId -> request timestamps in the last minute
    this.active = new Map(); // userId -> in-flight count
  }
  acquire(userId) {
    const t = this.now();
    const recent = (this.stamps.get(userId) ?? []).filter((s) => t - s < 60_000);
    if (this.perMinute > 0 && recent.length >= this.perMinute) {
      this.stamps.set(userId, recent);
      return { ok: false, reason: 'rate', retryAfter: Math.max(1, Math.ceil((recent[0] + 60_000 - t) / 1000)) };
    }
    const active = this.active.get(userId) ?? 0;
    if (this.maxConcurrent > 0 && active >= this.maxConcurrent) {
      this.stamps.set(userId, recent);
      return { ok: false, reason: 'concurrency', retryAfter: 1 };
    }
    recent.push(t);
    this.stamps.set(userId, recent);
    this.active.set(userId, active + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active.set(userId, Math.max(0, (this.active.get(userId) ?? 1) - 1));
      },
    };
  }
}
