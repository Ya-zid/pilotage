// Phone access: the PC's Wi-Fi / NetBird addresses, the Windows-side forwarder and its firewall rule.
//
// The forwarder runs as %LOCALAPPDATA%\Pilotage\pilotage-forwarder.exe, a copy of Windows node.exe.
// A separate exe matters: Windows Firewall already has *block* rules for node.exe on Public networks
// (home Wi-Fi and VPN adapters are often "Public"), and block rules always win over allow rules.
// Allowing it needs admin rights once: enablePhoneAccess() opens a UAC prompt that adds one narrow rule
// (TCP 4748, only from the local subnet and the NetBird/Tailscale ranges).
//
// Linux/macOS (no Windows forwarder): PILOTAGE_LAN_BIND=0.0.0.0 (or :: for IPv6 too) makes the phone listener bind
// LAN_PORT directly, gated per connection by lanConnectionAllowed() (same idea as the forwarder). Off by default. See
// docs/PHONE.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPCONFIG_EXE, WIN_PILOTAGE_DIR, LAN_PORT, LAN_INTERNAL_PORT, PORT, WIN_NODE, POWERSHELL_EXE, ROOT } from './config.js';
import { run, readJSONSync, log } from './util.js';
import { tlsStatus } from './tls.js';
import { parseIp, parseCidr, inCidr, formatCidr, maskBits } from './ip.js';

export const RULE_NAME = 'Pilotage phone access';
const NETSH = '/mnt/c/Windows/System32/netsh.exe';
const TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';
const TASKLIST = '/mnt/c/Windows/System32/tasklist.exe';
const FWD_EXE = WIN_PILOTAGE_DIR ? path.join(WIN_PILOTAGE_DIR, 'pilotage-forwarder.exe') : null;
const FWD_JS = WIN_PILOTAGE_DIR ? path.join(WIN_PILOTAGE_DIR, 'forwarder.js') : null;
const FWD_CFG = WIN_PILOTAGE_DIR ? path.join(WIN_PILOTAGE_DIR, 'forwarder-config.json') : null;

/** Windows tools are reachable (WSL): phones come through the Windows forwarder. */
const WIN_SIDE = fs.existsSync(IPCONFIG_EXE);
/** Opt-in direct bind for Linux/macOS (or WSL in mirrored networking mode): '0.0.0.0', '::', or one address. An IPv6
 * address may be written in URL brackets ([::]). '::' also takes IPv4 peers (as ::ffff:a.b.c.d, checked as IPv4). */
export const LAN_BIND = (process.env.PILOTAGE_LAN_BIND || '').trim().replace(/^\[([0-9a-f:.%_-]*)\]$/i, '$1');
/** LAN_BIND:LAN_PORT as it would appear in a URL ([::]:4748 for IPv6). */
export const LAN_BIND_LABEL = LAN_BIND.includes(':') ? `[${LAN_BIND}]:${LAN_PORT}` : `${LAN_BIND}:${LAN_PORT}`;
/** 'bind': the LAN listener is on LAN_BIND:LAN_PORT. 'forwarder': Windows forwarder → 127.0.0.1:LAN_INTERNAL_PORT. 'off'. */
export const LAN_MODE = LAN_BIND ? 'bind' : WIN_SIDE ? 'forwarder' : 'off';
/** NetBird and Tailscale both hand out IPv4 addresses in the CGNAT range; Tailscale's IPv6 addresses are in its own /48. */
const CGNAT = '100.64.0.0/10';
const TAILSCALE6 = 'fd7a:115c:a1e0::/48';
const VPN_CIDRS = [CGNAT, TAILSCALE6];

/**
 * The connected Wi-Fi network's name (SSID) in `netsh wlan show interfaces` output, or null (pure; tested).
 * Windows translates the other labels ("State", "État", "Status"…), but "SSID" is the same in every language and the
 * line is only there while connected (not to be confused with "BSSID" / "AP BSSID").
 */
