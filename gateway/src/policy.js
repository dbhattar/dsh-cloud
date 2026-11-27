/**
 * Policies the admin panel may change in the gateway: how long workspaces live, capacity, crash handling and who may sign up. The
 * environment value is the default; an override is stored in the gateway database and applied to the running configuration at
 * once (the rest of the gateway reads `cfg.<key>` when it uses a value), so no restart is needed and an override survives one.
 *
 * `zero` says what 0 means ('off' or 'no limit'), and 0 then needs the caller to confirm, so a limit is never turned off by a typo.
 * A boolean that opens something up (`confirmWhen`) needs the same yes. Secrets, addresses, image names, the sandbox runtime and the
 * settings that are only read at start (the watchdog and reaper intervals) are not here.
 */
const HOUR = 3600;
const DAY = 24 * HOUR;

export const POLICIES = [
  { key: 'idleSeconds', group: 'How long workspaces run', label: 'Idle time before a workspace is paused', description: 'A workspace with nobody in it (no open page, no traffic) is paused after this long. Files and sessions are kept; it starts again when the person returns.', type: 'int', unit: 'seconds', min: 60, max: 7 * DAY, applies: 'Right away, at the next check' },
  { key: 'maxBusySeconds', group: 'How long workspaces run', label: 'Keep a busy agent running after the person leaves', description: 'An agent that is still working (model calls or CPU use) is not paused for being idle, for up to this long after the person was last there. Then it is paused.', type: 'int', unit: 'seconds', min: 600, max: 7 * DAY, zero: 'off', applies: 'Right away, at the next check' },
  { key: 'busySignalSeconds', group: 'How long workspaces run', label: 'How long a sign of work counts as "busy"', description: 'A model call or a burst of CPU use keeps the agent counted as busy for this long.', type: 'int', unit: 'seconds', min: 30, max: HOUR, applies: 'Right away, at the next check' },
  { key: 'busyCpuPercent', group: 'How long workspaces run', label: 'CPU use that counts as "busy"', description: 'Share of one CPU, averaged between checks, above which an agent counts as working.', type: 'int', unit: '% of one CPU', min: 1, max: 100, applies: 'Right away, at the next check' },
  { key: 'maxRunSeconds', group: 'How long workspaces run', label: 'Longest continuous run', description: 'A workspace that has been running this long without a pause is stopped (a person can start it again). It limits how long one run can use the machine.', type: 'int', unit: 'seconds', min: 300, max: 30 * DAY, zero: 'no limit', applies: 'Right away, at the next check' },
  { key: 'maxDiskMb', group: 'Storage', label: 'Storage per person', description: 'Files, sessions and settings of one person together. A workspace over this is stopped at the next check and stays stopped while it is over.', type: 'int', unit: 'MB', min: 100, max: 1_048_576, zero: 'no limit', applies: 'At the next storage check' },
  { key: 'diskCheckSeconds', group: 'Storage', label: 'How often storage is checked', description: 'Storage is measured about this often. A smaller number notices sooner but costs the host more.', type: 'int', unit: 'seconds', min: 30, max: HOUR, applies: 'Right away' },
  { key: 'maxRunningSandboxes', group: 'Capacity', label: 'Workspaces running at once', description: 'When this many are running, a newcomer waits or gets "at capacity", unless an idle one can be paused to make room.', type: 'int', unit: 'workspaces', min: 1, max: 1000, zero: 'no limit', applies: 'Right away, for the next start' },
  { key: 'evictAfterIdleSeconds', group: 'Capacity', label: 'Idle time before a workspace may be paused for a newcomer', description: 'When the service is full, only a workspace that has been idle this long may be paused to make room.', type: 'int', unit: 'seconds', min: 0, max: DAY, applies: 'Right away, for the next start' },
  { key: 'crashMaxRestarts', group: 'Crashes', label: 'Automatic restarts after a crash', description: 'A workspace that stops unexpectedly is started again up to this many times within the window below, then held as a crash loop until the person restarts it. 0 means never restart automatically.', type: 'int', unit: 'restarts', min: 0, max: 20, applies: 'Right away, for the next crash' },
  { key: 'crashWindowSeconds', group: 'Crashes', label: 'The window for counting crashes', description: 'How far back crashes are counted.', type: 'int', unit: 'seconds', min: 60, max: DAY, applies: 'Right away, for the next crash' },
  { key: 'allowSignup', group: 'Access', label: 'Anyone may sign up', description: 'Off: a person needs an invite link to create an account. On: anyone who can reach the page can.', type: 'bool', confirmWhen: true, confirmText: 'Anyone who can reach this address will be able to create an account and use the model allowance.', applies: 'Right away' },
  { key: 'sessionTtlSeconds', group: 'Access', label: 'How long a sign-in lasts', description: 'A new sign-in stays valid this long. Sign-ins that already exist keep the time they were given.', type: 'int', unit: 'seconds', min: 300, max: 365 * DAY, applies: 'For sign-ins from now on' },
];

