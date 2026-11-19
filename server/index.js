// Pilotage server — local web app for organizing Claude Code work.
// Binds to 127.0.0.1 only. Phones reach it through the Windows forwarder (LAN/NetBird),
// and every request except /healthz, /pilotage-ca.crt and the pairing endpoints needs a paired device.
import http from 'node:http';
import https from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import QRCode from 'qrcode';
import { PORT, BIND, LAN_PORT, LAN_INTERNAL_PORT, WEB_DIST, VERSION, ensureDirs, HOME, paths, ROOT, IS_WSL, OS_NAME } from './config.js';
import { getStore } from './store.js';
import { userName, detectedName } from './profile.js';
import { importLocalWorkspaces } from './workspaces.js';
import { getSecrets, authenticate, deviceCookie, hostAllowed, authBlocked, authFailed, parseCookies } from './auth.js';
import { getSessionIndex } from './sources/sessions.js';
import { ProjectRegistry } from './sources/projects.js';
import { getLive } from './sources/live.js';
import { listDevServers, stopDevServer } from './sources/processes.js';
import { AIEngine } from './ai/engine.js';
import { usageNow } from './ai/usage.js';
import { Views } from './views.js';
import { launch, getLaunch, listLaunches, attachTerminal, stopBackground, openVSCode, openExplorer, openShell, openUrlOnPC, sanitizeName, terminal } from './launch.js';
import { trustState, trustFolder } from './claude-trust.js';
import { tilde as tildePath } from './work/spinoff.js';
import { windowsAddresses, forwarderStatus, ensureForwarder, enablePhoneAccess, stopForwarder, phoneAccessStatus, firewallRuleExists, setTrustedSsid, phoneAddresses, phoneUrls, lanConnectionAllowed, lanAllowList, LAN_BIND, LAN_MODE } from './net.js';
import { ensureTls, tlsStatus, caCertDer, noteHandshakeFailure } from './tls.js';
import { log, clip, randomToken, isInside, hash } from './util.js';

ensureDirs();
const store = getStore();
importLocalWorkspaces(store);
const secrets = getSecrets();
const index = getSessionIndex();
const registry = new ProjectRegistry(index, store);
const live = getLive();
let procs = [];
const ai = new AIEngine({ index, registry, store, live });
const views = new Views({ index, registry, store, live, ai, processes: () => procs });

// ---------------------------------------------------------------- memo + events
let gen = 0;
const memo = new Map();
function bump() {
  gen++;
  memo.clear();
}
function cached(key, fn) {
  if (memo.has(key)) return memo.get(key);
  const v = fn();
  memo.set(key, v);
  return v;
}
const projectsList = () => cached('projects', () => views.listProjects());
const sseClients = new Set();
const pendingEvents = new Set();
let flushTimer = null;
function broadcast(kind) {
  bump();
  pendingEvents.add(kind);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const kinds = [...pendingEvents];
    pendingEvents.clear();
    const msg = `event: change\ndata: ${JSON.stringify({ kinds, gen })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(msg);
      } catch {}
    }
  }, 700);
}
ai.on('changed', (e) => broadcast(e.kind === 'queue' ? 'ai' : 'ai-data'));
index.on('progress', (p) => {
  if (p.running || p.total) broadcast('index');
});

// ---------------------------------------------------------------- helpers
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SEC_HEADERS,
    'Content-Type': isBuf || typeof body === 'string' ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}
const json = (res, body, status = 200) => send(res, status, body);
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, max = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isPhoneUA(ua = '') {
  return /android|iphone|ipad|mobile/i.test(ua);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const file = path.join(WEB_DIST, rel);
  if (!isInside(file, WEB_DIST)) return false;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = path.extname(file);
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    ...SEC_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function pairPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pilotage</title><meta name="color-scheme" content="light dark"><link rel="icon" href="/icon.svg">
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee}
@media (prefers-color-scheme: light){body{background:#f5f6f8;color:#16181d}.card{background:#fff!important;border-color:#e3e5ea!important}}
.card{max-width:420px;margin:24px 16px;padding:28px;border-radius:16px;background:#171a21;border:1px solid #262a33}
h1{font-size:22px;margin:0 0 8px}p{margin:8px 0;opacity:.85}code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:6px}</style></head>
<body><div class="card"><h1>Pilotage</h1>${message}</div></body></html>`;
}

const NOT_PAIRED = `<p>This device isn't paired yet.</p>
<p><b>On your PC:</b> open Pilotage (Desktop shortcut, or run <code>pilotage open</code>), go to <b>Settings → Devices</b> and press <b>Pair a phone</b>. Then scan the QR code with this device.</p>`;

// Phones opening Pilotage from the home screen or another app sometimes send the first request without the device
// cookie, then send it on a reload ("not paired" until a refresh). So the "not paired" page checks once more from inside
// the page (a same-origin request carries the cookie) and reloads into the app when this device is in fact paired.
// Served without sign-in like the icons: it holds no data, and /api/bootstrap still needs the cookie.
const PAIR_RECHECK_JS = `(async () => {
  const KEY = 'pilotage-pair-recheck';
  let n = 0;
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (v && Date.now() - v.at < 60000) n = v.n;
  } catch {}
  if (n >= 2) return; // reloaded twice within a minute already: this device really isn't paired
  for (const wait of [0, 800, 2500]) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch('/api/bootstrap?recheck=1', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        try { sessionStorage.setItem(KEY, JSON.stringify({ n: n + 1, at: Date.now() })); } catch {}
        location.replace(location.pathname.startsWith('/auth/') ? '/' : location.href);
        return;
      }
    } catch {}
  }
})();
`;
const NOT_PAIRED_PAGE = NOT_PAIRED + '<script src="/pair-recheck.js"></script>';

// One log line per "not paired" answer (at most one every 10 s), never a cookie value: whether a device cookie came at
// all and how the browser labelled the request. Tells a browser quirk apart from a pairing that is really gone.
let notPairedLogAt = 0;
function noteNotPaired(req, where) {
  const now = Date.now();
  if (now - notPairedLogAt < 10_000) return;
  notPairedLogAt = now;
  const h = req.headers;
  const c = parseCookies(h.cookie || '');
  const cookie = 'pl_dev' in c ? 'device cookie not known here (removed device or other data folder)' : h.cookie ? 'other cookies only' : 'no cookie';
  const extra = (h['sec-purpose'] ? ` purpose=${clip(String(h['sec-purpose']), 40)}` : '') + (h['service-worker-navigation-preload'] ? ' sw-preload' : '');
  log.info(`not paired (${where}): ${req.viaLan ? 'phone port' : 'PC port'} ${req.socket?.encrypted ? 'https' : 'http'}, ${cookie}; fetch-site=${h['sec-fetch-site'] || '-'} mode=${h['sec-fetch-mode'] || '-'}${extra}`);
}

