import { loadConfig, runtimeWarning } from './config.js';
import { Docker } from './docker.js';
import { Networks } from './network.js';
import { createRunner } from './server.js';

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
const docker = new Docker(cfg.dockerSocket);
const warning = runtimeWarning(cfg);
if (warning) log(`WARNING: ${warning}`);
// The runtime has to exist on this daemon: Docker would refuse to start a sandbox with an unknown one, but only when the first user
// arrives. Say so now, and stop (the restart policy retries) instead of reporting healthy with a stack that cannot run anything.
if (cfg.sandboxRuntime) {
  const have = await docker.runtimes().catch((e) => { console.error(`${new Date().toISOString()} fatal: cannot ask Docker which runtimes it has: ${e.message}`); process.exit(1); });
  if (!have.includes(cfg.sandboxRuntime)) {
    console.error(`${new Date().toISOString()} fatal: sandbox runtime "${cfg.sandboxRuntime}" is not registered with this Docker daemon (it has: ${have.join(', ')}). Install it (scripts/lima/install-gvisor.sh shows how for gVisor) or, for development only, set SANDBOX_RUNTIME=runc and ALLOW_INSECURE_RUNTIME=true.`);
    process.exit(1);
  }
}
const networks = new Networks({ docker, cfg, log });
networks.reconcile().catch((e) => log(`initial reconcile: ${e.message}`));
networks.startReconciler(cfg.reconcileSeconds);
createRunner({ cfg, docker, networks, log }).listen(cfg.port, '0.0.0.0', () => {
  log(`sandbox-runner listening on :${cfg.port}, image ${cfg.sandboxImage}, shared roles ${cfg.sharedRoles.join(',')}`);
});
