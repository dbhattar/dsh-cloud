// Operator commands, run inside the gateway container (see scripts/invite.sh):
//   node src/cli.js invite create [count] [--note TEXT] [--days N] [--link]
//   node src/cli.js invite list
//   node src/cli.js audit [--user ID] [--event NAME|PREFIX.] [--since 24h|7d] [--limit N] [--json]
import { join } from 'node:path';
import { parseSpan } from './audit.js';
import { Store } from './db.js';

const [, , area, action, ...tail] = process.argv;
// `audit` takes only flags, so its first flag lands in `action`: treat it as part of the arguments.
const rest = area === 'audit' && action !== undefined ? [action, ...tail] : tail;
const store = new Store(join(process.env.DATA_DIR || '/data', 'gateway.db'));
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (area === 'invite' && action === 'create') {
  const count = Math.min(100, Math.max(1, Number.parseInt(rest.find((a) => /^\d+$/.test(a)) ?? '1', 10)));
  // --link prints each code as a sign-up link (PUBLIC_URL is set in the gateway's environment) instead of the bare code.
  const base = rest.includes('--link') ? new URL('gw/signup', process.env.PUBLIC_URL || 'https://localhost/').href : null;
  for (let i = 0; i < count; i++) {
    const code = store.createInvite({ note: flag('--note') ?? '', ttlDays: Number.parseInt(flag('--days') ?? '0', 10) || 0 });
    console.log(base ? `${base}?invite=${encodeURIComponent(code)}` : code);
  }
  store.addAudit({ event: 'admin.invite_create', detail: { count, note: flag('--note') ?? '', via: 'cli' } });
} else if (area === 'invite' && action === 'list') {
  const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '-');
  for (const i of store.listInvites()) console.log(`${i.usedBy ? `used by user ${i.usedBy} ${when(i.usedAt)}` : 'unused'.padEnd(10)}  created ${when(i.createdAt)}  expires ${when(i.expiresAt)}  ${i.note}`);
} else if (area === 'audit') {
  const span = flag('--since') ? parseSpan(flag('--since')) : null;
  if (flag('--since') && !span) (console.error('--since must look like 90m, 24h or 7d'), process.exit(2));
  const userId = flag('--user') === undefined ? undefined : Number.parseInt(flag('--user'), 10);
  const rows = store.queryAudit({ userId, event: flag('--event'), since: span ? Date.now() - span : undefined, limit: Number.parseInt(flag('--limit') ?? '50', 10) || 50 });
  for (const r of rows.reverse()) {
    if (rest.includes('--json')) console.log(JSON.stringify({ ...r, ts: new Date(r.ts).toISOString() }));
    else console.log(`${new Date(r.ts).toISOString().slice(0, 19).replace('T', ' ')}  ${r.event.padEnd(18)} user=${String(r.userId ?? '-').padEnd(4)} ip=${String(r.ip ?? '-').padEnd(15)} ${Object.keys(r.detail).length ? JSON.stringify(r.detail) : ''}`);
  }
} else {
  console.error('usage: cli.js invite create [count] [--note TEXT] [--days N] [--link] | invite list | audit [--user ID] [--event NAME] [--since 24h] [--limit N] [--json]');
  process.exit(2);
}
