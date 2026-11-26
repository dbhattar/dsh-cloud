// The sentences of the welcome screen that depend on the configured limits. Plain functions, so they are tested without a browser.

/** The limits as plain settings, from /gw/api/limits (0 means no limit). */
export interface Policy { idleSeconds: number; maxBusySeconds: number; maxRunSeconds: number; maxDiskMb: number }
export interface Tokens { day: { limit: number | null }; month: { limit: number | null } }

const number = new Intl.NumberFormat('en');
function span(seconds: number): string {
  if (seconds >= 3600) { const h = Math.round((seconds / 3600) * 10) / 10; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}
const size = (mb: number) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${number.format(mb)} MB`);

/** What the welcome says about limits, in one sentence, from only the limits that are actually set. */
export function limitsSentence(policy: Policy | null, tokens: Tokens | null): string {
  const parts: string[] = [];
  if (tokens?.day.limit) parts.push(`model use of ${number.format(tokens.day.limit)} tokens a day${tokens.month.limit ? ` (${number.format(tokens.month.limit)} a month)` : ''}`);
  if (policy?.maxDiskMb) parts.push(`${size(policy.maxDiskMb)} of storage`);
  if (policy?.maxRunSeconds) parts.push(`up to ${span(policy.maxRunSeconds)} of running time at a stretch`);
  if (parts.length === 0) return 'There are no usage limits on your account at the moment.';
  return `Your account has ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts.at(-1)}.`;
}

/** What the welcome says about pausing, from the idle and busy settings. */
export function pauseSentence(policy: Policy | null): string {
  if (!policy?.idleSeconds) return 'Your files, sessions and settings are kept between visits.';
  const busy = policy.maxBusySeconds > policy.idleSeconds ? `, or after up to ${span(policy.maxBusySeconds)} if the agent is still busy working` : '';
  return `Your files, sessions and settings are kept between visits. When you step away, your workspace pauses after ${span(policy.idleSeconds)} without activity${busy}, and starts again when you come back.`;
}

