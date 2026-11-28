// P5-8: what the gateway does with mail: password reset, emailed invites, the "your workspace finished" notice and its opt-out.
// A capturing provider stands in for Mailgun (the provider itself is in mail.test.mjs). No Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Audit } from '../../gateway/src/audit.js';
import { hashPassword, verifyPassword } from '../../gateway/src/auth.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createMailer } from '../../gateway/src/mail.js';
import { createMailFlows } from '../../gateway/src/mail-flows.js';
import { createRecordsApi } from '../../gateway/src/admin-records.js';
import { SandboxManager } from '../../gateway/src/sandbox.js';
import { createGateway } from '../../gateway/src/server.js';

const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const mg = { MAIL_PROVIDER: 'mailgun', MAILGUN_API_KEY: 'key-abc', MAILGUN_DOMAIN: 'mg.example.com', MAIL_FROM: 'dsh-cloud <noreply@mg.example.com>' };
const OLD = 'old-password-123';
const NEW = 'brand-new-password-456';

const opened = [];
after(() => opened.forEach((s) => { s.closeAllConnections(); s.close(); })); // even when a test failed before its own close

async function gateway(env = mg, { real = true } = {}) {
  const cfg = loadConfig({ ...base, ...env });
  const store = new Store(':memory:');
  const lines = [];
  const audit = new Audit({ store, log: (l) => lines.push(l) });
  const sent = [];
  const mailer = createMailer({ cfg, audit, log: (l) => lines.push(l), sleep: async () => {}, provider: { name: 'capture', real, deliver: async (m) => { sent.push(m); } } });
  const server = createGateway({ cfg, store, manager: { touch() {}, releaseUserHold() {}, ready: async () => null, ensure: () => Promise.resolve(), status: () => ({}) }, log: (l) => lines.push(l), audit, mailer });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  opened.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const form = (path, fields, headers = {}) => fetch(url + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://localhost', ...headers }, body: new URLSearchParams(fields) });
  const user = (email = 'ann@example.com', pw = OLD) => ({ email, id: store.createUser(email, hashPassword(pw)) });
  const flush = () => mailer.flush();
  const audits = () => store.queryAudit({ limit: 500 });
  return { cfg, store, server, url, form, user, sent, lines, flush, audits, mailer, audit, close: () => { server.closeAllConnections(); server.close(); } };
}
const tokenIn = (text) => /gw\/reset\?token=([\w-]+)/.exec(text)[1];
const login = (g, email, password) => g.form('/gw/login', { email, password });

test('mail off (the default): the sign-in page has no reset link, and /gw/forgot says it is not set up and sends nothing', async () => {
  const g = await gateway(base, { real: false });
  g.user();
  assert.doesNotMatch(await (await fetch(`${g.url}/gw/login`)).text(), /"canReset":true/);
  assert.match(await (await fetch(`${g.url}/gw/forgot`)).text(), /"available":false/);
  const r = await g.form('/gw/forgot', { email: 'ann@example.com' });
  assert.match(await r.text(), /"available":false/);
  await g.flush();
  assert.equal(g.sent.length, 0);
  g.close();
});

test('mail on: the sign-in page offers the reset link', async () => {
  const g = await gateway();
  assert.match(await (await fetch(`${g.url}/gw/login`)).text(), /"canReset":true/);
  g.close();
});

test('asking for a reset: the page says the same thing for a known and an unknown address, and only a real account gets a message', async () => {
  const g = await gateway();
  g.user();
  const known = await g.form('/gw/forgot', { email: 'ann@example.com' });
  const unknown = await g.form('/gw/forgot', { email: 'nobody@example.com' });
  assert.equal(known.status, unknown.status);
  assert.equal(await known.text(), await unknown.text(), 'identical pages');
  await g.flush();
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].to, 'ann@example.com');
  assert.match(g.sent[0].text, /^Someone asked to reset/);
  assert.match(g.sent[0].text, /https:\/\/localhost\/gw\/reset\?token=[\w-]{40,}/);
  const rows = g.audits().filter((a) => a.event === 'password.reset_request');
  assert.deepEqual(rows.map((r) => r.detail.known).sort(), [false, true]);
  g.close();
});

