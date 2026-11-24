// Starts a real server on a spare port with a temp data dir (no AI, no forwarder).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = 4851 + 2 * Math.floor(Math.random() * 40); // LAN listener uses PORT - 1
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-api-'));
// A fake home with one project, so the server never scans (or depends on) the real home folder or Windows profile.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-api-home-'));
fs.mkdirSync(path.join(FAKE_HOME, 'acme', 'shop'), { recursive: true });
fs.writeFileSync(path.join(FAKE_HOME, 'acme', 'shop', 'CLAUDE.md'), '# Shop\n');
const FAKE_WIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-api-winhome-'));
// A stand-in `claude` (found first, in the fake home): it records any AI call (`-p`) and answers `agents` with [].
const AI_CALLED = path.join(FAKE_HOME, 'ai-called');
fs.mkdirSync(path.join(FAKE_HOME, '.local', 'bin'), { recursive: true });
fs.writeFileSync(path.join(FAKE_HOME, '.local', 'bin', 'claude'), `#!/bin/sh\ncase " $* " in *" -p "*) touch '${AI_CALLED}' ;; esac\necho '[]'\n`, { mode: 0o755 });
// A tiny web build, so static serving is tested the same way with or without `pilotage build` (CI has none).
const WEB_DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-api-dist-'));
fs.mkdirSync(path.join(WEB_DIST, 'assets'));
fs.writeFileSync(path.join(WEB_DIST, 'index.html'), '<!doctype html><title>app shell</title>');
fs.writeFileSync(path.join(WEB_DIST, 'notes.txt'), 'private build note');
fs.writeFileSync(path.join(WEB_DIST, 'assets', 'app.js'), 'console.log(1)');
let proc;
let cookie = '';
let key = '';
const LAN = PORT - 1;
const base = `http://127.0.0.1:${PORT}`;

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, HOME: FAKE_HOME, PILOTAGE_WIN_HOME: FAKE_WIN_HOME, PILOTAGE_WEB_DIST: WEB_DIST, PILOTAGE_DATA: DATA, PILOTAGE_PORT: String(PORT), PILOTAGE_LAN_INTERNAL_PORT: String(PORT - 1), PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1' }, stdio: 'ignore' });
  await waitUp();
  key = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')).desktopKey;
  const lc = await fetch(`${base}/api/auth/login-code`, { method: 'POST', headers: { 'X-Pilotage-Key': key, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(lc.status, 200);
  const code = new URL((await lc.json()).url).searchParams.get('c');
  const r = await fetch(`${base}/auth/login?c=${code}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => proc?.kill());

const get = (p, h = {}) => fetch(base + p, { headers: { cookie, ...h } });
const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });

test('unauthenticated requests are refused', async () => {
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 401);
  const body = await page.text();
  assert.match(body, /isn't paired/);
  // The page re-checks by itself (a phone may leave the cookie off the first request) via a public, data-free script.
  assert.match(body, /<script src="\/pair-recheck\.js"><\/script>/);
  const js = await fetch(`${base}/pair-recheck.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /\/api\/bootstrap\?recheck=1/);
  assert.equal((await fetch(`${base}/api/bootstrap?recheck=1`)).status, 401);
  assert.equal((await fetch(`${base}/auth/desktop?k=wrong`, { redirect: 'manual' })).status, 410);
  assert.equal((await fetch(`${base}/auth/pair?c=wrong`, { redirect: 'manual' })).status, 403);
});

test('not-paired re-check: a paired device gets bootstrap, so the page reloads into the app', async () => {
  const r = await get('/api/bootstrap?recheck=1');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /SameSite=Lax/);
  assert.notEqual((await get('/')).status, 401); // the app shell (200), or 503 when web/dist isn't built (CI)
});

test('bootstrap names the real data folder (Settings → About used to say ~/pilotage/data for every install)', async () => {
  const b = await (await get('/api/bootstrap')).json();
  assert.equal(b.dataDir, DATA, 'PILOTAGE_DATA, as the server uses it');
});

