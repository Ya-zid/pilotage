// The Map's graph (server/graph.js), built from fake index / registry / AI state / store / work data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PILOTAGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-graph-'));
const { buildGraph, foldTopic } = await import('../server/graph.js');
const { Views } = await import('../server/views.js');

const DAY = 86400e3;
const NOW = Date.UTC(2026, 10, 24, 12);
const ago = (d) => NOW - d * DAY;
const HOME = os.homedir();

function project(id, p, workspace, sessionIds, lastAt) {
  return { id, path: p, name: path.basename(p), workspace, sessionIds, lastAt, worktrees: new Map() };
}

/** A small world: two active projects in one workspace, a quiet one pulled in by an open task, a dormant and a hidden one. */
function world({ extraMetas = [], extraBlocks = {} } = {}) {
  const metas = [
    { id: 's1', cwd: '/w/acme/shop', customTitle: 'Checkout page', counts: { h: 9 }, startedAt: ago(3), lastAt: ago(2), files: { '/w/acme/lib/money.ts': 3, '/w/acme/shop/cart.ts': 2, [`${HOME}/.claude/plans/plan.md`]: 1 } },
    { id: 's2', cwd: '/w/acme/shop', customTitle: 'Coupon codes', counts: { h: 4 }, startedAt: ago(6), lastAt: ago(5), files: { '/w/acme/shop/cart.ts': 1, [`${HOME}/.claude/plans/plan.md`]: 1 } },
    { id: 's3', cwd: '/w/acme/shop', customTitle: 'Loose fix', counts: { h: 1 }, startedAt: ago(1), lastAt: ago(1) },
    { id: 's5', cwd: '/w/acme/shop', customTitle: 'Ancient work', counts: { h: 2 }, startedAt: ago(200), lastAt: ago(200) },
    { id: 's6', cwd: '/w/acme/api', customTitle: 'Token refresh', counts: { h: 3 }, startedAt: ago(4), lastAt: ago(4), files: { '/w/acme/lib/money.ts': 1 } },
    { id: 's7', cwd: '/w/acme/api', customTitle: 'Rate limits', counts: { h: 2 }, startedAt: ago(8), lastAt: ago(8) },
    { id: 'bot', cwd: '/w/acme/api', entrypoint: 'sdk-cli', counts: { s: 3 }, firstPrompt: 'nightly run', startedAt: ago(1), lastAt: ago(1) },
    { id: 'gone', cwd: '/w/acme/api', customTitle: 'Hidden one', counts: { h: 1 }, startedAt: ago(1), lastAt: ago(1) },
    { id: 'h1', cwd: '/w/side/secret', customTitle: 'In a hidden project', counts: { h: 1 }, startedAt: ago(1), lastAt: ago(1) },
    ...extraMetas,
  ];
  const projects = new Map(
    [
      project('aaaaaaaaaa', '/w/acme/shop', 'acme', ['s1', 's2', 's3', 's5'], ago(1)),
      project('bbbbbbbbbb', '/w/acme/api', 'acme', ['s6', 's7', 'bot', 'gone'], ago(1)),
      project('cccccccccc', '/w/side/old', 'side', [], ago(300)),
      project('dddddddddd', '/w/side/dormant', 'side', [], ago(300)),
      project('eeeeeeeeee', '/w/side/secret', 'side', ['h1'], ago(1)),
    ].map((p) => [p.path, p]),
  );
  for (const m of extraMetas) projects.get('/w/acme/shop').sessionIds.push(m.id);
  const blocks = {
    's1:0': { sessionId: 's1', projectPath: '/w/acme/shop', endAt: ago(2), digest: { title: 'Checkout', topic: 'Auth flow', status: 'in_progress' } },
    's2:0': { sessionId: 's2', projectPath: '/w/acme/shop', endAt: ago(5), digest: { title: 'Coupons', topic: 'auth  flow!', status: 'done' } },
    's5:0': { sessionId: 's5', projectPath: '/w/acme/shop', endAt: ago(200), digest: { title: 'Old', topic: 'Legacy', status: 'done' } },
    's6:0': { sessionId: 's6', projectPath: '/w/acme/api', endAt: ago(4), digest: { title: 'Tokens', topic: 'Auth Flow', status: 'blocked' } },
    's7:0': { sessionId: 's7', projectPath: '/w/acme/api', endAt: ago(8), digest: { title: 'Limits', topic: 'misc', status: 'done' } },
    ...extraBlocks,
  };
  const briefs = {
    '/w/acme/shop': { brief: { threads: [{ name: 'Checkout', status: 'active', blockKeys: ['s1:0', 's2:0'] }, { name: 'Old thread', status: 'done', blockKeys: ['s5:0'] }] } },
  };
  const store = {
    project: (p) => (p === '/w/side/secret' ? { hidden: true } : p === '/w/acme/api' ? { name: 'Acme API' } : {}),
    session: (id) => (id === 'gone' ? { hidden: true } : {}),
    data: {
      ideas: [
        { id: 'idea1', text: 'A **loyalty** program', projectPath: '/w/acme/shop', createdAt: ago(3) },
        { id: 'idea2', text: 'Done already', projectPath: '/w/acme/shop', createdAt: ago(3), doneAt: ago(1) },
      ],
      workspaces: { acme: { name: 'Acme Corp' } },
    },
    settings: {},
  };
  const index = { list: () => metas.slice(), get: (id) => metas.find((m) => m.id === id) || null, loadTurns: () => assert.fail('the graph must not load turns') };
  const registry = { projects, gitOf: () => ({}), byId: (id) => [...projects.values()].find((p) => p.id === id) || null, projectOfSession: () => null, resolve: () => null };
  const ai = { state: { blocks, projects: briefs, cv: {} }, blocksOf: () => assert.fail('the graph must not compute blocks'), digestOf: () => null };
  const live = { get: (id) => (id === 's3' ? { live: true } : null) };
  const views = new Views({ index, registry, store, live, ai, processes: () => [] });
  return {
    index,
    registry,
    store,
    ai,
    views,
    live,
    workItems: [
      { id: 'u_1', projectPath: '/w/acme/shop', title: 'Ship the coupon field', status: 'todo', priority: 1, source: { kind: 'user', sessionId: 's2' }, updatedAt: ago(1) },
      { id: 'u_2', projectPath: '/w/side/old', title: 'Renew the domain', status: 'doing', priority: 2, source: { kind: 'user' }, updatedAt: ago(2) },
      { id: 'ai_1', projectPath: '/w/acme/shop', title: 'A suggestion', status: 'inbox', source: { kind: 'ai' }, updatedAt: ago(1) },
      { id: 'u_3', projectPath: '/w/acme/shop', title: 'Finished', status: 'done', source: { kind: 'user' }, updatedAt: ago(1) },
    ],
    spinoffs: [{ id: 's_x', from: '/w/acme/shop', to: '/w/acme/api', createdAt: ago(30) }],
    candidates: [
      { id: 'c1', status: 'new', title: 'Rate limiter as a library', projectPath: '/w/acme/api', at: ago(2) },
      { id: 'c2', status: 'dismissed', title: 'Nope', projectPath: '/w/acme/api', at: ago(2) },
    ],
    chats: [{ uuid: 'chat-1', name: 'Pricing for the shop', createdAt: ago(10), updatedAt: ago(9), messages: 6, projectPaths: ['/w/acme/shop'] }],
  };
}