test('a suspended account is not mailed a link, and the answer does not change', async () => {
  const g = await gateway();
  const { id } = g.user();
  g.store.suspendUser(id);
  assert.match(await (await g.form('/gw/forgot', { email: 'ann@example.com' })).text(), /"sent":true/);
  await g.flush();
  assert.equal(g.sent.length, 0);
  g.close();
});

test('the whole reset: link, new password, old password and old sessions stop working, the link works once, a notice goes out', async () => {
  const g = await gateway();
  const { id } = g.user();
  const cookie = (await login(g, 'ann@example.com', OLD)).headers.get('set-cookie').split(';')[0];
  assert.ok(g.store.userBySession(cookie.split('=')[1]), 'signed in');
  await g.form('/gw/forgot', { email: 'ann@example.com' });
  await g.flush();
  const token = tokenIn(g.sent[0].text);
  const page = await fetch(`${g.url}/gw/reset?token=${token}`);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin', 'a page with a secret in its address never sends its path as a referrer');
  assert.match(await page.text(), /"status":"valid"/);
  const done = await g.form('/gw/reset', { token, password: NEW, confirm: NEW });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), '/gw/login?reset=1');
  assert.equal(g.store.userBySession(cookie.split('=')[1]), null, 'the old session ended');
  assert.equal((await login(g, 'ann@example.com', OLD)).status, 401);
  assert.equal((await login(g, 'ann@example.com', NEW)).status, 303);
  assert.ok(verifyPassword(NEW, g.store.userById(id).pw_hash));
  // single use
  const again = await g.form('/gw/reset', { token, password: 'another-password-789', confirm: 'another-password-789' });
  assert.equal(again.status, 400);
  assert.match(await again.text(), /"status":"used"/);
  assert.equal((await login(g, 'ann@example.com', NEW)).status, 303, 'the second attempt changed nothing');
  await g.flush();
  assert.equal(g.sent.at(-1).subject, 'Your dsh-cloud password was changed');
  assert.match(await (await fetch(`${g.url}/gw/login?reset=1`)).text(), /Your password was changed/);
  g.close();
});

test('the reset form posts from the page it was served on: the same-origin check accepts the real Origin, and refuses null (which no-referrer would cause)', async () => {
  const g = await gateway();
  g.user();
  await g.form('/gw/forgot', { email: 'ann@example.com' });
  await g.flush();
  const token = tokenIn(g.sent[0].text);
  assert.equal((await g.form('/gw/reset', { token, password: NEW, confirm: NEW }, { origin: 'null' })).status, 403);
  assert.equal(g.store.resetTokenStatus(token), 'valid', 'a refused post does not use the link');
  assert.equal((await g.form('/gw/reset', { token, password: NEW, confirm: NEW })).status, 303);
  g.close();
});

test('a typo does not use up the link: a short or mismatched password is refused and the link still works', async () => {
  const g = await gateway();
  g.user();
  await g.form('/gw/forgot', { email: 'ann@example.com' });
  await g.flush();
  const token = tokenIn(g.sent[0].text);
  const short = await g.form('/gw/reset', { token, password: 'short', confirm: 'short' });
  assert.equal(short.status, 400);
  assert.match(await short.text(), /Password must be 10-200/);
  const diff = await g.form('/gw/reset', { token, password: NEW, confirm: `${NEW}x` });
  assert.equal(diff.status, 400);
  assert.match(await diff.text(), /not the same/);
  assert.equal(g.store.resetTokenStatus(token), 'valid');
  assert.equal((await g.form('/gw/reset', { token, password: NEW, confirm: NEW })).status, 303);
  g.close();
});

test('expiry: a link stops working after MAIL_RESET_MINUTES, and a newer link replaces the older one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  const g = await gateway({ ...mg, MAIL_RESET_MINUTES: '30' });
  g.user();
  await g.form('/gw/forgot', { email: 'ann@example.com' });
  await g.flush();
  const first = tokenIn(g.sent[0].text);
  t.mock.timers.tick(29 * 60_000);
  assert.equal(g.store.resetTokenStatus(first), 'valid');
  t.mock.timers.tick(2 * 60_000);
  assert.equal(g.store.resetTokenStatus(first), 'expired');
  const late = await g.form('/gw/reset', { token: first, password: NEW, confirm: NEW });
  assert.equal(late.status, 400);
  assert.match(await late.text(), /"status":"expired"/);
  await g.form('/gw/forgot', { email: 'ann@example.com' });
  await g.flush();
  await g.form('/gw/forgot', { email: 'ann@example.com' });
  await g.flush();
  const [, second, third] = g.sent.map((m) => tokenIn(m.text));
  assert.equal(g.store.resetTokenStatus(second), 'used', 'replaced by the newest');
  assert.equal(g.store.resetTokenStatus(third), 'valid');
  g.close();
});