test('DNS rebinding and CSRF protections', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/overview', headers: { host: 'evil.example', cookie } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 421);
  const noHeader = await fetch(`${base}/api/ideas`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
  assert.equal(noHeader.status, 403);
  const form = await fetch(`${base}/api/ideas`, { method: 'POST', headers: { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'text=x' });
  assert.equal(form.status, 415);
});

test('core read endpoints work', async () => {
  for (const p of ['/api/bootstrap', '/api/overview', '/api/projects', '/api/sessions?limit=5', '/api/live', '/api/ideas', '/api/ai', '/api/settings', '/api/timeline', '/api/portfolio', '/api/devices']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    await r.json();
  }
});

test('ideas CRUD', async () => {
  const r = await post('/api/ideas', { text: 'Test idea from the test suite' });
  assert.equal(r.status, 200);
  const idea = await r.json();
  const del = await fetch(`${base}/api/ideas/${idea.id}`, { method: 'DELETE', headers: { cookie, 'X-Pilotage': '1' } });
  assert.equal(del.status, 200);
});

test('launch refuses unknown projects and folders', async () => {
  assert.equal((await post('/api/launch', { projectId: '0000000000', mode: 'background' })).status, 404);
  assert.equal((await post('/api/launch', { mode: 'background' })).status, 400);
});

test('docs endpoint only serves listed documents', async () => {
  let projects = [];
  for (let i = 0; i < 60 && !projects.length; i++) {
    projects = (await (await get('/api/projects')).json()).projects;
    if (!projects.length) await new Promise((r) => setTimeout(r, 500));
  }
  const p = projects[0];
  assert.ok(p, 'projects discovered');
  const r = await get(`/api/projects/${p.id}/doc?path=${encodeURIComponent('/etc/passwd')}`);
  assert.equal(r.status, 403);
  const r2 = await get(`/api/projects/${p.id}/doc?path=${encodeURIComponent(path.join(FAKE_HOME, '.claude/.credentials.json'))}`);
  assert.equal(r2.status, 403);
});

test('pairing code is single-use', async () => {
  const r = await post('/api/devices/pair', {});
  assert.equal(r.status, 200);
  const { urls, primary } = await r.json();
  const code = new URL(primary).searchParams.get('c');
  const first = await fetch(`${base}/auth/pair?c=${code}`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  const again = await fetch(`${base}/auth/pair?c=${code}`, { redirect: 'manual' });
  assert.equal(again.status, 403);
  assert.ok(Array.isArray(urls));
});

function lanRequest(p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: LAN, path: p, method, headers: { host: '192.168.1.50:4748', ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('LAN listener: no master key, no PC-only actions, no localhost hosts', async () => {
  const k = await lanRequest('/api/overview', { headers: { 'X-Pilotage-Key': key } });
  assert.equal(k.status, 401);
  const asLocal = await lanRequest('/api/overview', { headers: { host: 'localhost:4747', cookie } });
  assert.equal(asLocal.status, 421);
  const ok = await lanRequest('/api/overview', { headers: { cookie } });
  assert.equal(ok.status, 200);
  const pair = await lanRequest('/api/devices/pair', { method: 'POST', headers: { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(pair.status, 403);
  const login = await lanRequest('/api/auth/login-code', { method: 'POST', headers: { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 403);
});

test('desktop login codes do not work from the LAN listener', async () => {
  const lc = await fetch(`${base}/api/auth/login-code`, { method: 'POST', headers: { 'X-Pilotage-Key': key, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
  const code = new URL((await lc.json()).url).searchParams.get('c');
  const r = await lanRequest(`/auth/login?c=${code}`);
  assert.equal(r.status, 403);
});

test('failed pairing attempts cannot lock out a valid code forever', async () => {
  for (let i = 0; i < 5; i++) await lanRequest('/auth/pair?c=junk');
  const r = await post('/api/devices/pair', {});
  const code = new URL((await r.json()).primary).searchParams.get('c');
  const ok = await fetch(`${base}/auth/pair?c=${code}`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
});

test('junk codes cannot lock out a valid login or pairing code', async () => {
  // Anyone who reaches a listener can send junk codes: a web page through the PC browser, a neighbour on the Wi-Fi.
  for (let i = 0; i < 25; i++) {
    await fetch(`${base}/auth/login?c=junk${i}`, { redirect: 'manual' });
    await lanRequest(`/auth/pair?c=junk${i}`);
  }
  const lc = await fetch(`${base}/api/auth/login-code`, { method: 'POST', headers: { 'X-Pilotage-Key': key, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: '{}' });
  const login = new URL((await lc.json()).url).searchParams.get('c');
  assert.equal((await fetch(`${base}/auth/login?c=${login}`, { redirect: 'manual' })).status, 302);
  const pr = await post('/api/devices/pair', {});
  const pair = new URL((await pr.json()).primary).searchParams.get('c');
  assert.equal((await lanRequest(`/auth/pair?c=${pair}`)).status, 302);
  // Junk is still slowed down once the limit is reached.
  assert.equal((await lanRequest('/auth/pair?c=more-junk')).status, 429);
});

test('phone listener: AI provider and coding-tool settings are PC-only (stored keys could be sent to any host)', async () => {
  const h = { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json' };
  const hostile = JSON.stringify({ providers: { 'openai-compatible': { preset: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } } });
  assert.equal((await lanRequest('/api/providers', { method: 'PATCH', headers: h, body: hostile })).status, 403);
  assert.equal((await lanRequest('/api/providers/test', { method: 'POST', headers: h, body: '{}' })).status, 403);
  assert.equal((await lanRequest('/api/harnesses', { method: 'PATCH', headers: h, body: '{}' })).status, 403);
  // Reading them still works from the phone, and the PC can still change them.
  assert.equal((await lanRequest('/api/providers', { headers: { cookie } })).status, 200);
  assert.equal((await lanRequest('/api/harnesses', { headers: { cookie } })).status, 200);
  const pc = await fetch(`${base}/api/providers`, { method: 'PATCH', headers: h, body: JSON.stringify({ dailyCallCap: 300 }) });
  assert.equal(pc.status, 200);
});

test('static files: encoded ../ cannot reach the app shell without a paired device; bad escapes are a 400', async () => {
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200, 'hashed assets are public');
  for (const p of ['/assets/..%2findex.html', '/assets/..%2fnotes.txt', '/assets/%2e%2e%2fnotes.txt', '/icon..%2f..%2fnotes.txt', '/assets/%252e%252e%252fnotes.txt']) {
    const r = await fetch(base + p);
    assert.ok(r.status === 401 || r.status === 404, `${p} gave ${r.status}`);
    assert.doesNotMatch(await r.text(), /app shell|private build note/, p);
  }
  assert.equal((await get('/notes.txt')).status, 200, 'a paired device still gets every file');
  assert.equal((await fetch(`${base}/assets/%E0%A4%A`)).status, 400);
});

test('a JSON body that is not an object is a 400, not a crash', async () => {
  for (const body of ['null', '42', '"text"', 'true']) {
    const r = await fetch(`${base}/api/ideas`, { method: 'POST', headers: { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 400, body);
  }
});

test('launch: an unknown permission mode is refused, never turned into "skip all prompts"', async () => {
  const r = await post('/api/launch', { projectId: 'nope', permissionMode: 'bogus', prompt: 'hello' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /permission mode/i);
});

test('PILOTAGE_NO_AI=1 means no AI call at all, not even Settings → AI → Test', async () => {
  const r = await post('/api/providers/test', {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.error, /PILOTAGE_NO_AI/);
  assert.equal(fs.existsSync(AI_CALLED), false, 'claude -p was started');
});

test('POST /api/open no longer opens URLs on the PC (no UI used it; phones could reach it)', async (t) => {
  // Its own server on plain Linux, with stand-in openers first on PATH: nothing real ever opens.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-api-open-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-api-open-bin-'));
  const opened = path.join(bin, 'opened');
  for (const name of ['xdg-open', 'open']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$*" >> '${opened}'\n`, { mode: 0o755 });
  // Its own range: PORT + 300 landed in reports.test.js's ports (5160-5239), and node --test runs files in parallel.
  const port = 5401 + 2 * Math.floor(Math.random() * 40);
  const p = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: FAKE_HOME, PILOTAGE_WSL: '0', PILOTAGE_DATA: data, PILOTAGE_PORT: String(port), PILOTAGE_LAN_INTERNAL_PORT: String(port - 1), PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1' }, stdio: 'ignore' });
  t.after(() => p.kill('SIGKILL'));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  }
  assert.ok(up, 'server did not start');
  const k = JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')).desktopKey;
  const r = await fetch(`http://127.0.0.1:${port}/api/open`, { method: 'POST', headers: { 'X-Pilotage-Key': k, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'url', url: 'https://example.com/' }) });
  assert.equal(r.status, 400);
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(fs.existsSync(opened), false, 'an opener ran');
});

test('a project Pilotage creates deep down (or in a dot-folder) is registered, and its starter task can be started', async () => {
  for (const parentDir of ['~/clients/2026/q4/tools', '~/.work']) {
    const r = await post('/api/projects/new', { name: `Deep tool ${parentDir.length}`, goal: 'Try the deep folder.', parentDir, useAI: false });
    assert.equal(r.status, 200, parentDir);
    const out = await r.json();
    assert.equal(out.project.registered, true, `${parentDir}: not registered`);
    assert.ok(out.items.length >= 1);
    const projects = (await (await get('/api/projects?hidden=1')).json()).projects;
    assert.ok(projects.some((p) => p.id === out.project.id && p.name === out.project.name), `${parentDir}: not listed under its name`);
    // Starting the starter task gets past the "folder not known" check (the stand-in claude then can't background).
    const s = await post(`/api/work/${out.items[0].id}/start`, { mode: 'background' });
    const err = s.status === 200 ? '' : (await s.json()).error;
    assert.doesNotMatch(err, /not known to Pilotage/, parentDir);
    assert.notEqual(s.status, 400, `${parentDir}: ${err}`);
  }
});

test('task Start records Claude Code trust for the folder when Settings → Trust folders is on, or when asked', async (t) => {
  const cfg = path.join(FAKE_HOME, '.claude.json'); // the stand-in Claude Code's settings, in the fake home
  const patch = (trustFolders) => fetch(`${base}/api/settings`, { method: 'PATCH', headers: { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { launch: { trustFolders } } }) });
  t.after(async () => {
    await patch(false);
    fs.rmSync(cfg, { force: true });
  });
  const shopPath = path.join(FAKE_HOME, 'acme', 'shop');
  const shop = (await (await get('/api/projects?hidden=1')).json()).projects.find((p) => p.path === shopPath);
  assert.ok(shop);
  const item = await (await post('/api/work', { projectId: shop.id, title: 'Check the shop footer' })).json();
  const trusted = () => JSON.parse(fs.readFileSync(cfg, 'utf8')).projects?.[shopPath]?.hasTrustDialogAccepted === true;
  for (const [setting, body, want] of [[true, {}, true], [false, { trust: true }, true], [false, {}, false]]) {
    fs.writeFileSync(cfg, JSON.stringify({ projects: {} }));
    assert.equal((await patch(setting)).status, 200);
    await post(`/api/work/${item.id}/start`, { mode: 'background', ...body }); // the stand-in claude can't start it: only the trust step matters
    assert.equal(trusted(), want, `trustFolders=${setting} ${JSON.stringify(body)}`);
  }
});

test('the Map: GET /api/graph needs a paired device or the CLI key and checks its parameters', async () => {
  assert.equal((await fetch(`${base}/api/graph`)).status, 401);
  let shop = null;
  for (let i = 0; i < 60 && !shop; i++) {
    const g = await (await get('/api/graph?days=0')).json();
    assert.ok(Array.isArray(g.nodes) && Array.isArray(g.links));
    shop = g.nodes.find((n) => n.type === 'project' && n.label === 'shop');
    if (shop) {
      // Other tests add workspaces (~/clients, ~/.work): look for shop's own link.
      const ws = new Set(g.nodes.filter((n) => n.type === 'workspace').map((n) => n.id));
      assert.ok(g.links.some((l) => ws.has(l.source) && l.target === shop.id && l.kind === 'workspace'), 'workspace → project');
    } else await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(shop, 'the fake project is on the map');
  assert.equal((await get('/api/graph?days=12')).status, 400);
  assert.equal((await get('/api/graph?project=..%2Fx')).status, 400);
  assert.equal((await get('/api/graph?project=0123456789')).status, 404);
  const one = await get(`/api/graph?days=0&project=${shop.projectId}`);
  assert.equal(one.status, 200);
  assert.ok((await one.json()).nodes.some((n) => n.id === shop.id));
  assert.equal((await fetch(`${base}/api/graph?days=7`, { headers: { 'X-Pilotage-Key': key } })).status, 200);
  assert.equal((await post('/api/graph', {})).status, 404, 'read-only');
});

test('claude.ai chats: import from the PC only, then listed, searched and on the map; remove forgets them', async () => {
  const dir = path.join(FAKE_HOME, 'Downloads', 'claude-export');
  fs.mkdirSync(dir, { recursive: true });
  const conv = [{ uuid: 'abcdef01-2345-4678-9abc-def012345678', name: 'Shop pricing ideas', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-02T10:00:00Z', chat_messages: [{ sender: 'human', text: 'Coupons for the shop?' }, { sender: 'assistant', text: 'Yes.' }] }];
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(conv));
  const body = JSON.stringify({ path: '~/Downloads/claude-export' });
  const h = { cookie, 'X-Pilotage': '1', 'Content-Type': 'application/json' };
  assert.equal((await lanRequest('/api/chats/import', { method: 'POST', headers: h, body })).status, 403, 'not from the phone');
  assert.equal((await lanRequest('/api/chats', { method: 'DELETE', headers: { cookie, 'X-Pilotage': '1' } })).status, 403);
  const bad = await post('/api/chats/import', { path: path.join(FAKE_HOME, 'acme') });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /No conversations\.json/);
  const r = await post('/api/chats/import', { path: '~/Downloads/claude-export' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.count, 1);
  assert.equal(j.linked, 1, '"shop" is a project in the fake home');
  const list = await (await lanRequest('/api/chats', { headers: { cookie } })).body;
  const chats = JSON.parse(list);
  assert.equal(chats.chats[0].url, 'https://claude.ai/chat/abcdef01-2345-4678-9abc-def012345678', 'the phone can read them');
  assert.equal(chats.chats[0].projects[0].name, 'shop');
  const s = await (await get('/api/search?q=coupons')).json();
  assert.equal(s.chats.length, 1);
  const g = await (await get('/api/graph?days=0')).json();
  const node = g.nodes.find((n) => n.type === 'chat');
  assert.ok(node && g.links.some((l) => l.source === node.id && l.kind === 'chat'));
  const del = await fetch(`${base}/api/chats`, { method: 'DELETE', headers: { cookie, 'X-Pilotage': '1' } });
  assert.equal(del.status, 200);
  assert.equal((await (await get('/api/chats')).json()).chats.length, 0);
  assert.ok(!(await (await get('/api/graph?days=0')).json()).nodes.some((n) => n.type === 'chat'), 'the map forgets them too');
});