export function parseWlanSsid(text) {
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const m = /^SSID\s*:\s*(.+)$/i.exec(raw.trim());
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/** Current Wi-Fi network name (SSID) of the PC, or null. */
export async function currentSsid() {
  const r = await run(NETSH, ['wlan', 'show', 'interfaces'], { timeout: 10000, cwd: '/mnt/c/' });
  return parseWlanSsid(r.stdout);
}

export function readForwarderConfig() {
  return (FWD_CFG && readJSONSync(FWD_CFG, null)) || { trustedSsids: [], vpnCidrs: ['100.64.0.0/10'] };
}

/** Which networks may reach Pilotage: VPN ranges always, Wi-Fi only while on a trusted SSID. */
export async function writeForwarderConfig(patch = {}) {
  const cur = readForwarderConfig();
  const addrs = await windowsAddresses(true);
  const vpn = new Set(['100.64.0.0/10', ...(cur.vpnCidrs || [])]);
  for (const a of addrs) if (a.kind === 'netbird') vpn.add(cidrOf(a.ip, a.mask) || `${a.ip.split('.').slice(0, 2).join('.')}.0.0/16`);
  const next = { ...cur, ...patch, vpnCidrs: [...vpn], listenPort: LAN_PORT, targetPort: LAN_INTERNAL_PORT };
  next.trustedSsids = [...new Set((next.trustedSsids || []).filter((x) => typeof x === 'string' && x.length <= 64))];
  fs.mkdirSync(WIN_PILOTAGE_DIR, { recursive: true });
  fs.writeFileSync(FWD_CFG, JSON.stringify(next, null, 2));
  return next;
}

let cache = { at: 0, addrs: [] };

/**
 * Firewall scope (defense in depth; the forwarder checks every connection): the VPN ranges plus Windows' own
 * "LocalSubnet" keyword, which follows whatever network the PC is on. A fixed list of subnets froze the network where
 * "Enable" was clicked: at home after enabling at work, Settings showed green while Windows dropped the phone's
 * packets. Which neighbours get in is the forwarder's job (trusted Wi-Fi only), and it can't be bypassed by this (pure;
 * tested; addrs is accepted for compatibility).
 */
export function firewallRanges(addrs, vpnCidrs = []) {
  return new Set(['LocalSubnet', ...vpnCidrs]);
}

// Wi-Fi adapters' type words in Windows' languages ("Wireless LAN adapter", "Carte réseau sans fil",
// "Drahtlos-LAN-Adapter", "Adaptador de LAN inalámbrica"…); most also name the adapter "Wi-Fi" or "WLAN".
const WIFI_WORDS = /wi-?fi|wlan|wireless|sans fil|drahtlos|inal[aá]mbric|sem fio|draadloos|senza fili|bezprzewod|беспровод|kablosuz/i;

/**
 * `ipconfig` output → [{adapter, ip, mask, kind}], Wi-Fi first, virtual adapters left out (pure; tested).
 * The labels are in the user's Windows language ("Adresse IPv4", "IPv4-Adresse"…), so this reads the layout instead:
 * a line at column 0 ending in ':' starts an adapter, the indented line whose label mentions IPv4 holds its address,
 * and the next indented line holding a netmask (255.x.x.x) its mask.
 */
export function parseIpconfig(text) {
  const addrs = [];
  let adapter = '';
  let cur = null;
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const a = /^(\S.*?)\s*:\s*$/.exec(raw);
    if (a) {
      adapter = a[1];
      cur = null;
      continue;
    }
    const m = /^\s+[^:]*IPv4[^:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})/.exec(raw);
    if (m && adapter) {
      const ip = m[1];
      let kind = 'other';
      if (/wt0|netbird/i.test(adapter)) kind = 'netbird';
      else if (/tailscale/i.test(adapter) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) kind = 'tailscale';
      else if (WIFI_WORDS.test(adapter)) kind = 'wifi';
      else if (/vEthernet|WSL|Default Switch/i.test(adapter)) kind = 'virtual';
      else if (/ethernet/i.test(adapter)) kind = 'ethernet';
      cur = { adapter: adapter.replace(/^.*adapter /i, ''), ip, kind, mask: null };
      if (kind !== 'virtual') addrs.push(cur);
      continue;
    }
    const mk = /^\s+[^:]*:\s*(255\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*$/.exec(raw);
    if (mk && cur && !cur.mask) cur.mask = mk[1];
  }
  const order = { wifi: 0, ethernet: 1, netbird: 2, tailscale: 3, other: 4 };
  return addrs.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** The PC's Windows-side addresses (cached 5 minutes). */
export async function windowsAddresses(force = false) {
  if (!force && Date.now() - cache.at < 5 * 60e3 && cache.addrs.length) return cache.addrs;
  const r = await run(IPCONFIG_EXE, [], { timeout: 10000, cwd: '/mnt/c/' });
  const addrs = parseIpconfig(r.stdout);
  cache = { at: Date.now(), addrs };
  return addrs;
}

const SKIP_IFACES = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|lxc|lxd|zt)/i;
const isFamily = (a, v) => a.family === `IPv${v}` || a.family === v; // Node 18.0-18.3 used numbers
const isVpn = (kind) => kind === 'netbird' || kind === 'tailscale';
function ifaceKind(name, vpnAddress) {
  if (/^(wt\d|netbird)/i.test(name)) return 'netbird';
  if (/tailscale/i.test(name) || vpnAddress) return 'tailscale';
  if (/^(wl|wlan|wifi)/i.test(name) || (process.platform === 'darwin' && name === 'en0')) return 'wifi';
  if (/^(en|eth|eno|enp|ens)/i.test(name)) return 'ethernet';
  return 'other';
}