test('using a link is atomic: of two uses at the same moment exactly one wins (the database decides, not the earlier look)', () => {
  const store = new Store(':memory:');
  const id = store.createUser('ann@example.com', hashPassword(OLD));
  const token = store.createResetToken(id, 60_000);
  assert.equal(store.consumeResetToken(token), id);
  assert.equal(store.consumeResetToken(token), null);
  assert.equal(store.consumeResetToken('nope'), null);
  assert.equal(store.consumeResetToken(store.createResetToken(id, -1)), null, 'an expired one is never accepted');
});

test('unknown and malformed tokens are refused and say nothing about accounts', async () => {
  const g = await gateway();
  for (const token of ['', 'nope', 'x'.repeat(500), '../etc']) {
    const r = await g.form('/gw/reset', { token, password: NEW, confirm: NEW });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /"status":"unknown"/);
  }
  g.close();
});

test('abuse: reset requests are limited per caller, lookups of links too; the message limit per address holds', async () => {
  const g = await gateway(mg);
  g.user();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await g.form('/gw/forgot', { email: `u${i}@example.com` })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429], 'five an hour per caller, every request counted');
  const g2 = await gateway({ ...mg, MAIL_MAX_PER_ADDRESS_HOUR: '2' });
  g2.user();
  for (let i = 0; i < 4; i++) await g2.form('/gw/forgot', { email: 'ann@example.com' }, { 'x-forwarded-for': `10.0.0.${i}` });
  await g2.flush();
  assert.equal(g2.sent.length, 2, 'two messages to one address in the hour, however many callers ask');
  const g3 = await gateway(mg);
  let last;
  for (let i = 0; i < 22; i++) last = (await fetch(`${g3.url}/gw/reset?token=guess${i}`)).status;
  assert.equal(last, 429);
  [g, g2, g3].forEach((x) => x.close());
});

