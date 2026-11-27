import http from 'node:http';

/** One request over a unix socket. Resolves { status, text }. */
function socketRequest(socketPath, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Admin client for llm-proxy: issues, revokes and reads usage of per-user tokens. The admin API is a unix
 * socket on a volume only the gateway shares with the proxy, so sandboxes have no path to it.
 */
export class LlmProxyClient {
  constructor({ socketPath, adminSecret, requestImpl = (...a) => socketRequest(socketPath, ...a) }) {
    this.adminSecret = adminSecret;
    this.request = requestImpl;
  }

  async #call(method, path, body) {
    const data = body ? JSON.stringify(body) : undefined;
    const headers = { authorization: `Bearer ${this.adminSecret}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const { status, text } = await this.request(method, path, headers, data);
    if (status < 200 || status > 299) {
      // Keep the status and the proxy's own explanation (never anything secret: it is the proxy's plain error), for callers that show it.
      const err = new Error(`llm-proxy ${method} ${path} -> ${status}`);
      err.status = status;
      try {
        err.detail = JSON.parse(text)?.error ?? null;
      } catch {
        err.detail = null;
      }
      throw err;
    }
    return status === 204 ? null : JSON.parse(text);
  }

  /** New token for the user; any previous token stops working. */
  async issueToken(userId) {
    const { token } = await this.#call('POST', '/admin/tokens', { userId });
    if (!token) throw new Error('llm-proxy returned no token');
    return token;
  }
  revoke(userId) {
    return this.#call('DELETE', `/admin/tokens/${userId}`);
  }
  /** { users: [{ userId, inflight, lastAt }] } for users with a model request in flight or one in the last 15 minutes. */
  activity() {
    return this.#call('GET', '/admin/activity');
  }
  /** The proxy's admin-editable settings with their values: { settings: [...] }. */
  policy() {
    return this.#call('GET', '/admin/policy');
  }
  /** Change one proxy setting. Rejects with the proxy's status in the message when it refuses (a bad value, a missing confirmation). */
  setPolicy(key, value, confirm = false) {
    return this.#call('PUT', `/admin/policy/${key}`, { value, ...(confirm ? { confirm: true } : {}) });
  }
  resetPolicy(key) {
    return this.#call('DELETE', `/admin/policy/${key}`);
  }
  /** { days: [{ day, tokens, requests, users }], global } for the admin overview. */
  stats(days = 14) {
    return this.#call('GET', `/admin/stats?days=${Number(days) || 14}`);
  }
  /** Every user's usage report (day, month, limits), for the admin overview. */
  usageAll() {
    return this.#call('GET', '/admin/usage');
  }
  usage(userId) {
    return this.#call('GET', `/admin/usage/${userId}`);
  }
}
