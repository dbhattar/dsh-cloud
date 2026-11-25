import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Networks, networkName } from './network.js';
import { LABEL, LLM_LABEL, LLM_LABEL_VALUE, buildSpec, containerName } from './spec.js';

const USER_ID = /^[1-9][0-9]{0,15}$/;
const LLM_TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_BODY = 4096;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorized(req, secret) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/**
 * Narrow sandbox API on the control network (all but /healthz need `Authorization: Bearer RUNNER_SECRET`):
 *   GET    /v1/sandboxes              [{ userId, running }]
 *   GET    /v1/sandboxes/:id          { running, startedAt, llmManaged } or 404
 *   POST   /v1/sandboxes/:id          { llmToken? } create (409 if it exists)
 *   POST   /v1/sandboxes/:id/start    204; 409 { error: 'stale_network' } if its network was recreated
 *   POST   /v1/sandboxes/:id/stop     204
 *   GET    /v1/sandboxes/:id/activity { cpuNs, memBytes } cumulative CPU time and memory of the running container
 *   DELETE /v1/sandboxes/:id          remove the container, keep the volumes
 *   GET    /v1/sandboxes/:id/logs     { logs } (?tail=N, max 500)
 */
export function createRunner({ cfg, docker, log = console.log, networks = new Networks({ docker, cfg, log }) }) {
  async function route(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['v1','sandboxes',id?,action?]
    if (parts[0] === 'v1' && parts[1] === 'usage' && parts.length === 2) {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      // Bytes per user across their two volumes (dsh-data-<id> and dsh-ws-<id>).
      const bytes = new Map();
      for (const v of await docker.volumes()) {
        const m = /^dsh-(?:data|ws)-(\d{1,9})$/.exec(v.Name);
        if (m && v.Size >= 0) bytes.set(Number(m[1]), (bytes.get(Number(m[1])) ?? 0) + v.Size);
      }
      return json(res, 200, [...bytes].map(([userId, b]) => ({ userId, bytes: b })));
    }
    if (parts[0] !== 'v1' || parts[1] !== 'sandboxes') throw new HttpError(404, 'not found');
    const [, , id, action] = parts;
    const method = req.method;

    if (id === undefined) {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      const list = await docker.list(LABEL);
      return json(res, 200, list.map((c) => ({ userId: Number(c.Labels[LABEL]), running: c.State === 'running' })));
    }
    if (!USER_ID.test(id)) throw new HttpError(400, 'invalid user id');
    const name = containerName(id);

    if (action === undefined && method === 'GET') {
      const info = await docker.inspect(name);
      if (!info) throw new HttpError(404, 'no such sandbox');
      return json(res, 200, {
        running: Boolean(info.State?.Running),
        startedAt: info.State?.StartedAt ?? null,
        llmManaged: info.Config?.Labels?.[LLM_LABEL] === LLM_LABEL_VALUE,
      });
    }
    if (action === undefined && method === 'POST') {
      const { llmToken } = await readJson(req);
      if (llmToken !== undefined && !(typeof llmToken === 'string' && LLM_TOKEN.test(llmToken))) {
        throw new HttpError(400, 'invalid llmToken');
      }
      if (llmToken && !cfg.llmProxyUrl) throw new HttpError(400, 'llm proxy is not configured');
      if (await docker.inspect(name)) throw new HttpError(409, 'sandbox already exists');
      const hosts = await networks.ensure(id);
      await docker.create(name, buildSpec(cfg, id, llmToken, hosts));
      log(`created sandbox ${id}`);
      return json(res, 201, {});
    }
    if (action === undefined && method === 'DELETE') {
      await docker.remove(name);
      // ?network=1 also removes the user's network (when their data is deleted); plain DELETE keeps it.
      if (url.searchParams.get('network') === '1') await networks.remove(id);
      log(`removed sandbox ${id}`);
      return json(res, 204);
    }
    if (action === 'start' && method === 'POST') {
      try {
        await networks.attachShared(networkName(id)); // the gateway or llm-proxy may have been recreated
        await docker.start(name);
      } catch (e) {
        // The container is pinned to a network ID that no longer exists (stack brought down and up).
        if (/network .* not found/.test(e.message)) throw new HttpError(409, 'stale_network');
        throw e;
      }
      return json(res, 204);
    }
    if (action === 'stop' && method === 'POST') {
      await docker.stop(name);
      log(`stopped sandbox ${id}`);
      return json(res, 204);
    }
    if (action === 'activity' && method === 'GET') {
      // Cumulative CPU time of the container; the gateway differences two samples to see whether it is busy.
      const sample = await docker.stats(name);
      if (!sample) throw new HttpError(404, 'no such sandbox');
      return json(res, 200, sample);
    }
    if (action === 'logs' && method === 'GET') {
      const tail = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('tail') ?? '100', 10) || 100));
      return json(res, 200, { logs: await docker.logs(name, tail) });
    }
    throw new HttpError(404, 'not found');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (!authorized(req, cfg.secret)) throw new HttpError(401, 'unauthorized');
      await route(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      log(`runner error ${req.method} ${url.pathname}: ${e.message}`);
      json(res, 502, { error: 'docker request failed' });
    }
  });
}

function json(res, status, body) {
  if (status === 204) return res.writeHead(204).end();
  const data = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }).end(data);
}
