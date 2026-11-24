/** UTC calendar windows for quota accounting. */
export function windows(now) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.toISOString().slice(0, 10);
  return {
    day,
    month: day.slice(0, 7),
    dayResetsAt: Date.UTC(y, m, d.getUTCDate() + 1),
    monthResetsAt: Date.UTC(y, m + 1, 1),
  };
}

/** The usage report shared by the admin API, the gateway and the 429 message. */
export function usageReport(userId, used, cfg, now) {
  const w = windows(now);
  const cap = (n) => (n > 0 ? n : null);
  const dayLimit = cap(cfg.dailyTokenQuota);
  const monthLimit = cap(cfg.monthlyTokenQuota);
  const dayOver = dayLimit !== null && used.day >= dayLimit;
  const monthOver = monthLimit !== null && used.month >= monthLimit;
  return {
    userId,
    day: { used: used.day, limit: dayLimit, resetsAt: new Date(w.dayResetsAt).toISOString() },
    month: { used: used.month, limit: monthLimit, resetsAt: new Date(w.monthResetsAt).toISOString() },
    exhausted: dayOver || monthOver,
    // Which window blocks the user, and when it clears (the later one if both do).
    blockedBy: monthOver ? 'month' : dayOver ? 'day' : null,
  };
}
