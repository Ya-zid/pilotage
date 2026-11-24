// Device pairing + cookie auth + request hardening (Host check, CSRF header).
import fs from 'node:fs';
import { paths } from './config.js';
import { readJSONSync, writeJSONSync, randomToken, hash, safeEqual, clip } from './util.js';
import { parseIp } from './ip.js';

const COOKIE = 'pl_dev';
const PAIR_TTL_MS = 10 * 60 * 1000;
const YEAR_S = 365 * 24 * 3600;

function sha(s) {
  return hash(s, 64);
}

class Secrets {
  constructor() {
    this.data = readJSONSync(paths.secrets, null) || {};
    let dirty = false;
    if (!this.data.desktopKey) {
      this.data.desktopKey = randomToken(32);
      dirty = true;
    }
    if (!Array.isArray(this.data.devices)) {
      this.data.devices = [];
      dirty = true;
    }
    if (!Array.isArray(this.data.pairCodes)) this.data.pairCodes = [];
    if (dirty) this.save();
  }
  save() {
    writeJSONSync(paths.secrets, this.data, 0o600);
    try {
      fs.chmodSync(paths.secrets, 0o600);
    } catch {}
  }
  get desktopKey() {
    return this.data.desktopKey;
  }
  createDevice(name, ua, via) {
    const token = randomToken(32);
    const dev = {
      id: hash(token + Date.now(), 12),
      name: clip(name || guessDeviceName(ua), 60),
      tokenHash: sha(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ua: clip(ua || '', 200),
      via,
    };
    this.data.devices.push(dev);
    this.save();
    return { dev, token };
  }
  findDevice(token) {
    if (!token) return null;
    const h = sha(token);
    return this.data.devices.find((d) => safeEqual(d.tokenHash, h)) || null;
  }
  touch(dev) {
    const now = Date.now();
    if (now - (dev.lastSeenAt || 0) > 60_000) {
      dev.lastSeenAt = now;
      this.save();
    }
  }
  revoke(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    this.save();
    return this.data.devices.length !== before;
  }
  rename(id, name) {
    const d = this.data.devices.find((x) => x.id === id);
    if (d) {
      d.name = clip(name, 60);
      this.save();
    }
    return d;
  }
  /** One-time code. kind 'pair' (phone, 10 min) or 'desktop' (PC browser login from `pilotage open`, 2 min). */
  createPairCode(kind = 'pair') {
    const code = randomToken(18);
    const now = Date.now();
    const ttl = kind === 'desktop' ? 2 * 60 * 1000 : PAIR_TTL_MS;
    this.data.pairCodes = (this.data.pairCodes || []).filter((c) => c.expiresAt > now);
    this.data.pairCodes.push({ hash: sha(code), expiresAt: now + ttl, kind });
    this.save();
    return { code, expiresAt: now + ttl };
  }
  /** Returns the code's kind if valid (and consumes it), else null. */
  consumePairCode(code) {
    if (!code) return null;
    const h = sha(code);
    const now = Date.now();
    const idx = (this.data.pairCodes || []).findIndex((c) => c.expiresAt > now && safeEqual(c.hash, h));
    if (idx === -1) return null;
    const [c] = this.data.pairCodes.splice(idx, 1);
    this.save();
    return c.kind || 'pair';
  }
  rotateDesktopKey() {
    this.data.desktopKey = randomToken(32);
    this.save();
  }
  publicDevices() {
    return this.data.devices.map(({ tokenHash, ...d }) => d);
  }
}

export function guessDeviceName(ua = '') {
  const u = ua.toLowerCase();
  let os = 'Device';
  if (u.includes('iphone')) os = 'iPhone';
  else if (u.includes('ipad')) os = 'iPad';
  else if (u.includes('android')) os = u.includes('mobile') ? 'Android phone' : 'Android tablet';
  else if (u.includes('windows')) os = 'Windows PC';
  else if (u.includes('mac os')) os = 'Mac';
  else if (u.includes('linux')) os = 'Linux';
  let br = '';
  if (u.includes('edg/')) br = 'Edge';
  else if (u.includes('samsungbrowser')) br = 'Samsung Internet';
  else if (u.includes('chrome/')) br = 'Chrome';
  else if (u.includes('firefox/')) br = 'Firefox';
  else if (u.includes('safari/')) br = 'Safari';
  return br ? `${os} · ${br}` : os;
}

let secrets = null;
export function getSecrets() {
  if (!secrets) secrets = new Secrets();
  return secrets;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* malformed cookie value: ignore */
    }
  }
  return out;
}

export function deviceCookie(token) {
  // Lax, not Strict: opening Pilotage from a home-screen icon or a link in another app is a cross-site navigation, and
  // a Strict cookie isn't sent then ("not paired" until a reload). CSRF stays covered: every mutating route needs the
  // X-Pilotage header + JSON (a cross-site form can't send either), and no GET route changes anything.
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR_S}`;
}

export function authenticate(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const dev = getSecrets().findDevice(cookies[COOKIE]);
  if (dev) getSecrets().touch(dev);
  return dev;
}

/**
 * DNS-rebinding guard. Local listener (PC browser + CLI): loopback names only (incl. *.localhost,
 * which browsers always resolve to loopback). LAN listener (phones via the Windows forwarder or a direct bind):
 * IP literals (IPv6 ones in brackets, without zone id) and NetBird/Tailscale names only. Never arbitrary DNS names.
 */
export function hostAllowed(hostHeader, viaLan = false, extra = []) {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  let host = hostHeader.toLowerCase().trim();
  let ip6 = false;
  if (host.startsWith('[')) {
    // [IPv6]:port. Brackets hold an IPv6 literal and nothing else (no name, no zone id).
    const end = host.indexOf(']');
    if (end === -1 || !/^(:\d{1,5})?$/.test(host.slice(end + 1))) return false;
    host = host.slice(1, end);
    if (!host.includes(':') || parseIp(host)?.zone !== '') return false;
    ip6 = true;
  } else host = host.replace(/:\d+$/, '');
  if (!host) return false;
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
  if (!viaLan) return loopback;
  if (ip6 || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.endsWith('.netbird.selfhosted') || host.endsWith('.netbird.cloud') || host.endsWith('.ts.net')) return true;
  return extra.map((h) => String(h).toLowerCase()).includes(host);
}

/** Failure counting per bucket. Callers check it only after a code failed: past 20 failures in 10 minutes junk gets
 * 429 instead of 403, and a valid code is never blocked (codes are 144-bit random, so this guards nothing else). */
const failures = new Map(); // bucket -> timestamps
export function authBlocked(bucket) {
  const now = Date.now();
  const arr = (failures.get(bucket) || []).filter((t) => now - t < 10 * 60_000);
  failures.set(bucket, arr);
  return arr.length >= 20;
}
export function authFailed(bucket) {
  const arr = failures.get(bucket) || [];
  arr.push(Date.now());
  failures.set(bucket, arr);
}
