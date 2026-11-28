// P5-8: the mail provider layer against a fake Mailgun HTTP server: request shape, auth, retries, permanent failures, limits, and that
// no secret or address reaches the audit trail or the log. No Docker, no network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Audit } from '../../gateway/src/audit.js';
import { loadConfig } from '../../gateway/src/config.js';
import { Store } from '../../gateway/src/db.js';
import { createMailer } from '../../gateway/src/mail.js';

const KEY = 'key-0123456789abcdef-SECRET';
const base = { PUBLIC_URL: 'https://localhost/', RUNNER_URL: 'http://sandbox-runner:8090', RUNNER_SECRET: 'runner-secret-0123456789' };
const mg = { MAIL_PROVIDER: 'mailgun', MAILGUN_API_KEY: KEY, MAILGUN_DOMAIN: 'mg.example.com', MAIL_FROM: 'dsh-cloud <noreply@mg.example.com>' };
const MSG = { kind: 'reset', to: 'Person@Example.com', userId: 7, subject: 'Reset your password SUBJECTMARK', text: 'Open https://localhost/gw/reset?token=TOKENMARK' };

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); })); // even when a test failed before closing its own

/** A fake Mailgun: answers each request with the next scripted status and records what it was sent. */
async function fakeMailgun(script = [200]) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())) });
      const status = script[Math.min(requests.length - 1, script.length - 1)];
      if (status === 'hang') return; // never answers
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status < 300 ? { id: '<x@mg>', message: 'Queued. Thank you.' } : { message: status === 401 ? 'Forbidden' : 'Try later' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

function setup(extraEnv = {}, apiBase, mailerOpts = {}) {
  const cfg = loadConfig({ ...base, ...mg, ...(apiBase ? { MAILGUN_API_BASE: apiBase } : {}), ...extraEnv });
  const store = new Store(':memory:');
  const lines = [];
  const audit = new Audit({ store, log: (l) => lines.push(l) });
  const delays = [];
  const mailer = createMailer({ cfg, audit, log: (l) => lines.push(l), sleep: async (ms) => { delays.push(ms); }, ...mailerOpts });
  const events = () => store.queryAudit({ event: 'mail.', limit: 50 }).reverse();
  return { cfg, mailer, store, lines, delays, events, everything: () => JSON.stringify([lines, store.queryAudit({ limit: 500 })]) };
}

test('config: the default sends nothing; a provider needs what it needs; the key is not enumerable', () => {
  assert.equal(loadConfig(base).mail.provider, 'log');
  assert.throws(() => loadConfig({ ...base, MAIL_PROVIDER: 'smtp' }), /MAIL_PROVIDER must be one of/);
  assert.throws(() => loadConfig({ ...base, ...mg, MAILGUN_API_KEY: '' }), /MAILGUN_API_KEY is required/);
  assert.throws(() => loadConfig({ ...base, ...mg, MAILGUN_DOMAIN: 'nodot' }), /MAILGUN_DOMAIN/);
  assert.throws(() => loadConfig({ ...base, ...mg, MAIL_FROM: '' }), /MAIL_FROM is required/);
  assert.throws(() => loadConfig({ ...base, ...mg, MAILGUN_REGION: 'asia' }), /us or eu/);
  assert.throws(() => loadConfig({ ...base, MAIL_PROVIDER: 'outbox', MAIL_FROM: 'a@b.co' }), /MAIL_OUTBOX_DIR/);
  const cfg = loadConfig({ ...base, ...mg });
  assert.equal(cfg.mail.apiBase, 'https://api.mailgun.net');
  assert.equal(loadConfig({ ...base, ...mg, MAILGUN_REGION: 'EU' }).mail.apiBase, 'https://api.eu.mailgun.net');
  assert.ok(!JSON.stringify(cfg).includes(KEY), 'a printed config must not carry the key');
  assert.equal(cfg.mail.mailgunKey, KEY, 'but it is still there for the provider');
});

test('mailgun: the request has the documented shape, basic auth with the key, tracking off, and the address as given', async () => {
  const srv = await fakeMailgun([200]);
  const { mailer, events } = setup({}, srv.url);
  assert.deepEqual(mailer.send(MSG), { queued: true });
  await mailer.flush();
  const [r] = srv.requests;
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/v3/mg.example.com/messages');
  assert.equal(r.headers.authorization, `Basic ${Buffer.from(`api:${KEY}`).toString('base64')}`);
  assert.match(r.headers['content-type'], /application\/x-www-form-urlencoded/);
  assert.deepEqual(r.form, { from: 'dsh-cloud <noreply@mg.example.com>', to: 'Person@Example.com', subject: MSG.subject, text: MSG.text, 'o:tracking': 'no', 'o:tracking-clicks': 'no', 'o:tracking-opens': 'no' });
  assert.deepEqual(events().map((e) => [e.event, e.detail.kind, e.detail.attempts]), [['mail.sent', 'reset', 1]]);
  await srv.close();
});

test('send returns at once: delivery happens in the background, so a slow mail service never holds up a request', async () => {
  const srv = await fakeMailgun(['hang']);
  const { mailer } = setup({}, srv.url);
  const t0 = Date.now();
  assert.equal(mailer.send(MSG).queued, true);
  assert.ok(Date.now() - t0 < 100, 'did not wait for the provider');
  assert.equal(srv.requests.length, 0, 'nothing has been delivered yet in this tick');
  await srv.close();
});

test('a temporary failure is retried with a short delay and then succeeds; the audit says how many attempts it took', async () => {
  const srv = await fakeMailgun([500, 429, 200]);
  const { mailer, events, delays } = setup({}, srv.url);
  mailer.send(MSG);
  await mailer.flush();
  assert.equal(srv.requests.length, 3);
  assert.deepEqual(delays, [1000, 4000]);
  assert.deepEqual(events().map((e) => [e.event, e.detail.attempts]), [['mail.sent', 3]]);
  await srv.close();
});

test('giving up: after the last attempt the message is dropped and mail.failed says why, without the message', async () => {
  const srv = await fakeMailgun([503]);
  const { mailer, events, everything } = setup({}, srv.url);
  mailer.send(MSG);
  await mailer.flush();
  assert.equal(srv.requests.length, 3);
  const [e] = events();
  assert.equal(e.event, 'mail.failed');
  assert.deepEqual([e.detail.kind, e.detail.attempts, e.userId], ['reset', 3, 7]);
  assert.match(e.detail.reason, /^http_503/);
  assert.ok(!/TOKENMARK|SUBJECTMARK|example\.com|SECRET/i.test(everything().replace(/mg\.example\.com/g, '')), 'no content, address or key in the trail');
  await srv.close();
});

test('a permanent failure (a wrong key) is not retried, and the key is not in what is recorded', async () => {
  const srv = await fakeMailgun([401]);
  const { mailer, events, everything, delays } = setup({}, srv.url);
  mailer.send(MSG);
  await mailer.flush();
  assert.equal(srv.requests.length, 1, 'one request, no retry');
  assert.deepEqual(delays, []);
  assert.match(events()[0].detail.reason, /^http_401: Forbidden$/);
  assert.ok(!everything().includes(KEY));
  await srv.close();
});

test('a server that is down is a network failure, retried and then reported; one that never answers is a timeout', async () => {
  const srv = await fakeMailgun([200]);
  const dead = srv.url;
  await srv.close();
  const a = setup({}, dead);
  a.mailer.send(MSG);
  await a.mailer.flush();
  assert.equal(a.events()[0].detail.reason, 'network');
  assert.equal(a.events()[0].detail.attempts, 3);
  const hang = await fakeMailgun(['hang']);
  const b = setup({}, hang.url);
  b.cfg.mail.timeoutMs = 150;
  b.cfg.mail.attempts = 1;
  const mailer = createMailer({ cfg: b.cfg, audit: new Audit({ store: b.store, log: () => {} }), log: () => {} });
  mailer.send(MSG);
  await mailer.flush();
  assert.equal(b.events().at(-1).detail.reason, 'timeout');
  await hang.close();
});

test('limits: per address and per hour, counted when a message is accepted; a refusal is audited as skipped and nothing is sent', async () => {
  const srv = await fakeMailgun([200]);
  const { mailer, events } = setup({ MAIL_MAX_PER_ADDRESS_HOUR: '2', MAIL_MAX_PER_HOUR: '3' }, srv.url);
  assert.equal(mailer.send({ ...MSG, to: 'a@x.co' }).queued, true);
  assert.equal(mailer.send({ ...MSG, to: 'A@X.co' }).queued, true, 'addresses are compared without case');
  assert.deepEqual(mailer.send({ ...MSG, to: 'a@x.co' }), { queued: false, reason: 'rate_limited' });
  assert.equal(mailer.send({ ...MSG, to: 'b@x.co' }).queued, true);
  assert.deepEqual(mailer.send({ ...MSG, to: 'c@x.co' }), { queued: false, reason: 'rate_limited' }, 'the total for the hour');
  await mailer.flush();
  assert.equal(srv.requests.length, 3);
  assert.deepEqual(events().filter((e) => e.event === 'mail.skipped').map((e) => e.detail.reason), ['rate_limited', 'rate_limited']);
  await srv.close();
});

test('the limits forget after an hour', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  const cfg = loadConfig({ ...base, ...mg, MAIL_MAX_PER_ADDRESS_HOUR: '1' });
  const store = new Store(':memory:');
  const mailer = createMailer({ cfg, audit: new Audit({ store, log: () => {} }), log: () => {}, provider: { name: 'fake', real: true, deliver: async () => {} } });
  assert.equal(mailer.send(MSG).queued, true);
  assert.equal(mailer.send(MSG).queued, false);
  t.mock.timers.tick(3600_001);
  assert.equal(mailer.send(MSG).queued, true);
});

