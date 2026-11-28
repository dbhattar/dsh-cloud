import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { UsageStore } from './db.js';
import { createProxy } from './server.js';

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
const store = new UsageStore(join(cfg.dataDir, 'llm-proxy.db'));
const { user, admin } = createProxy({ cfg, store, log });

// Admin first, so the user port (the healthcheck) only opens once the gateway can already reach the admin API.
mkdirSync(dirname(cfg.adminSocket), { recursive: true });
rmSync(cfg.adminSocket, { force: true }); // left over from a previous run
admin.listen(cfg.adminSocket, () => {
  chmodSync(cfg.adminSocket, 0o660);
  log(`llm-proxy admin API on ${cfg.adminSocket}`);
  user.listen(cfg.port, '0.0.0.0', () => {
    log(`llm-proxy listening on :${cfg.port}, upstream ${cfg.upstreamBaseUrl}, models ${cfg.allowedModels.join(',')}`);
  });
});