test('nothing secret reaches the audit trail or the log: no token, no link, no address in a reset request', async () => {
  const g = await gateway();
  g.user();
  await g.form('/gw/forgot', { email: 'ann@example.com' });
  await g.flush();
  const token = tokenIn(g.sent[0].text);
  await g.form('/gw/reset', { token, password: NEW, confirm: NEW });
  await g.flush();
  const everything = JSON.stringify([g.lines, g.audits()]);
  for (const secret of [token, NEW, OLD, 'gw/reset?token', 'key-abc']) assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 8)}`);
  assert.ok(!/ann@example\.com/.test(JSON.stringify(g.audits().filter((a) => a.event.startsWith('mail.') || a.event.startsWith('password.')))), 'no address in the mail or password rows');
  g.close();
});

test('invites by email: the admin API mails one invite, refuses when mail is off or the address is bad, and creates nothing when it refuses', async () => {
  const g = await gateway();
  const admin = { id: 1 };
  const api = createRecordsApi({ store: g.store, cfg: g.cfg, audit: g.audit, mail: createMailFlows({ cfg: g.cfg, store: g.store, mailer: g.mailer, audit: g.audit }) });
  const before = g.store.listInvites().length;
  assert.equal(api.invites.create({ email: 'not-an-address', admin, ip: 'x' }).status, 400);
  assert.equal(api.invites.create({ email: 'bob@example.com', count: 2, admin, ip: 'x' }).status, 400);
  assert.equal(g.store.listInvites().length, before, 'refusals created nothing');
  const ok = api.invites.create({ email: 'Bob@Example.com', days: 3, note: 'bob', admin, ip: 'x' });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json.emailed, { queued: true });
  assert.equal(ok.json.mailEnabled, true);
  await g.flush();
  assert.equal(g.sent[0].to, 'bob@example.com');
  assert.equal(g.sent[0].text.includes(ok.json.created[0].link), true, 'the message carries the sign-up link');
  assert.match(g.sent[0].text, /valid for 3 days/);
  assert.equal(g.store.inviteStatus(ok.json.created[0].code), 'valid');
  assert.ok(!JSON.stringify(g.audits()).includes(ok.json.created[0].code), 'the code is in the message and the answer only');
  const off = await gateway(base, { real: false });
  const offApi = createRecordsApi({ store: off.store, cfg: off.cfg, audit: off.audit, mail: createMailFlows({ cfg: off.cfg, store: off.store, mailer: off.mailer, audit: off.audit }) });
  const refused = offApi.invites.create({ email: 'bob@example.com', admin, ip: 'x' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'mail_off');
  assert.equal(off.store.listInvites().length, 0);
  assert.equal(offApi.invites.create({ admin, ip: 'x' }).status, 201, 'without an address it still works when mail is off');
  [g, off].forEach((x) => x.close());
});

test('the task-finished notice: at most one per window, never when opted out, never when mail or the setting is off', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  const g = await gateway({ ...mg, MAIL_TASK_NOTICE_HOURS: '6' });
  const { id } = g.user();
  const flows = createMailFlows({ cfg: g.cfg, store: g.store, mailer: g.mailer, audit: g.audit });
  assert.equal(flows.taskFinished(id).queued, true);
  assert.deepEqual(flows.taskFinished(id), { queued: false, reason: 'too_soon' });
  t.mock.timers.tick(6 * 3600_000 + 1);
  assert.equal(flows.taskFinished(id).queued, true);
  await g.flush();
  assert.equal(g.sent.length, 2);
  assert.match(g.sent[0].text, /stopped working while you were away/);
  assert.match(g.sent[0].text, /\/gw\/mail\/stop\?u=\d+&t=[\w-]+/);
  g.store.setMailNotices(id, false);
  t.mock.timers.tick(7 * 3600_000);
  assert.deepEqual(flows.taskFinished(id), { queued: false, reason: 'opted_out' });
  const off = await gateway({ ...mg, MAIL_TASK_NOTICES: 'false' });
  const offFlows = createMailFlows({ cfg: off.cfg, store: off.store, mailer: off.mailer, audit: off.audit });
  assert.equal(offFlows.taskFinished(off.user().id).reason, 'off');
  const noMail = await gateway(base, { real: false });
  assert.equal(createMailFlows({ cfg: noMail.cfg, store: noMail.store, mailer: noMail.mailer, audit: noMail.audit }).taskFinished(noMail.user().id).reason, 'off');
  [g, off, noMail].forEach((x) => x.close());
});

test('opting out: the link in the message is signed; a forged or altered one does nothing; it asks first, then does it, and can be undone', async () => {
  const g = await gateway();
  const { id } = g.user();
  const other = g.user('bo@example.com').id;
  const flows = createMailFlows({ cfg: g.cfg, store: g.store, mailer: g.mailer, audit: g.audit });
  flows.taskFinished(id);
  await g.flush();
  const [, u, t] = /mail\/stop\?u=(\d+)&t=([\w-]+)/.exec(g.sent[0].text);
  // a link on its own (a mail scanner opening it) changes nothing
  const look = await fetch(`${g.url}/gw/mail/stop?u=${u}&t=${t}`);
  assert.equal(look.status, 200);
  assert.match(await look.text(), /Stop these emails\?/);
  assert.equal(g.store.mailNotices(id), true, 'opening the link is not enough');
  // forged: someone else's id with this signature, a changed signature, no signature
  for (const bad of [`u=${other}&t=${t}`, `u=${u}&t=${t}x`, `u=${u}`, `u=abc&t=${t}`]) {
    const r = await fetch(`${g.url}/gw/mail/stop?${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal((await g.form('/gw/mail/stop', Object.fromEntries(new URLSearchParams(bad)))).status, 400, `post ${bad}`);
  }
  assert.equal(g.store.mailNotices(other), true);
  const done = await g.form('/gw/mail/stop', { u, t });
  assert.equal(done.status, 200);
  assert.equal(g.store.mailNotices(id), false);
  assert.equal(g.store.mailNotices(other), true, 'only that user');
  assert.deepEqual(g.audits().filter((a) => a.event === 'mail.opt_out').map((a) => a.userId), [id]);
  assert.equal(flows.taskFinished(id).reason, 'opted_out');
  await g.form('/gw/mail/stop', { u, t, on: '1' });
  assert.equal(g.store.mailNotices(id), true);
  g.close();
});

