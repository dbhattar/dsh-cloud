/** Container label holding the owning user's id. */
export const LABEL = 'dsh-cloud.user';
/** Marks containers created with a per-user proxy token. Older ones may carry the real key in their env. */
export const LLM_LABEL = 'dsh-cloud.llm';
export const LLM_LABEL_VALUE = 'proxy-v1';

import { networkName } from './network.js';

export const containerName = (userId) => `dsh-sbx-${userId}`;

/** Container label holding the account's volume key (absent for accounts that predate keys). */
export const VOLUME_KEY_LABEL = 'dsh-cloud.vkey';
/** 16 lower-case hex characters, made by the gateway when the account is created. */
export const VOLUME_KEY = /^[0-9a-f]{16}$/;

/**
 * The two volume names of an account. The user id alone is not a safe name: ids start at 1 again on a new or older database, and
 * `dsh-ws-1` would then hold the previous owner of id 1's files and credentials for whoever is user 1 now (docs/security-review.md,
 * SEC-09). A key made when the account was created, and stored only in the gateway's database, is part of the name. Accounts that
 * predate keys keep the old names (`volumeKey` empty).
 */
export const volumeNames = (userId, volumeKey = '') => {
  const suffix = volumeKey ? `${userId}-${volumeKey}` : String(userId);
  return { data: `dsh-data-${suffix}`, ws: `dsh-ws-${suffix}` };
};

/**
 * Web access goes through the egress proxy only. NODE_USE_ENV_PROXY makes Node's own fetch/http honour the
 * variables; the internal services are listed in NO_PROXY so model traffic never detours through the proxy.
 */
function proxyEnv(cfg) {
  if (!cfg.egressProxyUrl) return [];
  const noProxy = ['localhost', '127.0.0.1', ...cfg.sharedRoles.filter((r) => r !== 'egress-proxy')].join(',');
  return [
    `HTTP_PROXY=${cfg.egressProxyUrl}`, `HTTPS_PROXY=${cfg.egressProxyUrl}`,
    `http_proxy=${cfg.egressProxyUrl}`, `https_proxy=${cfg.egressProxyUrl}`,
    `NO_PROXY=${noProxy}`, `no_proxy=${noProxy}`,
    'NODE_USE_ENV_PROXY=1',
  ];
}

/**
 * The one container spec the runner will create. It takes a user id and that user's llm-proxy token
 * and nothing else, so no caller can add binds, capabilities, devices or privileged mode. `hosts` is
 * { name: address } computed by the runner for the shared services (see Networks).
 */
export function buildSpec(cfg, userId, llmToken, hosts = {}, volumeKey = '') {
  const vol = volumeNames(userId, volumeKey);
  return {
    Image: cfg.sandboxImage,
    Env: [
      `DSH_PUBLIC_URL=${cfg.publicUrl}`,
      `DSH_TRUSTED_HOST=${cfg.trustedHost}`,
      ...(llmToken ? [`LLM_PROXY_TOKEN=${llmToken}`, `LLM_BASE_URL=${cfg.llmProxyUrl}/v1`] : []),
      `DSH_DEFAULT_MODEL=${cfg.defaultModel}`,
      ...(cfg.modelDisplayName ? [`DSH_MODEL_NAME=${cfg.modelDisplayName}`] : []),
      `DSH_MODEL_MAX_TOKENS=${cfg.modelMaxOutputTokens}`,
      `DSH_SHOW_SIGN_IN=${cfg.showHarnessSignIn}`,
      ...proxyEnv(cfg),
    ],
    Labels: { [LABEL]: String(userId), ...(llmToken ? { [LLM_LABEL]: LLM_LABEL_VALUE } : {}), ...(volumeKey ? { [VOLUME_KEY_LABEL]: volumeKey } : {}) },
    HostConfig: {
      Binds: [`${vol.data}:/data/dsh`, `${vol.ws}:/workspace`],
      NetworkMode: networkName(userId),
      // Names of the shared services, from /etc/hosts: gVisor sandboxes cannot use Docker's embedded DNS.
      ExtraHosts: Object.entries(hosts).map(([name, ip]) => `${name}:${ip}`),
      Memory: cfg.sandboxMemoryMb * 1024 * 1024,
      MemorySwap: cfg.sandboxMemoryMb * 1024 * 1024, // equal to Memory: no swap, so the limit is real
      NanoCpus: Math.round(cfg.sandboxCpus * 1e9),
      PidsLimit: cfg.sandboxPids,
      // Per-process cap only. A nproc ulimit would be counted per host UID, shared by every sandbox
      // (they all run as the same image user), so PidsLimit is what bounds processes per container.
      Ulimits: [{ Name: 'nofile', Soft: cfg.sandboxNofile, Hard: cfg.sandboxNofile }],
      ReadonlyRootfs: true, // only the two volumes and the tmpfs below are writable
      // `exec` is required: Docker mounts tmpfs noexec by default, and the harness dlopen()s its native binding from /tmp.
      Tmpfs: { '/tmp': `rw,exec,nosuid,nodev,size=${cfg.sandboxTmpMb}m` },
      CapDrop: ['ALL'],
      // No seccomp entry on purpose: Docker applies its default profile. Never add `seccomp=unconfined`.
      SecurityOpt: ['no-new-privileges'],
      ...(cfg.sandboxRuntime ? { Runtime: cfg.sandboxRuntime } : {}),
      RestartPolicy: { Name: 'no' },
      // Bounded and rotated: the daemon's default keeps every byte a container prints, on the host's disk, outside every volume quota.
      LogConfig: { Type: 'local', Config: { 'max-size': cfg.sandboxLogMaxSize, 'max-file': String(cfg.sandboxLogMaxFiles) } },
    },
  };
}
