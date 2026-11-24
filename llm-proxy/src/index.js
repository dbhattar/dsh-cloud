import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { UsageStore } from './db.js';
import { createProxy } from './server.js';

const cfg = loadConfig();
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