test('the sandbox manager tells the mail when an agent that was kept running finishes; a plain idle stop and a busy-cap stop do not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  const cfg = loadConfig({ ...base, IDLE_SECONDS: '100', MAX_BUSY_SECONDS: '1000', BUSY_SIGNAL_SECONDS: '60' });
  const state = { users: [], boxes: new Map([[1, true]]) };
  const runner = {
    async list() { return [...state.boxes].map(([userId, running]) => ({ userId, running })); },
    async activity() { return { cpuNs: 0, memBytes: 1 }; },
    async stop(id) { state.boxes.set(id, false); },
    async info() { return { running: true, startedAt: 'x' }; },
  };
  const llm = { async activity() { return { users: state.users }; } };
  const m = new SandboxManager({ runner, cfg, log: () => {}, llm, audit: { record() {} } });
  const finished = [];
  m.onAgentFinished = (id) => finished.push(id);
  m.touch(1);
  t.mock.timers.tick(150_000);
  state.users = [{ userId: 1, inflight: 1, lastAt: new Date().toISOString() }];
  await m.reap();
  assert.deepEqual(finished, [], 'still working: kept, no notice');
  state.users = [];
  t.mock.timers.tick(200_000);
  await m.reap();
  assert.deepEqual(finished, [1], 'it went quiet and was stopped: one notice');
  // never busy: an ordinary idle stop is not "a task finished"
  state.boxes.set(1, true);
  m.touch(1);
  t.mock.timers.tick(150_000);
  await m.reap();
  assert.deepEqual(finished, [1]);
  // a listener that throws does not break the reaper
  m.onAgentFinished = () => { throw new Error('boom'); };
  state.boxes.set(1, true);
  m.touch(1);
  t.mock.timers.tick(150_000);
  state.users = [{ userId: 1, inflight: 1, lastAt: new Date().toISOString() }];
  await m.reap();
  state.users = [];
  t.mock.timers.tick(200_000);
  await assert.doesNotReject(m.reap());
});

test('invites by email through the real admin route: the panel lists whether mail is on, and an emailed invite arrives with its link', async () => {
  const g = await gateway();
  const admin = g.user('admin@example.com', OLD).id;
  g.store.setAdmin('admin@example.com', true);
  const cookie = `gw_session=${g.store.createSession(admin, 600)}`;
  const page = await (await fetch(`${g.url}/gw/admin`, { headers: { cookie } })).text();
  const csrf = JSON.parse(/<script id="gw-boot" type="application\/json">(.*?)<\/script>/s.exec(page)[1]).csrf;
  const post = (body) => fetch(`${g.url}/gw/admin/api/invites`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, origin: 'https://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(`${g.url}/gw/admin/api/invites`, { headers: { cookie } })).json()).mailEnabled, true);
  const r = await post({ email: 'new.person@example.com', days: 5 });
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.deepEqual(out.emailed, { queued: true });
  await g.flush();
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].to, 'new.person@example.com');
  assert.ok(g.sent[0].text.includes(out.created[0].link));
  assert.equal((await post({ email: 'nope' })).status, 400);
  g.close();
  const off = await gateway(base, { real: false });
  const adm = off.user('admin@example.com', OLD).id;
  off.store.setAdmin('admin@example.com', true);
  const c2 = `gw_session=${off.store.createSession(adm, 600)}`;
  assert.equal((await (await fetch(`${off.url}/gw/admin/api/invites`, { headers: { cookie: c2 } })).json()).mailEnabled, false);
});

// ---- the waitlist ----
const waitSigIn = (text) => /gw\/waitlist\/confirm\?e=([^&\s]+)&t=([\w-]+)/.exec(text);

test('waitlist: only offered where an invite is needed; the sign-in page links to it', async () => {
  const g = await gateway();
  assert.match(await (await fetch(`${g.url}/gw/login`)).text(), /"canJoinWaitlist":true/);
  assert.equal((await fetch(`${g.url}/gw/waitlist`)).status, 200);
  const open = await gateway({ ...mg, ALLOW_SIGNUP: 'true' });
  assert.match(await (await fetch(`${open.url}/gw/login`)).text(), /"canJoinWaitlist":false/);
  assert.notEqual((await fetch(`${open.url}/gw/waitlist`, { redirect: 'manual' })).status, 200, 'open sign-up has no waitlist page');
  await open.form('/gw/waitlist', { email: 'a@b.co' });
  assert.equal(open.store.listWaitlist().length, 0, 'nothing is stored where sign-up is open');
});