/** Non-WSL: this machine's own IPv4 interfaces, in the same shape as windowsAddresses(). */
export function localAddresses(ifaces = os.networkInterfaces()) {
  const addrs = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (SKIP_IFACES.test(name)) continue;
    for (const a of list || []) {
      if (a.internal || !isFamily(a, 4)) continue;
      addrs.push({ adapter: name, ip: a.address, kind: ifaceKind(name, inCidr(a.address, CGNAT)), mask: a.netmask || null });
    }
  }
  const order = { wifi: 0, ethernet: 1, netbird: 2, tailscale: 3, other: 4 };
  return addrs.sort((a, b) => order[a.kind] - order[b.kind]);
}

/**
 * This machine's IPv6 subnets that "lan" / "vpn" may open (pure; tested): unique-local (fc00::/7) and global (2000::/3)
 * prefixes of /48 or narrower, never link-local, 6to4 or Teredo (list fe80::/10 yourself to allow link-local).
 * VPN subnets: NetBird/Tailscale interfaces by name, or one holding a Tailscale address (a macOS utun). A CGNAT IPv4
 * alone doesn't make an interface's IPv6 "vpn": some hotspots hand those out.
 */
export function localSubnets6(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (SKIP_IFACES.test(name)) continue;
    const kind = ifaceKind(name, (list || []).some((a) => inCidr(a.address, TAILSCALE6)));
    for (const a of list || []) {
      if (a.internal || !isFamily(a, 6)) continue;
      const ip = parseIp(a.address);
      const bits = maskBits(a.netmask);
      if (!ip || ip.v !== 6 || bits === null || bits < 48) continue;
      if (!inCidr(ip, 'fc00::/7') && !inCidr(ip, '2000::/3')) continue;
      if (inCidr(ip, '2001::/32') || inCidr(ip, '2002::/16')) continue; // Teredo, 6to4: tunnels, not a network you're on
      const c = parseCidr(`${a.address}/${bits}`);
      if (c) out.push({ adapter: name, kind, cidr: formatCidr(c) });
    }
  }
  return out;
}

