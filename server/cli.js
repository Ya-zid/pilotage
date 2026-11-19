// Helper for bin/pilotage: talks to the running server with the desktop key.
// Usage (via bin/pilotage): projects [filter] | live | new <project> [--bg|--terminal] [--model m] [--name n] [prompt...]
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PORT } from './config.js';

const key = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')).desktopKey;
const base = `http://127.0.0.1:${PORT}`;

async function api(p, opts = {}) {
  const r = await fetch(base + p, {
    method: opts.method || 'GET',
    headers: { 'X-Pilotage-Key': key, ...(opts.body ? { 'X-Pilotage': '1', 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function ago(t) {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function findProject(projects, q) {
  const ql = q.toLowerCase();
  const exact = projects.filter((p) => p.path === q || p.folderName.toLowerCase() === ql || p.name.toLowerCase() === ql || p.id === q);
  if (exact.length === 1) return exact[0];
  const partial = projects.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(ql));
  if (exact.length > 1 || partial.length > 1) {
    const list = (exact.length > 1 ? exact : partial).slice(0, 10);
    throw new Error(`"${q}" matches several projects:\n${list.map((p) => `  ${p.name.padEnd(30)} ${p.displayPath}`).join('\n')}\nUse the full path.`);
  }
  if (partial.length === 1) return partial[0];
  throw new Error(`No project matches "${q}". Try: pilotage projects`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'login-url') {
    const r = await api('/api/auth/login-code', { method: 'POST', body: {} });
    console.log(r.url);
  } else if (cmd === 'heal-relay') {
    // Windows lost Pilotage's ports in the WSL localhost relay: re-open the listeners now (the watchdog would in ~2 min).
    const r = await api('/api/system/heal-relay', { method: 'POST', body: {} });
    console.log(r.ok ? 'Windows reaches Pilotage again.' : 'Still unreachable from Windows.');
  } else if (cmd === 'rotate-key') {
    await api('/api/security/rotate-key', { method: 'POST', body: {} });
    console.log('Desktop key rotated. Old shortcuts and scripts that embedded it stop working.');
  } else if (cmd === 'pair') {
    const r = await api('/api/devices/pair', { method: 'POST', body: { terminal: true } });
    if (!r.urls || !r.urls.length) console.log('No Wi-Fi/NetBird address found on the PC.');
    else {
      console.log('\nScan with your phone (home Wi-Fi or NetBird). Valid 10 minutes, one device.\n');
      console.log(r.urls[0].qr);
      for (const x of r.urls) console.log(`  ${x.kind.padEnd(9)} ${x.url}`);
    }
    if (!r.firewallRule) console.log('\n\x1b[33mPhone access is not enabled yet: run `pilotage phone` first (one Windows admin prompt).\x1b[0m');
    else if (!r.forwarder.running) console.log('\n\x1b[33mThe phone forwarder is not running: run `pilotage restart`.\x1b[0m');
  } else if (cmd === 'phone') {
    console.log('A Windows admin (UAC) prompt opens on the PC: click Yes. It adds one firewall rule for Pilotage (TCP 4748).');
    const r = await fetch(`${base}/api/net/enable`, { method: 'POST', headers: { 'X-Pilotage-Key': key, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json());
    console.log(r.ok ? `\x1b[32mPhone access enabled.\x1b[0m${r.trustedSsid ? ` Trusted Wi-Fi: ${r.trustedSsid}.` : ''} Now run: pilotage pair` : `\x1b[31m${r.error || 'failed'}\x1b[0m`);
  } else if (cmd === 'projects') {
    const { projects } = await api('/api/projects');
    const f = (args[0] || '').toLowerCase();
    for (const p of projects.filter((x) => !f || `${x.name} ${x.path} ${x.workspaceName}`.toLowerCase().includes(f))) {
      console.log(`${p.liveCount ? '●' : ' '} ${p.name.slice(0, 32).padEnd(32)} ${p.workspaceName.slice(0, 14).padEnd(14)} ${p.status.padEnd(8)} ${ago(p.lastAt).padEnd(9)} ${p.displayPath}`);
    }
  } else if (cmd === 'live') {
    const { live } = await api('/api/live');
    if (!live.length) console.log('Nothing running.');
    for (const s of live) console.log(`● ${s.title.slice(0, 50).padEnd(50)} ${(s.projectName || '').padEnd(24)} ${(s.live.kind === 'background' ? 'bg' : 'tab').padEnd(4)} ${s.live.bridgeUrl || ''}`);
  } else if (cmd === 'new') {
    let mode = 'terminal';
    let model = '';
    let name = '';
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--bg' || a === '--background') mode = 'background';
      else if (a === '--terminal') mode = 'terminal';
      else if (a === '--model') model = args[++i] || '';
      else if (a === '--name') name = args[++i] || '';
      else rest.push(a);
    }
    const target = rest.shift();
    if (!target) throw new Error('Usage: pilotage new <project> [--bg] [--model opus|sonnet|haiku|fable] [--name NAME] ["first prompt"]');
    const { projects } = await api('/api/projects?hidden=1');
    const p = findProject(projects, target);
    const rec = await api('/api/launch', { method: 'POST', body: { projectId: p.id, mode, model, name: name || undefined, prompt: rest.join(' ') } });
    process.stdout.write(`Starting "${rec.name}" in ${p.displayPath} (${rec.mode === 'terminal' ? rec.terminal || 'terminal' : 'background'})`);
    let l = rec;
    for (let i = 0; i < 40 && !l.bridgeUrl && l.state !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      l = await api(`/api/launch/${rec.id}`);
      process.stdout.write('.');
    }
    console.log('');
    if (l.state === 'error') throw new Error(l.error);
    if (l.note) console.log(l.note);
    console.log(l.bridgeUrl ? `Phone / web: ${l.bridgeUrl}` : 'Started (no Remote Control link yet; it will show in Pilotage → Live).');
    if (l.sessionId) console.log(`Session id:  ${l.sessionId}`);
  } else {
    console.log('Unknown command');
    process.exit(1);
  }
} catch (e) {
  console.error(`\x1b[31m${e.message}\x1b[0m`);
  process.exit(1);
}
