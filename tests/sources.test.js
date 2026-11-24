// Session sources and project discovery on a fake HOME (server/sources/sessions.js, projects.js, git.js).
// config.js reads HOME and the Windows profile once, at import, so each test runs its script in a child node with its
// own HOME, PILOTAGE_DATA and either PILOTAGE_WSL=0 or a temp PILOTAGE_WIN_HOME: the real ~/.claude and the real
// Windows profile are never read. All fixtures live in temp folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const mod = (p) => JSON.stringify(new URL(`../server/${p}`, import.meta.url).href);
const line = (o) => JSON.stringify(o) + '\n';

/** Run an ES module script in a child node; returns the JSON printed on its last line. */
function runIn(env, script) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1', GIT_CONFIG_NOSYSTEM: '1', ...env },
    encoding: 'utf8',
  }).trim();
  return JSON.parse(out.split('\n').pop());
}

function tempHome(name) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `pilotage-${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  return { base, home, data: path.join(base, 'data') };
}

test('a transcript reachable through two source folders (symlinked ~/.claude) is parsed once, and its history merged once', () => {
  const { base, home, data } = tempHome('alias');
  const win = path.join(base, 'win');
  const proj = path.join(win, '.claude', 'projects', '-home-alex-demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.symlinkSync(path.join(win, '.claude'), path.join(home, '.claude')); // ~/.claude -> the Windows profile's .claude
  const id = '55555555-6666-4777-8888-999999999999';
  const winId = '55555555-6666-4777-8888-aaaaaaaaaaaa';
  const file = path.join(proj, `${id}.jsonl`);
  const base0 = { isSidechain: false, cwd: '/home/alex/demo', sessionId: id, entrypoint: 'cli' };
  fs.writeFileSync(file, line({ ...base0, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Ship it' }, timestamp: '2026-11-01T10:00:00.000Z' }) + line({ ...base0, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200_000) }] }, timestamp: '2026-11-01T10:01:00.000Z' }));
  // Written by Claude Code on Windows into the same folder: its cwd still maps to the WSL mount.
  fs.writeFileSync(path.join(proj, `${winId}.jsonl`), line({ ...base0, cwd: 'C:\\Users\\alex\\demo', sessionId: winId, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Windows task' }, timestamp: '2026-11-01T09:00:00.000Z' }));
  fs.writeFileSync(path.join(win, '.claude', 'history.jsonl'), line({ display: 'Ship it', timestamp: Date.parse('2026-11-01T10:00:00.000Z'), project: '/home/alex/demo', sessionId: 'gone-session' }));
  const append = line({ ...base0, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'One more thing' }, timestamp: '2026-11-01T11:00:00.000Z' });
  const script = `const c = await import(${mod('config.js')}); c.ensureDirs(); const { SessionIndex } = await import(${mod('sources/sessions.js')});
    const fs = await import('node:fs');
    const ix = new SessionIndex(); ix.adapters = [];
    const parsed = [];
    const orig = ix.indexFile.bind(ix);
    ix.indexFile = (f) => { const m = ix.meta.get(f.id); parsed.push(m && m.file === f.file ? f.size - m.offset : f.size); return orig(f); };
    await ix.scan();
    const first = parsed.splice(0);
    fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(append)});
    await ix.scan();
    const second = parsed.splice(0);
    await ix.scan();
    console.log(JSON.stringify({ first, second, third: parsed, sessions: ix.list().length, turns: ix.loadTurns(${JSON.stringify(id)}).length,
      winCwd: ix.get(${JSON.stringify(winId)})?.cwd, history: ix.history.get('gone-session')?.prompts.length, sources: ix.allSources().length }));`;
  try {
    const r = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '1', PILOTAGE_WIN_HOME: win }, script);
    assert.equal(r.sources, 1, `one source for one real folder (${JSON.stringify(r)})`);
    assert.equal(r.first.length, 2, `first scan parses each transcript once (${r.first})`);
    assert.deepEqual(r.second, [Buffer.byteLength(append)], 'an append parses only the appended bytes');
    assert.deepEqual(r.third, [], 'nothing changed, nothing parsed');
    assert.equal(r.sessions, 3, `two transcripts and one history-only session`);
    assert.equal(r.turns, 2);
    assert.equal(r.winCwd, '/mnt/c/Users/alex/demo', 'Windows paths still map to the WSL mount');
    assert.equal(r.history, 1, 'history.jsonl merged once');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('PATCH /api/harnesses refuses a link to a Claude folder already indexed, and keeps one of two aliases', () => {
  const { base, home, data } = tempHome('alias-patch');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, 'work', '.claude', 'projects'), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude'), path.join(home, 'claude-link'));
  fs.symlinkSync(path.join(home, 'work', '.claude'), path.join(home, 'work-link'));
  const script = `const c = await import(${mod('config.js')}); c.ensureDirs();
    const { getStore } = await import(${mod('store.js')}); const routes = (await import(${mod('routes/providers.js')})).default;
    const h = {}; const out = {};
    routes({ route: (m, p, fn) => (h[m + ' ' + p] = fn), ctx: { store: getStore(), json: (res, body, status = 200) => Object.assign(out, { body, status }),
      fail: (res, status, error) => Object.assign(out, { body: { error }, status }), broadcast() {}, log: { warn() {} },
      index: { list: () => [], adapters: [], allSources: () => [], scan: async () => [] }, registry: { rebuild: async () => {} } } });
    const r = [];
    await h['PATCH /api/harnesses'](null, null, { body: { extraClaudeDirs: [${JSON.stringify(path.join(home, 'claude-link'))}] } });
    r.push([out.status, out.body.error || null]);
    await h['PATCH /api/harnesses'](null, null, { body: { extraClaudeDirs: [${JSON.stringify(path.join(home, 'work', '.claude'))}, ${JSON.stringify(path.join(home, 'work-link'))}] } });
    r.push([out.status, getStore().settings.sources.extraClaudeDirs]);
    console.log(JSON.stringify(r));`;
  try {
    const [link, aliases] = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, script);
    assert.equal(link[0], 400, `a link to ~/.claude is refused (${JSON.stringify(link)})`);
    assert.match(link[1], /already indexed/);
    assert.deepEqual(aliases, [200, [path.join(home, 'work', '.claude')]], 'two paths to one folder are kept once');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** A ProjectRegistry over fake sessions [{id, cwd}], in a child node with its own HOME. Prints rebuild() results. */
const registryScript = (steps) => `const c = await import(${mod('config.js')}); c.ensureDirs();
  const { ProjectRegistry } = await import(${mod('sources/projects.js')});
  const { execFileSync } = await import('node:child_process');
  const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  const metas = new Map();
  const index = { list: () => [...metas.values()], get: (id) => metas.get(id) || null, isInternal: () => false };
  const store = { settings: { scan: { hiddenPaths: [], extraRoots: [], depth: 3 } }, project: () => ({}), data: { workspaces: {} } };
  const session = (id, cwd) => metas.set(id, { id, cwd, startedAt: 1, lastAt: 2, counts: { h: 1 } });
  const projects = async (reg = new ProjectRegistry(index, store)) => Object.fromEntries([...(await reg.rebuild()).values()].map((p) => [p.path, { git: p.isGit, sessions: p.sessionIds.sort(), worktrees: [...p.worktrees.keys()] }]));
  const out = [];
  ${steps}
  console.log(JSON.stringify(out));`;

test('sessions of a removed worktree outside the repo stay in the repo project', () => {
  const { base, home, data } = tempHome('wt-gone');
  const repo = path.join(home, 'repo');
  const feat = path.join(home, 'repo-feat');
  const steps = `
    const repo = ${JSON.stringify(repo)}, feat = ${JSON.stringify(feat)};
    (await import('node:fs')).mkdirSync(repo);
    git(repo, 'init', '-q'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', feat);
    session('a', repo); session('b', feat); session('c', feat + '/server');
    const reg = new ProjectRegistry(index, store);
    out.push(await projects(reg));
    git(repo, 'worktree', 'remove', feat);
    out.push(await projects(reg));
    out.push(await projects()); // after a restart`;
  try {
    const [before, after, restarted] = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, registryScript(steps));
    assert.deepEqual(before[repo], { git: true, sessions: ['a', 'b', 'c'], worktrees: [feat] });
    for (const r of [after, restarted]) {
      assert.equal(r[feat], undefined, `no phantom project for the removed worktree (${JSON.stringify(r)})`);
      assert.deepEqual(r[repo], { git: true, sessions: ['a', 'b', 'c'], worktrees: [] });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a worktree made by Git for Windows (gitdir: C:/...) belongs to its repo under /mnt/c on WSL', () => {
  const { base, home, data } = tempHome('wt-win');
  const wt = path.join(home, 'feature');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: C:/Users/alex/repo/.git/worktrees/feature\n');
  const script = `const { gitKind } = await import(${mod('sources/git.js')}); console.log(JSON.stringify(gitKind(${JSON.stringify(wt)})));`;
  try {
    const win = path.join(base, 'win');
    fs.mkdirSync(win);
    const onWsl = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '1', PILOTAGE_WIN_HOME: win }, script);
    assert.equal(onWsl?.kind, 'worktree', JSON.stringify(onWsl));
    assert.equal(onWsl.mainRoot, '/mnt/c/Users/alex/repo', `main repo on the Windows drive (${onWsl.mainRoot})`);
    assert.equal(onWsl.gitdir, '/mnt/c/Users/alex/repo/.git/worktrees/feature');
    const plain = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, script);
    assert.ok(!String(plain?.mainRoot).startsWith('/mnt/'), 'no drive letters outside WSL: nothing is mapped');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktrees of a bare repo (proj/.bare + proj/main, proj/feat) belong to one project', () => {
  const { base, home, data } = tempHome('wt-bare');
  const proj = path.join(home, 'proj');
  const steps = `
    const fs = await import('node:fs'); const { gitKind } = await import(${mod('sources/git.js')});
    const home = ${JSON.stringify(home)}, proj = ${JSON.stringify(proj)};
    fs.mkdirSync(home + '/src'); git(home + '/src', 'init', '-q'); git(home + '/src', 'commit', '-q', '--allow-empty', '-m', 'first');
    git(home, 'clone', '-q', '--bare', home + '/src', proj + '/.bare');
    fs.writeFileSync(proj + '/.git', 'gitdir: ./.bare\\n');
    git(proj, 'worktree', 'add', '-q', '-b', 'main', 'main');
    git(proj, 'worktree', 'add', '-q', '-b', 'feat', 'feat');
    out.push(gitKind(proj + '/main'), gitKind(proj + '/feat'));
    session('m', proj + '/main'); session('f', proj + '/feat/web');
    out.push(await projects());`;
  try {
    const [main, feat, projects] = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, registryScript(steps));
    for (const k of [main, feat]) assert.deepEqual([k?.kind, k?.mainRoot], ['worktree', proj], `${JSON.stringify(k)} ${JSON.stringify(projects)}`);
    assert.equal(projects[path.join(proj, 'main')], undefined, `no project per worktree (${JSON.stringify(projects)})`);
    assert.equal(projects[path.join(proj, 'feat', 'web')], undefined);
    assert.deepEqual(projects[proj]?.sessions, ['f', 'm']);
    assert.deepEqual(projects[proj].worktrees.sort(), [path.join(proj, 'feat'), path.join(proj, 'main')]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a folder of 400+ repos is walked (projects and Gemini folders), a generated folder of 400+ dirs still is not', () => {
  const { base, home, data } = tempHome('bigdir');
  for (let i = 0; i < 401; i++) fs.mkdirSync(path.join(home, 'code', `repo-${i}`, '.git'), { recursive: true });
  for (let i = 0; i < 401; i++) fs.mkdirSync(path.join(home, 'gen', `concept-${i}`), { recursive: true });
  fs.mkdirSync(path.join(home, 'gen', 'concept-7', 'inner', '.git'), { recursive: true });
  const script = `const c = await import(${mod('config.js')}); c.ensureDirs();
    const { ProjectRegistry } = await import(${mod('sources/projects.js')}); const { geminiAdapter } = await import(${mod('sources/harness/gemini.js')});
    const crypto = await import('node:crypto'); const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const reg = new ProjectRegistry({ list: () => [] }, { settings: { scan: { hiddenPaths: [], extraRoots: [], depth: 3 } } });
    await reg.scanFs();
    await geminiAdapter.resolver.walk();
    console.log(JSON.stringify({ repos: reg.scanned.filter((p) => p.includes('/code/repo-')).length, generated: reg.scanned.filter((p) => p.includes('/gen/')),
      gemini: !!(await geminiAdapter.resolver.resolve(sha(${JSON.stringify(path.join(home, 'code', 'repo-123'))}))) }));`;
  try {
    const r = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, script);
    assert.equal(r.repos, 401, `repos found in ~/code (${JSON.stringify(r)})`);
    assert.equal(r.gemini, true, 'Gemini chats in ~/code/repo-123 find their folder');
    assert.deepEqual(r.generated, [], 'a folder of 401 plain dirs is still skipped');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('on macOS the home walk stays out of ~/Library, ~/Pictures, ~/Music, ~/Movies (privacy prompts)', () => {
  const { base, home, data } = tempHome('mac');
  const off = ['Library/Containers/x', 'Library/Group Containers/y', 'Pictures/p', 'Music/Music', 'Movies/m', 'Applications/a', 'Public/s'];
  for (const p of off) fs.mkdirSync(path.join(home, p, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, 'code', 'Library', '.git'), { recursive: true }); // a project of that name elsewhere is kept
  fs.mkdirSync(path.join(home, 'code', 'app', '.git'), { recursive: true });
  const script = (platform) => `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const c = await import(${mod('config.js')}); c.ensureDirs();
    const fsp = await import('node:fs/promises'); const read = fsp.readdir; const visited = new Set();
    fsp.default.readdir = (d, o) => { visited.add(String(d)); return read(d, o); };
    const { ProjectRegistry } = await import(${mod('sources/projects.js')}); const { geminiAdapter } = await import(${mod('sources/harness/gemini.js')});
    const reg = new ProjectRegistry({ list: () => [] }, { settings: { scan: { hiddenPaths: [], extraRoots: [], depth: 3 } } });
    await reg.scanFs(); await geminiAdapter.resolver.walk();
    const home = ${JSON.stringify(home)};
    console.log(JSON.stringify({ scanned: reg.scanned.map((p) => p.slice(home.length + 1)).sort(), entered: [...visited].filter((d) => /^(Library|Pictures|Music|Movies|Applications|Public)(\\/|$)/.test(d.slice(home.length + 1))) }));`;
  try {
    const mac = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, script('darwin'));
    assert.deepEqual(mac.entered, [], `macOS: no readdir inside those folders (${JSON.stringify(mac)})`);
    assert.deepEqual(mac.scanned, ['code/Library', 'code/app']);
    const linux = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, script('linux'));
    assert.ok(linux.scanned.includes('Pictures/p'), 'Linux keeps walking them');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('token usage: an index from before it was counted fills in without re-parsing turns; later appends count once', () => {
  const { base, home, data } = tempHome('usage');
  const proj = path.join(home, '.claude', 'projects', '-home-alex-demo');
  fs.mkdirSync(proj, { recursive: true });
  const id = '77777777-6666-4777-8888-999999999999';
  const file = path.join(proj, `${id}.jsonl`);
  const b = { isSidechain: false, cwd: '/home/alex/demo', sessionId: id, entrypoint: 'cli' };
  const u = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  const a = (mid, usage, ts) => line({ ...b, type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage }, timestamp: ts });
  fs.writeFileSync(file, line({ ...b, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Go' }, timestamp: '2026-11-01T10:00:00.000Z' }) + a('msg_1', u(100, 10), '2026-11-01T10:00:01.000Z') + a('msg_1', u(100, 10), '2026-11-01T10:00:02.000Z'));
  // The same message continues in the next write (it grew), then a new prompt and message; then msg_2 repeats.
  const append1 = a('msg_1', u(100, 30), '2026-11-01T10:00:03.000Z') + line({ ...b, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'More' }, timestamp: '2026-11-01T10:05:00.000Z' }) + a('msg_2', u(50, 5), '2026-11-01T10:05:01.000Z');
  const append2 = a('msg_2', u(50, 5), '2026-11-01T10:05:02.000Z');
  const script = `const c = await import(${mod('config.js')}); c.ensureDirs(); const { SessionIndex } = await import(${mod('sources/sessions.js')});
    const fs = await import('node:fs');
    const id = ${JSON.stringify(id)}; const file = ${JSON.stringify(file)};
    const strip = (m) => { delete m.usage; delete m.usageDays; delete m.usageMsg; m.outTokens = 999; };
    const fresh = () => { const ix = new SessionIndex(); ix.adapters = []; ix.parsed = []; const orig = ix.indexFile.bind(ix); ix.indexFile = (f) => (ix.parsed.push(f.id), orig(f)); return ix; };
    const ix = fresh();
    await ix.scan();
    const first = ix.get(id).usage;
    // An index file written by an older version: no usage fields, and the outTokens it counted once per line.
    const saved = JSON.parse(fs.readFileSync(c.paths.index, 'utf8'));
    for (const s of saved.sessions) strip(s);
    fs.writeFileSync(c.paths.index, JSON.stringify(saved));
    const turnsBefore = fs.readFileSync(ix.turnsFile(id), 'utf8');
    const ix2 = fresh();
    const pending = ix2.usagePending();
    await ix2.scan();
    const filled = { usage: ix2.get(id).usage, outTokens: ix2.get(id).outTokens, parsed: ix2.parsed.length, pending: ix2.usagePending(), turnsSame: fs.readFileSync(ix2.turnsFile(id), 'utf8') === turnsBefore };
    const savedAfter = JSON.parse(fs.readFileSync(c.paths.index, 'utf8')).sessions[0].usage;
    // An old entry that grows before the backfill reached it: the indexed part is counted first, then the new lines.
    strip(ix2.meta.get(id));
    fs.appendFileSync(file, ${JSON.stringify(append1)});
    await ix2.scan();
    const grown = { ...ix2.get(id).usage };
    fs.appendFileSync(file, ${JSON.stringify(append2)});
    await ix2.scan();
    console.log(JSON.stringify({ first, pending, filled, savedAfter, grown, again: ix2.get(id).usage, outTokens: ix2.get(id).outTokens, turns: ix2.loadTurns(id).length }));`;
  try {
    const r = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, script);
    assert.deepEqual(r.first, { in: 100, out: 10, cw: 0, cr: 0 });
    assert.equal(r.pending, 1, 'the old entry waits for its count');
    assert.deepEqual(r.filled, { usage: { in: 100, out: 10, cw: 0, cr: 0 }, outTokens: 10, parsed: 0, pending: 0, turnsSame: true }, 'filled in by the backfill, turns not re-parsed');
    assert.deepEqual(r.savedAfter, { in: 100, out: 10, cw: 0, cr: 0 }, 'and saved in the index');
    assert.deepEqual(r.grown, { in: 150, out: 35, cw: 0, cr: 0 }, 'msg_1 grew from 10 to 30 output tokens; msg_2 is new');
    assert.deepEqual(r.again, { in: 150, out: 35, cw: 0, cr: 0 }, 'a repeated line of msg_2 in a later write counts once');
    assert.equal(r.outTokens, 35);
    assert.equal(r.turns, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a live Codex session and a growing history.jsonl are read from where the last scan stopped, and their writes wait', () => {
  const { base, home, data } = tempHome('appends');
  const proj = path.join(home, '.claude', 'projects', '-home-alex-demo');
  fs.mkdirSync(proj, { recursive: true });
  const id = '66666666-7777-4888-9999-aaaaaaaaaaaa';
  const cl = { isSidechain: false, cwd: '/home/alex/demo', sessionId: id, entrypoint: 'cli' };
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), line({ ...cl, type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Ship it' }, timestamp: '2026-11-01T10:00:00.000Z' }));
  const history = path.join(home, '.claude', 'history.jsonl');
  const hist = (sessionId, display, ts) => line({ display, timestamp: Date.parse(ts), project: '/home/alex/demo', sessionId });
  fs.writeFileSync(history, hist(id, 'Ship it', '2026-11-01T10:00:00.000Z') + hist('gone-1', 'Old work', '2026-10-01T10:00:00.000Z'));
  const uuid = '019aa7b0-dec5-72c1-b8c7-d3a780256999';
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-11-01T10-00-00-${uuid}.jsonl`);
  const T = (m) => `2026-11-01T11:${String(m).padStart(2, '0')}:00.000Z`;
  const ask = (m, text) => line({ timestamp: T(m), type: 'event_msg', payload: { type: 'user_message', message: text, images: [] } }) +
    line({ timestamp: T(m), type: 'turn_context', payload: { cwd: '/home/alex/demo', model: 'gpt-5.1-codex' } }) +
    line({ timestamp: T(m), type: 'response_item', payload: { type: 'custom_tool_call', call_id: `c${m}`, name: 'apply_patch', input: `*** Begin Patch\n*** Add File: src/f${m}.js\n+x\n*** End Patch` } }) +
    line({ timestamp: T(m), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Done ${m}` }] } });
  fs.writeFileSync(rollout, line({ timestamp: T(0), type: 'session_meta', payload: { id: uuid, cwd: '/home/alex/demo', cli_version: '0.58.0', source: 'exec' } }) + ask(0, 'x'.repeat(100_000)));
  const script = `const c = await import(${mod('config.js')}); c.ensureDirs();
    const { SessionIndex } = await import(${mod('sources/sessions.js')});
    const { parseCodexFile } = await import(${mod('sources/harness/codex.js')});
    const fs = await import('node:fs'); const fsp = (await import('node:fs/promises')).default;
    const read = new Map(); // file -> bytes read
    const open = fsp.open;
    fsp.open = async (...a) => { const fh = await open(...a); const r = fh.read.bind(fh); fh.read = async (...x) => { const res = await r(...x); read.set(String(a[0]), (read.get(String(a[0])) || 0) + res.bytesRead); return res; }; return fh; };
    const rf = fsp.readFile;
    fsp.readFile = async (f, ...x) => { const b = await rf(f, ...x); read.set(String(f), (read.get(String(f)) || 0) + b.length); return b; };
    const ix = new SessionIndex();
    await ix.scan();
    const calls = { flush: 0, scheduleFlush: 0 };
    const flush = ix.flush.bind(ix); ix.flush = () => (calls.flush++, flush());
    const sched = ix.scheduleFlush.bind(ix); ix.scheduleFlush = () => (calls.scheduleFlush++, sched());
    const steps = [];
    const asks = ${JSON.stringify([1, 2, 3].map((m) => ask(m, `Step ${m}`)))};
    const hists = ${JSON.stringify([1, 2, 3].map((m) => hist(id, `Step ${m}`, T(m))))};
    for (let i = 0; i < 3; i++) {
      read.clear();
      fs.appendFileSync(${JSON.stringify(rollout)}, asks[i]);
      fs.appendFileSync(${JSON.stringify(history)}, hists[i]);
      const changed = await ix.scan();
      steps.push({ changed, structural: ix.lastScan.structural, rollout: read.get(${JSON.stringify(rollout)}) || 0, history: read.get(${JSON.stringify(history)}) || 0,
        appended: [Buffer.byteLength(asks[i]), Buffer.byteLength(hists[i])] });
    }
    const callsAfter = { ...calls };
    const codexId = 'codex-${uuid}';
    const fresh = await parseCodexFile(${JSON.stringify(rollout)}, codexId);
    const m = ix.get(codexId);
    const same = JSON.stringify([m.counts, m.tools, m.files, m.offset, m.size, m.turnCount, m.lastPrompt]) === JSON.stringify([fresh.meta.counts, fresh.meta.tools, fresh.meta.files, fresh.meta.offset, fresh.meta.size, fresh.meta.turnCount, fresh.meta.lastPrompt]);
    const turnsSame = JSON.stringify(ix.loadTurns(codexId)) === JSON.stringify(fresh.turns);
    const onDisk = JSON.parse(fs.readFileSync(ix.turnsFile(codexId), 'utf8')).length;
    // A history line for a session that has no transcript is a new session: structural.
    fs.appendFileSync(${JSON.stringify(history)}, ${JSON.stringify(hist('gone-2', 'Lost transcript', '2026-11-01T12:00:00.000Z'))});
    const gone = await ix.scan();
    const goneStructural = ix.lastScan.structural;
    await ix.flush();
    console.log(JSON.stringify({ calls: callsAfter, steps, same, turnsSame, onDisk, after: JSON.parse(fs.readFileSync(ix.turnsFile(codexId), 'utf8')).length,
      gone, goneStructural, listed: ix.list().map((s) => s.id).sort(), histPrompts: ix.history.get(${JSON.stringify(id)}).prompts.length, oldPrompts: ix.history.get('gone-1').prompts.length }));`;
  try {
    const r = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0', CODEX_HOME: path.join(home, '.codex') }, script);
    assert.deepEqual(r.calls, { flush: 0, scheduleFlush: 3 }, `appends never rewrite the whole index at once (${JSON.stringify(r.calls)})`);
    for (const s of r.steps) {
      assert.deepEqual(s.changed, [`codex-${uuid}`], 'only the Codex session changed (history lines of a session with a transcript show nothing new)');
      assert.equal(s.structural, false, 'no registry rebuild for appends');
      assert.equal(s.rollout, s.appended[0], `only the appended rollout bytes are read (${s.rollout} vs ${s.appended[0]})`);
      assert.ok(s.history <= s.appended[1] + 256, `only the appended history bytes are read (${s.history} vs ${s.appended[1]})`);
    }
    assert.ok(r.same && r.turnsSame, 'an incremental parse gives what a fresh one gives');
    assert.equal(r.onDisk, 1, 'turns file not rewritten on each append');
    assert.equal(r.after, 4, 'flush writes the deferred turns');
    assert.equal(r.histPrompts, 4, 'appended history prompts are merged');
    assert.equal(r.oldPrompts, 1, 'earlier history entries are kept');
    assert.deepEqual(r.gone, ['gone-2']);
    assert.equal(r.goneStructural, true, 'a new history-only session is structural');
    assert.deepEqual(r.listed, [id, `codex-${uuid}`, 'gone-1', 'gone-2'].sort());
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a forked session counts only its own work: copied turns stay with the parent in blocks, activity and totals', () => {
  const { base, home, data } = tempHome('fork');
  const demo = path.join(home, 'demo');
  fs.mkdirSync(demo);
  execFileSync('git', ['-C', demo, 'init', '-q']);
  const proj = path.join(home, '.claude', 'projects', demo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const ids = { P: '11111111-aaaa-4aaa-8aaa-000000000001', F: '11111111-aaaa-4aaa-8aaa-000000000002', Q: '11111111-aaaa-4aaa-8aaa-000000000003', G: '11111111-aaaa-4aaa-8aaa-000000000004' };
  const t0 = Date.now() - 2 * 86400e3;
  const at = (min) => new Date(t0 + min * 60e3).toISOString();
  const user = (sid, uuid, min, content, extra = {}) => line({ isSidechain: false, cwd: demo, sessionId: sid, entrypoint: 'cli', type: 'user', turnOrigin: 'human', uuid, message: { role: 'user', content }, timestamp: at(min), ...extra });
  // Each reply spent 10 input and 5 output tokens; a copied line keeps its message id and usage.
  const reply = (sid, uuid, min, text) => line({ isSidechain: false, cwd: demo, sessionId: sid, type: 'assistant', uuid, message: { id: `msg-${uuid}`, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: at(min) });
  // P: two prompts, then stopped. F = claude --resume P --fork-session: P's lines copied (uuids and times kept, the
  // session id rewritten), then its own prompt.
  const pLines = (sid) => user(sid, 'p-1', 0, 'Plan the API') + reply(sid, 'p-2', 1, 'Planned.') + user(sid, 'p-3', 5, 'Add auth') + reply(sid, 'p-4', 6, 'Auth added.');
  fs.writeFileSync(path.join(proj, `${ids.P}.jsonl`), pLines(ids.P));
  const fFile = path.join(proj, `${ids.F}.jsonl`);
  fs.writeFileSync(fFile, pLines(ids.F) + user(ids.F, 'f-1', 120, 'Try GraphQL instead') + reply(ids.F, 'f-2', 121, 'Switched.'));
  // Q was compacted; G forked it after the compaction, so G starts at Q's compact summary.
  const qTail = (sid) => user(sid, 'q-2', 30, 'Summary of the earlier work', { isCompactSummary: true }) + user(sid, 'q-3', 31, 'Continue the export') + reply(sid, 'q-4', 32, 'Exported.');
  fs.writeFileSync(path.join(proj, `${ids.Q}.jsonl`), user(ids.Q, 'q-1', 20, 'Start the export') + reply(ids.Q, 'q-1r', 21, 'Started.') + qTail(ids.Q));
  fs.writeFileSync(path.join(proj, `${ids.G}.jsonl`), qTail(ids.G) + user(ids.G, 'g-1', 200, 'Branch off to CSV') + reply(ids.G, 'g-2', 201, 'CSV done.'));
  const script = `const c = await import(${mod('config.js')}); c.ensureDirs();
    const { SessionIndex } = await import(${mod('sources/sessions.js')});
    const { ProjectRegistry } = await import(${mod('sources/projects.js')});
    const { Views, tokensOf } = await import(${mod('views.js')});
    const { computeBlocks } = await import(${mod('ai/engine.js')});
    const fs = await import('node:fs');
    const ids = ${JSON.stringify(ids)};
    const ix = new SessionIndex(); ix.adapters = [];
    await ix.scan();
    const store = { settings: { scan: { hiddenPaths: [], extraRoots: [], depth: 3 } }, project: () => ({}), session: () => ({}), data: { workspaces: {} } };
    const reg = new ProjectRegistry(ix, store);
    await reg.rebuild();
    const views = new Views({ index: ix, registry: reg, store, live: { get: () => null }, ai: { blocksOf: () => [], digestOf: () => null, state: { blocks: {}, projects: {} } }, processes: () => [] });
    const inh = (id) => { const x = ix.get(id).inherited; if (!x) return null; const { usageDays, ...rest } = x; return { ...rest, daysIn: Object.values(usageDays || {}).reduce((a, u) => a + u[0], 0) }; };
    const out = {
      inherited: Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, inh(id)])),
      blocksF: computeBlocks(ix.get(ids.F), ix.loadTurns(ids.F)).map((b) => [b.i0, b.prompts]),
      blocksG: computeBlocks(ix.get(ids.G), ix.loadTurns(ids.G)).map((b) => [b.i0, b.prompts]),
      raw: Object.values(ids).reduce((n, id) => n + ix.get(id).counts.h, 0),
      project: [...reg.projects.values()].map((p) => p.humanPrompts),
      activity: views.activityByDay(28).reduce((n, d) => n + d.prompts, 0),
      tokensRaw: Object.values(ids).reduce((n, id) => n + ix.get(id).usage.in, 0),
      perSession: Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, tokensOf(ix.get(id))?.input])),
      usage: (({ totals, projects, days }) => ({ total: totals.input, projects: projects.map((p) => p.input), days: Object.fromEntries(days.filter((d) => d.input).map((d) => [d.day, d.input])) }))(
        views.usage({ fromDay: new Date(${t0} - 86400e3).toISOString().slice(0, 10), toDay: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) })),
    };
    fs.appendFileSync(${JSON.stringify(fFile)}, ${JSON.stringify(user(ids.F, 'f-3', 130, 'And document it'))});
    out.grown = await ix.scan();
    out.grownStructural = ix.lastScan.structural;
    out.grownF = inh(ids.F);
    delete ix.get(ids.P).roots; // indexed by an older version: parsed again once
    await ix.scan();
    out.reparsed = ix.get(ids.P).roots;
    fs.rmSync(${JSON.stringify(path.join(proj, `${ids.P}.jsonl`))});
    await ix.scan();
    out.orphan = inh(ids.F);
    console.log(JSON.stringify(out));`;
  try {
    const r = runIn({ HOME: home, PILOTAGE_DATA: data, PILOTAGE_WSL: '0' }, script);
    // The copied lines' tokens too (P's two replies; Q's one after its compaction), per day as well.
    const F = { from: ids.P, n: 2, h: 2, s: 0, usage: { in: 20, out: 10, cw: 0, cr: 0 }, daysIn: 20 };
    assert.deepEqual(r.inherited, { P: null, F, Q: null, G: { from: ids.Q, n: 2, h: 1, s: 0, usage: { in: 10, out: 5, cw: 0, cr: 0 }, daysIn: 10 } }, JSON.stringify(r.inherited));
    assert.deepEqual(r.blocksF, [[2, 1]], "the fork's blocks start at its own work");
    assert.deepEqual(r.blocksG, [[2, 1]], 'also for a fork made after a compaction');
    assert.equal(r.raw, 9);
    assert.deepEqual(r.project, [6], 'the project total counts each typed prompt once');
    assert.equal(r.activity, 6, 'the timeline counts each prompt once');
    assert.equal(r.tokensRaw, 90, 'each transcript holds its copies');
    // Tokens: each reply once, per session, per project and on its own day (a fork's copies are the parent's).
    assert.deepEqual(r.perSession, { P: 20, F: 10, Q: 20, G: 10 }, "a fork's tokens are its own replies'");
    assert.equal(r.usage.total, 60, 'token totals count each reply once');
    assert.deepEqual(r.usage.projects, [60], 'the project total too');
    const day = (min) => { const d = new Date(t0 + min * 60e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const days = {};
    for (const min of [1, 6, 121, 21, 32, 201]) days[day(min)] = (days[day(min)] || 0) + 10; // P's 2, F's own 1, Q's 2, G's own 1
    assert.deepEqual(r.usage.days, days, 'and each day once');
    assert.deepEqual(r.grown, [ids.F], 'a fork that grows changes only itself');
    assert.equal(r.grownStructural, false);
    assert.deepEqual(r.grownF, F);
    assert.deepEqual(r.reparsed, ['p-1']);
    assert.equal(r.orphan, null, 'once the parent transcript is gone, the fork keeps the only copy');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
