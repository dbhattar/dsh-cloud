import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Start listening. With GATEWAY_SOCKET the gateway listens on a unix socket and on no TCP port at all (docs/security-review.md, SEC-04):
 * the runner attaches the gateway to every user's network so it can reach each sandbox, which also let every sandbox reach the
 * gateway's port directly, without Caddy: no real client address (so no rate limit worth the name), and every route, admin included,
 * open to an agent's shell. A socket in a volume that only Caddy mounts cannot be reached from a sandbox. Without the setting (development,
 * the tests) it listens on `cfg.port` as before.
 * @returns where it is listening, for the log line.
 */
export function listenGateway(server, cfg, onListening = () => {}) {
  if (cfg.socketPath) {
    mkdirSync(dirname(cfg.socketPath), { recursive: true });
    rmSync(cfg.socketPath, { force: true }); // left over from a previous run
    server.listen(cfg.socketPath, () => {
      chmodSync(cfg.socketPath, 0o660); // owner and group only; the volume is shared with Caddy and nothing else
      onListening();
    });
    return `unix socket ${cfg.socketPath}`;
  }
  server.listen(cfg.port, '0.0.0.0', onListening);
  return `:${cfg.port}`;
}
