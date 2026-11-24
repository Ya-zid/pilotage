// HTTPS for phones: the name-constrained Pilotage CA, the server certificate, and the LAN listener that speaks http and
// https on one port. Unit part runs server/tls.js in-process on a temp data dir; the rest starts a real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import nodeTls from 'node:tls';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';

const UNIT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-tls-unit-'));
process.env.PILOTAGE_DATA = UNIT_DATA; // read by server/config.js at import time
const tls = await import('../server/tls.js');

const SRV_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-tls-srv-'));
const PORT = 5061 + 2 * Math.floor(Math.random() * 40);
const LAN = PORT - 1;
const LAN_HOST = '192.168.1.50:4748';
let proc;
let caPem = '';
let cookie = '';
let key = '';

function opensslVerify(caFile, pem) {
  const f = path.join(UNIT_DATA, `check-${crypto.randomUUID()}.crt`);
  fs.writeFileSync(f, pem);
  const r = spawnSync('openssl', ['verify', '-CAfile', caFile, f], { encoding: 'utf8' });
  fs.rmSync(f, { force: true });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** One request to the test server. proto 'http' | 'https'; https verifies against the Pilotage CA unless ca === false. */
function request({ proto = 'http', port = LAN, path: p = '/', method = 'GET', headers = {}, body, ca = caPem, host = LAN_HOST, dial = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const mod = proto === 'https' ? https : http;
    const opts = { host: dial, port, path: p, method, headers: { host, ...headers }, agent: false };
    // Verify the chain against the Pilotage CA, and the name against the address we really dial (127.0.0.1 is in the
    // certificate), whatever Host header the test sends.
    if (proto === 'https') Object.assign(opts, ca ? { ca } : {}, { rejectUnauthorized: true, checkServerIdentity: (_h, cert) => nodeTls.checkServerIdentity('127.0.0.1', cert) });
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), encrypted: !!res.socket?.encrypted }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// Never scan the real home folder or Windows profile: the server only needs to come up with https here.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-tls-home-'));

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, HOME: FAKE_HOME, PILOTAGE_WIN_HOME: FAKE_HOME, PILOTAGE_DATA: SRV_DATA, PILOTAGE_PORT: String(PORT), PILOTAGE_LAN_INTERNAL_PORT: String(LAN), PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1', PILOTAGE_LAN_BIND: '' },
    stdio: 'ignore',
  });
  // up, and the certificate made (it's created right after the listeners start)
  for (let i = 0; i < 120; i++) {
    try {
      const pem = fs.readFileSync(path.join(SRV_DATA, 'tls', 'ca.crt'), 'utf8');
      const r = await request({ proto: 'https', path: '/healthz', ca: pem });
      if (r.status === 200) {
        caPem = pem;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(caPem, 'server did not come up with https');
  key = JSON.parse(fs.readFileSync(path.join(SRV_DATA, 'secrets.json'), 'utf8')).desktopKey;
  const lc = await request({ port: PORT, host: '127.0.0.1', path: '/api/auth/login-code', method: 'POST', headers: { 'X-Pilotage-Key': key, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(lc.status, 200);
  const code = new URL(JSON.parse(lc.body).url).searchParams.get('c');
  const r = await request({ port: PORT, host: '127.0.0.1', path: `/auth/login?c=${code}` });
  assert.equal(r.status, 302);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});

after(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill();
    await once(proc, 'exit');
  }
  for (const d of [UNIT_DATA, SRV_DATA]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------- the CA and certificates (in-process)
test('the CA has critical nameConstraints, the files are private, the server certificate is bounded', async () => {
  const r = await tls.ensureTls(['192.168.1.20', '100.64.3.4', '8.8.8.8']);
  assert.equal(r.ok, true, r.error);
  const caFile = path.join(UNIT_DATA, 'tls', 'ca.crt');
  const text = spawnSync('openssl', ['x509', '-in', caFile, '-noout', '-text'], { encoding: 'utf8' }).stdout;
  assert.match(text, /X509v3 Name Constraints: critical/);
  assert.match(text, /CA:TRUE, pathlen:0/);
  for (const want of ['IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0', 'IP:192.168.0.0/255.255.0.0', 'IP:100.64.0.0/255.192.0.0', 'IP:127.0.0.0/255.0.0.0', 'DNS:localhost', 'DNS:local', 'DNS:lan', 'DNS:home.arpa']) {
    assert.ok(text.includes(want), `CA permits ${want}`);
  }
  assert.doesNotMatch(text, /Excluded/); // allow-list only
  const st = tls.tlsStatus();
  assert.equal(st.ready, true);
  assert.match(st.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(st.leafNames.includes('192.168.1.20') && st.leafNames.includes('100.64.3.4') && st.leafNames.includes('localhost'));
  assert.ok(!st.leafNames.includes('8.8.8.8'), 'public addresses are never put in the certificate');
  const leaf = new crypto.X509Certificate(fs.readFileSync(path.join(UNIT_DATA, 'tls', 'leaf.crt')));
  const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / 86400e3;
  assert.ok(days <= 398 && days >= 390, `server certificate lifetime ${days} days`);
  assert.equal(fs.statSync(path.join(UNIT_DATA, 'tls')).mode & 0o777, 0o700);
  for (const f of ['ca.key', 'leaf.key']) assert.equal(fs.statSync(path.join(UNIT_DATA, 'tls', f)).mode & 0o777, 0o600, f);
  assert.ok(opensslVerify(caFile, leaf.toString()).ok);
});

test('a certificate for a public name or address fails verification; private ones pass', async () => {
  const caFile = path.join(UNIT_DATA, 'tls', 'ca.crt');
  for (const names of [{ dns: ['example.com'] }, { dns: ['www.google.com'] }, { ips: ['8.8.8.8'] }, { dns: ['pc.local', 'example.com'] }, { ips: ['192.168.1.20', '1.1.1.1'] }]) {
    const { pem } = await tls.issueLeaf(names);
    const v = opensslVerify(caFile, pem);
    assert.equal(v.ok, false, `must be rejected: ${JSON.stringify(names)}`);
    assert.match(v.out, /permitted subtree violation/);
  }
  for (const names of [{ ips: ['192.168.50.7'] }, { ips: ['100.64.0.9'] }, { ips: ['100.127.255.254', '10.20.30.40', '172.31.0.1'] }, { dns: ['pc.local', 'pc.home.arpa', 'x.lan'] }]) {
    const { pem } = await tls.issueLeaf(names);
    assert.equal(opensslVerify(caFile, pem).ok, true, `must pass: ${JSON.stringify(names)}`);
  }
});

test('the server certificate is re-issued only when an address is not covered', async () => {
  assert.equal((await tls.ensureTls(['192.168.1.20'])).changed, false);
  const r = await tls.ensureTls(['10.9.8.7', '192.168.1.20']);
  assert.equal(r.changed, true);
  assert.ok(tls.tlsStatus().leafNames.includes('10.9.8.7'));
  assert.equal((await tls.ensureTls(['10.9.8.7'])).changed, false);
});

// ---------------------------------------------------------------- the dual-protocol LAN listener (real server)
test('the LAN port serves the same responses over http and https', async () => {
  for (const [p, h] of [['/healthz', {}], ['/', {}], ['/api/overview', {}], ['/api/bootstrap', { cookie }], ['/api/ideas', { cookie }]]) {
    const a = await request({ proto: 'http', path: p, headers: h });
    const b = await request({ proto: 'https', path: p, headers: h });
    assert.equal(b.encrypted, true);
    assert.equal(a.status, b.status, p);
    if (p === '/api/bootstrap') {
      assert.equal(a.status, 200);
      assert.equal(JSON.parse(a.body).device.viaLan, true);
      assert.equal(JSON.parse(b.body).device.viaLan, true, 'TLS requests count as LAN');
    } else assert.deepEqual(a.body, b.body, p);
  }
  // Host allow-list (DNS rebinding guard) and CSRF checks apply over https too
  assert.equal((await request({ proto: 'https', path: '/api/overview', host: 'evil.example', headers: { cookie } })).status, 421);
  assert.equal((await request({ proto: 'https', path: '/api/ideas', method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"text":"x"}' })).status, 403);
});

test('PC-only actions are refused over https as over http', async () => {
  for (const proto of ['http', 'https']) {
    const r = await request({ proto, path: '/api/devices/pair', method: 'POST', headers: { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, proto);
    const k = await request({ proto, path: '/api/devices', headers: { 'X-Pilotage-Key': key } });
    assert.equal(k.status, 401, `${proto}: the desktop key never works from the phone listener`);
  }
});

test('/pilotage-ca.crt is served without sign-in on both listeners (DER); nothing else is', async () => {
  const der = new crypto.X509Certificate(caPem).raw;
  for (const [proto, port, host] of [['http', LAN, LAN_HOST], ['https', LAN, LAN_HOST], ['http', PORT, '127.0.0.1']]) {
    const r = await request({ proto, port, host, path: '/pilotage-ca.crt' });
    assert.equal(r.status, 200, `${proto}:${port}`);
    assert.equal(r.headers['content-type'], 'application/x-x509-ca-cert');
    assert.match(r.headers['content-disposition'], /attachment; filename="pilotage-ca\.crt"/);
    assert.ok(r.body.equals(der), 'the DER of the CA certificate');
    assert.ok(new crypto.X509Certificate(r.body).ca);
  }
  const closed = ['/api/net/tls', '/api/net', '/api/bootstrap', '/api/devices', '/sw.js', '/settings', '/index.html', '/pilotage-ca.key', '/ca.key', '/tls/ca.key', '/data/tls/ca.key', '/leaf.key', '/pilotage-ca.crt/../tls/ca.key', '/pilotage-ca.crt.key'];
  for (const p of closed) {
    for (const [proto, port, host] of [['http', LAN, LAN_HOST], ['https', LAN, LAN_HOST], ['http', PORT, '127.0.0.1']]) {
      const r = await request({ proto, port, host, path: p });
      assert.equal(r.status, 401, `${proto}:${port}${p} must need sign-in`);
      assert.ok(!r.body.includes('PRIVATE KEY'));
    }
  }
  assert.equal((await request({ path: '/pilotage-ca.crt', method: 'POST' })).status, 405);
});

test('without the CA the handshake fails, and plain http keeps working', async () => {
  await assert.rejects(request({ proto: 'https', path: '/healthz', ca: false }), (e) => /certificate|self.signed|verify/i.test(`${e.code} ${e.message}`));
  assert.equal((await request({ proto: 'http', path: '/healthz' })).status, 200);
});

test('pairing prefers https once the certificate exists, and pairing over https works', async () => {
  const r = await request({ port: PORT, host: '127.0.0.1', path: '/api/devices/pair', method: 'POST', headers: { 'X-Pilotage-Key': key, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.scheme, 'https');
  assert.equal(j.tls.ready, true);
  for (const u of j.urls) assert.match(u.url, /^https:\/\//);
  for (const u of j.alt) assert.match(u.url, /^http:\/\//);
  if (!j.urls.length) return; // no LAN address on this machine
  const code = new URL(j.urls[0].url).searchParams.get('c');
  const p = await request({ proto: 'https', path: `/auth/pair?c=${code}`, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/151 Mobile' } });
  assert.equal(p.status, 302);
  assert.match(String(p.headers['set-cookie']), /pl_dev=/);
  // the new phone's cookie works over https and over http (same host)
  const phone = String(p.headers['set-cookie']).split(';')[0];
  assert.equal((await request({ proto: 'https', path: '/api/bootstrap', headers: { cookie: phone } })).status, 200);
  assert.equal((await request({ proto: 'http', path: '/api/bootstrap', headers: { cookie: phone } })).status, 200);
});

// ---------------------------------------------------------------- Linux/macOS: direct bind (PILOTAGE_LAN_BIND)
test('bind mode allow-list: VPN ranges, explicit subnets, loopback; nothing else', async () => {
  process.env.PILOTAGE_LAN_ALLOW = 'vpn,192.168.7.0/24';
  const net = await import('../server/net.js');
  const yes = ['192.168.7.9', '::ffff:192.168.7.200', '100.70.1.1', '127.0.0.1', '::1'];
  const no = ['192.168.8.1', '8.8.8.8', '10.0.0.5', 'fe80::1', '2001:db8::1', '', 'nonsense'];
  for (const ip of yes) assert.equal(net.lanConnectionAllowed(ip), true, ip);
  for (const ip of no) assert.equal(net.lanConnectionAllowed(ip), false, ip);
});

test('bind mode: the phone listener binds LAN_PORT directly, speaks both protocols and still counts as LAN', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-tls-bind-'));
  const port = PORT + 200;
  const lanPort = PORT + 201;
  const p = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PILOTAGE_DATA: data, PILOTAGE_PORT: String(port), PILOTAGE_LAN_INTERNAL_PORT: String(port - 1), PILOTAGE_LAN_PORT: String(lanPort), PILOTAGE_LAN_BIND: '127.0.0.1', PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1' },
    stdio: 'ignore',
  });
  try {
    let ca = '';
    for (let i = 0; i < 120 && !ca; i++) {
      try {
        const pem = fs.readFileSync(path.join(data, 'tls', 'ca.crt'), 'utf8');
        if ((await request({ proto: 'https', port: lanPort, path: '/healthz', ca: pem })).status === 200) ca = pem;
      } catch {}
      if (!ca) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ca, 'bind-mode server did not come up with https');
    assert.equal((await request({ proto: 'http', port: lanPort, path: '/healthz' })).status, 200);
    const k = JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')).desktopKey;
    for (const proto of ['http', 'https']) {
      // the desktop key is refused on the phone listener: proof the request was seen as LAN without the loopback port trick
      assert.equal((await request({ proto, port: lanPort, path: '/api/devices', headers: { 'X-Pilotage-Key': k }, ca })).status, 401, proto);
      assert.equal((await request({ proto, port: lanPort, path: '/pilotage-ca.crt', ca })).status, 200, proto);
    }
    assert.equal((await request({ port, host: '127.0.0.1', path: '/api/devices', headers: { 'X-Pilotage-Key': k } })).status, 200);
    // nothing listens on the loopback forwarder port in bind mode
    await assert.rejects(request({ proto: 'http', port: port - 1, path: '/healthz' }));
  } finally {
    p.kill();
    await once(p, 'exit');
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('bind mode on IPv6: PILOTAGE_LAN_BIND=[::1] listens on IPv6 and takes bracketed IPv6 hosts, never names', async (t) => {
  if (!Object.values(os.networkInterfaces()).flat().some((a) => a?.address === '::1')) return t.skip('no IPv6 loopback here');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-tls-bind6-'));
  const port = PORT + 202;
  const lanPort = PORT + 203;
  const p = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, HOME: FAKE_HOME, PILOTAGE_WIN_HOME: FAKE_HOME, PILOTAGE_DATA: data, PILOTAGE_PORT: String(port), PILOTAGE_LAN_INTERNAL_PORT: String(port - 1), PILOTAGE_LAN_PORT: String(lanPort), PILOTAGE_LAN_BIND: '[::1]', PILOTAGE_LAN_ALLOW: 'vpn', PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1' },
    stdio: 'ignore',
  });
  const get6 = (host, headers = {}, p2 = '/healthz') => request({ port: lanPort, dial: '::1', host, path: p2, headers });
  try {
    let up = null;
    for (let i = 0; i < 120 && !up && p.exitCode === null; i++) {
      try {
        up = await get6(`[::1]:${lanPort}`);
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(up?.status, 200, `phone listener on [::1] (server exit code ${p.exitCode})`);
    // what a phone on Tailscale's IPv6 range sends
    assert.equal((await get6(`[fd7a:115c:a1e0::1]:${lanPort}`)).status, 200);
    for (const h of [`localhost:${lanPort}`, `[localhost]:${lanPort}`, `[fe80::1%25eth0]:${lanPort}`]) assert.equal((await get6(h)).status, 421, h);
    // still the phone listener: the desktop key counts for nothing there
    const k = JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')).desktopKey;
    assert.equal((await get6(`[::1]:${lanPort}`, { 'X-Pilotage-Key': k }, '/api/devices')).status, 401);
    // bound to ::1 only: nothing answers on IPv4
    await assert.rejects(request({ port: lanPort, path: '/healthz' }));
  } finally {
    p.kill();
    if (p.exitCode === null) await once(p, 'exit');
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
