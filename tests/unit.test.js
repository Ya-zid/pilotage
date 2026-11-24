import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

process.env.PILOTAGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-unit-'));
const { hostAllowed } = await import('../server/auth.js');
const { parseTranscriptFile, winToWsl, normalizeCwd, toolSummary } = await import('../server/sources/sessions.js');
const { computeBlocks } = await import('../server/ai/engine.js');
const { bridgeUrl } = await import('../server/sources/live.js');
const { webUrlFromRemote } = await import('../server/sources/git.js');
const { sanitizeName } = await import('../server/launch.js');
const { shq, isInside, backupDailySync } = await import('../server/util.js');

test('host allow-list blocks DNS rebinding hosts', () => {
  for (const h of ['localhost:4747', '127.0.0.1:4747', 'pilotage.localhost:4747', '[::1]:4747']) assert.equal(hostAllowed(h, false), true, h);
  for (const h of ['192.168.1.50:4748', 'evil.com', 'localhost.evil.com', 'evil.local', '', undefined]) assert.equal(hostAllowed(h, false), false, String(h));
  for (const h of ['192.168.1.50:4748', '10.20.30.40:4748', 'my-pc.netbird.selfhosted:4748']) assert.equal(hostAllowed(h, true), true, h);
  for (const h of ['evil.com', 'a.home', 'evil.local', 'localhost.evil.com:4748']) assert.equal(hostAllowed(h, true), false, h);
});

