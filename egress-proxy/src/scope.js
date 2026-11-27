import net from 'node:net';

/**
 * The operator's scope list: which hosts a sandbox may reach at all. When EGRESS_ALLOW_HOSTS is set the proxy is in "scoped" mode:
 * only those hosts, plus a small base list of what the tools and the repository work need (GitHub, package registries, vulnerability
 * and knowledge sources), are reachable; everything else is refused with the reason "not in scope". Unset, the proxy is open to any
 * public host, as before. The check is on the requested host name (no DNS needed), and the address filter still applies afterwards,
 * so an allowed name that resolves to a private address is refused as before. A name outside the list stays refused whatever it
 * resolves to, which is what stops a redirect or a crawled link from leading a tool to a third party.
 *
 * Entries: `example.com` (that host only), `*.example.com` (any subdomain, not the apex: list both to allow both), or an IPv4
 * address. A wildcard needs at least two labels after the `*`, so `*.com` is refused. The public-suffix list is not consulted, so
 * `*.co.uk` is accepted: write what you mean.
 */

/** What the tools shipped in the sandbox image reach, measured in tests/phase6/egress-limits.test.mjs (docs/research-security-tooling.md). */
export const DEFAULT_BASE_HOSTS = [
  // repositories: git clone, nuclei's template download
  'github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  // packages: pip, pip-audit, npm, Go
  'pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org', 'proxy.golang.org', 'sum.golang.org',
  // vulnerability and knowledge sources: osv-scanner and pip-audit, NVD, CISA's known-exploited list, EPSS
  'api.osv.dev', 'osv-vulnerabilities.storage.googleapis.com', 'services.nvd.nist.gov', 'nvd.nist.gov', 'www.cisa.gov', 'api.first.org',
];

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const validHostname = (h) => h.length <= 253 && h.split('.').length >= 2 && h.split('.').every((l) => LABEL.test(l));

/** Parse a comma-separated list into entries; throws with the offending entry. `name` is the setting's name, for the message. */
export function parseHostList(text, name = 'host list') {
  const entries = [];
  for (const raw of String(text ?? '').split(',')) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (net.isIPv4(e)) entries.push({ kind: 'ip', value: e });
    else if (e.startsWith('*.') && validHostname(e.slice(2))) entries.push({ kind: 'suffix', value: e.slice(2) });
    else if (!e.includes('*') && validHostname(e)) entries.push({ kind: 'exact', value: e });
    else throw new Error(`${name}: "${raw.trim()}" is not usable (write example.com, *.example.com with at least two labels after the *, or an IPv4 address)`);
  }
  return entries;
}

/** A scope over the operator's list and the base list. `active` is false when the operator list is empty (open mode). */
export function createScope({ allow = [], base = [] } = {}) {
  const exact = new Set();
  const suffixes = [];
  for (const e of [...allow, ...base]) (e.kind === 'suffix' ? suffixes.push(e.value) : exact.add(e.value));
  return {
    active: allow.length > 0,
    /** { ok: true } or { ok: false, reason }. */
    check(host) {
      if (allow.length === 0) return { ok: true };
      const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
      const no = { ok: false, reason: `not in scope: ${h || '(empty)'} is not on the allowed list` };
      // Anything but plain host-name characters (an IPv6 literal, a stray character) is not in scope; empty labels ("a..b") never match.
      if (!/^[a-z0-9.-]+$/.test(h) || h.split('.').some((l) => l === '')) return no;
      if (exact.has(h)) return { ok: true };
      if (suffixes.some((s) => h.endsWith(`.${s}`))) return { ok: true };
      return no;
    },
  };
}
