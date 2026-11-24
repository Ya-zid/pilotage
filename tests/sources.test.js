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
