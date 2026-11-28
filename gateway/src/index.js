import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { LlmProxyClient } from './llm.js';
import { Audit } from './audit.js';
import { RunnerClient } from './runner.js';
import { SandboxManager } from './sandbox.js';
import { createGateway } from './server.js';

const cfg = loadConfig();
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const store = new Store(join(cfg.dataDir, 'gateway.db'));
const llm = cfg.llmAdminSocket ? new LlmProxyClient({ socketPath: cfg.llmAdminSocket, adminSecret: cfg.llmAdminSecret }) : null;
if (!llm) log('LLM_ADMIN_SOCKET is not set: sandboxes get no model access');
const audit = new Audit({ store, log });
const manager = new SandboxManager({ runner: new RunnerClient({ url: cfg.runnerUrl, secret: cfg.runnerSecret }), cfg, log, llm, audit });

manager.startReaper();
setInterval(() => {
  store.purgeExpired();
  if (cfg.auditRetentionDays) store.purgeAudit(Date.now() - cfg.auditRetentionDays * 86400000);
}, 3600 * 1000).unref();

const server = createGateway({ cfg, store, manager, log, audit });
manager.onAgentFinished = (userId) => server.mail.taskFinished(userId);
server.listen(cfg.port, '0.0.0.0', () => {
  log(`gateway listening on :${cfg.port}, public ${cfg.publicUrl}, signup=${cfg.allowSignup}, mail=${cfg.mail.provider}`);
});