test('waitlist: joining says the same to everyone; only a new address is stored and asked to confirm; no address in the trail', async () => {
  const g = await gateway();
  g.user('member@example.com');
  const a = await g.form('/gw/waitlist', { email: 'Wait@Example.com' });
  const b = await g.form('/gw/waitlist', { email: 'wait@example.com' }); // again
  const c = await g.form('/gw/waitlist', { email: 'member@example.com' }); // already has an account
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  const [ta, tb, tc] = [await a.text(), await b.text(), await c.text()];
  assert.equal(ta, tb);
  assert.equal(ta, tc, 'the same page for a new address, a repeat and an existing account');
  await g.flush();
  assert.deepEqual(g.store.listWaitlist().map((e) => e.email), ['wait@example.com'], 'stored once, lower case; the account holder is not added');
  assert.equal(g.sent.length, 2, 'a confirmation for the new address and a resend on the repeat that never confirmed; nothing for the account holder');
  assert.ok(g.sent.every((m) => m.to === 'wait@example.com'));
  assert.match(g.sent[0].subject, /Confirm your place/);
  assert.deepEqual(g.audits().filter((x) => x.event === 'waitlist.join').map((x) => x.detail.result).sort(), ['exists', 'exists', 'new']);
  assert.ok(!/wait@example\.com|member@example\.com/.test(JSON.stringify(g.audits().filter((x) => x.event.startsWith('waitlist.')))), 'no address in the waitlist rows');
  assert.equal((await g.form('/gw/waitlist', { email: 'not-an-address' })).status, 400);
});

test('waitlist: asking again resends the confirmation until it is confirmed, then stops (and a mail limit still holds)', async () => {
  const g = await gateway({ ...mg, MAIL_MAX_PER_ADDRESS_HOUR: '3' });
  for (let i = 0; i < 3; i++) await g.form('/gw/waitlist', { email: 'wait@example.com' }, { 'x-forwarded-for': `10.1.0.${i}` });
  await g.flush();
  assert.equal(g.sent.length, 3);
  g.store.confirmWaitlist('wait@example.com');
  await g.form('/gw/waitlist', { email: 'wait@example.com' }, { 'x-forwarded-for': '10.1.0.9' });
  await g.flush();
  assert.equal(g.sent.length, 3, 'a confirmed address is not mailed again');
  const h = await gateway({ ...mg, MAIL_MAX_PER_ADDRESS_HOUR: '2' });
  for (let i = 0; i < 4; i++) await h.form('/gw/waitlist', { email: 'wait@example.com' }, { 'x-forwarded-for': `10.2.0.${i}` });
  await h.flush();
  assert.equal(h.sent.length, 2, 'the per-address limit bounds the resends');
});

test('waitlist without mail: the entry is kept, nothing is mailed, and the page does not promise a confirmation', async () => {
  const g = await gateway(base, { real: false });
  const r = await g.form('/gw/waitlist', { email: 'wait@example.com' });
  const text = await r.text();
  assert.match(text, /"done":true/);
  assert.match(text, /"confirmMail":false/);
  assert.equal(g.store.listWaitlist().length, 1);
  await g.flush();
  assert.equal(g.sent.length, 0);
});

test('waitlist confirmation: opening the link only asks; the button confirms; a forged or altered link does nothing', async () => {
  const g = await gateway();
  await g.form('/gw/waitlist', { email: 'wait@example.com' });
  await g.flush();
  const [, e, t] = waitSigIn(g.sent[0].text);
  const look = await fetch(`${g.url}/gw/waitlist/confirm?e=${e}&t=${t}`);
  assert.equal(look.status, 200);
  assert.match(await look.text(), /Confirm your place/);
  assert.equal(g.store.waitlistEntry('wait@example.com').confirmedAt, null, 'opening it is not enough');
  for (const bad of [`e=${e}&t=${t}x`, `e=other%40example.com&t=${t}`, `e=${e}`]) assert.equal((await fetch(`${g.url}/gw/waitlist/confirm?${bad}`)).status, 400, bad);
  assert.equal((await g.form('/gw/waitlist/confirm', { e: decodeURIComponent(e), t })).status, 200);
  const first = g.store.waitlistEntry('wait@example.com').confirmedAt;
  assert.ok(first);
  await g.form('/gw/waitlist/confirm', { e: decodeURIComponent(e), t });
  assert.equal(g.store.waitlistEntry('wait@example.com').confirmedAt, first, 'confirming twice changes nothing');
});