/** The addresses a phone uses to reach Pilotage: the Windows side under WSL, else this machine's interfaces. */
export async function phoneAddresses(force = false) {
  if (WIN_SIDE && !LAN_BIND) return windowsAddresses(force);
  if (WIN_SIDE) {
    // WSL with a direct bind (mirrored networking): Windows and WSL share addresses; prefer the Windows view.
    const w = await windowsAddresses(force);
    if (w.length) return w;
  }
  return localAddresses();
}

/** http and https addresses for a paired phone (same port: the LAN listener speaks both). */
export function phoneUrls(addrs) {
  return addrs.map((a) => ({ kind: a.kind, adapter: a.adapter, ip: a.ip, http: `http://${a.ip}:${LAN_PORT}`, https: `https://${a.ip}:${LAN_PORT}` }));
}

/**
 * Bind mode only: which remote addresses may open a connection (pure given the interfaces; tested).
 * PILOTAGE_LAN_ALLOW (comma list) can narrow or widen it: "vpn" = NetBird/Tailscale ranges (IPv4 and IPv6), "lan" =
 * the subnets this machine is on right now (IPv4 and IPv6), or explicit IPv4 / IPv6 CIDRs. Default "lan,vpn".
 * Loopback is always allowed. Entries that don't parse add nothing.
 */
export function allowListFor(specText, ifaces = os.networkInterfaces()) {
  const spec = String(specText || 'lan,vpn').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const out = new Set(['127.0.0.0/8', '::1/128']);
  const v4 = localAddresses(ifaces);
  const v6 = localSubnets6(ifaces);
  for (const item of spec) {
    if (item === 'vpn') for (const c of VPN_CIDRS) out.add(c);
    else if (item === 'lan') {
      for (const a of v4) if (!isVpn(a.kind)) {
        const c = cidrOf(a.ip, a.mask);
        if (c && Number(c.split('/')[1]) >= 16) out.add(c); // never a whole /8 by accident
      }
      for (const s of v6) if (!isVpn(s.kind)) out.add(s.cidr);
    } else if (parseCidr(item)) out.add(item);
  }
  // NetBird/Tailscale interfaces may use a custom range: allow the interface's own subnet when "vpn" is on.
  if (spec.includes('vpn')) {
    for (const a of v4) if (isVpn(a.kind)) {
      const c = cidrOf(a.ip, a.mask);
      if (c) out.add(c);
    }
    for (const s of v6) if (isVpn(s.kind)) out.add(s.cidr);
  }
  return [...out];
}

/** Is a socket's remoteAddress inside one of the ranges? Unparseable → no; ::ffff:a.b.c.d is checked as a.b.c.d. */
export function addressAllowed(remote, cidrs) {
  const ip = parseIp(remote);
  return !!ip && cidrs.some((c) => inCidr(ip, c));
}

let allowCache = { at: 0, cidrs: [], parsed: [] };
/** The allow-list for this machine right now (re-read every 30 s: Wi-Fi and VPN come and go). */
export function lanAllowList() {
  if (Date.now() - allowCache.at < 30_000) return allowCache.cidrs;
  const cidrs = allowListFor(process.env.PILOTAGE_LAN_ALLOW);
  allowCache = { at: Date.now(), cidrs, parsed: cidrs.map(parseCidr).filter(Boolean) };
  return cidrs;
}

/** Per-connection gate for the direct bind (the Windows forwarder does the same on its side). */
export function lanConnectionAllowed(remote) {
  lanAllowList();
  return addressAllowed(remote, allowCache.parsed);
}

/** The hash windows/forwarder.js puts in its heartbeat (same bytes: syncFiles copies the file as is). */
export function forwarderCode(src) {
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
}
let shipped = null;
function shippedCode() {
  if (shipped === null) {
    try {
      shipped = forwarderCode(fs.readFileSync(path.join(ROOT, 'windows', 'forwarder.js')));
    } catch {
      shipped = '';
    }
  }
  return shipped;
}

