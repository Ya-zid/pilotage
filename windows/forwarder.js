// Pilotage LAN forwarder — runs on WINDOWS as pilotage-forwarder.exe (a copy of node.exe), no admin rights.
// Listens on 0.0.0.0:4748 and pipes allowed TCP connections to 127.0.0.1:4746, which Windows relays into WSL
// where Pilotage serves phones (that listener refuses PC-only actions like pairing or firewall changes).
//
// Who may connect (checked per connection, before any byte is forwarded):
//   - NetBird / Tailscale peers (encrypted WireGuard tunnels): always.
//   - Wi-Fi / Ethernet neighbours: only while the PC is connected to one of the trusted Wi-Fi networks
//     (your home network), so cafés/hotels/campus Wi-Fi can never reach Pilotage.
// Config: %LOCALAPPDATA%\Pilotage\forwarder-config.json (written by Pilotage).
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const dir = path.join(process.env.LOCALAPPDATA || __dirname, 'Pilotage');
const hbFile = path.join(dir, 'forwarder.json');
const logFile = path.join(dir, 'forwarder.log');
const cfgFile = path.join(dir, 'forwarder-config.json');

let cfg = { listenPort: 4748, targetPort: 4746, vpnCidrs: ['100.64.0.0/10'], trustedSsids: [] };
let currentSsid = null;
let connections = 0;
let refused = 0;
let lastError = null;

function log(msg) {
  try {
    const st = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (st && st.size > 512 * 1024) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg = { ...cfg, ...j };
  } catch (_) {}
}

function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function inCidr(ip, cidr) {
  const [base, bitsStr] = String(cidr).split('/');
  const bits = Number(bitsStr);
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function pollSsid() {
  execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
    if (err) {
      currentSsid = null;
      return;
    }
    // Same rule as parseWlanSsid() in server/net.js: "SSID" is not translated and only shows while connected,
    // unlike "State" ("État", "Status"…), so this works on Windows in any language.
    let ssid = null;
    for (const raw of String(stdout).split(/\r?\n/)) {
      const m = /^SSID\s*:\s*(.+)$/i.exec(raw.trim());
      if (m && m[1].trim() && !ssid) ssid = m[1].trim();
    }
    currentSsid = ssid;
  });
}

function allowed(remote) {
  const ip = String(remote || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1') return true; // local test from the PC itself
  if ((cfg.vpnCidrs || []).some((c) => inCidr(ip, c))) return true;
  return !!currentSsid && (cfg.trustedSsids || []).includes(currentSsid);
}

/** exiting: the last heartbeat before process.exit, marked so Pilotage never takes it for a running forwarder. */
function heartbeat(exiting = false) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const hb = { pid: process.pid, listenPort: cfg.listenPort, targetPort: cfg.targetPort, at: Date.now(), connections, refused, error: lastError, ssidTrusted: !!currentSsid && (cfg.trustedSsids || []).includes(currentSsid), onWifi: !!currentSsid };
    if (exiting) hb.exitedAt = Date.now();
    fs.writeFileSync(hbFile, JSON.stringify(hb));
  } catch (_) {}
}

// Leave a trace when it stops on an error (it runs hidden: nobody sees its console).
process.on('uncaughtException', (e) => {
  lastError = String((e && e.stack) || e).slice(0, 500);
  log(`stopped on an error: ${lastError}`);
  heartbeat(true);
  process.exit(1);
});

loadConfig();
pollSsid();

const server = net.createServer((client) => {
  if (!allowed(client.remoteAddress)) {
    refused++;
    client.destroy();
    return;
  }
  connections++;
  client.setNoDelay(true);
  const upstream = net.connect({ host: '127.0.0.1', port: cfg.targetPort });
  upstream.setNoDelay(true);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
  client.setTimeout(10 * 60 * 1000, close);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`port ${cfg.listenPort} already in use; another forwarder is probably running. Exiting.`);
    // Only when no other forwarder keeps the heartbeat fresh: otherwise this would mark a running one as gone.
    try {
      const prev = JSON.parse(fs.readFileSync(hbFile, 'utf8'));
      if (Date.now() - (prev.at || 0) > 90000) {
        lastError = `port ${cfg.listenPort} in use by another program`;
        heartbeat(true);
      }
    } catch (_) {}
    process.exit(0);
  }
  lastError = String(e.message || e);
  log(`server error: ${lastError}`);
  heartbeat();
  setTimeout(() => process.exit(1), 500);
});

server.listen(cfg.listenPort, '0.0.0.0', () => {
  log(`listening on 0.0.0.0:${cfg.listenPort} -> 127.0.0.1:${cfg.targetPort} (pid ${process.pid})`);
  setTimeout(heartbeat, 1500);
  setInterval(() => {
    loadConfig();
    pollSsid();
    heartbeat();
  }, 20 * 1000);
});
