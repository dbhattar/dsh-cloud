import http from 'node:http';
import net from 'node:net';
import { resolvePublic } from './filter.js';
import { Limits } from './limits.js';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/**
 * Forward proxy for the sandboxes: CONNECT tunnels (HTTPS) and absolute-URI requests (plain HTTP).
 * Every destination is resolved here and refused unless it is a public address on an allowed port;
 * the connection then goes to the address we checked. No SOCKS, no other schemes, no content inspection.
 * One log line per request: source, method, destination and the decision.
 */
export function createEgressProxy({ cfg, log = console.log, lookup, blocked }) {
  const opts = { lookup, blocked };
  const limits = new Limits(cfg.limits ?? {});
  const scope = cfg.scope ?? { check: () => ({ ok: true }) };
  const sourceOf = (req) => String(req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
  let active = 0;
  const audit = (req, target, decision, reason = '') =>
    log(`egress ${decision} src=${req.socket.remoteAddress ?? '?'} ${req.method} ${target}${reason ? ` (${reason})` : ''}`);

  /** Resolve and vet host:port. Returns the address to dial, or { status, reason } to answer with. */
  async function vet(host, port) {
    if (!cfg.allowedPorts.has(port)) return { status: 403, reason: `port ${port} not allowed` };
    try {
      return { address: await resolvePublic(host, opts) };
    } catch (e) {
      return { status: e.code === 'blocked' ? 403 : 502, reason: e.message };
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    let url;
    try {
      url = new URL(req.url); // a proxy request carries the absolute URL
    } catch {
      res.writeHead(400).end('absolute URL required');
      return;
    }
    const port = Number(url.port || 80);
    const target = `${url.hostname}:${port}`;
    if (url.protocol !== 'http:') {
      audit(req, target, 'deny', `scheme ${url.protocol}`);
      res.writeHead(400).end('only http: and CONNECT are supported');
      return;
    }
    if (active >= cfg.maxConnections) {
      audit(req, target, 'deny', 'too many connections');
      res.writeHead(503).end('busy');
      return;
    }
    const inScope = scope.check(url.hostname);
    if (!inScope.ok) {
      audit(req, target, 'deny', inScope.reason);
      res.writeHead(403, { 'x-egress-reason': inScope.reason }).end(inScope.reason);
      return;
    }
    const v = await vet(url.hostname, port);
    if (!v.address) {
      audit(req, target, 'deny', v.reason);
      res.writeHead(v.status).end(v.reason);
      return;
    }
    const adm = await limits.admit(sourceOf(req), url.hostname);
    if (!adm.ok) {
      audit(req, target, 'deny', adm.reason);
      res.writeHead(429, { 'retry-after': String(adm.retryAfter), 'x-egress-reason': adm.reason }).end(adm.reason);
      return;
    }
    audit(req, target, 'allow');
    active++;
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const out = http.request(
      { host: v.address, port, method: req.method, path: url.pathname + url.search, headers, timeout: cfg.idleTimeoutMs, setHost: false },
      (r) => {
        const rh = { ...r.headers };
        for (const h of HOP_BY_HOP) delete rh[h];
        res.writeHead(r.statusCode, rh);
        r.pipe(res);
      },
    );
    const done = () => {
      active--;
      adm.release();
    };
    res.on('close', done);
    out.on('timeout', () => out.destroy(new Error('upstream timed out')));
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('upstream error');
      else res.destroy();
    });
    req.pipe(out);
  });

  server.on('connect', async (req, client, head) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    // The reason travels in a header (and a short body) so the tool's error says why, not just "403".
    const refuse = (status, text, reason = '', retryAfter = 0) => {
      const body = reason ? `${reason}\n` : '';
      client.end(`HTTP/1.1 ${status} ${text}\r\n${reason ? `X-Egress-Reason: ${reason}\r\n` : ''}${retryAfter ? `Retry-After: ${retryAfter}\r\n` : ''}Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    // A client that resets its connection (straight after a refusal, say) makes the socket emit an error; with no listener that is an
    // uncaught exception and the whole proxy, shared by every sandbox, would exit. Listen from the first moment, before any await.
    client.on('error', () => client.destroy());
    if (!m) return refuse(400, 'Bad Request');
    const host = m[1];
    const port = Number(m[2]);
    if (active >= cfg.maxConnections) {
      audit(req, req.url, 'deny', 'too many connections');
      return refuse(503, 'Busy');
    }
    active++; // counted while vetting and waiting too, so a flood of slow lookups or queued requests is capped
    const inScope = scope.check(host);
    if (!inScope.ok) {
      active--;
      audit(req, req.url, 'deny', inScope.reason);
      return refuse(403, 'Forbidden', inScope.reason);
    }
    const v = await vet(host, port);
    if (!v.address) {
      active--;
      audit(req, req.url, 'deny', v.reason);
      return refuse(v.status, v.status === 403 ? 'Forbidden' : 'Bad Gateway', v.reason);
    }
    const adm = await limits.admit(sourceOf(req), host);
    if (!adm.ok) {
      active--;
      audit(req, req.url, 'deny', adm.reason);
      return refuse(429, 'Too Many Requests', adm.reason, adm.retryAfter);
    }
    if (client.destroyed) {
      // The client left while it was vetted or queued: do not dial for nobody, and give its slot back.
      active--;
      adm.release();
      return;
    }
    audit(req, req.url, 'allow');
    const upstream = net.connect({ host: v.address, port, timeout: cfg.connectTimeoutMs });
    let released = false;
    const release = () => {
      if (!released) {
        active--;
        adm.release();
      }
      released = true;
    };
    const close = () => {
      release();
      upstream.destroy();
      client.destroy();
    };
    upstream.once('connect', () => {
      upstream.setTimeout(cfg.idleTimeoutMs);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('timeout', close);
    upstream.on('error', () => {
      if (!upstream.connecting || !client.writable) return close();
      refuse(502, 'Bad Gateway');
      release();
    });
    upstream.on('close', close);
    client.on('close', close);
    client.on('error', close);
    client.setTimeout(cfg.idleTimeoutMs, close);
  });

  server.on('clientError', (_e, socket) => socket.destroy());
  return server;
}
