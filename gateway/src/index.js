import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { LlmProxyClient } from './llm.js';
import { Audit } from './audit.js';
import { RunnerClient } from './runner.js';
import { SandboxManager } from './sandbox.js';
import { listenGateway } from './listen.js';
import { createGateway } from './server.js';

const cfg = loadConfig();
// Last resort: an error nothing handled leaves the process in an unknown state, so say what it was and exit non-zero; the
// restart policy (infra/docker-compose.gateway.yml) brings the service back. Do not keep serving.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (e) => {
    console.error(`${new Date().toISOString()} fatal ${event}: ${e?.stack ?? e}`);
    process.exit(1);
  });
}
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const store = new Store(join(cfg.dataDir, 'gateway.db'));
const llm = cfg.llmAdminSocket ? new LlmProxyClient({ socketPath: cfg.llmAdminSocket, adminSecret: cfg.llmAdminSecret }) : null;
if (!llm) log('LLM_ADMIN_SOCKET is not set: sandboxes get no model access');
const audit = new Audit({ store, log });
const manager = new SandboxManager({ runner: new RunnerClient({ url: cfg.runnerUrl, secret: cfg.runnerSecret }), cfg, log, llm, audit, volumeKeyOf: (id) => store.volumeKey(id) });

manager.startReaper();
setInterval(() => {
  store.purgeExpired();
  if (cfg.auditRetentionDays) store.purgeAudit(Date.now() - cfg.auditRetentionDays * 86400000);
  store.purgeUnconfirmedWaitlist(Date.now() - 14 * 86400000); // an address nobody confirmed in two weeks is not waiting
}, 3600 * 1000).unref();

const server = createGateway({ cfg, store, manager, log, audit });
manager.onAgentFinished = (userId) => server.mail.taskFinished(userId);
const where = listenGateway(server, cfg, () => {
  log(`gateway listening on ${where}, public ${cfg.publicUrl}, signup=${cfg.allowSignup}, mail=${cfg.mail.provider}`);
});
