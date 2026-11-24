import net from 'node:net';
import dns from 'node:dns/promises';

// [network, prefix length] pairs that a sandbox may never reach through the proxy.
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12], // Docker networks live here
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
];

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);

function blockedV4(ip) {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address to 8 16-bit groups (handles "::" and a trailing dotted IPv4). */
function groupsV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => Number.parseInt(g || '0', 16));
}

function blockedV6(ip) {
  const g = groupsV6(ip);
  if (g.length !== 8 || g.some(Number.isNaN)) return true; // cannot parse: refuse
  const embeddedV4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embeddedV4); // ::ffff:a.b.c.d, ::a.b.c.d (includes :: and ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64: would reach IPv4 space unfiltered
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4 embeds an IPv4 address
  return false;
}

/** True for any address that is not a public unicast address. Unparseable input counts as blocked. */
export function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return blockedV4(ip);
  if (kind === 6) return blockedV6(ip);
  return true;
}

/**
 * Resolve `host` ourselves and return an address to connect to. The caller connects to this address, not
 * the name, so a second DNS answer cannot redirect the connection (DNS rebinding). If ANY answer is
 * blocked the whole name is refused, so a mixed public/private record cannot be used to probe.
 * Throws an Error with .code 'blocked' or 'unresolved'.
 */
export async function resolvePublic(host, { lookup = dns.lookup, blocked = isBlockedAddress } = {}) {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  let answers;
  if (net.isIP(bare)) answers = [{ address: bare }];
  else {
    try {
      answers = await lookup(bare, { all: true, verbatim: true });
    } catch {
      throw Object.assign(new Error(`cannot resolve ${bare}`), { code: 'unresolved' });
    }
  }
  if (!answers.length) throw Object.assign(new Error(`cannot resolve ${bare}`), { code: 'unresolved' });
  if (answers.some((a) => blocked(a.address))) throw Object.assign(new Error(`${bare} resolves to a non-public address`), { code: 'blocked' });
  return answers[0].address;
}