test('the queue is bounded: a flood is refused, not held in memory', () => {
  const cfg = loadConfig({ ...base, ...mg, MAIL_MAX_PER_HOUR: '100000', MAIL_MAX_PER_ADDRESS_HOUR: '100000' });
  const store = new Store(':memory:');
  const mailer = createMailer({ cfg, audit: new Audit({ store, log: () => {} }), log: () => {}, provider: { name: 'slow', real: true, deliver: () => new Promise(() => {}) } });
  let refused = 0;
  for (let i = 0; i < 150; i++) if (mailer.send({ ...MSG, to: `u${i}@x.co` }).reason === 'queue_full') refused++;
  assert.ok(refused >= 49 && refused <= 50, `refused ${refused}`); // one message is already being delivered, 100 wait
});

test('the log provider sends nothing, says so, and reports that mail is not enabled', () => {
  const cfg = loadConfig(base);
  const store = new Store(':memory:');
  const mailer = createMailer({ cfg, audit: new Audit({ store, log: () => {} }), log: () => {} });
  assert.equal(mailer.enabled, false);
  assert.deepEqual(mailer.send(MSG), { queued: false, reason: 'disabled' });
  assert.deepEqual(store.queryAudit({ event: 'mail.', limit: 5 }).map((e) => [e.event, e.detail.reason]), [['mail.skipped', 'no_provider']]);
});