/** A running forwarder that serves another port or runs older code than the one shipped (pure; tested). */
export function forwarderOutdated(hb, running, want = { targetPort: LAN_INTERNAL_PORT, code: shippedCode() }) {
  if (!running) return false;
  return hb?.targetPort !== want.targetPort || (!!want.code && hb?.code !== want.code);
}

export function forwarderStatus() {
  if (!WIN_PILOTAGE_DIR) return { installed: false, running: false };
  const hb = readJSONSync(path.join(WIN_PILOTAGE_DIR, 'forwarder.json'), null);
  const installed = !!FWD_JS && fs.existsSync(FWD_JS);
  const running = !!hb && !hb.exitedAt && Date.now() - (hb.at || 0) < 90_000; // exitedAt: it said goodbye
  return {
    installed,
    running,
    port: hb?.listenPort || LAN_PORT,
    pid: running ? hb?.pid || null : null,
    lastSeen: hb?.at || 0,
    error: hb?.error || null,
    connections: hb?.connections || 0,
    refused: hb?.refused || 0,
    ssidTrusted: !!hb?.ssidTrusted,
    onWifi: !!hb?.onWifi,
    outdated: forwarderOutdated(hb, running),
  };
}

let ruleCache = { at: 0, exists: false };
export async function firewallRuleExists(force = false) {
  if (!force && Date.now() - ruleCache.at < 60e3) return ruleCache.exists;
  const r = await run(NETSH, ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`], { timeout: 15000, cwd: '/mnt/c/' });
  const exists = r.code === 0 && /Rule Name/i.test(r.stdout);
  ruleCache = { at: Date.now(), exists };
  return exists;
}

function syncFiles() {
  fs.mkdirSync(WIN_PILOTAGE_DIR, { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, 'windows', 'forwarder.js'), 'utf8');
  if (!fs.existsSync(FWD_JS) || fs.readFileSync(FWD_JS, 'utf8') !== src) fs.writeFileSync(FWD_JS, src);
  const nodeSize = fs.statSync(WIN_NODE).size;
  if (!fs.existsSync(FWD_EXE) || fs.statSync(FWD_EXE).size !== nodeSize) fs.copyFileSync(WIN_NODE, FWD_EXE);
}

async function ensureConfig() {
  if (!fs.existsSync(FWD_CFG) || readForwarderConfig().targetPort !== LAN_INTERNAL_PORT) await writeForwarderConfig();
}

async function winPath(p) {
  return (await run('wslpath', ['-w', p])).stdout.trim();
}

/**
 * What ensureForwarder does (pure; tested). ruleOk: the firewall rule exists (or force). A running forwarder that is
 * outdated is only stopped once its replacement can start: when the rule check fails (netsh timed out, the rule
 * was removed) the old one keeps serving phones instead of leaving none.
 */
export function forwarderPlan(st, ruleOk) {
  if (st.running && !st.outdated) return 'already';
  if (!ruleOk) return st.running ? 'keep' : 'needs-firewall';
  return st.running ? 'restart' : 'start';
}

/** Start the forwarder (hidden). By default only once the firewall rule exists (otherwise it can't be reached). */
export async function ensureForwarder({ force = false } = {}) {
  if (!WIN_PILOTAGE_DIR || !fs.existsSync(WIN_NODE)) return { ok: false, error: 'Windows Node.js not found' };
  stoppedByUser = false;
  revive.gaveUp = false;
  try {
    syncFiles();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  await ensureConfig();
  const st = forwarderStatus();
  const plan = forwarderPlan(st, st.running && !st.outdated ? true : force || (await firewallRuleExists()));
  if (plan === 'already') return { ok: true, already: true };
  if (plan === 'keep') return { ok: true, already: true, outdated: true }; // an older forwarder beats none
  if (plan === 'needs-firewall') return { ok: false, needsFirewall: true, error: 'Phone access is not enabled yet (needs the one-time firewall rule)' };
  if (plan === 'restart') {
    log.info('forwarder runs older code (or serves another port): restarting it');
    await stopForwarder();
  }
  const exe = await winPath(FWD_EXE);
  const js = await winPath(FWD_JS);
  const ps = `Start-Process -WindowStyle Hidden -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '"${js.replace(/'/g, "''")}"'`;
  const r = await run(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000, cwd: '/mnt/c/' });
  if (r.code !== 0) {
    log.warn('forwarder start failed', r.stderr);
    return { ok: false, error: r.stderr.slice(0, 300) };
  }
  return { ok: true };
}

