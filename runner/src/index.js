import { loadConfig } from './config.js';
import { Docker } from './docker.js';
import { Networks } from './network.js';
import { createRunner } from './server.js';

const cfg = loadConfig();
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const docker = new Docker(cfg.dockerSocket);
const networks = new Networks({ docker, cfg, log });
networks.reconcile().catch((e) => log(`initial reconcile: ${e.message}`));
networks.startReconciler(cfg.reconcileSeconds);
createRunner({ cfg, docker, networks, log }).listen(cfg.port, '0.0.0.0', () => {
  log(`sandbox-runner listening on :${cfg.port}, image ${cfg.sandboxImage}, shared roles ${cfg.sharedRoles.join(',')}`);
});
