// windows/forwarder.js decides, per connection, who may reach Pilotage's phone listener. It runs on Windows as a
// CommonJS script (no package.json next to it); here its pure parts are loaded the same way, without starting it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'windows', 'forwarder.js');
function load() {
  const mod = { exports: {} };
  const req = createRequire(file);
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports, path.dirname(file), file);
  return mod.exports;
}

test('forwarder: VPN ranges count only on a VPN adapter; Wi-Fi neighbours only on a trusted network', () => {
  const fwd = load();
  assert.equal(typeof fwd.allowed, 'function', 'loading the file must not start the forwarder');
  fwd.pollInterfaces({ wt0: [{ address: '10.99.0.4' }], 'Wi-Fi': [{ address: '100.66.1.5' }], 'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1' }] });
  fwd._set({ vpnCidrs: ['100.64.0.0/10', '10.99.0.0/16'], trustedSsids: ['Home'] }, 'Cafe');
  assert.equal(fwd.allowed('10.99.0.7', '10.99.0.4'), true, 'a NetBird phone, arriving on wt0');
  assert.equal(fwd.allowed('::ffff:10.99.0.7', '::ffff:10.99.0.4'), true, 'IPv4-mapped spelling');
  // A hotspot that hands out CGNAT (100.64.0.0/10) addresses on plain Wi-Fi: those neighbours are not VPN peers.
  assert.equal(fwd.allowed('100.66.1.9', '100.66.1.5'), false, 'CGNAT neighbour on an untrusted Wi-Fi');
  assert.equal(fwd.allowed('192.168.1.50', '100.66.1.5'), false, 'untrusted Wi-Fi');
  assert.equal(fwd.allowed('127.0.0.1', '127.0.0.1'), true, 'the PC itself');
  fwd._set({}, 'Home');
  assert.equal(fwd.allowed('192.168.1.50', '192.168.1.20'), true, 'trusted home Wi-Fi');
});

test('forwarder: a running forwarder from older code counts as outdated, so an upgrade restarts it', async () => {
  const fwd = load();
  const { forwarderCode, forwarderOutdated } = await import('../server/net.js');
  assert.match(fwd.CODE || '', /^[0-9a-f]{16}$/, 'the forwarder hashes its own source for its heartbeat');
  assert.equal(fwd.CODE, forwarderCode(fs.readFileSync(file, 'utf8')), 'the server computes the same hash from the bundled file');
  const now = { targetPort: 4746, code: fwd.CODE };
  assert.equal(forwarderOutdated({ targetPort: 4746, code: fwd.CODE }, true, now), false, 'same code, same port');
  assert.equal(forwarderOutdated({ targetPort: 4746 }, true, now), true, 'a heartbeat without a hash: code from before this check');
  assert.equal(forwarderOutdated({ targetPort: 4746, code: '0123456789abcdef' }, true, now), true, 'other code');
  assert.equal(forwarderOutdated({ targetPort: 4999, code: fwd.CODE }, true, now), true, 'other target port');
  assert.equal(forwarderOutdated({ targetPort: 4746 }, false, now), false, 'a stopped forwarder is started, not "outdated"');
});

test('forwarder: an upgrade stops the old forwarder only once the new one can start; wg0 counts as a VPN (review R9)', async () => {
  const { forwarderPlan } = await import('../server/net.js');
  assert.equal(forwarderPlan({ running: true, outdated: false }, false), 'already');
  assert.equal(forwarderPlan({ running: true, outdated: true }, true), 'restart');
  assert.equal(forwarderPlan({ running: true, outdated: true }, false), 'keep', 'the rule check failed: keep the old one serving phones');
  assert.equal(forwarderPlan({ running: false }, false), 'needs-firewall');
  assert.equal(forwarderPlan({ running: false }, true), 'start');
  const fwd = load();
  fwd.pollInterfaces({ wg0: [{ address: '10.99.0.4' }] });
  fwd._set({ vpnCidrs: ['10.99.0.0/16'], trustedSsids: [] }, null);
  assert.equal(fwd.allowed('10.99.0.7', '10.99.0.4'), true, 'a WireGuard tunnel named wg0');
});