export async function stopForwarder({ byUser = false } = {}) {
  if (byUser) stoppedByUser = true;
  const st = forwarderStatus();
  if (!st.pid) return { ok: true, already: true };
  await run(TASKKILL, ['/PID', String(st.pid), '/F'], { timeout: 15000, cwd: '/mnt/c/' });
  return { ok: true };
}

let stoppedByUser = false;
const revive = { misses: 0, failures: 0, nextTryAt: 0, gaveUp: false, checking: false };

/**
 * What the once-a-minute check should do (pure; tested). hb = the last heartbeat (null: never ran), running = fresh
 * heartbeat. Waits for two missed checks in a row, backs off after failed restarts (3 failures: once every 30 min)
 * and gives up when a restart said the firewall rule is gone (the user removed it; "Enable" starts over).
 */
export function reviveStep(st, { hb, running, stoppedByUser: stopped, now = Date.now() }) {
  // A restart only counts as working once the forwarder is seen running: one that dies right after starting (port
  // taken by another program) must back off, not restart every 2 minutes forever.
  if (running) return { ...st, misses: 0, failures: 0, nextTryAt: 0, checking: false, action: 'none' };
  if (st.checking) {
    const failures = st.failures + 1;
    st = { ...st, checking: false, failures, nextTryAt: failures >= 3 ? now + 30 * 60e3 : 0 };
  }
  if (!hb || stopped || st.gaveUp) return { ...st, misses: 0, action: 'none' };
  if (st.misses + 1 < 2) return { ...st, misses: st.misses + 1, action: 'none' };
  if (now < st.nextTryAt) return { ...st, misses: 0, action: 'none' };
  return { ...st, misses: 0, action: 'try' };
}
/** After a restart attempt (pure; tested). */
export function reviveResult(st, r, now = Date.now()) {
  if (r?.ok) return { ...st, checking: true }; // confirmed (or counted as a failure) by the next check
  if (r?.needsFirewall) return { ...st, gaveUp: true };
  const failures = st.failures + 1;
  return { ...st, failures, nextTryAt: failures >= 3 ? now + 30 * 60e3 : 0 };
}

/** The process from the last heartbeat still exists: Windows freezes it while the PC sleeps (no heartbeats), then it carries on. */
async function forwarderProcessExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const r = await run(TASKLIST, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 15000, cwd: '/mnt/c/' });
  return /pilotage-forwarder/i.test(r.stdout);
}

/**
 * Called every minute: the forwarder can stop (closed while the PC slept, killed, crashed) and nothing else would start
 * it again. Only for a forwarder that ran before and was not stopped from the app, after two missed checks in a row,
 * and not while its process still exists.
 */
export async function reviveForwarder() {
  const hb = WIN_PILOTAGE_DIR ? readJSONSync(path.join(WIN_PILOTAGE_DIR, 'forwarder.json'), null) : null;
  const step = reviveStep(revive, { hb, running: forwarderStatus().running, stoppedByUser });
  Object.assign(revive, step);
  if (step.action !== 'try') return null;
  if (!hb.exitedAt && (await forwarderProcessExists(Number(hb.pid)))) return null; // frozen by sleep: it carries on
  const r = await ensureForwarder();
  Object.assign(revive, reviveResult(revive, r));
  return r;
}

function cidrOf(ip, mask) {
  if (!ip || !mask) return null;
  const a = ip.split('.').map(Number);
  const m = mask.split('.').map(Number);
  const bits = m.reduce((n, x) => n + x.toString(2).split('1').length - 1, 0);
  return `${a.map((x, i) => x & m[i]).join('.')}/${bits}`;
}

