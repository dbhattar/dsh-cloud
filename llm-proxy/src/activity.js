/**
 * Who is using the model right now, and who did a moment ago. The gateway asks (over the admin socket) so it can
 * tell a sandbox whose agent is mid-task from one that is truly idle, and not stop the first when the browser tab
 * has been closed. In memory on purpose: a restart forgets it, which only makes the gateway fall back to its
 * other signals for a few minutes.
 */
export class ActivityTracker {
  constructor() {
    this.users = new Map(); // userId -> { inflight, lastAt }
  }

  /** A model request started. */
  begin(userId, now) {
    const u = this.users.get(userId) ?? { inflight: 0, lastAt: 0 };
    u.inflight += 1;
    u.lastAt = now;
    this.users.set(userId, u);
  }

  /** A model request finished (successfully or not). */
  end(userId, now) {
    const u = this.users.get(userId);
    if (!u) return;
    u.inflight = Math.max(0, u.inflight - 1);
    u.lastAt = now;
  }

  /** Users with a request in flight or one that ended within `windowMs`; older entries are dropped. */
  snapshot(now, windowMs) {
    const out = [];
    for (const [userId, u] of this.users) {
      if (u.inflight === 0 && now - u.lastAt > windowMs) {
        this.users.delete(userId);
        continue;
      }
      out.push({ userId, inflight: u.inflight, lastAt: new Date(u.lastAt).toISOString() });
    }
    return out;
  }
}
