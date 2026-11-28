import http from 'node:http';

/** Minimal Docker Engine API client over the unix socket. */
export class Docker {
  constructor(socketPath) {
    this.socketPath = socketPath;
  }
  request(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : {},
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }
  async #json(method, path, body, ok) {
    const r = await this.request(method, path, body);
    if (!ok.includes(r.status)) {
      throw new Error(`docker ${method} ${path} -> ${r.status}: ${r.buf.toString().slice(0, 300)}`);
    }
    return r.buf.length ? JSON.parse(r.buf.toString()) : null;
  }
  /** Names of the OCI runtimes the daemon has registered (runc, runsc, ...). */
  async runtimes() {
    return Object.keys((await this.#json('GET', '/info', undefined, [200]))?.Runtimes ?? {});
  }
  async inspect(name) {
    const r = await this.request('GET', `/containers/${encodeURIComponent(name)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`docker inspect ${name} -> ${r.status}`);
    return JSON.parse(r.buf.toString());
  }
  /** Network JSON, or null if it does not exist. */
  async inspectNetwork(name) {
    const r = await this.request('GET', `/networks/${encodeURIComponent(name)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`docker network inspect ${name} -> ${r.status}`);
    return JSON.parse(r.buf.toString());
  }
  /** An internal (no default route, no published ports) bridge network. */
  createInternalNetwork(name, labels) {
    return this.#json('POST', '/networks/create', { Name: name, Driver: 'bridge', Internal: true, CheckDuplicate: true, Labels: labels }, [201]);
  }
  removeNetwork(name) {
    return this.#json('DELETE', `/networks/${encodeURIComponent(name)}`, undefined, [204, 404]);
  }
  listNetworks(label) {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return this.#json('GET', `/networks?filters=${filters}`, undefined, [200]);
  }
  /** Attach a container to a network under extra DNS aliases and, if given, a fixed IPv4 address. No-op if already attached. */
  async connect(network, containerId, { aliases = [], ipv4 } = {}) {
    const r = await this.request('POST', `/networks/${encodeURIComponent(network)}/connect`, {
      Container: containerId,
      EndpointConfig: { Aliases: aliases, ...(ipv4 ? { IPAMConfig: { IPv4Address: ipv4 } } : {}) },
    });
    const already = r.status === 403 && /already exists/.test(r.buf.toString());
    if (r.status !== 200 && !already) throw new Error(`docker network connect ${network} -> ${r.status}: ${r.buf.toString().slice(0, 200)}`);
  }
  async disconnect(network, containerId) {
    const r = await this.request('POST', `/networks/${encodeURIComponent(network)}/disconnect`, { Container: containerId, Force: true });
    if (![200, 404].includes(r.status)) throw new Error(`docker network disconnect ${network} -> ${r.status}: ${r.buf.toString().slice(0, 200)}`);
  }
  /** { cpuNs, memBytes } for a running container (one sample, no waiting), or null if it does not exist. */
  async stats(name) {
    const r = await this.request('GET', `/containers/${encodeURIComponent(name)}/stats?stream=false&one-shot=true`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`docker stats ${name} -> ${r.status}`);
    const j = JSON.parse(r.buf.toString());
    return { cpuNs: j.cpu_stats?.cpu_usage?.total_usage ?? null, memBytes: j.memory_stats?.usage ?? null };
  }
  /** [{ Name, Size }] for every volume (Docker computes sizes on demand, so this can take a few seconds). */
  async volumes() {
    const df = await this.#json('GET', '/system/df?type=volume', undefined, [200]);
    return (df?.Volumes ?? []).map((v) => ({ Name: v.Name, Size: v.UsageData?.Size ?? -1 }));
  }
  create(name, spec) {
    return this.#json('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec, [201]);
  }
  start(name) {
    return this.#json('POST', `/containers/${encodeURIComponent(name)}/start`, undefined, [204, 304]);
  }
  /** Remove a container (not its named volumes). */
  remove(name) {
    return this.#json('DELETE', `/containers/${encodeURIComponent(name)}?force=1`, undefined, [204, 404]);
  }
  stop(name, seconds = 10) {
    return this.#json('POST', `/containers/${encodeURIComponent(name)}/stop?t=${seconds}`, undefined, [204, 304]);
  }
  list(label) {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return this.#json('GET', `/containers/json?all=1&filters=${filters}`, undefined, [200]);
  }
  /** stdout+stderr as text (demultiplexes Docker's 8-byte frame headers; Tty=false). */
  async logs(name, tail = 200) {
    const r = await this.request('GET', `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=${tail}`);
    if (r.status !== 200) throw new Error(`docker logs ${name} -> ${r.status}`);
    const b = r.buf;
    let out = '';
    for (let i = 0; i + 8 <= b.length; ) {
      const size = b.readUInt32BE(i + 4);
      out += b.subarray(i + 8, i + 8 + size).toString();
      i += 8 + size;
    }
    return out;
  }
}
