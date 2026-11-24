// Helper for bin/pilotage: talks to the running server with the desktop key.
// Usage (via bin/pilotage): projects [filter] | live | new <project> [--bg|--terminal] [--model m] [--name n] [prompt...]
//   | standup [--yesterday|--today|--week|--since YYYY-MM-DD [--until YYYY-MM-DD]] [--project p] [--md]
//   | sessions [project] [--limit n|--all] | resume <project|session id> [--bg] [--model m] [prompt...]
//   | export <session id> [--out file.md] [--last n] | usage [--week|--days n|--since YYYY-MM-DD] [--project p] [--top n]
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PORT } from './config.js';
import { renderStandup } from './standup.js';
import { compactNum } from './util.js';

let key;
try {
  key = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')).desktopKey;
} catch {
  // Before the first start there is no key yet: say what to do instead of a stack trace.
  console.error(`Pilotage hasn't been started with this data folder yet (${DATA}). Start it first: pilotage start`);
  process.exit(1);
}
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

/**
 * `--flag`, `--key value` and `--key=value` options; everything else stays positional (`_`). An unknown `--option` is
 * an error (a typo must not silently become part of a prompt or be ignored).
 */
function parseArgs(args, { flags = [], values = [] } = {}, usage = '') {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      o._.push(...args.slice(i + 1)); // everything after -- is positional (a prompt that starts with --)
      break;
    }
    const m = /^--([a-z][\w-]*)(?:=(.*))?$/.exec(a);
    if (!m) o._.push(a);
    else if (flags.includes(m[1]) && m[2] == null) o[m[1]] = true;
    else if (values.includes(m[1])) {
      const v = m[2] ?? args[++i];
      if (v == null || v === '') throw new Error(`--${m[1]} needs a value.${usage ? `\n${usage}` : ''}`);
      o[m[1]] = v;
    } else throw new Error(`Unknown option ${a}.${usage ? `\n${usage}` : ''}`);
  }
  return o;
}

const USAGE = {
  standup: 'Usage: pilotage standup [--yesterday | --today | --week | --since YYYY-MM-DD [--until YYYY-MM-DD]] [--project NAME] [--md]',
  sessions: 'Usage: pilotage sessions [PROJECT] [--limit N | --all]',
  resume: 'Usage: pilotage resume <PROJECT | SESSION-ID> [--bg] [--model opus|sonnet|haiku|fable] ["prompt"]',
  export: 'Usage: pilotage export <SESSION-ID> [--out FILE.md] [--last N]   (the id or its first 8 characters: pilotage sessions)',
  usage: 'Usage: pilotage usage [--week | --days N | --since YYYY-MM-DD [--until YYYY-MM-DD]] [--project NAME] [--top N]',
};

async function projectId(name) {
  const { projects } = await api('/api/projects?hidden=1');
  return findProject(projects, name).id;
}

/** A running session's state in the web's words (SIMPLIFY.md): needs you · working · open; '' when not running. */
function runWord(s) {
  if (!s.live) return '';
  if (s.live.kind === 'background') return s.live.state === 'working' ? 'working' : s.live.state === 'blocked' ? 'needs you' : 'open';
  return s.live.status === 'waiting' ? 'needs you' : s.live.status === 'busy' ? 'working' : 'open';
}

/** The id as `pilotage sessions` shows it: 8 characters (after the codex- / gemini- prefix). Enough for resume/export. */
const shortId = (id) => (/^(codex|gemini)-/.test(id) ? id.slice(0, id.indexOf('-') + 9) : id.slice(0, 8));

function sessionRows(sessions) {
  const w = Math.max(8, ...sessions.map((s) => shortId(s.id).length));
  const rows = [`  ${'ID'.padEnd(w)}  ${'LAST'.padEnd(8)}  ${'PROJECT'.padEnd(20)}  ${'STATE'.padEnd(9)}  TITLE`];
  for (const s of sessions) rows.push(`${s.live ? '●' : ' '} ${shortId(s.id).padEnd(w)}  ${ago(s.lastAt).padEnd(8)}  ${(s.projectName || '-').slice(0, 20).padEnd(20)}  ${runWord(s).padEnd(9)}  ${s.title.slice(0, 70)}`);
  return rows.join('\n');
}

