/** Client for the sandbox-runner's narrow API. The gateway has no Docker access of its own. */
export class RunnerClient {
  constructor({ url, secret, fetchImpl = fetch }) {
    this.url = url.replace(/\/+$/, '');
    this.secret = secret;
    this.fetch = fetchImpl;
  }

  async #call(method, path, { body, allow = [] } = {}) {
    const res = await this.fetch(`${this.url}/v1/sandboxes${path}`, {
      method,
      headers: { authorization: `Bearer ${this.secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (allow.includes(res.status)) return { status: res.status, data: null };
    if (!res.ok) {
      const detail = await res.json().then((j) => j.error, () => '');
      throw new Error(`runner ${method} ${path || '/'} -> ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  }

  /** { running, startedAt, llmManaged }, or null when the user has no container. */
  async info(userId) {
    return (await this.#call('GET', `/${userId}`, { allow: [404] })).data;
  }
  /** Create (not start) the user's container; the runner builds the spec from the id and token alone. */
  async create(userId, llmToken) {
    await this.#call('POST', `/${userId}`, { body: llmToken ? { llmToken } : {} });
  }
  /** Rejects with a message containing "stale_network" if the container's network was recreated. */
  async start(userId) {
    await this.#call('POST', `/${userId}/start`);
  }
  async stop(userId) {
    await this.#call('POST', `/${userId}/stop`);
  }
  /** Remove the container; volumes stay. */
  async remove(userId, { network = false } = {}) {
    await this.#call('DELETE', `/${userId}${network ? '?network=1' : ''}`);
  }
  async logs(userId, tail = 100) {
    return (await this.#call('GET', `/${userId}/logs?tail=${tail}`)).data.logs;
  }
  /** [{ userId, bytes }]: disk used by each user's two volumes. */
  async diskUsage() {
    const res = await this.fetch(`${this.url}/v1/usage`, { headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`runner GET /v1/usage -> ${res.status}`);
    return res.json();
  }
  /** [{ userId, running }] for every sandbox container. */
  async list() {
    return (await this.#call('GET', '')).data;
  }
}