/**
 * Opens a UAC prompt on the PC that adds the firewall rule, then starts the forwarder.
 * Scope: TCP 4748 for pilotage-forwarder.exe only, from the local subnet + VPN ranges.
 */
/**
 * The forwarder-config change "Enable phone access" makes for the current Wi-Fi (pure; tested): nothing unless the user
 * said this network is theirs. Trusting it lets every device on it reach the phone listener, so it is never implied:
 * a café, office or campus network (or any other network with the same name) must not become trusted by accident.
 */
export function enableTrustPatch(ssid, trustWifi, cur = {}) {
  return ssid && trustWifi === true ? { trustedSsids: [...(cur.trustedSsids || []), ssid] } : {};
}

export async function enablePhoneAccess({ trustWifi = false } = {}) {
  if (!WIN_PILOTAGE_DIR) return { ok: false, error: 'Windows profile not found' };
  syncFiles();
  const addrs = await windowsAddresses(true);
  const ssid = await currentSsid();
  const cfg = await writeForwarderConfig(enableTrustPatch(ssid, trustWifi, readForwarderConfig()));
  const ranges = firewallRanges(addrs, cfg.vpnCidrs);
  const exe = await winPath(FWD_EXE);
  const q = (x) => x.replace(/'/g, "''");
  // Passed inline with -EncodedCommand (no script file another program could swap before you click Yes).
  const script = [
    `$exe = '${q(exe)}'`,
    'netsh advfirewall firewall delete rule name=all program="$exe" | Out-Null',
    `netsh advfirewall firewall delete rule name="${RULE_NAME}" | Out-Null`,
    `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow program="$exe" protocol=TCP localport=${LAN_PORT} remoteip=${[...ranges].join(',')} profile=any`,
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const cmd = `Start-Process -Verb RunAs -WindowStyle Hidden -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`;
  const r = await run(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 120000, cwd: '/mnt/c/' });
  if (r.code !== 0) return { ok: false, error: /cancel|1223/i.test(r.stderr) ? 'The Windows admin prompt was cancelled' : r.stderr.slice(0, 300) };
  for (let i = 0; i < 20; i++) {
    if (await firewallRuleExists(true)) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (!(await firewallRuleExists(true))) return { ok: false, error: 'The firewall rule was not added (was the admin prompt accepted?)' };
  await stopForwarder();
  const f = await ensureForwarder({ force: true });
  const trusted = !!ssid && (cfg.trustedSsids || []).includes(ssid);
  return { ok: f.ok, ruleAdded: true, wifi: ssid || null, trustedSsid: trusted ? ssid : null, forwarder: f };
}

export async function setTrustedSsid(ssid, trusted) {
  const cur = readForwarderConfig();
  const list = new Set(cur.trustedSsids || []);
  if (trusted) list.add(ssid);
  else list.delete(ssid);
  return writeForwarderConfig({ trustedSsids: [...list] });
}

export async function phoneAccessStatus() {
  const cfg = readForwarderConfig();
  const fwd = LAN_MODE === 'forwarder';
  return {
    addresses: await phoneAddresses(),
    forwarder: forwarderStatus(),
    firewallRule: fwd ? await firewallRuleExists() : false,
    lanPort: LAN_PORT,
    port: PORT,
    currentSsid: fwd ? await currentSsid() : null,
    trustedSsids: cfg.trustedSsids || [],
    vpnCidrs: cfg.vpnCidrs || [],
    // How phones get in: 'forwarder' (WSL + Windows), 'bind' (PILOTAGE_LAN_BIND), 'off'.
    mode: LAN_MODE,
    lanBind: LAN_BIND || null,
    allowList: LAN_MODE === 'bind' ? lanAllowList() : null,
    // HTTPS on the same port (server/tls.js): CA fingerprint for the "Install as an app" steps.
    tls: tlsStatus(),
  };
}