/** Sessions whose id starts with `prefix` (at least 4 characters), newest first. */
async function sessionsById(prefix) {
  if (!/^[\w.-]{4,160}$/.test(prefix)) return [];
  const { sessions } = await api(`/api/sessions?id=${encodeURIComponent(prefix)}&hidden=1&limit=20`);
  const exact = sessions.find((s) => s.id === prefix);
  return exact ? [exact] : sessions.sort((a, b) => b.lastAt - a.lastAt);
}

function oneSession(list, prefix) {
  if (list.length === 1) return list[0];
  if (!list.length) throw new Error(`No session id starts with "${prefix}". Try: pilotage sessions`);
  throw new Error(`"${prefix}" matches several sessions:\n${sessionRows(list.slice(0, 10))}\nGive more of the id.`);
}

/**
 * What `pilotage resume X` resumes: the most recent session of the project X matches (the way `pilotage new` matches
 * projects), else the session whose id starts with X. Gemini sessions can't be resumed by id; background is Claude-only.
 */
async function resumeTarget(target, mode) {
  const { projects } = await api('/api/projects?hidden=1');
  let project;
  try {
    project = findProject(projects, target);
  } catch (e) {
    if (!/^No project matches/.test(e.message)) throw e;
    const byId = await sessionsById(target);
    if (!byId.length) throw e;
    return oneSession(byId, target);
  }
  const { sessions } = await api(`/api/sessions?project=${project.id}&kind=interactive&limit=500`);
  const ok = sessions.filter((s) => s.harness !== 'gemini' && (mode !== 'background' || s.harness === 'claude')).sort((a, b) => b.lastAt - a.lastAt);
  if (!ok.length) throw new Error(`${project.name} has no session to resume. Start one: pilotage new "${project.name}"`);
  return ok[0];
}

/** Already running: say how to get to it instead of starting a second copy. */
function printRunning(s) {
  const st = runWord(s);
  console.log(`"${s.title}" (${s.projectName || 'no project'}) is already running${st ? ` (${st}${s.live.detail ? `: ${s.live.detail}` : ''})` : ''}. Open it instead:`);
  if (s.live.bridgeUrl) console.log(`  Phone / web:   ${s.live.bridgeUrl}`);
  if (s.live.kind === 'background' && s.live.bgId) console.log(`  In a terminal: claude attach ${s.live.bgId}`);
  else console.log(`  On the PC:     its terminal window${s.live.name ? ` ("${s.live.name}")` : ''}`);
  console.log(`  In Pilotage:   http://pilotage.localhost:${PORT}/sessions/${s.id}`);
}

