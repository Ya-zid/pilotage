// IP addresses and CIDR ranges, IPv4 and IPv6 (pure; tested). Used by the phone listener's allow-list (net.js) and the
// Host check (auth.js), so the rule is strict: anything that isn't a well-formed address or range is null, and null
// never matches anything.
//
// An address is { v: 4 | 6, n: BigInt, zone }. IPv4-mapped IPv6 (::ffff:192.168.1.5, any spelling) comes back as the
// IPv4 address it stands for, so a dual-stack socket's IPv4 peers are only ever checked against IPv4 rules, and an
// IPv6 rule (even ::/0) can't let an IPv4 peer in.

const V4_PART = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'; // decimal, no leading zeros (010 could mean octal)
const V4 = new RegExp(`^${V4_PART}(\\.${V4_PART}){3}$`);
const ZONE = /^[0-9a-z_.-]{1,64}$/i; // an interface name or index (fe80::1%eth0, fe80::1%25)
const WIDTH = { 4: 32, 6: 128 };

function v4ToInt(s) {
  return s.split('.').reduce((n, x) => n * 256 + Number(x), 0);
}

/** IPv6 text without zone → 128-bit BigInt, or null. "::" stands for one or more zero groups; the last 32 bits may be
 * written as an IPv4 address (::ffff:1.2.3.4). */
function v6ToBigInt(s) {
  if (s.length > 45 || !/^[0-9a-f:.]+$/i.test(s)) return null; // 45 = ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (h) => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const last = halves.length === 2 ? tail : head;
  if (last.length && last[last.length - 1].includes('.')) {
    const v4 = last.pop();
    if (!V4.test(v4)) return null;
    const n = v4ToInt(v4);
    last.push(Math.floor(n / 65536).toString(16), (n % 65536).toString(16));
  }
  const all = [...head, ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  if (halves.length === 2 ? all.length > 7 : all.length !== 8) return null;
  const full = [...head, ...Array(8 - all.length).fill('0'), ...tail];
  return full.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** '192.168.1.5', 'fd7a:115c:a1e0::1', 'fe80::1%eth0', '::ffff:192.168.1.5'… → { v, n, zone }, or null. */
export function parseIp(text) {
  if (typeof text !== 'string') return null;
  if (V4.test(text)) return { v: 4, n: BigInt(v4ToInt(text)), zone: '' };
  let s = text;
  let zone = '';
  const pct = s.indexOf('%');
  if (pct !== -1) {
    zone = s.slice(pct + 1);
    s = s.slice(0, pct);
    if (!ZONE.test(zone)) return null;
  }
  const n = v6ToBigInt(s);
  if (n === null) return null;
  if (n >> 32n === 0xffffn) return zone ? null : { v: 4, n: n & 0xffffffffn, zone: '' }; // IPv4-mapped
  return { v: 6, n, zone };
}

/** 'fd7a:115c:a1e0::/48', '192.168.1.0/24' → { v, n (host bits cleared), bits }, or null. No zone ids, and no IPv4
 * rule written as IPv6 (::ffff:192.168.1.0/120): IPv4 ranges are written as IPv4. */
export function parseCidr(text) {
  const m = /^([^/]+)\/(0|[1-9]\d{0,2})$/.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  const a = parseIp(m[1]);
  const bits = Number(m[2]);
  if (!a || a.zone || (a.v === 4 && m[1].includes(':')) || bits > WIDTH[a.v]) return null;
  const host = BigInt(WIDTH[a.v] - bits);
  return { v: a.v, n: (a.n >> host) << host, bits };
}

/** Is the address inside the range? Either may be text or already parsed; unparseable → false. */
export function inCidr(ip, cidr) {
  const a = typeof ip === 'string' ? parseIp(ip) : ip;
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!a || !c || a.v !== c.v) return false;
  const host = BigInt(WIDTH[c.v] - c.bits);
  return a.n >> host === c.n >> host;
}

/** Canonical text: dotted IPv4, RFC 5952 IPv6 (lowercase, longest run of two or more zero groups as "::"). */
export function formatIp({ v, n }) {
  if (v === 4) return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join('.');
  const g = [];
  for (let i = 7n; i >= 0n; i--) g.push(Number((n >> (i * 16n)) & 0xffffn));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  const hex = g.map((x) => x.toString(16));
  return best === -1 ? hex.join(':') : `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

export function formatCidr(c) {
  return `${formatIp(c)}/${c.bits}`;
}

/** Length of a prefix netmask ('255.255.255.0' → 24, 'ffff:ffff:ffff:ffff::' → 64), or null if it isn't one. */
export function maskBits(mask) {
  const m = parseIp(mask);
  if (!m || m.zone || (m.v === 4 && String(mask).includes(':'))) return null;
  const width = BigInt(WIDTH[m.v]);
  const inv = ((1n << width) - 1n) ^ m.n; // the host part: must be 0…01…1
  if (inv & (inv + 1n)) return null;
  let bits = WIDTH[m.v];
  for (let x = inv; x; x >>= 1n) bits--;
  return bits;
}