const has = (g, source, target, kind) => g.links.some((l) => l.source === source && l.target === target && (!kind || l.kind === kind));
const node = (g, id) => g.nodes.find((n) => n.id === id);

test('graph: every node type and link kind from the data Pilotage already has', () => {
  const g = buildGraph(world(), { days: 90, now: NOW });
  const types = new Set(g.nodes.map((n) => n.type));
  for (const t of ['workspace', 'project', 'thread', 'topic', 'session', 'idea', 'task', 'chat', 'file']) assert.ok(types.has(t), `a ${t} node`);
  // workspaces and projects
  assert.equal(node(g, 'ws:acme').label, 'Acme Corp');
  assert.ok(has(g, 'ws:acme', 'p:aaaaaaaaaa', 'workspace') && has(g, 'ws:acme', 'p:bbbbbbbbbb', 'workspace'));
  assert.equal(node(g, 'p:bbbbbbbbbb').label, 'Acme API', 'the display name from the user');
  assert.equal(node(g, 'p:aaaaaaaaaa').href, '/projects/aaaaaaaaaa');
  // a workstream and its sessions
  const thread = g.nodes.find((n) => n.type === 'thread');
  assert.equal(thread.label, 'Checkout');
  assert.ok(has(g, 'p:aaaaaaaaaa', thread.id, 'thread'));
  assert.ok(has(g, thread.id, 's:s1', 'session') && has(g, thread.id, 's:s2', 'session'));
  assert.match(thread.href, /^\/projects\/aaaaaaaaaa\?workstream=Checkout$/);
  // a session outside every workstream hangs off its project
  assert.ok(has(g, 'p:aaaaaaaaaa', 's:s3', 'session'));
  assert.equal(node(g, 's:s3').live, true);
  assert.equal(node(g, 's:s1').status, 'in_progress', 'the digest status');
  // one topic for "Auth flow" / "auth  flow!" / "Auth Flow", shared by two projects; "misc" is not a topic
  const topics = g.nodes.filter((n) => n.type === 'topic');
  assert.equal(topics.length, 1);
  assert.match(topics[0].sub, /3 sessions · 2 projects/);
  for (const s of ['s:s1', 's:s2', 's:s6']) assert.ok(has(g, s, topics[0].id, 'topic'));
  assert.ok(has(g, 'p:aaaaaaaaaa', topics[0].id, 'topic'), 'two shop sessions share it');
  assert.ok(!has(g, 'p:bbbbbbbbbb', topics[0].id, 'topic'), 'only one api session has it');
  // ideas: a saved idea and an open possible project
  assert.equal(node(g, 'i:idea1').label, 'A loyalty program', 'markdown stripped');
  assert.ok(has(g, 'i:idea1', 'p:aaaaaaaaaa', 'idea') && has(g, 'sc:c1', 'p:bbbbbbbbbb', 'idea'));
  assert.ok(!node(g, 'i:idea2') && !node(g, 'sc:c2'), 'done ideas and dismissed candidates stay off');
  // a spin-off
  assert.ok(has(g, 'p:aaaaaaaaaa', 'p:bbbbbbbbbb', 'spinoff'));
  // tasks: To do / Doing only, linked to their project and source session
  assert.ok(has(g, 'k:u_1', 'p:aaaaaaaaaa', 'task') && has(g, 'k:u_1', 's:s2', 'source'));
  assert.equal(node(g, 'k:u_1').href, '/tasks?open=u_1');
  assert.ok(!node(g, 'k:ai_1') && !node(g, 'k:u_3'), 'no suggestions, no done tasks');
  // a quiet project with an open task is on the map; a dormant one with nothing open is not
  assert.ok(node(g, 'p:cccccccccc') && has(g, 'k:u_2', 'p:cccccccccc', 'task'));
  assert.ok(!node(g, 'p:dddddddddd'));
  // the shared file: two sessions of two projects; one-session files and Claude's own plans stay off
  const files = g.nodes.filter((n) => n.type === 'file');
  assert.deepEqual(files.map((f) => f.label).sort(), ['cart.ts', 'money.ts']);
  const money = files.find((f) => f.label === 'money.ts');
  assert.ok(has(g, 's:s1', money.id, 'edit') && has(g, 's:s6', money.id, 'edit'));
  assert.ok(has(g, money.id, 'p:aaaaaaaaaa', 'file') && has(g, money.id, 'p:bbbbbbbbbb', 'file'));
  // a claude.ai chat
  assert.ok(has(g, 'c:chat-1', 'p:aaaaaaaaaa', 'chat'));
  assert.equal(node(g, 'c:chat-1').href, 'https://claude.ai/chat/chat-1');
  // every link points at nodes that exist, and nothing is reported missing
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const l of g.links) assert.ok(ids.has(l.source) && ids.has(l.target), `${l.source} → ${l.target}`);
  assert.equal(g.truncated, undefined);
});

