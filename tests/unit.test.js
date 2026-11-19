import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PILOTAGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-unit-'));
const { hostAllowed } = await import('../server/auth.js');
const { parseTranscriptFile, winToWsl, normalizeCwd, toolSummary } = await import('../server/sources/sessions.js');
const { computeBlocks } = await import('../server/ai/engine.js');
const { bridgeUrl } = await import('../server/sources/live.js');
const { webUrlFromRemote } = await import('../server/sources/git.js');
const { sanitizeName } = await import('../server/launch.js');
const { shq, isInside } = await import('../server/util.js');

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