test('secret redaction', async () => {
  const { redact } = await import('../server/util.js');
  // Fake secrets are assembled at runtime so no secret-shaped literal sits in the repo (secret scanners flag those).
  const fake = (prefix, body) => prefix + body;
  const cases = [
    'DB_PASSWORD=hunter2secret',
    `STRIPE_SECRET_KEY=${fake('sk_' + 'live_', 'abcdefghijklmnop1234')}`,
    '{"password": "s3cr3tvalue"}',
    `token ${fake('sb' + 'p_', '0123456789abcdef0123456789abcdef01234567')}`,
    'https://user:pass1234@host.com/x',
    fake('gh' + 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123',
  ];
  for (const c of cases) assert.match(redact(c), /\[hidden\]/, c);
  assert.equal(redact('the token field is required'), 'the token field is required');
});

test('secret redaction: provider keys, webhooks, Basic auth, quoted and punctuated values', async () => {
  const { redact } = await import('../server/util.js');
  const fake = (prefix, body) => prefix + body;
  const a40 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const cases = {
    groq: fake('gs' + 'k_', a40 + 'efghijkl'),
    huggingface: fake('h' + 'f_', a40.slice(0, 34)),
    xai: fake('xa' + 'i-', a40 + a40),
    replicate: fake('r' + '8_', a40.slice(0, 37)),
    googleOAuth: fake('GOCS' + 'PX-', a40.slice(0, 28)),
    stripeWebhook: fake('whs' + 'ec_', a40.slice(0, 32)),
    slackWebhook: fake('https://hooks.slack' + '.com/services/', 'T0123ABCD/B0123ABCD/' + a40.slice(0, 24)),
    discordWebhook: fake('https://discord' + '.com/api/webhooks/', '123456789012345678/' + a40 + a40.slice(0, 28)),
    basicAuth: fake('Authorization: Basic ', 'dXNlcjpwYXNzd29yZDEyMzQ1Ng=='),
    semicolon: 'DB_PASSWORD=Xy;9!kq',
    quotedWithSpaces: 'password: "correct horse battery"',
  };
  for (const [name, c] of Object.entries(cases)) {
    const out = redact(c);
    assert.match(out, /\[hidden\]/, name);
    for (const part of c.split(/[\s"]+/).filter((p) => p.length >= 16)) assert.ok(!out.includes(part), `${name} leaks ${part}`);
  }
  assert.ok(!redact(cases.semicolon).includes('9!kq'));
  assert.ok(!redact(cases.quotedWithSpaces).includes('horse'));
  // Plain prose stays as it is.
  for (const ok of ['Basic configuration of the server', 'the password field is required', 'see the hf_ prefix']) assert.equal(redact(ok), ok);
  // Other spellings of Basic auth, and curl's -u user:password.
  const basic = 'dXNlcjpwYXNzd29yZDEyMzQ1Ng==';
  for (const c of [`{"Authorization": "Basic ${basic}"}`, `headers={'Authorization': 'Basic ${basic}'}`, `Authorization = Basic ${basic}`]) assert.ok(!redact(c).includes(basic.slice(4)), c);
  assert.ok(!redact('curl -u admin:' + 'hunter2pass https://x.example').includes('hunter2pass'));
  // Code is not mangled: a closing quote followed by ` + x + "` is not a quoted secret.
  for (const code of ['throw new Error("Invalid token: " + t + " in request")', 'const s = "password=" + pw + ", user=" + u;', 'Authorization: Basic authentication required', 'git push -u origin main']) assert.equal(redact(code), code);
});

test('path + url helpers', () => {
  assert.equal(winToWsl('C:\\Users\\Alex\\Documents\\Projects\\Portfolio'), '/mnt/c/Users/Alex/Documents/Projects/Portfolio');
  assert.equal(bridgeUrl('cse_01ABCDEFGHJKMNPQRSTVWXYZ'), 'https://claude.ai/code/session_01ABCDEFGHJKMNPQRSTVWXYZ');
  assert.equal(bridgeUrl('session_abc123'), 'https://claude.ai/code/session_abc123');
  assert.equal(bridgeUrl('bad id/../x'), null);
  assert.equal(webUrlFromRemote('git@github.com:alex/shop-api.git'), 'https://github.com/alex/shop-api');
  assert.equal(webUrlFromRemote('https://token@github.com/a/b.git'), 'https://github.com/a/b');
  assert.equal(normalizeCwd('/home/alex/x/'), '/home/alex/x');
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(toolSummary('Bash', { command: 'ls', description: 'List files' }), 'List files');
});

test('launch names and shell quoting are safe', () => {
  assert.equal(sanitizeName('--evil; rm -rf /'), 'evil rm -rf');
  assert.equal(sanitizeName(''), 'Session');
  assert.equal(sanitizeName('Billing – échéances'), 'Billing échéances');
  assert.equal(shq("it's"), `'it'\\''s'`);
});

function line(o) {
  return JSON.stringify(o) + '\n';
}

test('transcript parser classifies prompts, replies, tools and skips noise', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-tr-'));
  const f = path.join(dir, '11111111-2222-3333-4444-555555555555.jsonl');
  const base = { isSidechain: false, cwd: '/home/alex/demo', sessionId: 'x', version: '2.1.325', gitBranch: 'main', entrypoint: 'cli' };
  let s = '';
  s += line({ type: 'mode', mode: 'normal' });
  s += line({ parentUuid: null, ...base, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Build the export feature' }, timestamp: '2026-11-01T10:00:00.000Z' });
  s += line({ parentUuid: 'a', ...base, type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/home/alex/demo/a.js' } }], usage: { output_tokens: 10 } }, timestamp: '2026-11-01T10:00:05.000Z' });
  s += line({ parentUuid: 'b', ...base, type: 'user', message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok https://github.com/a/b/pull/12' }] }, timestamp: '2026-11-01T10:00:06.000Z' });
  s += line({ parentUuid: 'c', ...base, type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done: export added.' }] }, timestamp: '2026-11-01T10:01:00.000Z' });
  s += line({ parentUuid: 'd', ...base, isSidechain: true, type: 'user', message: { role: 'user', content: 'subagent prompt' }, timestamp: '2026-11-01T10:02:00.000Z' });
  s += line({ parentUuid: 'e', ...base, type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' }, timestamp: '2026-11-01T10:03:00.000Z' });
  s += line({ parentUuid: 'f', ...base, type: 'user', message: { role: 'user', content: '<command-name>/model</command-name><command-args></command-args>' }, timestamp: '2026-11-01T10:03:01.000Z' });
  s += line({ parentUuid: 'g', ...base, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Now deploy it' }, timestamp: '2026-11-01T18:00:00.000Z' });
  s += line({ parentUuid: 'h', ...base, type: 'system', subtype: 'away_summary', content: 'Export shipped; deploy pending. (disable recaps in /config)', timestamp: '2026-11-01T18:05:00.000Z' });
  s += line({ type: 'ai-title', aiTitle: 'Export feature', sessionId: 'x' });
  s += '{"type":"user","partial line without newline';
  fs.writeFileSync(f, s);
  const { meta, turns } = await parseTranscriptFile(f);
  assert.equal(meta.counts.h, 2);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].p, 'Build the export feature');
  assert.equal(turns[0].a, 'Done: export added.');
  assert.equal(turns[0].n, 1);
  assert.equal(meta.aiTitle, 'Export feature');
  assert.equal(meta.awaySummary, 'Export shipped; deploy pending.');
  assert.deepEqual(meta.prs, ['https://github.com/a/b/pull/12']);
  assert.equal(meta.files['/home/alex/demo/a.js'], 1);
  assert.equal(meta.cwd, '/home/alex/demo');
  assert.ok(meta.offset < fs.statSync(f).size, 'partial last line is not consumed');
  const blocks = computeBlocks(meta, turns);
  assert.equal(blocks.length, 2, '8h gap splits into two work blocks');
});

test('runWithInput: the timeout is a real deadline (SIGTERM ignored, grandchild holding stdout)', async () => {
  const { runWithInput } = await import('../server/util.js');
  let t0 = Date.now();
  const r1 = await runWithInput('sh', ['-c', 'trap "" TERM; sleep 8'], '', { timeout: 300, killGrace: 300 });
  assert.ok(Date.now() - t0 < 3000, `ignored SIGTERM still resolves (${Date.now() - t0} ms)`);
  assert.equal(r1.code, -1);
  assert.equal(r1.timedOut, true);
  assert.match(r1.stderr, /Timed out/);
  t0 = Date.now();
  const r2 = await runWithInput('sh', ['-c', '(sleep 2) & echo hi'], '', { timeout: 20000 });
  assert.ok(Date.now() - t0 < 1900, `a grandchild holding stdout doesn't hold the call (${Date.now() - t0} ms)`);
  assert.equal(r2.code, 0);
  assert.equal(r2.stdout.trim(), 'hi');
  const r3 = await runWithInput('cat', [], 'echoed back', { timeout: 5000 });
  assert.equal(r3.code, 0);
  assert.equal(r3.stdout, 'echoed back');
  assert.equal(r3.timedOut, undefined);
  const r4 = await runWithInput('/nonexistent/binary-xyz', [], '', { timeout: 5000 });
  assert.equal(r4.code, -1);
});

test('session index: appends to a known session are written later, together with the index', async () => {
  const { SessionIndex, readAccountUuid } = await import('../server/sources/sessions.js');
  const { paths } = await import('../server/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ix-'));
  const id = '22222222-3333-4444-5555-666666666666';
  const f = path.join(dir, `${id}.jsonl`);
  const base = { isSidechain: false, cwd: '/home/alex/demo', sessionId: id, entrypoint: 'cli' };
  let s = line({ type: 'session-owner', accountUuid: 'abcdef12-0000-4000-8000-000000000001', sessionId: id });
  s += line({ ...base, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'First task' }, timestamp: '2026-11-01T10:00:00.000Z' });
  fs.writeFileSync(f, s);
  const src = { id: 'test', mapCwd: (p) => p };
  const entry = () => {
    const st = fs.statSync(f);
    return { id, file: f, src, projectKey: 'k', size: st.size, mtimeMs: st.mtimeMs };
  };
  const ix = new SessionIndex();
  assert.equal(await ix.indexFile(entry()), false, 'first parse is written at once');
  assert.equal(ix.get(id).accountUuid, 'abcdef12-0000-4000-8000-000000000001', 'session-owner line read by the parser');
  assert.equal(await readAccountUuid(f), 'abcdef12-0000-4000-8000-000000000001');
  const onDisk = () => JSON.parse(fs.readFileSync(ix.turnsFile(id), 'utf8'));
  assert.equal(onDisk().length, 1);
  fs.appendFileSync(f, line({ ...base, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Second task' }, timestamp: '2026-11-01T11:00:00.000Z' }));
  assert.equal(await ix.indexFile(entry()), true, 'an append is deferred');
  assert.equal(ix.loadTurns(id).length, 2, 'readers see the new turn right away');
  assert.equal(onDisk().length, 1, 'turns file not rewritten yet');
  for (let i = 0; i < 50; i++) ix.loadTurns(`other-${i}`); // LRU churn must not lose deferred turns
  assert.equal(ix.loadTurns(id).length, 2);
  await ix.flush();
  assert.equal(onDisk().length, 2);
  const saved = JSON.parse(fs.readFileSync(paths.index, 'utf8')).sessions.find((m) => m.id === id);
  assert.equal(saved.turnCount, 2, 'index written with the turns');
  fs.appendFileSync(f, line({ ...base, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Third task' }, timestamp: '2026-11-01T12:00:00.000Z' }));
  assert.equal(await ix.indexFile(entry()), true);
  ix.flushNow();
  assert.equal(onDisk().length, 3, 'shutdown flush writes deferred turns');
  // A fresh index (restart) continues from the saved offset with matching turns.
  const ix2 = new SessionIndex();
  assert.equal(ix2.get(id).turnCount, 3);
  assert.equal(ix2.loadTurns(id).length, 3);
});

test('registry: sessions that only grew refresh their project totals without a rebuild', async () => {
  const { ProjectRegistry } = await import('../server/sources/projects.js');
  const metas = new Map([
    ['a', { id: 'a', cwd: '/w/app', startedAt: 100, lastAt: 200, counts: { h: 2 } }],
    ['b', { id: 'b', cwd: '/w/app', startedAt: 150, lastAt: 300, counts: { h: 1 } }],
  ]);
  const index = { get: (id) => metas.get(id) || null, isInternal: () => false, list: () => [...metas.values()] };
  const store = { settings: { scan: { hiddenPaths: [] } }, project: () => ({}) };
  const reg = new ProjectRegistry(index, store);
  reg.resolve = (cwd) => (cwd === '/w/app' ? { root: '/w/app', worktree: null } : null);
  reg.projects = new Map([['/w/app', { id: 'x', path: '/w/app', sessionIds: ['a', 'b'], worktrees: new Map(), firstAt: 100, lastAt: 300, humanPrompts: 3, automationRuns: 0 }]]);
  reg.lastScanAt = Date.now();
  metas.set('b', { ...metas.get('b'), lastAt: 900, counts: { h: 4 } });
  assert.equal(reg.refreshSessions(['b']), true);
  const p = reg.projects.get('/w/app');
  assert.equal(p.lastAt, 900);
  assert.equal(p.humanPrompts, 6);
  assert.equal(p.firstAt, 100);
  metas.set('c', { id: 'c', cwd: '/w/app', startedAt: 1, lastAt: 2, counts: { h: 1 } });
  assert.equal(reg.refreshSessions(['c']), false, 'an unknown session needs a full rebuild');
  reg.lastScanAt = Date.now() - 11 * 60e3;
  assert.equal(reg.refreshSessions(['b']), false, 'the periodic folder scan still happens');
});

function viewsWith({ metas = [], blocks = {}, liveIds = [], projects = new Map(), names = {}, daily = null } = {}) {
  return import('../server/views.js').then(
    ({ Views }) =>
      new Views({
        index: { list: () => metas.slice(), get: (id) => metas.find((m) => m.id === id) || null, loadTurns: () => [] },
        registry: { projects, projectOfSession: () => null, resolve: () => null, gitOf: () => ({}), byId: () => null },
        store: { project: (p) => ({ name: names[p] }), session: () => ({}), data: { ideas: [], workspaces: {} }, settings: {} },
        live: { get: (id) => (liveIds.includes(id) ? { live: true, status: 'busy' } : null) },
        ai: {
          blocksOf: (m) => blocks[m.id] || [],
          blockView: (m, b) => ({ key: b.key, sessionId: m.id, startAt: b.startAt, endAt: b.endAt, digest: { title: b.key, status: 'done' }, lastText: '' }),
          digestOf: () => null,
          state: { projects: {}, blocks: {}, cv: {}, daily },
        },
        processes: () => [],
      }),
  );
}

test('views: only the latest block of a live session is live', async () => {
  const meta = { id: 's1', cwd: '/w', counts: { h: 3 }, lastAt: 3 };
  const bl = [1, 2, 3].map((i) => ({ key: `s1:${i}`, startAt: i, endAt: i }));
  const v = await viewsWith({ metas: [meta], blocks: { s1: bl }, liveIds: ['s1'] });
  assert.deepEqual(bl.map((b) => v.displayBlock(meta, b).live), [false, false, true]);
  const idle = await viewsWith({ metas: [meta], blocks: { s1: bl } });
  assert.deepEqual(bl.map((b) => idle.displayBlock(meta, b).live), [false, false, false]);
});

test('views: search keeps the newest matches when there are more than 30', async () => {
  const metas = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, cwd: '/w', customTitle: `Thing ${i}`, counts: { h: 1 }, lastAt: 1000 + i, startedAt: 1000 + i }));
  const v = await viewsWith({ metas });
  const r = v.search('thing');
  assert.equal(r.sessions.length, 30);
  assert.deepEqual(r.sessions.map((s) => s.id), Array.from({ length: 30 }, (_, i) => `s${44 - i}`));
});

test('views: the daily brief shows project names, never the prompt ids', async () => {
  const projects = new Map([
    ['/w/acme', { id: 'id-dev', path: '/w/acme', name: 'acme' }],
    ['/w/shop', { id: 'id-eye', path: '/w/shop', name: 'shop-api' }],
  ]);
  const daily = {
    day: '2026-11-15',
    at: 1,
    brief: {
      headline: 'p3 is moving and p5 needs a token fix.',
      focus: [{ project: 'p3', projectPath: '/w/acme', title: 'Call the suppliers', why: 'Campaign for p3 ends Thursday', action: 'Open p3' }],
      forgotten: [
        { project: 'p5', projectPath: '/w/shop', note: 'Token still active' },
        { project: 'p9', projectPath: null, note: 'Old servers' },
      ],
      ideas: ['Share the p5 scheduler with p3'],
    },
  };
  const v = await viewsWith({ projects, names: { '/w/acme': 'Acme' }, daily });
  const d = v.dailyView(daily);
  assert.equal(d.focus[0].project, 'Acme', 'custom name wins');
  assert.equal(d.focus[0].projectId, 'id-dev');
  assert.equal(d.focus[0].why, 'Campaign for Acme ends Thursday');
  assert.equal(d.forgotten[0].project, 'shop-api');
  assert.equal(d.forgotten[1].project, '', 'an unresolved id is not shown');
  assert.equal(d.headline, 'Acme is moving and shop-api needs a token fix.');
  assert.deepEqual(d.ideas, ['Share the shop-api scheduler with Acme']);
  assert.equal(d.day, '2026-11-15');
});

test('usage: keeps the highest reading per window, so per-model weekly limits do not flip the number', async () => {
  const { recordReading } = await import('../server/ai/usage.js');
  const now = Date.now();
  const R = now + 40 * 3600e3;
  const keep = Infinity; // weekly readings: valid until the window resets
  const s = {};
  assert.equal(recordReading(s, { pct: 69, resetsAt: R, at: now - 60e3 }, keep, now).pct, 69);
  assert.equal(recordReading(s, { pct: 48, resetsAt: R, at: now }, keep, now).pct, 69); // other model's limit, same window
  assert.equal(recordReading(s, { pct: 48, resetsAt: R + 3600e3, at: now }, keep, now).pct, 69);
  assert.equal(recordReading(s, {}, keep, now + 13 * 3600e3).pct, 69); // no new reading for 13 h: still guarded
  assert.equal(recordReading({ f: { pct: 50, resetsAt: now + 1000, at: now - 1000 } }, {}, 30 * 60e3, now + 31 * 60e3), null); // 5-hour readings must be fresh
  assert.equal(recordReading({ x: { pct: 90, resetsAt: now - 1, at: now - 5 } }, {}, keep, now), null); // window over
});

test('data folder: a git clone keeps <clone>/data, an npm install uses ~/.pilotage', async () => {
  const { defaultDataDir } = await import('../server/config.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-datadir-'));
  const clone = path.join(base, 'clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const pkg = path.join(base, 'lib', 'node_modules', 'pilotage-cli');
  fs.mkdirSync(pkg, { recursive: true });
  assert.equal(defaultDataDir(clone, '/home/u'), path.join(clone, 'data'));
  assert.equal(defaultDataDir(pkg, '/home/u'), '/home/u/.pilotage');
  fs.mkdirSync(path.join(pkg, 'data'));
  assert.equal(defaultDataDir(pkg, '/home/u'), path.join(pkg, 'data'), 'an existing data folder is kept');
});

// Windows prints ipconfig / netsh in the user's language: phone access must not depend on English labels.
const IPCONFIG = {
  en: `\r\nWindows IP Configuration\r\n\r\n\r\nEthernet adapter Ethernet:\r\n\r\n   Media State . . . . . . . . . . . : Media disconnected\r\n   Connection-specific DNS Suffix  . :\r\n\r\nWireless LAN adapter Wi-Fi:\r\n\r\n   Connection-specific DNS Suffix  . : home\r\n   Link-local IPv6 Address . . . . . : fe80::1c2b:3d4e:5f60:7182%12\r\n   IPv4 Address. . . . . . . . . . . : 192.168.1.23\r\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0\r\n   Default Gateway . . . . . . . . . : 192.168.1.1\r\n\r\nUnknown adapter wt0:\r\n\r\n   IPv4 Address. . . . . . . . . . . : 100.92.10.4\r\n   Subnet Mask . . . . . . . . . . . : 255.192.0.0\r\n\r\nEthernet adapter vEthernet (WSL (Hyper-V firewall)):\r\n\r\n   IPv4 Address. . . . . . . . . . . : 172.29.64.1\r\n   Subnet Mask . . . . . . . . . . . : 255.255.240.0\r\n`,
  fr: `\r\nConfiguration IP de Windows\r\n\r\n\r\nCarte Ethernet Ethernet :\r\n\r\n   Statut du média. . . . . . . . . . . . : Média déconnecté\r\n\r\nCarte réseau sans fil Wi-Fi :\r\n\r\n   Suffixe DNS propre à la connexion. . . : home\r\n   Adresse IPv6 de liaison locale. . . . .: fe80::1c2b:3d4e:5f60:7182%12\r\n   Adresse IPv4. . . . . . . . . . . . . .: 192.168.1.23\r\n   Masque de sous-réseau. . . . . . . . . : 255.255.255.0\r\n   Passerelle par défaut. . . . . . . . . : 192.168.1.1\r\n\r\nCarte inconnue wt0 :\r\n\r\n   Adresse IPv4. . . . . . . . . . . . . .: 100.92.10.4\r\n   Masque de sous-réseau. . . . . . . . . : 255.192.0.0\r\n`,
  de: `\r\nWindows-IP-Konfiguration\r\n\r\n\r\nDrahtlos-LAN-Adapter WLAN:\r\n\r\n   Verbindungsspezifisches DNS-Suffix: fritz.box\r\n   Verbindungslokale IPv6-Adresse  . : fe80::1c2b:3d4e:5f60:7182%5\r\n   IPv4-Adresse  . . . . . . . . . . : 192.168.1.23\r\n   Subnetzmaske  . . . . . . . . . . : 255.255.255.0\r\n   Standardgateway . . . . . . . . . : 192.168.1.1\r\n\r\nUnbekannter Adapter wt0:\r\n\r\n   IPv4-Adresse  . . . . . . . . . . : 100.92.10.4\r\n   Subnetzmaske  . . . . . . . . . . : 255.192.0.0\r\n`,
};
const NETSH_WLAN = {
  en: `\r\nThere is 1 interface on the system:\r\n\r\n    Name                   : Wi-Fi\r\n    Description            : Intel(R) Wi-Fi 6 AX201 160MHz\r\n    State                  : connected\r\n    SSID                   : Home Net\r\n    AP BSSID               : 12:34:56:78:9a:bc\r\n    Radio type             : 802.11ax\r\n`,
  fr: `\r\nIl existe 1 interface sur le système :\r\n\r\n    Nom                    : Wi-Fi\r\n    Description            : Intel(R) Wi-Fi 6 AX201 160MHz\r\n    État                   : connecté\r\n    SSID                   : Home Net\r\n    BSSID                  : 12:34:56:78:9a:bc\r\n`,
  de: `\r\nEs ist 1 Schnittstelle auf dem System vorhanden:\r\n\r\n    Name                   : WLAN\r\n    Beschreibung           : Intel(R) Wi-Fi 6 AX201 160MHz\r\n    Status                 : Verbunden\r\n    SSID                   : Home Net\r\n    BSSID                  : 12:34:56:78:9a:bc\r\n`,
  enOff: `\r\nThere is 1 interface on the system:\r\n\r\n    Name                   : Wi-Fi\r\n    State                  : disconnected\r\n    Radio status           : Hardware On\r\n`,
  frOff: `\r\nIl existe 1 interface sur le système :\r\n\r\n    Nom                    : Wi-Fi\r\n    État                   : déconnecté\r\n`,
};

test('Windows network output is read in any language (ipconfig, netsh wlan)', async () => {
  const { parseIpconfig, parseWlanSsid } = await import('../server/net.js');
  for (const [lang, text] of Object.entries(IPCONFIG)) {
    const addrs = parseIpconfig(text);
    const wifi = addrs.find((a) => a.kind === 'wifi');
    assert.ok(wifi, `${lang}: no Wi-Fi address`);
    assert.equal(wifi.ip, '192.168.1.23', lang);
    assert.equal(wifi.mask, '255.255.255.0', lang);
    const nb = addrs.find((a) => a.kind === 'netbird');
    assert.equal(nb?.ip, '100.92.10.4', `${lang}: NetBird`);
    assert.equal(addrs[0].kind, 'wifi', `${lang}: Wi-Fi first`);
    assert.ok(!addrs.some((a) => a.ip === '172.29.64.1'), `${lang}: WSL's virtual adapter is left out`);
  }
  for (const lang of ['en', 'fr', 'de']) assert.equal(parseWlanSsid(NETSH_WLAN[lang]), 'Home Net', lang);
  assert.equal(parseWlanSsid(NETSH_WLAN.enOff), null);
  assert.equal(parseWlanSsid(NETSH_WLAN.frOff), null);
  assert.equal(parseWlanSsid(''), null);
});

test('an unreadable state.json is kept aside and the newest readable backup is loaded, never replaced by defaults', () => {
  // A fresh process per start: config paths and the store are module singletons. It starts like server/index.js
  // (ensureDirs, getStore) and then saves once, as the first change after startup does.
  const url = (f) => JSON.stringify(new URL(`../server/${f}`, import.meta.url).href);
  const start = (data) => {
    const code = `const { ensureDirs } = await import(${url('config.js')}); ensureDirs();
      const s = (await import(${url('store.js')})).getStore(); s.saveNow();
      console.log(JSON.stringify({ settings: s.settings, ideas: s.data.ideas, projects: s.data.projects }));`;
    const env = { ...process.env, HOME: data, PILOTAGE_DATA: data, PILOTAGE_WSL: '0', PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1' };
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { ...JSON.parse(r.stdout.trim().split('\n').pop()), stderr: r.stderr };
  };
  const corrupt = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).sort();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-state-'));
  try {
    // A hand edit left a trailing comma; the newest backup is damaged too, the one before is good.
    const data = path.join(base, 'a');
    fs.mkdirSync(path.join(data, 'backups'), { recursive: true });
    const saved = {
      version: 1,
      projects: { '/p/acme': { name: 'Acme site', notes: 'call back' } },
      ideas: [{ id: 'i1', text: 'Ship the export', createdAt: 1 }],
      settings: { profile: { name: 'Sam' }, ai: { enabled: false }, launch: { permissionMode: 'default' } },
    };
    fs.writeFileSync(path.join(data, 'backups', 'state-2000-01-01.json'), JSON.stringify(saved));
    fs.writeFileSync(path.join(data, 'backups', 'state-2000-01-02.json'), '{"ideas": [');
    const broken = JSON.stringify(saved).replace(/}$/, ',}');
    fs.writeFileSync(path.join(data, 'state.json'), broken);
    const a = start(data);
    assert.equal(a.settings.profile.name, 'Sam');
    assert.equal(a.settings.ai.enabled, false, 'AI stays off');
    assert.equal(a.settings.launch.permissionMode, 'default', 'the chosen permission mode stays');
    assert.deepEqual(a.ideas.map((i) => i.text), ['Ship the export']);
    assert.equal(a.projects['/p/acme']?.name, 'Acme site');
    assert.equal(corrupt(data).length, 1);
    assert.equal(fs.readFileSync(path.join(data, corrupt(data)[0]), 'utf8'), broken, 'the damaged file is kept as it was');
    assert.match(a.stderr, /state\.json is unreadable/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).settings.profile.name, 'Sam', 'the save wrote the restored state');
    for (const f of fs.readdirSync(path.join(data, 'backups')).filter((f) => f !== 'state-2000-01-02.json')) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'backups', f), 'utf8')).settings.profile.name, 'Sam', `backups/${f}`);
    }

    // No backup at all: defaults, but the damaged file is kept and the save does not touch it. A file that parses
    // but is not an object counts as damaged; a second damaged start keeps a second copy.
    const data2 = path.join(base, 'b');
    fs.mkdirSync(data2);
    fs.writeFileSync(path.join(data2, 'state.json'), '[]');
    const b = start(data2);
    assert.equal(b.settings.profile.name, '');
    assert.deepEqual(b.ideas, []);
    assert.deepEqual(corrupt(data2).map((f) => fs.readFileSync(path.join(data2, f), 'utf8')), ['[]']);
    assert.deepEqual(fs.readdirSync(path.join(data2, 'backups')), [], 'nothing damaged is copied into the backups');
    const truncated = '{"version":1,"ideas":[{"id":"i1","te';
    fs.writeFileSync(path.join(data2, 'state.json'), truncated);
    start(data2);
    assert.equal(corrupt(data2).length, 2);
    assert.deepEqual(corrupt(data2).map((f) => fs.readFileSync(path.join(data2, f), 'utf8')).sort(), ['[]', truncated].sort());

    // The daily backup (what a damaged start falls back to) never takes a copy of a file that doesn't parse.
    const data3 = path.join(base, 'c');
    fs.mkdirSync(data3);
    fs.writeFileSync(path.join(data3, 'state.json'), '{"ideas":[],}');
    backupDailySync(path.join(data3, 'state.json'), path.join(data3, 'backups'), 'state', 21);
    assert.equal(fs.existsSync(path.join(data3, 'backups')), false);
    fs.writeFileSync(path.join(data3, 'state.json'), '{"ideas":[]}');
    backupDailySync(path.join(data3, 'state.json'), path.join(data3, 'backups'), 'state', 21);
    assert.equal(fs.readdirSync(path.join(data3, 'backups')).length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the claude binary is found where installers put it, not only on the PATH of the shell that started Pilotage', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-claudebin-'));
  const put = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude'), '#!/usr/bin/env node\n', { mode: 0o755 });
    return path.join(dir, 'claude');
  };
  // As started by the login item / Windows Startup entry: a PATH without nvm, Claude Code installed with npm under nvm.
  const viaNvm = put(path.join(home, '.nvm/versions/node/v22.18.0/bin'));
  if (!fs.existsSync(path.join(path.dirname(process.execPath), 'claude'))) {
    const cfg = new URL('../server/config.js', import.meta.url).href;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(cfg)}).then((c) => console.log(JSON.stringify([c.CLAUDE_BIN, c.CLAUDE_CMD])))`], { env: { HOME: home, PATH: '/usr/bin:/bin', PILOTAGE_WSL: '0', PILOTAGE_DATA: path.join(home, 'data') }, encoding: 'utf8' }).trim();
    const [bin, cmd] = JSON.parse(out);
    assert.equal(bin, viaNvm, 'a bare "claude" is "command not found" in launch tabs and for the autostarted server');
    assert.deepEqual(cmd, [process.execPath, viaNvm], 'an npm-installed claude runs with Pilotage\'s node, whatever node is first on PATH');
  }
  fs.rmSync(path.join(home, '.nvm'), { recursive: true });
  const { resolveClaudeBin } = await import('../server/config.js');
  const sys = { envPath: '', execDir: path.join(home, 'no-node-here'), systemDirs: [] };
  assert.equal(resolveClaudeBin({ home, ...sys }), 'claude', 'nothing installed: the bare name, as before');
  // npm under nvm: the login item / Startup entry PATH has no nvm, and the newest node's copy wins.
  put(path.join(home, '.nvm/versions/node/v20.11.1/bin'));
  const nvm22 = put(path.join(home, '.nvm/versions/node/v22.18.0/bin'));
  assert.equal(resolveClaudeBin({ home, ...sys }), nvm22);
  // PATH (never Windows' /mnt/...) beats other nvm versions and the old ~/.claude/local install.
  put(path.join(home, '.claude/local'));
  const onPath = put(path.join(home, 'tools'));
  assert.equal(resolveClaudeBin({ home, envPath: `/mnt/c/Program Files/x:${path.dirname(onPath)}`, execDir: sys.execDir, systemDirs: [] }), onPath);
  // The node running Pilotage beats PATH (an old `sudo npm i -g` claude on the autostart's PATH must not win).
  const execDir = path.join(home, 'node-running-pilotage', 'bin');
  const fromExec = put(execDir);
  assert.equal(resolveClaudeBin({ home, envPath: path.dirname(onPath), execDir, systemDirs: [] }), fromExec);
  // The native installer's ~/.local/bin/claude first, as before.
  const native = put(path.join(home, '.local/bin'));
  assert.equal(resolveClaudeBin({ home, envPath: path.dirname(onPath), execDir, systemDirs: [] }), native);
  const { isNodeScript } = await import('../server/config.js');
  assert.equal(isNodeScript(native), true);
  fs.writeFileSync(native, '\x7fELF binary', { mode: 0o755 });
  assert.equal(isNodeScript(native), false, 'the native binary runs as is');
});

test('redaction stays fast on long pasted blobs (it runs on every indexed prompt and reply)', async () => {
  const { redact } = await import('../server/util.js');
  const { clip } = await import('../server/sources/harness/common.js');
  const time = (f) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  const blob = Buffer.alloc(300_000, 'a1-_').toString('base64url'); // a pasted base64url payload
  assert.ok(time(() => clip(blob, 1500)) < 300, 'clip() of a 300 KB blob');
  const ids = 'token.'.repeat(1_000); // a long run of identifier characters around a secret-sounding word
  assert.ok(time(() => redact(ids)) < 300, 'redact() of 6 KB of token.token.…');
  // Still masks what it should after the change.
  assert.match(clip('DB_PASSWORD=hunter2secret ' + 'x'.repeat(5000), 1500), /DB_PASSWORD=\[hidden\]/);
  // Pathological inputs stay fast too (each used to be quadratic).
  for (const [name, s] of Object.entries({ curl: 'curl '.repeat(40_000), eyJ: 'eyJ'.repeat(70_000), hex: 'f0e1'.repeat(50_000), url: 'a'.repeat(200_000) })) {
    assert.ok(time(() => redact(s)) < 500, name);
  }
});

test('a secret right at the clip point is never shown in part, even after masks earlier shorten the text', async () => {
  const { clip } = await import('../server/sources/harness/common.js');
  const key = (i) => 'sk-' + 'proj-' + String(i).repeat(150).slice(0, 150);
  const gh = 'gh' + 'p_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  let env = '';
  for (let i = 0; i < 8; i++) env += `OPENAI_API_KEY_${i}=${key(i)}\n`;
  env += 'x'.repeat(1890 - env.length) + ` export GITHUB_PAT=${gh}\n` + 'y'.repeat(3000);
  const out = clip(env, 1500);
  assert.ok(!out.includes(gh.slice(0, 12)), 'part of the GitHub token is shown');
  // A key that also passes in "+…+" shape is still masked when it is a real value.
  const { redact } = await import('../server/util.js');
  assert.ok(!redact('{"SecretAccessKey": "+AbC/dEf9GhIjKlMnOpQrStUv"}').includes('GhIjKlMnOp'));
  assert.equal(redact('const s = "token:"+value+"suffix";'), 'const s = "token:"+value+"suffix";');
});

test('phone firewall scope keeps a Wi-Fi adapter whose name arrives garbled (Windows console code page)', async () => {
  const { parseIpconfig, firewallRanges } = await import('../server/net.js');
  // Russian Windows, read through WSL as UTF-8: the Cyrillic header and labels turn into "?".
  const ru = `\r\n????????? IP ??? Windows\r\n\r\n\r\n??????? ???????????? ????????? ???? ???????????? ????:\r\n\r\n   IPv4-?????. . . . . . . . . . . . : 192.168.1.23\r\n   ????? ???????. . . . . . . . . . : 255.255.255.0\r\n   ???????? ????. . . . . . . . . . : 192.168.1.1\r\n\r\n??????? ?????????? wt0:\r\n\r\n   IPv4-?????. . . . . . . . . . . . : 100.92.10.4\r\n   ????? ???????. . . . . . . . . . : 255.192.0.0\r\n`;
  const addrs = parseIpconfig(ru);
  assert.ok(addrs.some((a) => a.ip === '192.168.1.23'), 'address found');
  const ranges = firewallRanges(addrs, ['100.64.0.0/10']);
  assert.ok(ranges.has('192.168.1.0/24'), `the Wi-Fi subnet is in the firewall rule (${[...ranges]})`);
  assert.ok(!firewallRanges([{ kind: 'other', ip: '169.254.10.1', mask: '255.255.0.0' }]).has('169.254.0.0/16'), 'link-local is not a network to open');
});

test('new installs ask before commands and edits; installs from before keep "Skip all prompts"', () => {
  const url = JSON.stringify(new URL('../server/store.js', import.meta.url).href);
  const cfg = JSON.stringify(new URL('../server/config.js', import.meta.url).href);
  const modeIn = (data) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `const c = await import(${cfg}); c.ensureDirs(); const { getStore } = await import(${url}); console.log(getStore().settings.launch.permissionMode);`], { env: { ...process.env, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, encoding: 'utf8' }).trim();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-mode-'));
  try {
    const fresh = path.join(base, 'fresh');
    assert.equal(modeIn(fresh), 'default', 'a new install');
    const old = path.join(base, 'old');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'state.json'), JSON.stringify({ settings: { profile: { name: 'Sam' }, launch: { model: '' } } }));
    assert.equal(modeIn(old), 'bypassPermissions', 'an older install that never chose keeps what it had');
    const chose = path.join(base, 'chose');
    fs.mkdirSync(chose);
    fs.writeFileSync(path.join(chose, 'state.json'), JSON.stringify({ settings: { launch: { permissionMode: 'manual' } } }));
    assert.equal(modeIn(chose), 'default', '"manual" is the old name of Ask every time');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('"Enable phone access" never trusts the current Wi-Fi unless asked', async () => {
  const { enableTrustPatch } = await import('../server/net.js');
  assert.deepEqual(enableTrustPatch('Cafe Free WiFi', undefined, { trustedSsids: ['Home'] }), {}, 'not by default');
  assert.deepEqual(enableTrustPatch('Cafe Free WiFi', false), {});
  assert.deepEqual(enableTrustPatch('Cafe Free WiFi', 'yes'), {}, 'only an explicit true');
  assert.deepEqual(enableTrustPatch('Home', true, { trustedSsids: ['Office'] }), { trustedSsids: ['Office', 'Home'] });
  assert.deepEqual(enableTrustPatch(null, true), {}, 'not on Wi-Fi');
});

test("Pilotage's claude -p calls don't bill an ANTHROPIC_API_KEY that happens to be in the shell", async () => {
  const { claudeEnv } = await import('../server/ai/runner.js');
  const shell = { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't', PILOTAGE_DATA: '/d' };
  const env = claudeEnv(shell);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PILOTAGE_DATA, undefined);
  assert.equal(env.PATH, `/usr/bin:${path.dirname(process.execPath)}`, "the user's PATH first, Pilotage's node last (for claude's children)");
  const opted = claudeEnv({ ...shell, PILOTAGE_USE_ANTHROPIC_API_KEY: '1' });
  assert.equal(opted.ANTHROPIC_API_KEY, 'sk-ant-x', 'kept when asked for');
});

test('phone forwarder revive: waits two misses, leaves a user stop alone, backs off, gives up without a firewall rule', async () => {
  const { reviveStep, reviveResult } = await import('../server/net.js');
  const hb = { pid: 42, at: 0 };
  let st = { misses: 0, failures: 0, nextTryAt: 0, gaveUp: false };
  const t = 1_000_000;
  st = reviveStep(st, { hb, running: false, stoppedByUser: false, now: t });
  assert.equal(st.action, 'none', 'first miss: wait (a heartbeat can be late)');
  st = reviveStep(st, { hb, running: false, stoppedByUser: false, now: t });
  assert.equal(st.action, 'try');
  assert.equal(reviveStep(st, { hb, running: false, stoppedByUser: true, now: t }).action, 'none', 'stopped from the app');
  assert.equal(reviveStep(st, { hb: null, running: false, stoppedByUser: false, now: t }).action, 'none', 'never ran');
  // Three failed restarts: then at most once every 30 minutes.
  for (let i = 0; i < 3; i++) st = reviveResult(st, { ok: false, error: 'powershell failed' }, t);
  st = reviveStep(reviveStep(st, { hb, running: false, now: t + 60e3 }), { hb, running: false, now: t + 120e3 });
  assert.equal(st.action, 'none', 'backing off');
  st = reviveStep(reviveStep(st, { hb, running: false, now: t + 31 * 60e3 }), { hb, running: false, now: t + 32 * 60e3 });
  assert.equal(st.action, 'try', 'tries again after 30 minutes');
  // The user removed the firewall rule: stop trying.
  st = reviveResult(st, { ok: false, needsFirewall: true }, t);
  st = reviveStep(reviveStep(st, { hb, running: false, now: t + 99e6 }), { hb, running: false, now: t + 99e6 });
  assert.equal(st.action, 'none');
  // A success resets everything.
  assert.deepEqual(reviveResult(st, { ok: true }, t), { misses: 0, failures: 0, nextTryAt: 0, gaveUp: false });
});

test('a 5-hour usage reading holds until its window resets, even when the statusline file stops being refreshed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-usage-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    const now = Math.floor(Date.now() / 1000);
    // Saved 31 minutes ago (the user stopped working; Pilotage's own calls never refresh it), window resets in 2 h.
    fs.writeFileSync(path.join(home, '.claude', 'rate_limits.json'), JSON.stringify({ saved_at: now - 31 * 60, five_hour: { used_percentage: 70, resets_at: now + 7200 }, seven_day: { used_percentage: 40, resets_at: now + 86400 } }));
    const url = JSON.stringify(new URL('../server/ai/usage.js', import.meta.url).href);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const u = await import(${url}); console.log(JSON.stringify(u.usageNow().five))`], { env: { ...process.env, HOME: home, PILOTAGE_DATA: path.join(home, 'data'), PILOTAGE_WSL: '0' }, encoding: 'utf8' }).trim();
    assert.equal(JSON.parse(out)?.pct, 70, 'the guard must stay closed until the window resets');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the turn cache stays bounded after indexing many sessions (memory does not grow with history)', async () => {
  const { SessionIndex } = await import('../server/sources/sessions.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-turncache-'));
  const ix = new SessionIndex();
  const src = { id: 'test', mapCwd: (p) => p };
  for (let i = 0; i < 100; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, line({ isSidechain: false, cwd: '/home/alex/demo', sessionId: id, entrypoint: 'cli', type: 'user', turnOrigin: 'human', message: { role: 'user', content: `Task ${i}` }, timestamp: '2026-11-01T10:00:00.000Z' }));
    const st = fs.statSync(f);
    await ix.indexFile({ id, file: f, src, projectKey: 'k', size: st.size, mtimeMs: st.mtimeMs });
  }
  assert.ok(ix.turnCache.size <= 40, `turnCache holds ${ix.turnCache.size} sessions`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a block that starts with a scripted or peer prompt still splits on a 4-hour gap', () => {
  const meta = { id: 'S', startedAt: 0 };
  const t0 = Date.UTC(2026, 10, 1, 10);
  const blocks = computeBlocks(meta, [
    { t: t0, o: 's', p: 'claude -p run' },
    { t: t0 + 3 * 86400e3, o: 'h', p: 'Back on it three days later' },
  ]);
  assert.equal(blocks.length, 2, 'one 72-hour block would get one digest for two pieces of work');
});

test('a calendar day is 23 or 25 hours long on DST days (day detail and the heatmap agree)', async () => {
  const { dayRange } = await import('../server/views.js');
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/Paris';
  try {
    const [s, e] = dayRange('2026-10-25'); // clocks go back: 25 hours
    assert.equal((e - s) / 3600e3, 25);
    const [s2, e2] = dayRange('2026-03-29'); // clocks go forward: 23 hours
    assert.equal((e2 - s2) / 3600e3, 23);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

// ---------------------------------------------------------------- IPv6 on the phone listener (direct bind)
test('IP parser: IPv4, IPv6 (::, zone ids, IPv4 tail), CIDRs; anything else is refused', async () => {
  const net = await import('node:net');
  const { parseIp, parseCidr, inCidr, formatIp } = await import('../server/ip.js');
  const canon = { '::': '::', '::1': '::1', '1::': '1::', 'FD7A:115C:A1E0:0:0:0:0:1': 'fd7a:115c:a1e0::1', '2001:0db8:0000:0000:0000:ff00:0042:8329': '2001:db8::ff00:42:8329', '2001:db8:0:0:1:0:0:1': '2001:db8::1:0:0:1', '1:2:3:4:5:6:7:8': '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::': '1:2:3:4:5:6:7:0', '::2:3:4:5:6:7:8': '0:2:3:4:5:6:7:8', '1:0:0:2::3': '1:0:0:2::3', '0::0': '::', '64:ff9b::192.0.2.33': '64:ff9b::c000:221', '::1.2.3.4': '::102:304', '::ffff:0:1.2.3.4': '::ffff:0:102:304', '1:2:3:4:5:6:1.2.3.4': '1:2:3:4:5:6:102:304' };
  for (const [text, want] of Object.entries(canon)) {
    const a = parseIp(text);
    assert.equal(a?.v, 6, text);
    assert.equal(formatIp(a), want, text);
    assert.equal(`[${want}]`, new URL(`http://[${text}]/`).hostname, `${text}: same canonical form as the URL parser`);
  }
  // IPv4-mapped, in every spelling, comes back as the IPv4 address it stands for
  for (const text of ['::ffff:192.168.1.5', '::FFFF:c0a8:105', '0:0:0:0:0:ffff:192.168.1.5', '0000:0000:0000:0000:0000:ffff:c0a8:0105']) assert.deepEqual(parseIp(text), parseIp('192.168.1.5'), text);
  assert.equal(parseIp('192.168.1.5').v, 4);
  assert.equal(formatIp(parseIp('::ffff:192.168.1.5')), '192.168.1.5');
  // zone ids are read and kept apart from the address
  assert.deepEqual(parseIp('fe80::1%eth0'), { ...parseIp('fe80::1'), zone: 'eth0' });
  assert.equal(parseIp('fe80::1%25').zone, '25');
  const bad = ['', ' ', ':', ':::', '1:::2', '::1::', '1::2::3', ':1::2', '1::2:', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', '::1:2:3:4:5:6:7:8', '12345::', 'g::1', '::ffff:1.2.3', '::ffff:256.1.1.1', '::ffff:1.2.3.4:5', '1.2.3.4::', '::ffff:01.2.3.4', '1:2:3:4:5:6:7:1.2.3.4', '1:2:3:4:5:6:1.2.3.4:5', '[::1]', ' ::1', '::1 ', '::1/128', 'fe80::1%', 'fe80::1%eth0%1', 'fe80::1%eth 0', 'fe80::1%eth0/x', '::ffff:1.2.3.4%eth0', '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.-4', '0x1.2.3.4', '1..2.3', '1.2.3.4 ', '1.2.3.4/24', '١.٢.٣.٤', 'localhost', 'a'.repeat(100), `${'1:'.repeat(30)}1`];
  for (const text of bad) assert.equal(parseIp(text), null, JSON.stringify(text));
  for (const x of [undefined, null, 123, {}, ['::1']]) assert.equal(parseIp(x), null, String(x));
  // same verdict as Node's own parser on everything without a zone id
  for (const text of [...Object.keys(canon), ...bad, '::ffff:192.168.1.5', '0.0.0.0', '255.255.255.255']) if (!text.includes('%')) assert.equal(parseIp(text) !== null, net.isIP(text) !== 0, JSON.stringify(text));

  for (const c of ['192.168.1.0/24', '0.0.0.0/0', '1.2.3.4/32', 'fd7a:115c:a1e0::/48', '::/0', '::1/128', 'fe80::/10', '2001:db8::5/64']) assert.ok(parseCidr(c), c);
  // no prefix, prefix out of range or oddly written, zone ids, brackets, and IPv4 rules written as IPv6: all refused
  for (const c of ['192.168.1.0', '192.168.1.0/', '/24', '192.168.1.0/33', '192.168.1.0/024', 'fd7a::/129', 'fd7a::/-1', 'fd7a::/1.5', 'fd7a::/48/1', 'fe80::%eth0/10', '[fd7a::]/48', '::ffff:192.168.1.0/120', '::ffff:0:0/96', '::ffff:192.168.1.0/24', 'lan', '', undefined]) assert.equal(parseCidr(c), null, String(c));
  const inside = [['fd7a:115c:a1e0:ab12::5', 'fd7a:115c:a1e0::/48'], ['fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff', 'fd7a:115c:a1e0::/48'], ['::ffff:100.70.1.1', '100.64.0.0/10'], ['fe80::1%eth0', 'fe80::/10'], ['::', '::/0'], ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '::/0'], ['2001:db8::5', '2001:db8::5/128'], ['192.168.1.9', '192.168.1.200/24']];
  for (const [ip, c] of inside) assert.equal(inCidr(ip, c), true, `${ip} in ${c}`);
  const outside = [['fd7a:115c:a1e1::5', 'fd7a:115c:a1e0::/48'], ['fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff', 'fd7a:115c:a1e0::/48'], ['fe80::1', 'fd00::/8'], ['2001:db8::6', '2001:db8::5/128'],
    // an IPv4 peer, however it is spelled, is never matched by an IPv6 rule (and the reverse)
    ['100.70.1.1', '::/0'], ['::ffff:8.8.8.8', '::/0'], ['::ffff:808:808', '::/0'], ['::ffff:8.8.8.8', '::ffff:0:0/96'], ['2001:db8::1', '0.0.0.0/0'], ['::8.8.8.8', '8.8.8.0/24'], ['64:ff9b::8.8.8.8', '8.8.8.0/24'],
    ['nonsense', '::/0'], ['', '0.0.0.0/0'], ['1.2.3.4', 'garbage'], ['[::1]', '::/0']];
  for (const [ip, c] of outside) assert.equal(inCidr(ip, c), false, `${ip} not in ${c}`);
});

/** os.networkInterfaces() of a laptop on Wi-Fi with IPv6, Tailscale, NetBird, a macOS-style VPN tunnel and some noise. */
const IFACES6 = {
  lo: [
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' },
    { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', internal: true, cidr: '::1/128', scopeid: 0 },
  ],
  wlan0: [
    { address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.23/24' },
    { address: 'fd12:3456:789a:1::23', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, cidr: 'fd12:3456:789a:1::23/64', scopeid: 0 },
    { address: '2001:db8:1:2:aaaa:bbbb:cccc:dddd', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, scopeid: 0 },
    { address: 'fe80::1234:5678', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, cidr: 'fe80::1234:5678/64', scopeid: 3 },
  ],
  tailscale0: [
    { address: '100.101.102.103', netmask: '255.255.255.255', family: 'IPv4', internal: false },
    { address: 'fd7a:115c:a1e0::1234', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', internal: false, scopeid: 0 },
  ],
  wt0: [
    { address: '100.92.10.4', netmask: '255.255.0.0', family: 'IPv4', internal: false },
    { address: 'fd00:4e42:1::5', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, scopeid: 0 },
  ],
  // macOS: VPNs live on utunN. A Tailscale address makes the interface a VPN; a CGNAT IPv4 alone (hotspots use those
  // too) leaves its IPv6 subnet in "lan", never "vpn"
  utun4: [
    { address: '100.80.1.2', netmask: '255.255.255.255', family: 'IPv4', internal: false },
    { address: 'fd99:1:2:3::4', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, scopeid: 0 },
  ],
  utun5: [{ address: 'fd7a:115c:a1e0::77', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', internal: false, scopeid: 0 }],
  docker0: [{ address: 'fd00:dead:beef::1', netmask: 'ffff:ffff:ffff::', family: 'IPv6', internal: false, scopeid: 0 }],
  eth1: [{ address: '2001:db8:aaaa::1', netmask: 'ffff:ffff::', family: 'IPv6', internal: false, scopeid: 0 }], // a /32: too wide for "lan"
  eth2: [{ address: '2002:c000:221::1', netmask: 'ffff:ffff:ffff:ffff::', family: 6, internal: false, scopeid: 0 }], // 6to4 (Node 18.0 spells family as a number)
  teredo: [{ address: '2001:0:53aa:64c:1c:2a3f:ad5c:fe12', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, scopeid: 0 }],
  eth3: [{ address: 'fd55::1', netmask: 'ffff:0:ffff::', family: 'IPv6', internal: false, scopeid: 0 }], // not a prefix mask
  eth4: [{ address: 'fec0::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, scopeid: 0 }], // deprecated site-local
};

test('phone allow-list over IPv6: lan/vpn ranges and CIDRs; link-local only when listed; ::ffff: never bypasses IPv4 rules', async () => {
  const { allowListFor, addressAllowed, localAddresses, lanConnectionAllowed } = await import('../server/net.js');
  const sorted = (xs) => [...xs].sort();
  const loop = ['127.0.0.0/8', '::1/128'];
  const lan = ['192.168.1.0/24', 'fd12:3456:789a:1::/64', '2001:db8:1:2::/64', 'fd99:1:2:3::/64'];
  const vpn = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48', '100.101.102.103/32', 'fd7a:115c:a1e0::1234/128', '100.92.0.0/16', 'fd00:4e42:1::/64', '100.80.1.2/32', 'fd7a:115c:a1e0::77/128'];
  assert.deepEqual(sorted(allowListFor(undefined, IFACES6)), sorted([...loop, ...lan, ...vpn]));
  assert.deepEqual(sorted(allowListFor('LAN', IFACES6)), sorted([...loop, ...lan]));
  assert.deepEqual(sorted(allowListFor('vpn', IFACES6)), sorted([...loop, ...vpn]));
  // the address list phones see (URLs, QR codes) stays IPv4
  assert.deepEqual(localAddresses(IFACES6).map((a) => a.ip).sort(), ['100.101.102.103', '100.80.1.2', '100.92.10.4', '192.168.1.23']);
  // typos and unparseable entries add nothing
  assert.deepEqual(sorted(allowListFor('lan6, fd7a::/129, 2001:db8::/33/1, *, 0/0, fe80::%wlan0/10, ::ffff:0:0/96', IFACES6)), sorted(loop));

  const check = (spec, yes, no) => {
    const list = allowListFor(spec, IFACES6);
    for (const ip of yes) assert.equal(addressAllowed(ip, list), true, `${spec}: ${ip} allowed`);
    for (const ip of no) assert.equal(addressAllowed(ip, list), false, `${spec}: ${ip} refused`);
  };
  const always = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  const never = ['fe80::1', 'fe80::1%wlan0', 'fe80::1234:5678%3', '2001:4860:4860::8888', '2001:db8:aaaa::2', 'fd00:dead:beef::2', '2002:c000:221::2', '2001:0:53aa:64c::1', 'fec0::2', '::', '::ffff:8.8.8.8', '::ffff:808:808', '0:0:0:0:0:ffff:8.8.8.8', '::ffff:0:8.8.8.8', '64:ff9b::8.8.8.8', '::8.8.8.8', '8.8.8.8', '', 'nonsense', undefined, null, '[fd12:3456:789a:1::99]', 'fd12:3456:789a:1::99 ', 'fd12:3456:789a:1::99%'];
  const lanPeers = ['192.168.1.50', '::ffff:192.168.1.50', '::ffff:c0a8:132', 'fd12:3456:789a:1::99', 'fd12:3456:789a:1:ffff:ffff:ffff:ffff', '2001:db8:1:2::77', 'fd99:1:2:3::9'];
  const vpnPeers = ['100.70.1.1', '::ffff:100.70.1.1', 'fd7a:115c:a1e0:ab12:4843:cd96:625b:e016', 'fd00:4e42:1::9'];
  check('lan,vpn', [...always, ...lanPeers, ...vpnPeers], [...never, 'fd12:3456:789a:2::1', '2001:db8:1:3::1']);
  check('lan', [...always, ...lanPeers], [...never, ...vpnPeers]);
  check('vpn', [...always, ...vpnPeers], [...never, ...lanPeers]);
  // link-local only when listed explicitly; explicit IPv6 CIDRs mix with keywords and IPv4 CIDRs
  check('vpn,fe80::/10,192.168.7.0/24,2001:db8:1:2::/64', ['fe80::1', 'fe80::1%wlan0', '192.168.7.9', '::ffff:192.168.7.9', '2001:db8:1:2::77', 'fd7a:115c:a1e0::5'], ['192.168.1.50', 'fd12:3456:789a:1::99', '::ffff:8.8.8.8']);
  // "all of IPv6" lets in every IPv6 peer but not one IPv4 peer, however it is spelled
  check('::/0', ['2001:4860:4860::8888', 'fd12:3456:789a:1::99', 'fe80::1%wlan0', '::'], ['::ffff:8.8.8.8', '::ffff:808:808', '0:0:0:0:0:ffff:192.168.1.50', '::ffff:192.168.1.50', '192.168.1.50']);
  // an IPv4 rule written in IPv6 form is ignored, never turned into "every IPv4 peer"
  check('::ffff:0:0/96,::ffff:192.168.1.0/120,::ffff:192.168.1.0/24', always, ['::ffff:192.168.1.50', '192.168.1.50', '::ffff:8.8.8.8']);

  // the live gate reads PILOTAGE_LAN_ALLOW and this machine's interfaces (documentation and example prefixes below,
  // so whatever the machine running the tests is on can't change the outcome)
  process.env.PILOTAGE_LAN_ALLOW = 'vpn,fd12:3456:789a:1::/64,192.168.7.0/24';
  for (const ip of ['fd12:3456:789a:1::99', 'fd7a:115c:a1e0::5', '::ffff:192.168.7.9', '192.168.7.9', '::1']) assert.equal(lanConnectionAllowed(ip), true, ip);
  for (const ip of ['fd12:3456:789a:2::1', '2001:db8::1', 'fe80::1%eth0', '::ffff:192.168.8.1', '::ffff:0:192.168.7.9', 'nonsense', '']) assert.equal(lanConnectionAllowed(ip), false, ip);
});

test('host allow-list on the phone listener: IPv6 literals in brackets, never names or zone ids', () => {
  for (const h of ['[fd7a:115c:a1e0::1]:4748', '[fd7a:115c:a1e0::1]', '[2001:DB8::1]:4748', '[::ffff:192.168.1.50]:4748', '[::1]:4748']) assert.equal(hostAllowed(h, true), true, h);
  for (const h of ['fd7a:115c:a1e0::1', 'fd7a::1:4748', '[fd7a::1', '[fd7a::1]x', '[fd7a::1]:', '[fd7a::1]:4748:1', '[fe80::1%25eth0]:4748', '[fe80::1%eth0]', '[localhost]:4748', '[evil.com]:4748', '[1.2.3.4]:4748', '[]:4748', 'localhost:4748', 'pilotage.localhost:4748']) assert.equal(hostAllowed(h, true), false, h);
  // the PC listener still takes loopback only
  assert.equal(hostAllowed('[::1]:4747', false), true);
  for (const h of ['[fd7a:115c:a1e0::1]:4747', '[::1]x', '[localhost]:4747', '[::ffff:127.0.0.1]:4747']) assert.equal(hostAllowed(h, false), false, h);
});

test('a malformed but successful AI reply is repaired, not retried forever as a paid call', async () => {
  const { sanitizeDigest } = await import('../server/ai/engine.js');
  const d = sanitizeDigest({ title: 'Fix login', summary: 's', highlights: 'Shipped the fix', who: 'you' });
  assert.deepEqual(d.highlights, ['Shipped the fix']);
  assert.deepEqual(sanitizeDigest({ highlights: { a: 1 } }).highlights, []);
  assert.deepEqual(sanitizeDigest(null).highlights, []);
});

test('a transcript folder that is unreadable for a moment keeps its sessions (no drop, no full re-parse)', { skip: process.getuid?.() === 0 && 'root reads anything' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-eio-'));
  const proj = path.join(home, '.claude', 'projects', '-home-alex-demo');
  fs.mkdirSync(proj, { recursive: true });
  const id = '33333333-4444-4555-8666-777777777777';
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), line({ isSidechain: false, cwd: '/home/alex/demo', sessionId: id, entrypoint: 'cli', type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Ship it' }, timestamp: '2026-11-01T10:00:00.000Z' }));
  const url = JSON.stringify(new URL('../server/sources/sessions.js', import.meta.url).href);
  const cfg = JSON.stringify(new URL('../server/config.js', import.meta.url).href);
  const script = `const c = await import(${cfg}); c.ensureDirs(); const { SessionIndex } = await import(${url});
    const ix = new SessionIndex(); ix.adapters = [];
    await ix.scan(); const a = ix.list().length;
    const fs = await import('node:fs'); fs.chmodSync(${JSON.stringify(proj)}, 0);
    await ix.scan(); const b = ix.list().length;
    fs.chmodSync(${JSON.stringify(proj)}, 0o755);
    const before = ix.get(${JSON.stringify(id)})?.offset; await ix.scan();
    console.log(JSON.stringify([a, b, ix.list().length, before === ix.get(${JSON.stringify(id)})?.offset]));`;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, PILOTAGE_DATA: path.join(home, 'data'), PILOTAGE_WSL: '0' }, encoding: 'utf8' }).trim();
    const [a, b, c, sameOffset] = JSON.parse(out.split('\n').pop());
    assert.equal(a, 1);
    assert.equal(b, 1, 'the session vanished while its folder could not be read');
    assert.equal(c, 1);
    assert.equal(sameOffset, true, 'no full re-parse afterwards');
  } finally {
    fs.chmodSync(proj, 0o755);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a prompt with several screenshots (a line over 6 MB) is indexed, and each reply stays on its own prompt', async () => {
  const { SessionIndex } = await import('../server/sources/sessions.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-images-'));
  const id = '44444444-5555-4666-8777-888888888888';
  const f = path.join(dir, `${id}.jsonl`);
  const base = { isSidechain: false, cwd: '/home/alex/demo', sessionId: id, entrypoint: 'cli' };
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo' + 'A'.repeat(2_300_000) } };
  let s = line({ ...base, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'First small prompt' }, timestamp: '2026-11-01T10:00:00.000Z' });
  s += line({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer one' }] }, timestamp: '2026-11-01T10:00:05.000Z' });
  s += line({ ...base, type: 'user', turnOrigin: 'human', message: { role: 'user', content: [{ type: 'text', text: 'Fix the layout shown in these screenshots' }, img, img, img] }, timestamp: '2026-11-01T10:05:00.000Z' });
  s += line({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed the layout' }] }, timestamp: '2026-11-01T10:06:00.000Z' });
  fs.writeFileSync(f, s);
  const st = fs.statSync(f);
  const ix = new SessionIndex();
  await ix.indexFile({ id, file: f, src: { id: 'test', mapCwd: (p) => p }, projectKey: 'k', size: st.size, mtimeMs: st.mtimeMs });
  const turns = ix.loadTurns(id);
  assert.equal(turns.length, 2, 'the screenshot prompt is a turn');
  assert.match(turns[1].p, /Fix the layout/);
  assert.equal(turns[1].a, 'Fixed the layout');
  assert.equal(turns[0].a, 'Answer one', 'the first reply is not overwritten');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redaction: JWTs after URL escapes, curl -u anywhere on the line, and no slow separators', async () => {
  const { redact } = await import('../server/util.js');
  const jwt = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.ok(!redact(`https://app.example/cb#id_token%3D${jwt}&state=x`).includes('dozjgNryP4J3'), 'URL-encoded id_token');
  assert.ok(!redact(`{"t":"\\u003d${jwt}"}`).includes('dozjgNryP4J3'));
  const curl = `curl -X POST https://api.example/v1 -H 'Content-Type: application/json' -d '${JSON.stringify({ q: 'x'.repeat(400) })}' -u admin:` + 'hunter2pass';
  assert.ok(!redact(curl).includes('hunter2pass'), '-u far into a long curl line');
  const slow = 'a-'.repeat(20) + 'pwd'.repeat(13) + '=' + ' '.repeat(1_000_000);
  const t0 = performance.now();
  redact(slow);
  assert.ok(performance.now() - t0 < 400, 'spaces after a secret-sounding key stay fast');
});