test('graph: hidden projects and sessions, automations and work outside the window stay off', () => {
  const g = buildGraph(world(), { days: 90, now: NOW });
  for (const id of ['s:bot', 's:gone', 's:h1', 'p:eeeeeeeeee', 's:s5']) assert.ok(!node(g, id), id);
  assert.ok(!g.nodes.some((n) => n.label === 'Old thread'), 'a workstream with nothing in the window');
  const all = buildGraph(world(), { days: 0, now: NOW });
  assert.ok(node(all, 's:s5') && all.nodes.some((n) => n.label === 'Old thread'), 'all time brings them back');
  assert.ok(node(all, 'p:dddddddddd'), 'and the dormant project');
  assert.ok(!node(all, 'p:eeeeeeeeee') && !node(all, 's:gone'), 'hidden stays hidden');
});

test('graph: one project shows its own nodes and what they touch', () => {
  const g = buildGraph(world(), { days: 90, projectId: 'bbbbbbbbbb', now: NOW });
  for (const id of ['p:bbbbbbbbbb', 'ws:acme', 's:s6', 's:s7', 'sc:c1']) assert.ok(node(g, id), id);
  assert.ok(node(g, 'p:aaaaaaaaaa'), 'the project it was spun off from');
  assert.ok(!node(g, 's:s1') && !node(g, 'k:u_1') && !node(g, 'p:cccccccccc') && !node(g, 'c:chat-1'), "other projects' own nodes stay off");
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const l of g.links) assert.ok(ids.has(l.source) && ids.has(l.target));
  // a quiet project can still be looked at on its own
  const quiet = buildGraph(world(), { days: 7, projectId: 'dddddddddd', now: NOW });
  assert.ok(node(quiet, 'p:dddddddddd'));
});