const BY_KEY = new Map(POLICIES.map((p) => [p.key, p]));
export const policyOf = (key) => BY_KEY.get(key) ?? null;

/** Rules between settings. Returns a message, or null when the values fit together. */
export function crossCheck(v) {
  if (v.maxBusySeconds > 0 && v.maxBusySeconds < v.idleSeconds) return 'The time a busy agent may keep running must be at least the idle time (or 0 to turn it off).';
  return null;
}

/**
 * Check one proposed value. Returns { ok: true, value } or { ok: false, error, message }.
 * `confirmed` is the caller's explicit yes to a value that turns a limit off or opens access up.
 */
export function validate(setting, raw, { confirmed = false } = {}) {
  if (setting.type === 'bool') {
    const value = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null;
    if (value === null) return { ok: false, error: 'not_a_bool', message: 'Choose on or off.' };
    if (value === setting.confirmWhen && !confirmed) return { ok: false, error: 'confirm_open', message: `${setting.confirmText} Confirm to continue.` };
    return { ok: true, value };
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,12}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'not_a_number', message: 'Enter a whole number, 0 or more.' };
  if (n === 0 && setting.zero) {
    if (!confirmed) return { ok: false, error: 'confirm_zero', message: `0 means ${setting.zero}: this turns the limit off. Confirm to continue.` };
    return { ok: true, value: 0 };
  }
  if (n < setting.min || n > setting.max) return { ok: false, error: 'out_of_range', message: `Use ${setting.zero ? `0 (${setting.zero}) or ` : ''}a value from ${setting.min} to ${setting.max}.` };
  return { ok: true, value: n };
}

/** Same shape as the llm-proxy's policies, over the gateway's configuration and database. */
export function createPolicies({ cfg, store, log = () => {} }) {
  const defaults = Object.fromEntries(POLICIES.map((p) => [p.key, cfg[p.key]]));
  const overrides = new Map(); // key -> { value, updatedAt, updatedBy }

  const effective = (extra = {}) => ({ ...Object.fromEntries(POLICIES.map((p) => [p.key, overrides.get(p.key)?.value ?? defaults[p.key]])), ...extra });
  const apply = () => {
    for (const p of POLICIES) cfg[p.key] = overrides.get(p.key)?.value ?? defaults[p.key];
  };
  const decode = (setting, stored) => (setting.type === 'bool' ? stored === 1 : stored);

  /** Read the stored overrides and apply them. A value that no longer passes the checks is ignored and logged. */
  function load() {
    overrides.clear();
    for (const row of store.policyOverrides()) {
      const setting = policyOf(row.key);
      const value = setting ? decode(setting, row.value) : null;
      if (!setting || !validate(setting, value, { confirmed: true }).ok) {
        log(`policy: ignoring the stored value for "${row.key}" (it is not valid for this version)`);
        continue;
      }
      overrides.set(row.key, { value, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
    }
    const conflict = crossCheck(effective());
    if (conflict) {
      log(`policy: the stored values conflict (${conflict}); using the defaults`);
      overrides.clear();
    }
    apply();
  }

  const encode = (setting, value) => (setting.type === 'bool' ? (value ? 1 : 0) : value);
  return {
    load,
    list: () => POLICIES.map((p) => ({ scope: 'gateway', ...p, default: defaults[p.key], value: cfg[p.key], source: overrides.has(p.key) ? 'admin' : 'default', updatedAt: overrides.get(p.key)?.updatedAt ?? null, updatedBy: overrides.get(p.key)?.updatedBy ?? null })),
    /** Change one value. Returns { ok: true, from, to } or { ok: false, status, error, message }. */
    set(key, raw, { confirmed = false, by = null } = {}) {
      const setting = policyOf(key);
      if (!setting) return { ok: false, status: 404, error: 'not_found', message: 'No such setting.' };
      const v = validate(setting, raw, { confirmed });
      if (!v.ok) return { ...v, status: 400 };
      const conflict = crossCheck(effective({ [key]: v.value }));
      if (conflict) return { ok: false, status: 400, error: 'conflict', message: conflict };
      const from = cfg[key];
      store.setPolicy(key, encode(setting, v.value), by);
      overrides.set(key, { value: v.value, updatedAt: Date.now(), updatedBy: by });
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
