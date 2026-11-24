import http from 'node:http';
import net from 'node:net';
import { resolvePublic } from './filter.js';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/**
 * Forward proxy for the sandboxes: CONNECT tunnels (HTTPS) and absolute-URI requests (plain HTTP).
 * Every destination is resolved here and refused unless it is a public address on an allowed port;
 * the connection then goes to the address we checked. No SOCKS, no other schemes, no content inspection.
 * One log line per request: source, method, destination and the decision.
 */
export function createEgressProxy({ cfg, log = console.log, lookup, blocked }) {
  const opts = { lookup, blocked };
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
    const v = await vet(url.hostname, port);
    if (!v.address) {
      audit(req, target, 'deny', v.reason);
      res.writeHead(v.status).end(v.reason);
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
    const refuse = (status, text) => client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    if (!m) return refuse(400, 'Bad Request');
    const host = m[1];
    const port = Number(m[2]);
    if (active >= cfg.maxConnections) {
      audit(req, req.url, 'deny', 'too many connections');
      return refuse(503, 'Busy');
    }
    active++; // counted while vetting too, so a flood of slow lookups is capped
    const v = await vet(host, port);
    if (!v.address) {
      active--;
      audit(req, req.url, 'deny', v.reason);
      return refuse(v.status, v.status === 403 ? 'Forbidden' : 'Bad Gateway');
    }
    audit(req, req.url, 'allow');
    const upstream = net.connect({ host: v.address, port, timeout: cfg.connectTimeoutMs });
    let released = false;
    const release = () => {
      if (!released) active--;
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