test('graph: the size cap keeps workspaces and projects first and says what was left out', () => {
  const g = buildGraph(world(), { days: 90, now: NOW, limits: { nodes: 8, projects: 150, sessions: 2, threadsPerProject: 8, topics: 60, tasks: 80, ideas: 40, files: 40, chats: 80 } });
  assert.equal(g.nodes.length, 8);
  // 2 workspaces + 3 projects (shop, api, and the quiet one with an open task)
  assert.ok(g.nodes.slice(0, 5).every((n) => n.type === 'workspace' || n.type === 'project'), 'the skeleton comes first');
  assert.ok(g.truncated);
  assert.equal(g.truncated.shown, 8);
  assert.ok(g.truncated.left.session >= 3, 'sessions over their own cap are counted');
  assert.equal(g.truncated.total, 8 + Object.values(g.truncated.left).reduce((a, b) => a + b, 0));
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const l of g.links) assert.ok(ids.has(l.source) && ids.has(l.target));
  // the sessions kept are the newest
  const sessions = buildGraph(world(), { days: 90, now: NOW, limits: { nodes: 400, projects: 150, sessions: 2, threadsPerProject: 8, topics: 60, tasks: 80, ideas: 40, files: 40, chats: 80 } }).nodes.filter((n) => n.type === 'session');
  assert.deepEqual(sessions.map((n) => n.id).sort(), ['s:s1', 's:s3']);
});

test('graph: topics fold case, spacing, punctuation and accents', () => {
  assert.equal(foldTopic('  Auth   Flow! '), 'auth flow');
  assert.equal(foldTopic('Déploiement'), 'deploiement');
  assert.equal(foldTopic(null), '');
});

test('graph: fast on a big index (5,000 sessions, 20,000 digests, 60 projects) without loading turns', () => {
  const extraMetas = [];
  const extraBlocks = {};
  for (let i = 0; i < 5000; i++) {
    const files = {};
    for (let f = 0; f < 30; f++) files[`/w/acme/shop/src/f${(i * 7 + f) % 900}.ts`] = 1;
    extraMetas.push({ id: `x${i}`, cwd: '/w/acme/shop', customTitle: `Session ${i}`, counts: { h: 3 }, startedAt: ago(i % 80), lastAt: ago(i % 80) + i, files });
    for (let b = 0; b < 4; b++) extraBlocks[`x${i}:${b}`] = { sessionId: `x${i}`, projectPath: '/w/acme/shop', endAt: ago(i % 80), digest: { title: 't', topic: `Topic ${(i + b) % 300}`, status: 'done' } };
  }
  const src = world({ extraMetas, extraBlocks });
  for (let p = 0; p < 60; p++) src.registry.projects.set(`/w/many/p${p}`, project(`f${String(p).padStart(9, '0')}`, `/w/many/p${p}`, 'many', [], ago(p)));
  buildGraph(src, { days: 90, now: NOW }); // warm up the JIT
  const t0 = performance.now();
  const g = buildGraph(src, { days: 90, now: NOW });
  const ms = performance.now() - t0;
  assert.ok(g.nodes.length <= 400);
  assert.ok(g.truncated && g.truncated.left.session > 4000);
  // ~60-150 ms alone; the limit leaves room for a loaded machine (the full suite runs files in parallel, CI runners are
  // slower) and still catches a quadratic slip, which takes seconds here.
  assert.ok(ms < 1000, `built in ${ms.toFixed(0)} ms`);
});
