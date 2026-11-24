/** Label on user networks, and on the containers that must be attached to every one of them. */
export const NET_LABEL = 'dsh-cloud.user';
export const ROLE_LABEL = 'dsh-cloud.role';

export const networkName = (userId) => `dsh-net-${userId}`;

const toInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/**
 * Fixed address for the shared service at `index` (its position in the configured roles): the top usable
 * addresses of the subnet, counting down. Docker hands out dynamic addresses from the bottom, so a sandbox
 * never lands on one, whatever order things were attached in. null if the subnet is not IPv4 or too small.
 */
export function pinnedAddress(subnet, index) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(subnet ?? '');
  if (!m || Number(m[2]) > 29) return null; // fewer than 8 addresses: no room for a sandbox plus services
  const size = 2 ** (32 - Number(m[2]));
  return toIp((toInt(m[1]) + size - 2 - index) >>> 0);
}

const subnetOf = (net) => net?.IPAM?.Config?.find((c) => c.Subnet && !c.Subnet.includes(':'))?.Subnet ?? null;

/**
 * One internal network per user: the sandbox, the gateway and the llm-proxy share it, so sandboxes
 * cannot see each other and have no route off the host. The shared services are found by their
 * `dsh-cloud.role` label (their container ids change whenever compose recreates them) and are
 * re-attached whenever that happens.
 *
 * Each shared service gets a fixed address on every user network, and the sandbox is given those as
 * `ExtraHosts`. gVisor sandboxes cannot use Docker's embedded DNS (127.0.0.11), so names must come from
 * /etc/hosts; fixed addresses keep those entries valid when a service is recreated.
 */
export class Networks {
  constructor({ docker, cfg, log = console.log }) {
    this.docker = docker;
    this.roles = cfg.sharedRoles;
    this.log = log;
  }

  /** Create the user's network if missing and attach the shared services. Returns { role: address } for ExtraHosts. */
  async ensure(userId) {
    const name = networkName(userId);
    let net = await this.docker.inspectNetwork(name);
    if (!net) {
      await this.docker.createInternalNetwork(name, { [NET_LABEL]: String(userId) });
      this.log(`created network ${name}`);
      net = await this.docker.inspectNetwork(name);
    }
    await this.attachShared(name);
    return this.addresses(net);
  }

  /** { role: fixed address } for a network; empty if its subnet cannot hold them. */
  addresses(net) {
    const subnet = subnetOf(net);
    const out = {};
    this.roles.forEach((role, i) => {
      const ip = pinnedAddress(subnet, i);
      if (ip) out[role] = ip;
    });
    return out;
  }

  /** Attach each shared service to the network, with its role as a DNS alias. Skips ones already attached. */
  async attachShared(name) {
    const net = await this.docker.inspectNetwork(name);
    if (!net) return;
    const fixed = this.addresses(net);
    for (const role of this.roles) {
      const found = (await this.docker.list(`${ROLE_LABEL}=${role}`)).filter((c) => c.State === 'running');
      if (!found.length) this.log(`no running container with role ${role}; it cannot reach ${name}`);
      for (const c of found) {
        const current = net.Containers?.[c.Id]?.IPv4Address?.split('/')[0];
        if (current && (!fixed[role] || current === fixed[role])) continue; // attached, at the right address
        if (current) {
          // Attached earlier at a dynamic address (before addresses were pinned): move it.
          await this.docker.disconnect(name, c.Id);
          this.log(`moving ${role} on ${name} from ${current} to ${fixed[role]}`);
        }
        await this.docker.connect(name, c.Id, { aliases: [role], ipv4: fixed[role] });
        this.log(`attached ${role} to ${name}${fixed[role] ? ` at ${fixed[role]}` : ''}`);
      }
    }
  }

  /** Re-attach the shared services to every user network (after the gateway or llm-proxy was recreated). */
  async reconcile() {
    for (const n of await this.docker.listNetworks(NET_LABEL)) await this.attachShared(n.Name);
  }

  /** Remove the user's network (its sandbox container must already be gone). */
  async remove(userId) {
    const name = networkName(userId);
    const net = await this.docker.inspectNetwork(name);
    if (!net) return;
    for (const id of Object.keys(net.Containers ?? {})) await this.docker.disconnect(name, id);
    await this.docker.removeNetwork(name);
    this.log(`removed network ${name}`);
  }

  startReconciler(seconds) {
    const t = setInterval(() => this.reconcile().catch((e) => this.log(`reconcile: ${e.message}`)), seconds * 1000);
    t.unref();
    return t;
  }
}