test('waitlist abuse: five requests an hour per caller, and the list is capped', async () => {
  const g = await gateway();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await g.form('/gw/waitlist', { email: `p${i}@example.com` })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  const store = new Store(':memory:');
  assert.equal(store.joinWaitlist('a@x.co', 1, 2), 'new');
  assert.equal(store.joinWaitlist('b@x.co', 2, 2), 'new');
  assert.equal(store.joinWaitlist('c@x.co', 3, 2), 'full');
  assert.equal(store.joinWaitlist('a@x.co', 4, 2), 'exists');
});

test('inviting from the waitlist: only a confirmed address, only with mail on; the invite is mailed, the entry marked, and signing up takes the person off the list', async () => {
  const g = await gateway();
  const admin = { id: 1 };
  const api = createRecordsApi({ store: g.store, cfg: g.cfg, audit: g.audit, mail: createMailFlows({ cfg: g.cfg, store: g.store, mailer: g.mailer, audit: g.audit }) });
  g.store.joinWaitlist('wait@example.com');
  assert.equal(api.waitlist.invite({ email: 'nobody@example.com', admin, ip: 'x' }).status, 404);
  const early = api.waitlist.invite({ email: 'wait@example.com', admin, ip: 'x' });
  assert.equal(early.status, 409);
  assert.equal(early.json.error, 'not_confirmed');
  assert.equal(g.store.listInvites().length, 0, 'no invite was created for an unconfirmed address');
  g.store.confirmWaitlist('wait@example.com');
  const ok = api.waitlist.invite({ email: 'wait@example.com', days: 3, admin, ip: 'x' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.sent, { queued: true });
  assert.ok(ok.json.entries[0].invitedAt);
  await g.flush();
  assert.equal(g.sent.at(-1).to, 'wait@example.com');
  const code = /invite=([\w-]+)/.exec(g.sent.at(-1).text)[1];
  assert.equal(g.store.inviteStatus(code), 'valid');
  // they sign up with it: off the list
  const up = await g.form('/gw/signup', { email: 'wait@example.com', password: 'a-long-password-1', invite: code });
  assert.equal(up.status, 303);
  assert.equal(g.store.waitlistEntry('wait@example.com'), null);
  g.store.joinWaitlist('x@example.com');
  assert.equal(api.waitlist.remove({ email: 'x@example.com', admin, ip: 'x' }).status, 200);
  assert.equal(api.waitlist.remove({ email: 'x@example.com', admin, ip: 'x' }).status, 404);
  assert.ok(!/@example\.com/.test(JSON.stringify(g.audits().filter((x) => x.event.startsWith('admin.waitlist')))), 'no address in the admin rows');
  const off = await gateway(base, { real: false });
  off.store.joinWaitlist('w@example.com');
  off.store.confirmWaitlist('w@example.com');
  const offApi = createRecordsApi({ store: off.store, cfg: off.cfg, audit: off.audit, mail: createMailFlows({ cfg: off.cfg, store: off.store, mailer: off.mailer, audit: off.audit }) });
  assert.equal(offApi.waitlist.invite({ email: 'w@example.com', admin, ip: 'x' }).json.error, 'mail_off');
});

test('the waitlist admin routes need an admin, like every admin route', async () => {
  const g = await gateway();
  g.store.joinWaitlist('wait@example.com');
  const user = g.user('plain@example.com').id;
  const cookie = `gw_session=${g.store.createSession(user, 600)}`;
  for (const [method, path] of [['GET', '/gw/admin/api/waitlist'], ['POST', '/gw/admin/api/waitlist/invite'], ['POST', '/gw/admin/api/waitlist/remove'], ['GET', '/gw/admin/waitlist']]) {
    const r = await fetch(g.url + path, { method, headers: { cookie, origin: 'https://localhost', 'content-type': 'application/json' }, body: method === 'POST' ? '{"email":"wait@example.com"}' : undefined, redirect: 'manual' });
    assert.ok([403, 404].includes(r.status), `${method} ${path} -> ${r.status}`);
  }
  assert.equal(g.store.listWaitlist().length, 1);
});
