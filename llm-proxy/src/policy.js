/**
 * Policies the admin panel may change in the llm-proxy: quotas, the shared budget, rate limits and the output cap. The environment
 * value is the default; an override is stored in the proxy's own database and applied to the running configuration at once, so
 * nothing needs a restart and an override survives one. Secrets, the upstream, the model list and the body limit are not here.
 *
 * `zero` says what 0 means ('unlimited' or 'off'); setting 0 needs the caller to confirm, so a limit is never turned off by a typo.
 */
export const POLICIES = [
  { key: 'dailyTokenQuota', group: 'Model allowances', label: 'Daily tokens per user', description: 'Input plus output tokens one user may use per UTC day. Past it, their model requests are refused until the day resets.', unit: 'tokens', min: 1_000, max: 10_000_000_000, zero: 'unlimited', applies: 'Right away, for the next request' },
  { key: 'monthlyTokenQuota', group: 'Model allowances', label: 'Monthly tokens per user', description: 'The same, per UTC month.', unit: 'tokens', min: 1_000, max: 10_000_000_000, zero: 'unlimited', applies: 'Right away, for the next request' },
  { key: 'globalDailyTokenBudget', group: 'Model allowances', label: 'Shared daily budget (all users together)', description: 'When all users together have used this many tokens in a UTC day, every request is refused until the day resets. This protects the bill.', unit: 'tokens', min: 1_000, max: 100_000_000_000, zero: 'off', applies: 'Right away, for the next request' },
  { key: 'rateLimitPerMinute', group: 'Request limits', label: 'Requests per minute per user', description: 'How many model requests one user may start per minute.', unit: 'requests', min: 1, max: 100_000, zero: 'unlimited', applies: 'Right away, for the next request' },
  { key: 'maxConcurrent', group: 'Request limits', label: 'Requests in flight per user', description: 'How many model requests one user may have running at once.', unit: 'requests', min: 1, max: 1_000, zero: 'unlimited', applies: 'Right away, for the next request' },
  { key: 'maxOutputTokens', group: 'Request limits', label: 'Longest single reply', description: 'The most output tokens one model reply may have. It also bounds how far one call can overshoot a user\'s allowance. The workspace\'s own model setting (MODEL_MAX_OUTPUT_TOKENS) should stay at or below this.', unit: 'tokens', min: 256, max: 1_000_000, zero: 'off', applies: 'Right away, for the next request' },
];

const BY_KEY = new Map(POLICIES.map((p) => [p.key, p]));
export const policyOf = (key) => BY_KEY.get(key) ?? null;

/** Rules between settings. `effective` holds every setting's value. Returns a message, or null when fine. */
export function crossCheck(effective) {
  const { dailyTokenQuota: day, monthlyTokenQuota: month } = effective;
  if (day > 0 && month > 0 && month < day) return 'The monthly allowance must be at least the daily one (or 0 for unlimited).';
  return null;
}

/**
 * Check one proposed value. Returns { ok: true, value } or { ok: false, error, message }.
 * `confirmed` is the caller's explicit yes to a value that turns a limit off.
 */
export function validate(setting, raw, { confirmed = false } = {}) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,12}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'not_a_number', message: 'Enter a whole number, 0 or more.' };
  if (n === 0) {
    if (!setting.zero) return { ok: false, error: 'out_of_range', message: `The smallest allowed value is ${setting.min}.` };
    if (!confirmed) return { ok: false, error: 'confirm_zero', message: `0 means ${setting.zero}: this turns the limit off. Confirm to continue.` };
    return { ok: true, value: 0 };
  }
  if (n < setting.min || n > setting.max) return { ok: false, error: 'out_of_range', message: `Use ${setting.zero ? `0 (${setting.zero}) or ` : ''}a value from ${setting.min} to ${setting.max}.` };
  return { ok: true, value: n };
}

/**
 * Policy values over a configuration object: `defaults` are the environment values taken before any override is applied, and
 * every change updates `cfg` in place, so code that reads `cfg.<key>` when it is used sees it at once. `onChange` lets a part that
 * copied a value (the rate limiter) take it again.
 */
export function createPolicies({ cfg, store, log = () => {}, onChange = () => {} }) {
  const defaults = Object.fromEntries(POLICIES.map((p) => [p.key, cfg[p.key]]));
  const overrides = new Map(); // key -> { value, updatedAt }

  const effective = (extra = {}) => ({ ...Object.fromEntries(POLICIES.map((p) => [p.key, overrides.get(p.key)?.value ?? defaults[p.key]])), ...extra });
  const apply = () => {
    for (const p of POLICIES) cfg[p.key] = overrides.get(p.key)?.value ?? defaults[p.key];
    onChange(cfg);
  };

  /** Read the stored overrides and apply them. A stored value that no longer passes the checks is ignored and logged. */
  function load() {
    overrides.clear();
    for (const row of store.policyOverrides()) {
      const setting = policyOf(row.key);
      const ok = setting && validate(setting, row.value, { confirmed: true }).ok;
      if (!ok) {
        log(`policy: ignoring the stored value for "${row.key}" (it is not valid for this version)`);
        continue;
      }
      overrides.set(row.key, { value: row.value, updatedAt: row.updatedAt });
    }
    const conflict = crossCheck(effective());
    if (conflict) {
      log(`policy: the stored values conflict (${conflict}); using the defaults`);
      overrides.clear();
    }
    apply();
  }

  return {
    load,
    list: () => POLICIES.map((p) => ({ ...p, default: defaults[p.key], value: cfg[p.key], source: overrides.has(p.key) ? 'admin' : 'default', updatedAt: overrides.get(p.key)?.updatedAt ?? null })),
    /** Change one value. Returns { ok: true, from, to } or { ok: false, status, error, message }. */
    set(key, raw, { confirmed = false } = {}) {
      const setting = policyOf(key);
      if (!setting) return { ok: false, status: 404, error: 'not_found', message: 'No such setting.' };
      const v = validate(setting, raw, { confirmed });
      if (!v.ok) return { ...v, status: 400 };
      const conflict = crossCheck(effective({ [key]: v.value }));
      if (conflict) return { ok: false, status: 400, error: 'conflict', message: conflict };
      const from = cfg[key];
      store.setPolicy(key, v.value);
      overrides.set(key, { value: v.value, updatedAt: Date.now() });
      apply();
      return { ok: true, from, to: v.value };
    },
    /** Remove the override: the environment value applies again. */
    reset(key) {
      if (!policyOf(key)) return { ok: false, status: 404, error: 'not_found', message: 'No such setting.' };
      const from = cfg[key];
      store.deletePolicy(key);
      overrides.delete(key);
      apply();
      return { ok: true, from, to: cfg[key] };
    },
  };
}
