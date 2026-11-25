import http from 'node:http';

/** Startup stages in order; the launching page renders these labels from /gw/api/status. */
export const STAGES = [
  { key: 'prepare', label: 'Preparing your workspace' },
  { key: 'container', label: 'Starting your container' },
  { key: 'boot', label: 'Waiting for the harness to boot' },
  { key: 'connect', label: 'Signing in to your workspace' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One container per user, created and driven through the sandbox-runner (the only holder of the Docker
 * socket). Volumes outlive the container's running state, so idle-stop / restart keeps $DSH_HOME and
 * the workspace.
 */
export class SandboxManager {
  constructor({ runner, cfg, log = console.log, llm = null, audit = { record() {} } }) {
    this.audit = audit;
    this.runner = runner;
    this.llm = llm;
    this.cfg = cfg;
    this.log = log;
    this.cache = new Map(); // userId -> { cookie, startedAt, checkedAt }
    this.inflight = new Map(); // userId -> Promise
    this.errors = new Map(); // userId -> message of the last failed start
    this.progress = new Map(); // userId -> { stage, resumed, startedAt } while a start is in flight
    this.lastSeen = new Map(); // userId -> ms
    this.sockets = new Map(); // userId -> open upgraded connections
    this.held = new Map(); // userId -> why a limit stopped them; only an explicit start (the launching page) clears it
    this.admission = Promise.resolve(); // serialises the capacity check with the start that follows it
    this.lastDiskCheck = 0;
    this.cpuSample = new Map(); // userId -> { ns, at } previous CPU reading, to compute use between reaps
    this.lastBusy = new Map(); // userId -> { at, signal } last time the agent looked busy
    this.keptBusy = new Set(); // userIds currently being kept alive past the idle limit (so the audit line is written once)
    this.signalWarned = false;
  }

  name(userId) {
    return `dsh-sbx-${userId}`;
  }

  touch(userId) {
    this.lastSeen.set(userId, Date.now());
  }
  wsOpen(userId) {
    this.sockets.set(userId, (this.sockets.get(userId) ?? 0) + 1);
    this.touch(userId);
  }
  wsClose(userId) {
    this.sockets.set(userId, Math.max(0, (this.sockets.get(userId) ?? 1) - 1));
    this.touch(userId);
  }
  invalidate(userId) {
    this.cache.delete(userId);
  }

  /** Cached entry if the container is still the same running instance, else null. */
  async ready(userId) {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt < 3000) return entry;
    const info = await this.runner.info(userId);
    if (info?.running && info.startedAt === entry.startedAt) {
      entry.checkedAt = Date.now();
      return entry;
    }
    this.cache.delete(userId);
    return null;
  }

  setStage(userId, stage, extra = {}) {
    const p = this.progress.get(userId);
    if (p) Object.assign(p, { stage }, extra);
  }

  /** Snapshot for the launching page. */
  status(userId) {
    const p = this.progress.get(userId);
    return {
      state: this.state(userId),
      stages: STAGES,
      stage: p ? STAGES.findIndex((x) => x.key === p.stage) : -1,
      resumed: p?.resumed ?? false,
      elapsedMs: p ? Date.now() - p.startedAt : 0,
      error: this.errors.get(userId),
    };
  }

  state(userId) {
    if (this.cache.has(userId)) return 'running';
    if (this.inflight.has(userId)) return 'starting';
    return this.errors.has(userId) ? 'error' : 'stopped';
  }

  /** Create/start the user's container and exchange the launch token for the auth cookie. */
  ensure(userId, { explicit = false } = {}) {
    const ready = this.cache.get(userId);
    if (ready) return Promise.resolve(ready);
    if (this.held.has(userId)) {
      // A limit stopped this sandbox. Background requests (an open browser tab) must not quietly restart it.
      if (!explicit) {
        this.audit.record('sandbox.refused', { userId, reason: 'held' });
        this.errors.set(userId, this.held.get(userId));
        return Promise.reject(new Error(this.held.get(userId)));
      }
      this.held.delete(userId);
    }
    let p = this.inflight.get(userId);
    if (!p) {
      this.errors.delete(userId); // a retry starts clean; never show the previous failure
      const startedAt = Date.now();
      this.progress.set(userId, { stage: 'prepare', resumed: false, startedAt });
      p = this.#start(userId)
        .then((entry) => {
          this.errors.delete(userId);
          this.cache.set(userId, entry);
          this.audit.record('sandbox.start', { userId, resumed: this.progress.get(userId)?.resumed ?? false, ms: Date.now() - startedAt });
          return entry;
        })
        .catch((e) => {
          this.errors.set(userId, e.message);
          this.log(`sandbox ${userId} failed to start: ${e.message}`);
          if (/at capacity/.test(e.message)) this.audit.record('sandbox.refused', { userId, reason: 'capacity' });
          else this.audit.record('sandbox.start_failed', { userId, error: e.message.slice(0, 300) });
          throw e;
        })
        .finally(() => {
          this.inflight.delete(userId);
          this.progress.delete(userId);
        });
      this.inflight.set(userId, p);
    }
    return p;
  }

  /** Create the container with a freshly issued proxy token (which revokes the user's previous one). */
  async #create(userId) {
    const token = this.llm ? await this.llm.issueToken(userId) : undefined;
    if (token) this.audit.record('token.issue', { userId });
    await this.runner.create(userId, token);
    this.audit.record('sandbox.create', { userId });
  }

  async #start(userId) {
    const name = this.name(userId);
    let info = await this.runner.info(userId);
    if (info && this.llm && !info.llmManaged) {
      // Created before metering existed: its environment may hold the real key. Recreate; volumes keep the data.
      this.log(`sandbox ${userId}: pre-proxy container, recreating`);
      this.audit.record('sandbox.recreate', { userId, reason: 'pre_proxy' });
      await this.runner.remove(userId);
      info = null;
    }
    this.setStage(userId, 'prepare', { resumed: Boolean(info) });
    if (!info) {
      await this.#create(userId);
      info = await this.runner.info(userId);
    }
    this.setStage(userId, 'container');
    await this.#admit(userId, async () => {
      // Always ask for a start: it is a no-op on a running container but re-attaches the gateway and
      // llm-proxy to the user's network if either was recreated.
      try {
        await this.runner.start(userId);
      } catch (e) {
        // The container is pinned to a network ID; if the network was recreated that ID is gone.
        // Recreate the container; the named volumes keep the data.
        if (!/stale_network/.test(e.message)) throw e;
        this.log(`sandbox ${userId}: stale network reference, recreating container`);
        this.audit.record('sandbox.recreate', { userId, reason: 'stale_network' });
        await this.runner.remove(userId);
        await this.#create(userId);
        await this.runner.start(userId);
      }
    });
    this.setStage(userId, 'boot');
    info = await this.runner.info(userId);
    const startedAt = info.startedAt;
    this.touch(userId);

    const deadline = Date.now() + this.cfg.startTimeoutSeconds * 1000;
    let lastErr = 'timed out waiting for dsh to start';
    while (Date.now() < deadline) {
      const cur = await this.runner.info(userId);
      if (!cur?.running) throw new Error('sandbox container exited during startup');
      try {
        const logs = await this.runner.logs(userId, 100);
        const tokens = [...logs.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)];
        if (tokens.length) {
          this.setStage(userId, 'connect');
          const cookie = await this.#exchange(name, tokens.at(-1)[1]);
          return { cookie, startedAt, checkedAt: Date.now(), host: name, port: this.cfg.sandboxPort };
        }
      } catch (e) {
        lastErr = e.message;
      }
      await sleep(500);
    }
    throw new Error(lastErr);
  }

  /**
   * Run `start` only if there is room. Checks and starts are serialised so two newcomers cannot both take the
   * last slot. A sandbox that is already running never counts against itself. When full, the longest-idle
   * sandbox (no open sockets, idle for at least evictAfterIdleSeconds) is stopped to make room; otherwise the
   * start fails with an "at capacity" message.
   */
  #admit(userId, start) {
    const max = this.cfg.maxRunningSandboxes;
    if (!max) return start();
    const run = this.admission.then(async () => {
      const others = (await this.runner.list()).filter((s) => s.running && s.userId !== userId);
      if (others.length >= max) {
        const minIdle = (this.cfg.evictAfterIdleSeconds ?? 300) * 1000;
        const victim = others
          .filter((s) => !this.inflight.has(s.userId) && (this.sockets.get(s.userId) ?? 0) === 0 && !this.isBusy(s.userId) && Date.now() - (this.lastSeen.get(s.userId) ?? 0) >= minIdle)
          .sort((a, b) => (this.lastSeen.get(a.userId) ?? 0) - (this.lastSeen.get(b.userId) ?? 0))[0];
        if (!victim) throw new Error('the service is at capacity right now; try again in a few minutes');
        this.log(`at capacity (${others.length}/${max}): stopping idle sandbox ${victim.userId} to make room for ${userId}`);
        await this.stop(victim.userId, 'evicted');
        this.audit.record('sandbox.evicted', { userId: victim.userId, forUser: userId });
      }
      await start();
    });
    this.admission = run.catch(() => {}); // a failed admission must not block the next one
    return run;
  }

  /** Stop a sandbox because of a limit and keep it stopped until the user starts it again on purpose. */
  async #stopForLimit(userId, limit, message) {
    this.held.set(userId, message);
    this.log(`sandbox ${userId} stopped: ${message}`);
    try {
      await this.stop(userId, `limit:${limit}`);
    } catch (e) {
      this.log(`stop ${userId}: ${e.message}`);
    }
    this.errors.set(userId, message);
  }

  /** Stop sandboxes past MAX_RUN_SECONDS, and (every diskCheckSeconds) those whose volumes exceed MAX_DISK_MB. */
  async enforceLimits(list) {
    const { maxRunSeconds, maxDiskMb, diskCheckSeconds } = this.cfg;
    if (maxRunSeconds) {
      for (const { userId, running } of list) {
        if (!running) continue;
        const info = await this.runner.info(userId).catch(() => null);
        const since = info?.startedAt ? Date.parse(info.startedAt) : NaN;
        if (Number.isFinite(since) && Date.now() - since > maxRunSeconds * 1000) {
          const span = maxRunSeconds >= 3600 ? `${Math.round((maxRunSeconds / 3600) * 10) / 10} h` : `${Math.max(1, Math.round(maxRunSeconds / 60))} min`;
          await this.#stopForLimit(userId, 'run_time', `Your workspace reached the maximum run time of ${span} and was stopped. Your files are kept; start it again to continue.`);
        }
      }
    }
    if (maxDiskMb && Date.now() - this.lastDiskCheck >= diskCheckSeconds * 1000) {
      this.lastDiskCheck = Date.now();
      let usage;
      try {
        usage = await this.runner.diskUsage();
      } catch (e) {
        this.log(`disk usage: ${e.message}`);
        return;
      }
      const limit = maxDiskMb * 1024 * 1024;
      const running = new Set(list.filter((s) => s.running).map((s) => s.userId));
      for (const { userId, bytes } of usage) {
        if (bytes <= limit || !running.has(userId)) continue;
        const mb = Math.round(bytes / 1024 / 1024);
        await this.#stopForLimit(userId, 'disk', `Your workspace uses ${mb} MB of storage, over the ${maxDiskMb} MB limit, so it was stopped. Start it again and delete files to get under the limit; it is checked every ${Math.max(1, Math.round(diskCheckSeconds / 60))} min.`);
      }
    }
  }

  /** GET /?token=T against the sandbox; returns "name=value" of the auth cookie it sets. */
  #exchange(host, token) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host,
          port: this.cfg.sandboxPort,
          path: `/?token=${token}`,
          headers: { host: this.cfg.publicHost },
          timeout: 5000,
        },
        (res) => {
          res.resume();
          const set = res.headers['set-cookie'] ?? [];
          const c = set.map((s) => s.split(';')[0]).find((s) => s.startsWith('dsh-auth-'));
          if (c) resolve(c);
          else reject(new Error(`token exchange returned ${res.statusCode} without auth cookie`));
        },
      );
      req.on('timeout', () => req.destroy(new Error('token exchange timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  async stop(userId, by = 'user') {
    this.cache.delete(userId);
    await this.runner.stop(userId);
    this.audit.record('sandbox.stop', { userId, by });
    this.log(`sandbox ${userId} stopped`);
  }

  /** True if the agent in this sandbox looked busy (model call or CPU use) within the last busySignalSeconds. */
  isBusy(userId) {
    const b = this.lastBusy.get(userId);
    return Boolean(b) && Date.now() - b.at <= this.cfg.busySignalSeconds * 1000;
  }

  /**
   * Update what we know about which running sandboxes are busy. Two signals, either is enough: the llm-proxy saw a
   * model request from the user in flight or recently, or the container's CPU use since the previous reap was above
   * busyCpuPercent of one CPU. Only sandboxes with no browser attached are sampled (the others cannot be stopped
   * for idleness anyway). A failing signal source is logged once and treated as "no signal", so the worst case is the
   * old behaviour (an idle sandbox is stopped).
   */
  async #sampleBusy(userIds) {
    if (!this.cfg.maxBusySeconds) return;
    const now = Date.now();
    let model = new Map();
    try {
      if (this.llm) model = new Map((await this.llm.activity()).users.map((u) => [u.userId, u]));
    } catch (e) {
      if (!this.signalWarned) this.log(`busy signal (llm-proxy activity) unavailable: ${e.message}`);
      this.signalWarned = true;
    }
    for (const userId of userIds) {
      const m = model.get(userId);
      if (m && (m.inflight > 0 || now - Date.parse(m.lastAt) <= this.cfg.busySignalSeconds * 1000)) {
        this.lastBusy.set(userId, { at: now, signal: 'model' });
      }
      try {
        const sample = await this.runner.activity(userId);
        const prev = this.cpuSample.get(userId);
        this.cpuSample.set(userId, { ns: sample.cpuNs, at: now });
        if (prev && sample.cpuNs !== null && now > prev.at) {
          const percent = ((sample.cpuNs - prev.ns) / ((now - prev.at) * 1e6)) * 100; // ns of CPU over ms of wall clock
          const alreadyModel = this.lastBusy.get(userId)?.at === now; // keep the model tag when both signals fire
          if (percent >= this.cfg.busyCpuPercent && !alreadyModel) this.lastBusy.set(userId, { at: now, signal: 'cpu' });
        }
      } catch (e) {
        if (!this.signalWarned) this.log(`busy signal (runner activity) unavailable: ${e.message}`);
        this.signalWarned = true;
      }
    }
  }

  /**
   * Stop running sandboxes that have no browser attached and no traffic for idleSeconds, unless their agent is busy:
   * a busy sandbox keeps running until maxBusySeconds after the user's last activity, then is stopped as "busy_cap".
   */
  async reap() {
    const list = await this.runner.list();
    await this.enforceLimits(list);
    const detached = list.filter((s) => s.running && !this.inflight.has(s.userId) && (this.sockets.get(s.userId) ?? 0) === 0).map((s) => s.userId);
    for (const id of detached) if (!this.lastSeen.has(id)) this.touch(id); // found after gateway restart
    await this.#sampleBusy(detached);
    const live = new Set(list.filter((s) => s.running).map((s) => s.userId));
    for (const id of [...this.cpuSample.keys(), ...this.lastBusy.keys(), ...this.keptBusy]) {
      if (!live.has(id)) { this.cpuSample.delete(id); this.lastBusy.delete(id); this.keptBusy.delete(id); }
    }
    for (const userId of detached) {
      if (Date.now() - this.lastSeen.get(userId) <= this.cfg.idleSeconds * 1000) { this.keptBusy.delete(userId); continue; }
      const sinceUser = Date.now() - this.lastSeen.get(userId);
      let by = 'idle';
      if (this.isBusy(userId)) {
        if (sinceUser <= this.cfg.maxBusySeconds * 1000) {
          if (!this.keptBusy.has(userId)) {
            this.keptBusy.add(userId);
            this.audit.record('sandbox.kept_busy', { userId, signal: this.lastBusy.get(userId).signal, idleSeconds: Math.round(sinceUser / 1000) });
          }
          continue;
        }
        by = 'busy_cap';
      }
      this.keptBusy.delete(userId);
      try {
        await this.stop(userId, by);
      } catch (e) {
        this.log(`reap ${userId}: ${e.message}`);
      }
    }
  }

  startReaper() {
    const t = setInterval(() => this.reap().catch((e) => this.log(`reap: ${e.message}`)), this.cfg.reapIntervalSeconds * 1000);
    t.unref();
    return t;
  }
}