/** GET /api/usage as text: totals, per project, per day (a bar each), the top sessions. */
function renderUsage(r, project) {
  const L = [`Tokens: ${r.label}${project ? ` · ${project}` : ''}`];
  const t = r.totals;
  L.push(`Total ${compactNum(t.total)}  (output ${compactNum(t.output)} · input ${compactNum(t.input)} · cache write ${compactNum(t.cacheWrite)} · cache read ${compactNum(t.cacheRead)})`);
  if (r.pending) L.push(`Still counting ${r.pending} older session${r.pending === 1 ? '' : 's'} (in the background, after an update); the numbers will grow. Run it again in a few minutes.`);
  if (!t.total) return L.join('\n');
  const num = (n) => compactNum(n).padStart(7);
  if (!project) {
    L.push('', `By project${' '.repeat(16)}  total   output    input  c.write   c.read  sessions`);
    for (const p of r.projects) L.push(`  ${p.name.slice(0, 24).padEnd(24)}${num(p.total)}  ${num(p.output)}  ${num(p.input)}  ${num(p.cacheWrite)}  ${num(p.cacheRead)}  ${String(p.sessions).padStart(8)}`);
  }
  const max = Math.max(...r.days.map((d) => d.total));
  const days = r.days.length > 45 ? r.days.filter((d) => d.total) : r.days;
  L.push('', `By day${r.days.length > 45 ? ' (days with use)' : ''}`);
  for (const d of days) {
    const label = new Date(`${d.day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(r.days.length > 45 ? { year: 'numeric' } : {}) });
    const bar = d.total ? '█'.repeat(Math.max(1, Math.round((d.total / max) * 30))) : '';
    L.push(`  ${label.padEnd(r.days.length > 45 ? 16 : 11)}${num(d.total)}${bar ? `  ${bar}` : ''}`);
  }
  L.push('', 'Top sessions');
  for (const s of r.sessions) L.push(`  ${shortId(s.id).padEnd(8)}${num(s.total)}  ${(s.projectName || '-').slice(0, 20).padEnd(20)}  ${s.title.slice(0, 60)}`);
  return L.join('\n');
}

/** Wait (up to a minute) for a launch to get its phone link, then say where it is. */
async function followLaunch(rec) {
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
    const trustWifi = args.includes('--trust-wifi');
    const r = await fetch(`${base}/api/net/enable`, { method: 'POST', headers: { 'X-Pilotage-Key': key, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ trustWifi }) }).then((x) => x.json());
    if (!r.ok) {
      console.log(`\x1b[31m${r.error || 'failed'}\x1b[0m`);
      process.exit(1);
    }
    console.log(`\x1b[32mPhone access enabled.\x1b[0m${r.trustedSsid ? ` Trusted Wi-Fi: ${r.trustedSsid}.` : ''} Now run: pilotage pair`);
    if (r.wifi && !r.trustedSsid) console.log(`\x1b[33mWi-Fi "${r.wifi}" is not trusted, so phones on it are refused (VPN works). If it is your home network: pilotage phone --trust-wifi\x1b[0m`);
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
    let model; // left out unless --model is given: the server then uses the default model from Settings
    let name = '';
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--bg' || a === '--background') mode = 'background';
      else if (a === '--terminal') mode = 'terminal';
      else if (a === '--model') {
        model = args[++i];
        if (!model) throw new Error('--model needs a name: opus, sonnet, haiku or fable');
      }
      else if (a === '--name') name = args[++i] || '';
      else rest.push(a);
    }
    const target = rest.shift();
    if (!target) throw new Error('Usage: pilotage new <project> [--bg] [--model opus|sonnet|haiku|fable] [--name NAME] ["first prompt"]');
    const { projects } = await api('/api/projects?hidden=1');
    const p = findProject(projects, target);
    const rec = await api('/api/launch', { method: 'POST', body: { projectId: p.id, mode, model, name: name || undefined, prompt: rest.join(' ') } });
    process.stdout.write(`Starting "${rec.name}" in ${p.displayPath} (${rec.mode === 'terminal' ? rec.terminal || 'terminal' : 'background'})`);
    await followLaunch(rec);
  } else if (cmd === 'sessions') {
    const o = parseArgs(args, { flags: ['all'], values: ['limit'] }, USAGE.sessions);
    if (o._.length > 1) throw new Error(USAGE.sessions);
    const q = new URLSearchParams({ kind: 'interactive', limit: String(o.all ? 2000 : Math.max(1, Math.min(Number(o.limit) || 20, 2000))) });
    if (o._[0]) q.set('project', await projectId(o._[0]));
    const { sessions } = await api(`/api/sessions?${q}`);
    console.log(sessions.length ? sessionRows(sessions) : 'No sessions.');
  } else if (cmd === 'resume') {
    const o = parseArgs(args, { flags: ['bg', 'background', 'terminal'], values: ['model'] }, USAGE.resume);
    const target = o._.shift();
    if (!target) throw new Error(USAGE.resume);
    const mode = o.bg || o.background ? 'background' : 'terminal';
    const s = await resumeTarget(target, mode);
    if (s.live) {
      printRunning(s);
      process.exit(2); // nothing started (and a prompt given here was not sent)
    }
    // Same route, validation and settings (permission mode, default model) as every other launch.
    const rec = await api('/api/launch', { method: 'POST', body: { resumeId: s.id, mode, prompt: o._.join(' '), ...(o.model ? { model: o.model } : {}) } });
    process.stdout.write(`Resuming "${rec.name}" (${s.projectName || 'no project'}, last active ${ago(s.lastAt)}) in ${rec.mode === 'terminal' ? rec.terminal || 'a terminal' : 'the background'}`);
    await followLaunch(rec);
  } else if (cmd === 'export') {
    const o = parseArgs(args, { values: ['out', 'last'] }, USAGE.export);
    if (o._.length !== 1) throw new Error(USAGE.export);
    if (o._[0].length < 4) throw new Error(`Give at least 4 characters of the session id.\n${USAGE.export}`);
    const last = o.last == null ? 0 : Number(o.last);
    if (!(Number.isInteger(last) && last >= 0)) throw new Error('--last takes a number of turns, like --last 20');
    const s = oneSession(await sessionsById(o._[0]), o._[0]);
    const r = await api(`/api/sessions/${encodeURIComponent(s.id)}/export${last ? `?last=${last}` : ''}`);
    if (!o.out) process.stdout.write(r.markdown);
    else {
      // Relative to where the command was typed (bin/pilotage runs this from its own folder).
      const file = path.resolve(process.env.PILOTAGE_CALLER_CWD || process.cwd(), o.out);
      fs.writeFileSync(file, r.markdown);
      console.log(`Wrote ${file}: "${r.title}", ${r.turns} turn${r.turns === 1 ? '' : 's'}${r.turns < r.total ? ` (the last of ${r.total})` : ''}. Secrets Pilotage recognises are hidden; read it before you share it.`);
    }
  } else if (cmd === 'usage') {
    const o = parseArgs(args, { flags: ['week'], values: ['days', 'since', 'until', 'project', 'top'] }, USAGE.usage);
    if (o._.length || (o.until && !o.since) || [o.week, o.days, o.since].filter(Boolean).length > 1) throw new Error(USAGE.usage);
    const q = new URLSearchParams();
    if (o.since) {
      q.set('since', o.since);
      if (o.until) q.set('until', o.until);
    } else q.set('days', o.week ? '7' : o.days || '30');
    if (o.top) q.set('top', o.top);
    let name = '';
    if (o.project) {
      const { projects } = await api('/api/projects?hidden=1');
      const p = findProject(projects, o.project);
      q.set('project', p.id);
      name = p.name;
    }
    console.log(renderUsage(await api(`/api/usage?${q}`), name));
  } else if (cmd === 'standup') {
    const o = parseArgs(args, { flags: ['yesterday', 'today', 'week', 'md'], values: ['since', 'until', 'project'] }, USAGE.standup);
    if (o._.length || (o.until && !o.since) || [o.yesterday, o.today, o.week, o.since].filter(Boolean).length > 1) throw new Error(USAGE.standup);
    const q = new URLSearchParams();
    if (o.since) {
      q.set('since', o.since);
      if (o.until) q.set('until', o.until);
    } else q.set('range', o.yesterday ? 'yesterday' : o.today ? 'today' : o.week ? 'week' : 'recent');
    if (o.project) q.set('project', await projectId(o.project));
    const r = await api(`/api/standup?${q}`);
    console.log(o.md ? r.markdown : renderStandup(r));
  } else {
    console.log('Unknown command');
    process.exit(1);
  }
} catch (e) {
  // Red on a terminal only: piped or captured output (scripts, agents) gets the plain message.
  console.error(process.stderr.isTTY && !process.env.NO_COLOR ? `\x1b[31m${e.message}\x1b[0m` : e.message);
  process.exit(1);
}