// ---------------------------------------------------------------- routes
const routes = [];
// opts.localOnly: refuse when the request came through the phone/LAN listener (pairing, devices, firewall, keys).
const route = (method, pattern, handler, opts = {}) => routes.push({ method, rx: new RegExp(`^${pattern}$`), handler, localOnly: !!opts.localOnly });
const LOCAL_ONLY = [/^\/api\/devices(\/|$)/, /^\/api\/net\//, /^\/api\/security\//, /^\/api\/auth\//];

// The web build that is on disk now. Open pages compare it with the one they loaded and offer a reload after a deploy.
let buildMemo = { mtime: -1, id: '' };
function webBuild() {
  try {
    const st = fs.statSync(path.join(WEB_DIST, 'index.html'));
    if (st.mtimeMs !== buildMemo.mtime) buildMemo = { mtime: st.mtimeMs, id: hash(fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8'), 12) };
  } catch {}
  return buildMemo.id;
}

route('GET', '/api/bootstrap', async (req, res, { dev, url }) => {
  if (url.searchParams.get('recheck') === '1') log.info(`not-paired page: re-check found ${dev.name} paired, reloading into the app`);
  // Re-issue the device cookie with today's attributes (older ones were SameSite=Strict), so paired devices migrate.
  const raw = /(?:^|;\s*)pl_dev=([^;]+)/.exec(req.headers.cookie || '');
  if (raw && dev?.id && dev.id !== 'cli') res.setHeader('Set-Cookie', deviceCookie(decodeURIComponent(raw[1])));
  json(res, {
    version: VERSION,
    build: webBuild(),
    device: { id: dev.id, name: dev.name, isPhone: isPhoneUA(req.headers['user-agent']), viaLan: !!req.viaLan },
    settings: store.settings,
    // The name the greeting and AI prompts use (settings.profile.name, else detected from git / $USER).
    user: { name: userName(store.settings), detectedName: detectedName() },
    // WSL2 + Windows: VS Code / Explorer on the PC, the phone forwarder. Elsewhere the UI hides those.
    // terminal: where sessions open (Windows Terminal, Terminal, kitty…); null = background only.
    platform: { wsl: IS_WSL, os: OS_NAME, terminal: terminal()?.label || null },
    home: HOME,
    usage: usageNow(),
    index: index.progress,
    ai: ai.status(),
    gen,
  });
});

route('GET', '/api/overview', async (req, res) => {
  const projects = projectsList();
  const extras = {};
  for (const fn of overviewExtenders) {
    try {
      Object.assign(extras, cached(`ovx:${overviewExtenders.indexOf(fn)}`, fn));
    } catch (e) {
      log.warn('overview extender failed', e.message);
    }
  }
  json(res, { ...cached('overview', () => views.overview(projects)), ...extras, usage: usageNow(), index: index.progress, ai: ai.status(), gen });
});

route('GET', '/api/projects', async (req, res, { url }) => {
  const includeHidden = url.searchParams.get('hidden') === '1';
  json(res, { projects: includeHidden ? views.listProjects({ includeHidden: true }) : projectsList(), gen });
});

route('GET', '/api/projects/([a-f0-9]{10})', async (req, res, { m }) => {
  const p = registry.byId(m[1]);
  if (!p) return fail(res, 404, 'Project not found');
  // fresh git for the page being looked at
  const st = registry.gitOf(p.path).status;
  if (p.isGit && (!st || Date.now() - (st.checkedAt || 0) > 30_000)) {
    if (await registry.refreshGit({ only: p })) bump();
  }
  json(res, views.projectDetail(m[1]));
});

route('PATCH', '/api/projects/([a-f0-9]{10})', async (req, res, { m, body }) => {
  const p = registry.byId(m[1]);
  if (!p) return fail(res, 404, 'Project not found');
  const allowed = {};
  if (typeof body.name === 'string') allowed.name = clip(body.name.trim(), 80) || undefined;
  if (body.status === null || ['active', 'paused', 'done', 'archived'].includes(body.status)) allowed.status = body.status || undefined;
  if (typeof body.pinned === 'boolean') allowed.pinned = body.pinned;
  if (typeof body.hidden === 'boolean') allowed.hidden = body.hidden;
  if (typeof body.notes === 'string') allowed.notes = clip(body.notes, 20000);
  if (typeof body.oneLiner === 'string') allowed.oneLiner = clip(body.oneLiner, 200) || undefined;
  if (typeof body.workspace === 'string') allowed.workspace = clip(body.workspace.trim().toLowerCase(), 40) || undefined;
  if (typeof body.color === 'string' || body.color === null) allowed.color = body.color || undefined;
  if (Array.isArray(body.links)) allowed.links = body.links.slice(0, 40).map((l) => ({ title: clip(String(l.title || ''), 80), url: clip(String(l.url || ''), 500) })).filter((l) => /^https?:\/\//.test(l.url));
  if (body.portfolio && typeof body.portfolio === 'object') {
    const pf = body.portfolio;
    allowed.portfolio = {
      include: pf.include !== false,
      title: clip(String(pf.title || ''), 120),
      tagline: clip(String(pf.tagline || ''), 240),
      role: clip(String(pf.role || ''), 120),
      period: clip(String(pf.period || ''), 60),
      stack: Array.isArray(pf.stack) ? pf.stack.slice(0, 20).map((s) => clip(String(s), 40)) : [],
      bullets: Array.isArray(pf.bullets) ? pf.bullets.slice(0, 10).map((s) => clip(String(s), 400)) : [],
      link: clip(String(pf.link || ''), 300),
    };
  }
  store.patchProject(p.path, allowed);
  if ('workspace' in allowed) await registry.rebuild();
  broadcast('projects');
  json(res, views.projectDetail(m[1]));
});

route('GET', '/api/projects/([a-f0-9]{10})/doc', async (req, res, { m, url }) => {
  const p = registry.byId(m[1]);
  if (!p) return fail(res, 404, 'Project not found');
  const want = url.searchParams.get('path') || '';
  const docs = (views.projectDetail(m[1]).docs || []).map((d) => d.path);
  if (!docs.includes(want)) return fail(res, 403, 'Not a listed document');
  try {
    const real = fs.realpathSync(want);
    const roots = [p.path, ...p.worktrees.keys(), path.join(HOME, '.claude', 'projects'), '/mnt/c/Users'].map((x) => {
      try {
        return fs.realpathSync(x);
      } catch {
        return x;
      }
    });
    if (fs.lstatSync(want).isSymbolicLink() || !roots.some((r) => isInside(real, r))) return fail(res, 403, 'Not a project document');
    const st = fs.statSync(real);
    if (st.size > 2_000_000) return fail(res, 413, 'Too large');
    json(res, { path: want, name: path.basename(want), content: fs.readFileSync(real, 'utf8'), mtime: st.mtimeMs });
  } catch (e) {
    fail(res, 404, 'Cannot read file');
  }
});

route('GET', '/api/sessions', async (req, res, { url }) => {
  json(res, {
    sessions: views.listSessions({
      projectId: url.searchParams.get('project') || undefined,
      q: url.searchParams.get('q') || undefined,
      kind: url.searchParams.get('kind') || undefined,
      liveOnly: url.searchParams.get('live') === '1',
      limit: Math.min(Number(url.searchParams.get('limit')) || 300, 2000),
      includeHidden: url.searchParams.get('hidden') === '1',
    }),
    gen,
  });
});

route('GET', '/api/sessions/([\\w.-]{8,160})', async (req, res, { m }) => {
  const d = views.sessionDetail(m[1]);
  if (!d) return fail(res, 404, 'Session not found');
  json(res, d);
});

route('PATCH', '/api/sessions/([\\w.-]{8,160})', async (req, res, { m, body }) => {
  if (!index.get(m[1])) return fail(res, 404, 'Session not found');
  const patch = {};
  if (typeof body.title === 'string') patch.title = clip(body.title.trim(), 120) || undefined;
  if (typeof body.hidden === 'boolean') patch.hidden = body.hidden;
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
  store.patchSession(m[1], patch);
  broadcast('sessions');
  json(res, views.sessionDetail(m[1]));
});

route('GET', '/api/sessions/([\\w.-]{8,160})/turns', async (req, res, { m, url }) => {
  if (!index.get(m[1])) return fail(res, 404, 'Session not found');
  const before = url.searchParams.get('before');
  json(res, views.turns(m[1], { before: before != null ? Number(before) : undefined, limit: Math.min(Number(url.searchParams.get('limit')) || 60, 300), includeSystem: url.searchParams.get('system') === '1' }));
});

route('GET', '/api/sessions/([\\w.-]{8,160})/turns/(\\d+)', async (req, res, { m }) => {
  if (!index.get(m[1])) return fail(res, 404, 'Session not found');
  json(res, await index.turnDetail(m[1], Number(m[2])));
});

route('POST', '/api/sessions/([\\w.-]{8,160})/stop', async (req, res, { m }) => {
  const l = live.get(m[1]);
  if (!l || l.kind !== 'background' || !l.bgId) return fail(res, 400, 'Only background sessions can be stopped from here');
  try {
    await stopBackground(l.bgId);
    await live.refresh();
    broadcast('live');
    json(res, { ok: true });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

route('POST', '/api/sessions/([\\w.-]{8,160})/attach', async (req, res, { m }) => {
  const l = live.get(m[1]);
  if (!l || !l.bgId) return fail(res, 400, 'Not a background session');
  try {
    await attachTerminal(l.bgId, l.name);
    json(res, { ok: true });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

route('GET', '/api/live', async (req, res) => {
  json(res, { live: views.listSessions({ liveOnly: true, limit: 100 }), launches: listLaunches(), gen });
});

/** The folder a launch runs in: {cwd, projectName, meta} or {status, error}. Only known projects and worktrees. */
function launchTarget({ projectId, worktree, resumeId }) {
  let cwd = null;
  let projectName = '';
  let meta = null;
  if (projectId) {
    const p = registry.byId(projectId);
    if (!p) return { status: 404, error: 'Project not found' };
    cwd = p.path;
    projectName = store.project(p.path).name || p.name;
    if (worktree) {
      const w = p.worktrees.get(worktree);
      if (!w) return { status: 400, error: 'Unknown worktree' };
      cwd = w.path;
    }
  }
  if (resumeId) {
    meta = index.get(resumeId);
    if (!meta) return { status: 404, error: 'Session not found' };
    cwd = cwd || meta.cwd;
    const pj = registry.projectOfSession(meta);
    projectName = projectName || (pj ? store.project(pj.path).name || pj.name : '');
  }
  if (!cwd) return { status: 400, error: 'Pick a project' };
  const known = [...registry.projects.values()].some((p) => isInside(cwd, p.path) || [...p.worktrees.keys()].some((w) => isInside(cwd, w)));
  if (!known) return { status: 400, error: 'Folder is not a known project' };
  return { cwd, projectName, meta };
}

// Claude Code's "trust this folder?" question for a launch target (see claude-trust.js).
route('GET', '/api/trust', async (req, res, { url }) => {
  const q = url.searchParams;
  const t = launchTarget({ projectId: q.get('projectId'), worktree: q.get('worktree'), resumeId: q.get('resumeId') });
  if (t.error) return fail(res, t.status, t.error);
  const s = trustState(t.cwd);
  json(res, { trusted: s.trusted, home: s.home, via: s.via ? tildePath(s.via) : null, auto: !!store.settings.launch.trustFolders });
});

/** Record Claude Code trust for `cwd` when asked (checkbox) or when the setting is on. Never blocks a launch. */
async function trustBeforeLaunch(cwd, asked, why) {
  if (!asked && !store.settings.launch.trustFolders) return;
  try {
    if (trustState(cwd).trusted) return;
    const r = await trustFolder(cwd);
    if (r.changed) log.info(`trust: marked ${tildePath(cwd)} as trusted in Claude Code (${why})`);
  } catch (e) {
    log.warn(`trust: could not mark ${tildePath(cwd)} as trusted: ${e.message}`);
  }
}

route('POST', '/api/launch', async (req, res, { body, dev }) => {
  const t = launchTarget(body);
  if (t.error) return fail(res, t.status, t.error);
  const { cwd, projectName } = t;
  if (body.resumeId) {
    if (live.get(body.resumeId)?.live && !body.fork) return fail(res, 409, 'This session is already running. Open it instead, or fork it.');
    if (!body.name) body.name = views.sessionTitle(t.meta, null);
  }
  const harnessIn = typeof body.harness === 'string' ? body.harness : 'claude';
  if (harnessIn === 'claude') await trustBeforeLaunch(cwd, body.trust === true, body.trust === true ? `asked from ${dev.name}` : 'setting');
  const isPhone = isPhoneUA(req.headers['user-agent']);
  const mode = body.mode === 'terminal' || body.mode === 'background' ? body.mode : isPhone ? store.settings.launch.phoneMode : store.settings.launch.pcMode;
  const rec = await launch({
    cwd,
    name: sanitizeName(body.name || projectName || path.basename(cwd)),
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    mode,
    resumeId: body.resumeId || null,
    fork: !!body.fork,
    model: typeof body.model === 'string' ? body.model : store.settings.launch.model,
    permissionMode: body.permissionMode || store.settings.launch.permissionMode,
    from: dev.name,
    harness: typeof body.harness === 'string' ? body.harness : undefined,
  });
  if (body.ideaId) {
    const idea = store.data.ideas.find((x) => x.id === body.ideaId);
    if (idea) {
      idea.launchedAt = Date.now();
      idea.launchId = rec.id;
      store.save();
    }
  }
  setTimeout(() => live.refresh().then((c) => c && broadcast('live')), 4000);
  if (rec.state === 'error') return fail(res, 500, rec.error);
  json(res, rec);
});

route('GET', '/api/launch/([\\w-]{36})', async (req, res, { m }) => {
  const r = getLaunch(m[1]);
  if (!r) return fail(res, 404, 'Unknown launch');
  json(res, r);
});

route('POST', '/api/open', async (req, res, { body }) => {
  const p = body.projectId ? registry.byId(body.projectId) : null;
  let dir = p?.path;
  if (p && body.worktree) dir = p.worktrees.get(body.worktree)?.path || dir;
  try {
    if (body.what === 'url') await openUrlOnPC(String(body.url || ''));
    else if (!dir) return fail(res, 400, 'Pick a project');
    else if (body.what === 'vscode') await openVSCode(dir);
    else if (body.what === 'explorer') await openExplorer(dir);
    else if (body.what === 'shell') await openShell(dir, p ? store.project(p.path).name || p.name : 'Shell');
    else return fail(res, 400, 'Unknown action');
    json(res, { ok: true });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

route('POST', '/api/processes/(\\d+)/stop', async (req, res, { m }) => {
  const r = await stopDevServer(Number(m[1]), procs);
  if (!r.ok) return fail(res, 400, r.error);
  setTimeout(refreshProcs, 1500);
  json(res, r);
});

route('GET', '/api/timeline', async (req, res, { url }) => {
  const days = Math.min(Number(url.searchParams.get('days')) || 380, 800);
  const data = cached(`activity:${days}`, () => views.activityByDay(days));
  const projects = projectsList().map((p) => ({ id: p.id, path: p.path, name: p.name, workspace: p.workspace, workspaceName: p.workspaceName }));
  json(res, { days: data, projects });
});

route('GET', '/api/timeline/day/(\\d{4}-\\d{2}-\\d{2})', async (req, res, { m }) => {
  json(res, views.dayDetail(m[1]));
});

route('GET', '/api/search', async (req, res, { url }) => {
  json(res, views.search(url.searchParams.get('q') || ''));
});

// Home › Pick up: "Not now" hides a row until that session has new activity
route('POST', '/api/pickup/(hide|unhide)', async (req, res, { m, body }) => {
  const key = String(body.key || '');
  if (!/^s:[\w.-]{8,160}$/.test(key)) return fail(res, 400, 'Bad key');
  const hidden = (store.data.pickupHidden ||= {});
  if (m[1] === 'hide') hidden[key] = Date.now();
  else delete hidden[key];
  // keep the map small: drop entries older than 60 days
  for (const [k, t] of Object.entries(hidden)) if (Date.now() - t > 60 * 86400e3) delete hidden[k];
  store.save();
  broadcast('overview');
  json(res, { ok: true });
});

// Ideas
route('GET', '/api/ideas', async (req, res) => json(res, { ideas: store.data.ideas.slice().reverse() }));
route('POST', '/api/ideas', async (req, res, { body, dev }) => {
  const text = clip(String(body.text || '').trim(), 4000);
  if (!text) return fail(res, 400, 'Empty idea');
  let projectPath = null;
  if (body.projectId) projectPath = registry.byId(body.projectId)?.path || null;
  const idea = { id: randomToken(9), text, projectPath, createdAt: Date.now(), doneAt: null, source: body.source === 'ai' ? 'ai' : dev.name };
  store.data.ideas.push(idea);
  store.save();
  broadcast('ideas');
  json(res, idea);
});
route('PATCH', '/api/ideas/([\\w-]{6,20})', async (req, res, { m, body }) => {
  const idea = store.data.ideas.find((x) => x.id === m[1]);
  if (!idea) return fail(res, 404, 'Not found');
  if (typeof body.text === 'string') idea.text = clip(body.text.trim(), 4000);
  if (typeof body.done === 'boolean') idea.doneAt = body.done ? Date.now() : null;
  if ('projectId' in body) idea.projectPath = body.projectId ? registry.byId(body.projectId)?.path || null : null;
  store.save();
  broadcast('ideas');
  json(res, idea);
});
route('DELETE', '/api/ideas/([\\w-]{6,20})', async (req, res, { m }) => {
  store.data.ideas = store.data.ideas.filter((x) => x.id !== m[1]);
  store.save();
  broadcast('ideas');
  json(res, { ok: true });
});

// AI
route('GET', '/api/ai', async (req, res) => json(res, { ...ai.status(), usage: usageNow() }));
route('POST', '/api/ai/pause', async (req, res, { body }) => {
  ai.pausedByUser = !!body.paused;
  broadcast('ai');
  json(res, ai.status());
});
route('POST', '/api/ai/run', async (req, res, { body }) => {
  if (!store.settings.ai.enabled) return fail(res, 400, 'AI is turned off in Settings');
  const scope = body.scope;
  if (scope === 'project') {
    const p = registry.byId(body.projectId);
    if (!p) return fail(res, 404, 'Project not found');
    // digest its pending blocks first, then the brief
    let n = 0;
    for (const pb of ai.pendingBlocks({ manual: true }).filter((x) => x.project.path === p.path)) {
      ai.enqueue({ id: `block:${pb.block.key}`, kind: 'block', priority: 50, manual: true, run: () => ai.digestBlock(pb), label: p.name, projectPath: p.path });
      n++;
    }
    const doBrief = () => ai.briefProject({ project: p });
    if (n === 0) ai.enqueue({ id: `brief:${p.path}`, kind: 'brief', priority: 49, manual: true, run: doBrief, label: p.name, projectPath: p.path });
    else ai.enqueue({ id: `brief-after:${p.path}`, kind: 'brief', priority: 1, manual: true, run: doBrief, label: p.name, projectPath: p.path });
    return json(res, { ok: true, queued: n + 1 });
  }
  if (scope === 'daily') {
    ai.enqueue({ id: `daily-manual:${Date.now()}`, kind: 'daily', priority: 60, manual: true, run: () => ai.runDaily(views.overview(projectsList())), label: 'Daily brief' });
    return json(res, { ok: true });
  }
  if (scope === 'all') {
    ai.tick(() => views.overview(projectsList()));
    return json(res, { ok: true });
  }
  fail(res, 400, 'Unknown scope');
});
route('POST', '/api/ai/cv', async (req, res, { body }) => {
  if (!store.settings.ai.enabled) return fail(res, 400, 'AI is turned off in Settings');
  const p = registry.byId(body.projectId);
  if (!p) return fail(res, 404, 'Project not found');
  try {
    const r = await ai.runCV(p, body.lang === 'fr' ? 'fr' : 'en');
    broadcast('ai-data');
    json(res, r);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

route('GET', '/api/portfolio', async (req, res) => json(res, { projects: cached('portfolio', () => views.portfolio()), settings: store.data.portfolio }));
route('PATCH', '/api/portfolio', async (req, res, { body }) => {
  if (typeof body.lang === 'string') store.data.portfolio.lang = body.lang === 'fr' ? 'fr' : 'en';
  if (typeof body.header === 'string') store.data.portfolio.header = clip(body.header, 4000);
  store.save();
  broadcast('projects'); // refreshes the portfolio query on the other devices
  json(res, store.data.portfolio);
});

route('GET', '/api/settings', async (req, res) => json(res, { settings: store.settings, workspaces: store.data.workspaces }));
route('PATCH', '/api/settings', async (req, res, { body }) => {
  const s = body.settings || {};
  const clean = {};
  if (s.profile && typeof s.profile.name === 'string') {
    clean.profile = { name: s.profile.name.replace(/[^\p{L}\p{N} .'’-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) };
  }
  if (s.ai) {
    clean.ai = {};
    for (const k of ['enabled', 'autoDigest', 'dailyBrief']) if (typeof s.ai[k] === 'boolean') clean.ai[k] = s.ai[k];
    for (const k of ['digestModel', 'briefModel', 'cvModel', 'scoutModel']) if (['haiku', 'sonnet', 'opus', 'fable'].includes(s.ai[k])) clean.ai[k] = s.ai[k];
    if (Number.isFinite(s.ai.maxFiveHourPct)) clean.ai.maxFiveHourPct = Math.max(5, Math.min(100, s.ai.maxFiveHourPct));
    if (Number.isFinite(s.ai.maxSevenDayPct)) clean.ai.maxSevenDayPct = Math.max(5, Math.min(100, s.ai.maxSevenDayPct));
    if (Number.isFinite(s.ai.concurrency)) clean.ai.concurrency = Math.max(1, Math.min(4, s.ai.concurrency));
    for (const k of ['maxCallsPer5h', 'maxCallsPerDay']) if (Number.isFinite(s.ai[k])) clean.ai[k] = Math.max(0, Math.min(100000, Math.round(s.ai[k])));
  }
  if (s.launch) {
    clean.launch = {};
    if (['bypassPermissions', 'acceptEdits', 'auto', 'manual', 'plan'].includes(s.launch.permissionMode)) clean.launch.permissionMode = s.launch.permissionMode;
    if (['', 'opus', 'sonnet', 'haiku', 'fable'].includes(s.launch.model)) clean.launch.model = s.launch.model;
    if (['terminal', 'background'].includes(s.launch.pcMode)) clean.launch.pcMode = s.launch.pcMode;
    if (['terminal', 'background'].includes(s.launch.phoneMode)) clean.launch.phoneMode = s.launch.phoneMode;
    if (typeof s.launch.trustFolders === 'boolean') clean.launch.trustFolders = s.launch.trustFolders;
  }
  if (s.scan) {
    clean.scan = {};
    if (Array.isArray(s.scan.hiddenPaths)) clean.scan.hiddenPaths = s.scan.hiddenPaths.filter((x) => typeof x === 'string' && x.startsWith('/')).slice(0, 200);
    if (Array.isArray(s.scan.extraRoots)) clean.scan.extraRoots = s.scan.extraRoots.filter((x) => typeof x === 'string' && x.startsWith('/') && fs.existsSync(x)).slice(0, 20);
  }
  if (s.ui && ['system', 'light', 'dark'].includes(s.ui.theme)) clean.ui = { theme: s.ui.theme };
  store.patchSettings(clean);
  if (body.workspaces && typeof body.workspaces === 'object') {
    for (const [k, v] of Object.entries(body.workspaces)) {
      if (typeof k !== 'string' || k.length > 40) continue;
      store.data.workspaces[k] = { ...(store.data.workspaces[k] || {}), name: clip(String(v?.name || ''), 60) || undefined };
    }
    store.save();
  }
  if (clean.scan) {
    registry.lastScanAt = 0;
    await registry.rebuild();
  }
  // Theme, AI and launch defaults apply on every open device (settings + bootstrap queries).
  broadcast('settings');
  broadcast('projects');
  json(res, { settings: store.settings, workspaces: store.data.workspaces });
});

// Devices / pairing / network
route('GET', '/api/devices', async (req, res, { dev }) => json(res, { devices: secrets.publicDevices(), current: dev.id }));
route('PATCH', '/api/devices/([\\w-]{6,20})', async (req, res, { m, body }) => {
  const d = secrets.rename(m[1], String(body.name || ''));
  if (!d) return fail(res, 404, 'Unknown device');
  json(res, { ok: true });
});
route('DELETE', '/api/devices/([\\w-]{6,20})', async (req, res, { m }) => {
  json(res, { ok: secrets.revoke(m[1]) });
});
// `pilotage open` (desktop shortcut) asks for a one-time login code; the master key never appears in a URL.
route('POST', '/api/auth/login-code', async (req, res, { dev }) => {
  if (dev.id !== 'cli') return fail(res, 403, 'CLI only');
  const { code, expiresAt } = secrets.createPairCode('desktop');
  json(res, { url: `http://pilotage.localhost:${PORT}/auth/login?c=${code}`, expiresAt });
}, { localOnly: true });
route('POST', '/api/security/rotate-key', async (req, res) => {
  secrets.rotateDesktopKey();
  json(res, { ok: true });
}, { localOnly: true });
// Pairing links prefer https once the Pilotage certificate exists (the phone needs it installed; pairing over http
// still works, so `alt` carries the http links). body.scheme forces one; body.terminal = `pilotage pair` (text QR).
route('POST', '/api/devices/pair', async (req, res, { body }) => {
  const { code, expiresAt } = secrets.createPairCode();
  const tlsReady = tlsStatus().ready;
  const scheme = body.scheme === 'http' || body.scheme === 'https' ? body.scheme : tlsReady ? 'https' : 'http';
  const other = scheme === 'https' ? 'http' : tlsReady ? 'https' : null;
  const addrs = phoneUrls(await phoneAddresses());
  const make = (sch) => addrs.map((a) => ({ kind: a.kind, adapter: a.adapter, scheme: sch, url: `${a[sch]}/auth/pair?c=${code}` }));
  const terminal = !!body.terminal;
  const qr = (u) => QRCode.toString(u, terminal ? { type: 'terminal', small: true } : { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const withQr = async (list) => Promise.all(list.map(async (u) => ({ ...u, qr: await qr(u.url) })));
  const urls = await withQr(make(scheme));
  // The CLI prints every link of `urls` (QR for the first); give it both schemes so a phone without the certificate can still pair.
  if (terminal && other) urls.push(...make(other).map((u) => ({ ...u, qr: '' })));
  const alt = !terminal && other ? await withQr(make(other)) : [];
  const primary = urls.find((u) => u.kind === 'wifi') || urls[0] || { url: `http://localhost:${PORT}/auth/pair?c=${code}` };
  json(res, { expiresAt, scheme, urls, alt, primary: primary.url, tls: { ready: tlsReady, fingerprint: tlsStatus().fingerprint }, mode: LAN_MODE, forwarder: forwarderStatus(), firewallRule: LAN_MODE === 'forwarder' ? await firewallRuleExists() : true });
});
route('GET', '/api/net', async (req, res) => {
  json(res, await phoneAccessStatus());
});
// "Install Pilotage as an app": certificate fingerprint, the http/https phone addresses and (?qr=1, for the PC) QR codes
// for the certificate download (over http: the phone doesn't trust https yet) and the https address.
const qrMemo = new Map();
async function qrSvg(text) {
  if (!qrMemo.has(text)) {
    if (qrMemo.size > 64) qrMemo.clear();
    qrMemo.set(text, await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  }
  return qrMemo.get(text);
}
route('GET', '/api/net/tls', async (req, res, { url }) => {
  const wantQr = url.searchParams.get('qr') === '1';
  const status = tlsStatus();
  const addrs = phoneUrls(await phoneAddresses());
  const out = await Promise.all(
    addrs.map(async (a) => {
      const caUrl = `${a.http}/pilotage-ca.crt`;
      return { ...a, caUrl, ...(wantQr && status.ready ? { caQr: await qrSvg(caUrl), httpsQr: await qrSvg(`${a.https}/`) } : {}) };
    }),
  );
  json(res, { ...status, mode: LAN_MODE, lanPort: LAN_PORT, urls: out, secure: !!req.socket.encrypted });
});
route('POST', '/api/net/forwarder', async (req, res) => {
  const r = await ensureForwarder();
  setTimeout(() => broadcast('net'), 3000);
  json(res, { ...r, forwarder: forwarderStatus() });
});
// One click in the morning: UAC prompt → firewall rule → forwarder started.
route('POST', '/api/net/enable', async (req, res) => {
  const r = await enablePhoneAccess();
  setTimeout(() => broadcast('net'), 3000);
  json(res, { ...r, status: await phoneAccessStatus() }, r.ok ? 200 : 500);
});
route('POST', '/api/net/trust', async (req, res, { body }) => {
  const ssid = typeof body.ssid === 'string' ? body.ssid.trim().slice(0, 64) : '';
  if (!ssid) return fail(res, 400, 'Missing network name');
  await setTrustedSsid(ssid, body.trusted !== false);
  broadcast('net');
  json(res, await phoneAccessStatus());
});
route('POST', '/api/net/stop', async (req, res) => {
  const r = await stopForwarder();
  setTimeout(() => broadcast('net'), 2000);
  json(res, r);
});

// Refresh button
route('POST', '/api/refresh', async (req, res) => {
  await fullRefresh({ forceGit: true });
  json(res, { ok: true, gen });
});

// SSE
route('GET', '/api/events', async (req, res) => {
  res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: hello\ndata: ${JSON.stringify({ gen })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------- feature modules
// Each server/routes/*.js exports default ({ route, ctx }) and may register routes, loops and overview extras.
const overviewExtenders = [];
const ctx = {
  index, registry, store, live, ai, views, secrets, broadcast, bump, cached, projectsList, json, fail, send,
  getProcs: () => procs,
  every: (ms, fn) => every(ms, fn),
  extendOverview: (fn) => overviewExtenders.push(fn),
  log,
};
{
  const routesDir = path.join(ROOT, 'server', 'routes');
  const files = fs.existsSync(routesDir) ? fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort() : [];
  for (const f of files) {
    try {
      const mod = await import(path.join(routesDir, f));
      await mod.default?.({ route, ctx });
      log.info(`module ${f} loaded`);
    } catch (e) {
      log.error(`module ${f} failed to load`, e);
    }
  }
}

// ---------------------------------------------------------------- request handler
async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://x');
    decodeURIComponent(url.pathname);
  } catch {
    return fail(res, 400, 'Bad URL');
  }
  const pathname = url.pathname;
  // Phones arrive on the LAN listener (Windows forwarder → 127.0.0.1:LAN_INTERNAL_PORT, or PILOTAGE_LAN_BIND), over
  // http or https; the PC browser and CLI on PORT. The LAN servers tag their requests, so TLS sockets count too.
  const viaLan = req[FROM_LAN] === true || req.socket.localPort === LAN_INTERNAL_PORT;
  req.viaLan = viaLan;
  if (!hostAllowed(req.headers.host, viaLan)) return fail(res, 421, 'Unrecognized host');
  const html = (status, body) => send(res, status, pairPage(body), { 'Content-Type': 'text/html; charset=utf-8' });

  if (pathname === '/healthz') return json(res, { ok: true, version: VERSION, app: 'pilotage' });

  // The Pilotage CA *certificate* (public, no key): DER, which Android and iOS offer to install. No sign-in needed,
  // since the phone needs it before https works. Nothing else under data/tls is ever served.
  if (pathname === '/pilotage-ca.crt' && (req.method === 'GET' || req.method === 'HEAD')) {
    const der = caCertDer();
    if (!der) return fail(res, 503, 'The Pilotage certificate is not ready yet');
    return send(res, 200, der, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="pilotage-ca.crt"', 'Content-Length': String(der.length) });
  }
  if (pathname === '/pair-recheck.js' && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 200, PAIR_RECHECK_JS, { 'Content-Type': 'text/javascript; charset=utf-8' });

  if (pathname === '/auth/desktop') {
    // The master key never travels in URLs any more: `pilotage open` mints a one-time code instead.
    return html(410, '<p>This link is outdated. Use the Pilotage shortcut on your Desktop, or run <code>pilotage open</code> in WSL.</p>');
  }
  if (pathname === '/auth/pair' || pathname === '/auth/login') {
    const bucket = viaLan ? 'pair-lan' : 'pair-local';
    if (authBlocked(bucket)) return html(429, '<p>Too many failed attempts. Wait a few minutes.</p>');
    const already = authenticate(req);
    const c = url.searchParams.get('c') || '';
    if (already) {
      if (c) secrets.consumePairCode(c);
      return send(res, 302, '', { Location: '/' });
    }
    const kind = secrets.consumePairCode(c);
    if (kind === 'desktop' && viaLan) {
      authFailed(bucket);
      return html(403, '<p>This login link only works on the PC itself.</p>');
    }
    if (kind) {
      const { token } = secrets.createDevice(null, req.headers['user-agent'], kind === 'desktop' ? 'desktop' : 'pair');
      broadcast('devices');
      return send(res, 302, '', { Location: kind === 'desktop' ? '/' : '/?paired=1', 'Set-Cookie': deviceCookie(token) });
    }
    authFailed(bucket);
    noteNotPaired(req, 'pairing link');
    return html(403, '<p>This code is expired or was already used.</p>' + NOT_PAIRED_PAGE);
  }

  if (pathname.startsWith('/api/')) {
    // The `pilotage` CLI authenticates with the desktop key (data/secrets.json, mode 600), on the local listener only.
    const cliKey = req.headers['x-pilotage-key'];
    let dev = null;
    if (typeof cliKey === 'string' && cliKey) {
      if (viaLan || cliKey.length !== secrets.desktopKey.length || hash(cliKey, 64) !== hash(secrets.desktopKey, 64)) return fail(res, 401, 'Bad key');
      dev = { id: 'cli', name: 'pilotage CLI' };
    } else dev = authenticate(req);
    if (!dev) {
      noteNotPaired(req, 'api');
      return fail(res, 401, 'Not paired');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // CSRF: custom header + JSON only (cross-site pages cannot send these without CORS, which we never grant)
      if (req.headers['x-pilotage'] !== '1') return fail(res, 403, 'Missing X-Pilotage header');
      const ct = req.headers['content-type'] || '';
      if (req.method !== 'DELETE' && !ct.startsWith('application/json')) return fail(res, 415, 'JSON only');
    }
    if (viaLan && req.method !== 'GET' && LOCAL_ONLY.some((rx) => rx.test(pathname))) return fail(res, 403, 'Only possible from the PC');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      if (r.localOnly && viaLan) return fail(res, 403, 'Only possible from the PC');
      let body = {};
      if (req.method === 'POST' || req.method === 'PATCH') {
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(res, 400, e.message);
        }
      }
      return r.handler(req, res, { m, url, body, dev, viaLan });
    }
    return fail(res, 404, 'Not found');
  }

  // Static app. Public assets are harmless; the app shell needs a paired device.
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
  const isAsset = /^\/(assets\/|icon|favicon|manifest|apple-touch)/.test(pathname);
  if (isAsset && serveStatic(req, res, pathname)) return;
  const dev = authenticate(req);
  if (!dev) {
    noteNotPaired(req, 'page');
    return html(401, NOT_PAIRED_PAGE);
  }
  if (pathname !== '/' && serveStatic(req, res, pathname)) return;
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) return send(res, 503, pairPage('<p>The web app is not built yet. Run <code>pilotage build</code>.</p>'), { 'Content-Type': 'text/html; charset=utf-8' });
  serveStatic(req, res, '/index.html');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log.error('request failed', req.method, req.url?.split('?')[0], e);
    try {
      if (!res.headersSent) fail(res, 500, 'Internal error');
      else res.end();
    } catch {}
  });
});
server.keepAliveTimeout = 65000;
server.requestTimeout = 120000;

// ---------------------------------------------------------------- LAN listener (phones)
// Same app on a second port used only by phones, so PC-only actions can be refused there. It speaks plain HTTP and
// HTTPS on the same port: the first byte of a connection tells them apart (0x16 = TLS handshake). Plain HTTP keeps
// working for phones that don't have the Pilotage certificate yet. Every check in handle() is the same for both.
const FROM_LAN = Symbol('fromLan');
const appHandler = server.listeners('request')[0];
const lanHandler = (req, res) => {
  req[FROM_LAN] = true;
  return appHandler(req, res);
};
const lanHttp = http.createServer(lanHandler);
const lanHttps = https.createServer({ minVersion: 'TLSv1.2' }, lanHandler);
for (const s of [lanHttp, lanHttps]) {
  s.keepAliveTimeout = 65000;
  s.requestTimeout = 120000;
}
let lanTlsReady = false;
let tlsForcedAt = 0;
// A phone without the certificate aborts the handshake: count it for Settings, nothing to log. It may also mean the
// PC got a new address the certificate doesn't cover yet (Wi-Fi up after Pilotage started): re-check, at most once a minute.
lanHttps.on('tlsClientError', (err, sock) => {
  noteHandshakeFailure(err);
  sock?.destroy();
  if (Date.now() - tlsForcedAt > 60_000) {
    tlsForcedAt = Date.now();
    refreshTls(true).catch(() => {});
  }
});
const server2 = createTcpServer((sock) => {
  // Direct bind (no Windows forwarder in front): the same per-connection allow-list the forwarder applies.
  if (LAN_BIND && !lanConnectionAllowed(sock.remoteAddress)) return sock.destroy();
  sock.on('error', () => sock.destroy());
  sock.setTimeout(30000, () => sock.destroy()); // silent connections don't hold a socket
  sock.once('data', (first) => {
    sock.setTimeout(0);
    sock.pause();
    sock.unshift(first);
    if (first[0] === 0x16) {
      if (!lanTlsReady) return sock.destroy();
      lanHttps.emit('connection', sock);
    } else lanHttp.emit('connection', sock);
    process.nextTick(() => sock.resume());
  });
});

/** Keeps the server certificate in step with the phone addresses (re-issued when they change or near expiry). */
async function refreshTls(force = false) {
  const addrs = await phoneAddresses(force).catch(() => []);
  const r = await ensureTls(addrs.map((a) => a.ip));
  if (r.ok && (r.changed || !lanTlsReady)) {
    lanHttps.setSecureContext({ key: r.key, cert: r.cert, minVersion: 'TLSv1.2' });
    lanTlsReady = true;
  }
  return r;
}

// ---------------------------------------------------------------- background loops
async function refreshProcs() {
  try {
    const next = await listDevServers();
    for (const pr of next) {
      // most specific project; for deleted folders use the nearest existing parent
      // A server whose worktree folder was deleted still belongs to that repo: git keeps prunable entries.
      let owner = null;
      for (const p of registry.projects.values()) {
        for (const w of p.worktrees.keys()) if (isInside(pr.cwd, w)) owner = { root: p.path, worktree: w };
        for (const w of registry.gitOf(p.path).extras?.worktrees || []) if (isInside(pr.cwd, w.path)) owner = { root: p.path, worktree: w.path };
      }
      let r = owner;
      if (!r) {
        let dir = pr.cwd;
        while (dir && dir !== '/' && !fs.existsSync(dir)) dir = path.dirname(dir);
        r = registry.resolve(dir);
      }
      pr.projectPath = r && registry.projects.has(r.root) && r.root !== HOME ? r.root : null;
      pr.worktree = r?.worktree || null;
    }
    const sig = JSON.stringify(next.map((p) => [p.pid, p.ports]));
    const old = JSON.stringify(procs.map((p) => [p.pid, p.ports]));
    procs = next;
    if (sig !== old) broadcast('projects');
  } catch (e) {
    log.warn('procs', e.message);
  }
}

let scanning = false;
async function scanSessions() {
  if (scanning) return;
  scanning = true;
  try {
    const changed = await index.scan();
    if (changed.length) {
      // A live session that only grew doesn't need the whole registry rebuilt every 8 s.
      if (index.lastScan.structural || !registry.refreshSessions(changed)) await registry.rebuild();
      broadcast('sessions');
    }
  } catch (e) {
    log.warn('scan', e);
  } finally {
    scanning = false;
  }
}

async function refreshLive(full = true) {
  try {
    if (await live.refresh({ full })) broadcast('live');
  } catch (e) {
    log.warn('live', e.message);
  }
}

async function fullRefresh({ forceGit = false } = {}) {
  registry.lastScanAt = 0;
  await scanSessions();
  await registry.rebuild();
  await refreshLive();
  await refreshProcs();
  if (await registry.refreshGit({ force: forceGit })) broadcast('projects');
  broadcast('sessions');
}

function every(ms, fn) {
  const t = setInterval(() => fn().catch?.((e) => log.warn('loop', e.message)), ms);
  t.unref?.();
  return t;
}

// WSL: Windows reaches Pilotage (browser on :PORT, phone forwarder on :LAN_INTERNAL_PORT) through WSL's localhost relay.
// After sleep or a network change the relay can forget ports that were already open while new ones still work, and
// Windows then gets "connection refused". So once a minute, ask Windows itself (curl.exe) and, after two misses in a
// row, close and re-open both listeners: the relay picks them up again. Open connections are not dropped.
const WIN_CURL = '/mnt/c/Windows/System32/curl.exe';
function windowsReaches(port) {
  return new Promise((resolve) =>
    execFile(WIN_CURL, ['-s', '-o', 'NUL', '-m', '4', '-w', '%{http_code}', `http://127.0.0.1:${port}/healthz`], { timeout: 9000, cwd: '/mnt/c', windowsHide: true }, (err, out) => {
      const code = String(out || '').trim();
      resolve(!err && /^[1-5]\d\d$/.test(code));
    }),
  );
}
function relistenOne(srv, port, host) {
  return new Promise((resolve) => {
    const onErr = (e) => {
      log.warn(`re-listen on ${host}:${port} failed: ${e.message}`);
      resolve(false);
    };
    srv.once('error', onErr);
    srv.close();
    srv.listen(port, host, () => {
      srv.off('error', onErr);
      resolve(true);
    });
  });
}
let relayHeals = 0;
async function healRelay(why) {
  log.warn(`Windows can't reach Pilotage (${why}): re-opening the listeners so the WSL relay sees them again`);
  await relistenOne(server, PORT, BIND);
  await relistenOne(server2, LAN_INTERNAL_PORT, BIND);
  relayHeals++;
  const ok = (await windowsReaches(PORT)) && (await windowsReaches(LAN_INTERNAL_PORT));
  log.info(`relay heal #${relayHeals}: ${ok ? 'Windows reaches Pilotage again' : 'still unreachable (will retry)'}`);
  return ok;
}
function startRelayWatchdog() {
  if (!IS_WSL || LAN_BIND || process.env.PILOTAGE_NO_FORWARDER === '1' || process.env.PILOTAGE_NO_RELAY_WATCH === '1' || !fs.existsSync(WIN_CURL)) return;
  let misses = 0;
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const ok = (await windowsReaches(PORT)) && (await windowsReaches(LAN_INTERNAL_PORT));
      misses = ok ? 0 : misses + 1;
      if (misses >= 2 && (await healRelay('watchdog'))) misses = 0;
    } catch (e) {
      log.warn('relay watchdog', e.message);
    } finally {
      busy = false;
    }
  }, 60e3);
  t.unref?.();
}

route(
  'POST',
  '/api/system/heal-relay',
  async (req, res) => {
    if (!IS_WSL) return json(res, { ok: true, skipped: 'not WSL' });
    json(res, { ok: await healRelay('asked by the CLI') });
  },
  { localOnly: true },
);

async function start() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, BIND, resolve);
  });
  await new Promise((resolve, reject) => {
    server2.once('error', reject);
    // PILOTAGE_LAN_BIND (Linux/macOS): phones connect straight to LAN_PORT; otherwise loopback behind the forwarder.
    if (LAN_BIND) server2.listen(LAN_PORT, LAN_BIND, resolve);
    else server2.listen(LAN_INTERNAL_PORT, BIND, resolve);
  });
  // The inner http/https servers never listen() themselves, but Node only enforces headersTimeout/requestTimeout
  // (slow-client protection) once a server emits 'listening'.
  for (const s of [lanHttp, lanHttps]) s.emit('listening');
  if (LAN_BIND) log.info(`phone listener on ${LAN_BIND}:${LAN_PORT} (PILOTAGE_LAN_BIND), allowed from ${lanAllowList().join(', ')}`);
  refreshTls(true).catch((e) => log.warn('tls', e.message));
  startRelayWatchdog();
  fs.writeFileSync(path.join(paths.logs, '..', 'pilotage.pid'), String(process.pid));
  log.info(`Pilotage ${VERSION} listening on http://${BIND}:${PORT} (data: ${paths.state})`);
  const t0 = Date.now();
  await scanSessions();
  await registry.rebuild();
  log.info(`indexed ${index.list().length} sessions, ${registry.projects.size} projects in ${Date.now() - t0}ms`);
  await refreshLive();
  await refreshProcs();
  broadcast('sessions');
  registry.refreshGit().then((c) => {
    if (c) broadcast('projects');
    log.info('git refreshed');
  });
  every(8000, scanSessions);
  let liveTick = 0;
  every(5000, async () => {
    liveTick++;
    // Cheap state-file reads every 5 s while someone is looking; the `claude agents` spawn at most every 30-60 s.
    if (sseClients.size > 0 || liveTick % 6 === 0) await refreshLive(liveTick % 12 === 0);
  });
  every(30000, refreshProcs);
  every(60000, async () => {
    if (await registry.refreshGit()) broadcast('projects');
  });
  every(45000, async () => ai.tick(() => views.overview(projectsList())));
  setTimeout(() => ai.tick(() => views.overview(projectsList())), 15000);
  // Server certificate vs current addresses: cheap check every minute (addresses cached ≤ 5 min), fresh lookup every 10.
  every(60000, async () => {
    await refreshTls(false);
  });
  every(10 * 60000, async () => {
    await refreshTls(true);
  });
  if (IS_WSL && process.env.PILOTAGE_NO_FORWARDER !== '1' && !LAN_BIND) {
    ensureForwarder()
      .then((r) => log.info('forwarder', JSON.stringify(r)))
      .catch((e) => log.warn('forwarder', e.message));
  }
}

function shutdown(sig) {
  log.info(`${sig}, saving state`);
  store.saveNow();
  ai.saveNow();
  index.flushNow();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log.error('uncaught', e));
process.on('unhandledRejection', (e) => log.error('unhandled', e));

start().catch((e) => {
  log.error('failed to start', e);
  process.exit(1);
});
