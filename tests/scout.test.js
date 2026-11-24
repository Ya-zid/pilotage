// Project scout (server/ai/scout.js + routes/scout.js + the scoutId hook in routes/work.js). No real AI, no real $HOME:
// HOME points at a temp folder before any server module loads, and every AI call is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-scout-')));
const HOME_DIR = path.join(BASE, 'home');
fs.mkdirSync(HOME_DIR);
process.env.HOME = HOME_DIR; // config.HOME = os.homedir(): spin-off folders land in the temp home
process.env.PILOTAGE_DATA = path.join(BASE, 'data');
delete process.env.PILOTAGE_NO_AI;

const { ensureDirs } = await import('../server/config.js');
ensureDirs();
// The user's name in prompts comes from Settings (server/profile.js); pin it so the tests don't depend on git config.
(await import('../server/store.js')).getStore().settings.profile.name = 'Sam';
const S = await import('../server/ai/scout.js');
const { AIEngine, computeBlocks } = await import('../server/ai/engine.js');
const { default: workRoutes } = await import('../server/routes/work.js');
const { default: scoutRoutes } = await import('../server/routes/scout.js');
const { hash } = await import('../server/util.js');

const DAY = 86400e3;
const NOW = Date.now();
const P = path.join(HOME_DIR, 'Acme');
const SECRET = 'SENTINEL_SECRET_VALUE_42';

// ---------------------------------------------------------------- fixture

function write(rel, content) {
  const f = path.join(P, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

function makeFolder() {
  write('tools/wa/package.json', JSON.stringify({ name: 'acme-wa-bridge', description: 'Guarded one-shot WhatsApp bridge for listed prospects' }));
  write('tools/wa/README.md', '# tools/wa: guarded WhatsApp bridge\n\nA small linked-device bridge that only messages allow-listed prospects.\n');
  write('tools/wa/.env', `WA_TOKEN=${SECRET}\n`);
  write('tools/wa/send.js', 'export {}\n');
  write('tools/meta/README.md', '# tools/meta\n\nGuarded Meta ads test.\n');
  write('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad-should-not-appear' }));
  write('dist/package.json', JSON.stringify({ name: 'dist-should-not-appear' }));
  write('.hidden/pkg/package.json', JSON.stringify({ name: 'hidden-should-not-appear' }));
  for (let i = 0; i < 320; i++) fs.mkdirSync(path.join(P, 'big', `c${i}`), { recursive: true });
  write('big/c1/package.json', JSON.stringify({ name: 'deep-in-big-should-not-appear' }));
  const outside = path.join(BASE, 'outside');
  fs.mkdirSync(path.join(outside, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'proj', 'README.md'), `# leaked\n\n${SECRET}\n`);
  fs.mkdirSync(path.join(P, 'linked'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'proj', 'README.md'), path.join(P, 'linked', 'README.md')); // a link out of the project
  fs.symlinkSync(path.join(outside, 'proj'), path.join(P, 'linkdir')); // a linked folder is never walked
}
makeFolder();

const filler = (i) => `Filler prompt number ${i} about the outreach desk: ${'please check the lead list and tell me what to send next, '.repeat(5)}`;

function sessions() {
  const t0 = NOW - 20 * DAY;
  const turns1 = [
    { t: t0, o: 'h', p: 'Set up the outreach desk for clinics and send the first batch', a: 'Done, the desk is live.' },
    { t: t0 + 60e3, o: 'h', p: 'Set up the outreach desk for clinics and send the first batch', a: '' }, // duplicate
    { t: t0 + 120e3, o: 'h', p: `here is the password abcd efgh ijkl mnop and the key e8100fa9cf55d02d00e39793b93d91b4f6f0cca8 use them`, a: '' },
    { t: t0 + 180e3, o: 'h', p: 'Honestly we could turn the WhatsApp bridge into its own product for other freelancers, it works so well', a: 'Possible: the bridge in tools/wa has no Acme-specific code.' },
    { t: t0 + 240e3, o: 'h', p: "On pourrait en faire un projet à part, l'outil de relance des clients", a: 'Oui.' },
    { t: t0 + 300e3, o: 'h', p: 'remind me later to call the clinic', a: '' },
    { t: t0 + 360e3, o: 'h', p: '<pasted_content id="1">We have an idea: buy our SaaS product today!</pasted_content id="1"> what is this email?', a: '' },
  ];
  for (let i = 0; i < 300; i++) turns1.push({ t: t0 + (400 + i) * 60e3, o: 'h', p: filler(i), a: i === 299 ? 'Sent.' : '' });
  turns1.push({ t: t0 + 800 * 60e3, o: 'h', p: 'Send the second batch to the clinics in Springfield', a: '' });
  turns1.push({ t: t0 + 801 * 60e3, o: 'h', p: 'send the second batch to the clinics in Springfield!', a: '' }); // the same prompt again
  const turns2 = [{ t: NOW - 2 * DAY, o: 'h', p: 'Fix the follow-up email copy', a: 'Fixed.' }];
  const auto = [{ t: NOW - DAY, o: 's', p: 'AUTOMATION_PROMPT_SHOULD_NOT_APPEAR we could build a tool for this', a: '' }];
  const meta = (id, turns, extra = {}) => ({
    id,
    cwd: P,
    startedAt: turns[0].t,
    lastAt: turns[turns.length - 1].t,
    lastHumanAt: turns.filter((t) => t.o === 'h').pop()?.t || 0,
    turnCount: turns.length,
    counts: { h: turns.filter((t) => t.o === 'h').length, s: turns.filter((t) => t.o === 's').length },
    entrypoint: 'cli',
    files: {},
    ...extra,
  });
  const S1 = meta('S1', turns1, {
    files: {
      [path.join(P, 'tools/wa/send.js')]: 30,
      [path.join(P, 'tools/wa/lib/guard.js')]: 12,
      [path.join(P, 'tools/meta/ads.py')]: 4,
      [path.join(P, 'mail.py')]: 9,
      [path.join(P, '.env.local')]: 99,
      [path.join(P, 'config/credentials.json')]: 50,
      [path.join(P, 'node_modules/x/index.js')]: 7,
      [path.join(HOME_DIR, '.claude/projects/x/memory/MEMORY.md')]: 5,
    },
  });
  const S2 = meta('S2', turns2, { files: { [path.join(P, 'mail.py')]: 2 } });
  const A1 = meta('A1', auto, { entrypoint: 'sdk-cli' });
  return { metas: [S1, S2, A1], turns: { S1: turns1, S2: turns2, A1: auto } };
}

function fakeIndex(fx) {
  const byId = new Map(fx.metas.map((m) => [m.id, m]));
  return { get: (id) => byId.get(id) || null, loadTurns: (id) => fx.turns[id] || [], list: () => fx.metas };
}

function fakeProject(fx, extra = {}) {
  return { id: hash(P, 10), path: P, name: 'Acme', workspace: 'acme', isGit: false, worktrees: new Map(), sessionIds: fx.metas.map((m) => m.id), lastAt: Math.max(...fx.metas.map((m) => m.lastAt)), stack: [], ...extra };
}

function fakeRegistry(projects) {
  const map = new Map(projects.map((p) => [p.path, p]));
  return {
    projects: map,
    known: new Set(),
    byId: (id) => [...map.values()].find((p) => p.id === id) || null,
    projectOfSession: (m) => [...map.values()].find((p) => m.cwd && m.cwd.startsWith(p.path)) || null,
    gitOf: () => ({}),
    rebuild: async () => map,
    lastScanAt: 0,
  };
}

function fakeStore() {
  const data = { ideas: [], scout: {}, projects: {}, sessions: {} };
  return {
    data,
    settings: { ai: { enabled: true, autoDigest: true, dailyBrief: false, scoutModel: 'sonnet', concurrency: 2, maxFiveHourPct: 60, maxSevenDayPct: 92, maxCallsPer5h: 500, maxCallsPerDay: 1500 }, launch: { permissionMode: 'manual', model: '', pcMode: 'terminal', phoneMode: 'background' } },
    project: (p) => data.projects[p] || {},
    patchProject(p, patch) {
      data.projects[p] = { ...(data.projects[p] || {}), ...patch };
    },
    session: () => ({}),
    save() {},
  };
}

const BRIEF = {
  oneLiner: 'Autonomous client-acquisition workspace.',
  description: 'Finds clients; runs a guarded WhatsApp bridge.',
  currentState: 'Outreach running.',
  nextSteps: ['Call the two referring doctors on Sunday'],
  threads: [
    { name: 'Cold outreach experiment', summary: 'Cold email funnel.', status: 'paused', blockKeys: [] },
    { name: 'WhatsApp bridge', summary: 'Guarded bridge.', status: 'active', blockKeys: [] },
  ],
};

/** A fake engine: just enough for Scout (state, blocksOf, blockView, queue fields). */
function fakeAI(fx, { brief = BRIEF } = {}) {
  const state = { blocks: {}, projects: brief ? { [P]: { hash: 'brief1', at: NOW - DAY, brief } } : {}, scout: {} };
  const ai = {
    state,
    settings: { scoutModel: 'sonnet' },
    queue: [],
    queued: new Set(),
    running: new Map(),
    providerSig: () => 'sig',
    blocksOf: (meta) => computeBlocks(meta, fx.turns[meta.id] || []).map((b) => ({ ...b, hash: `h-${b.key}` })),
    blockView: () => ({ fallbackTitle: 'untitled block' }),
    enqueue(job) {
      if (this.queued.has(job.id)) return false;
      this.queued.add(job.id);
      this.queue.push(job);
      return true;
    },
    on() {},
  };
  for (const m of fx.metas) for (const b of ai.blocksOf(m)) state.blocks[b.key] = { hash: b.hash, digest: { title: `Block ${b.key}`, summary: 'Worked on outreach.', status: 'done', topic: 'Outreach' } };
  return ai;
}

function setup({ brief = BRIEF, callAI } = {}) {
  const fx = sessions();
  const index = fakeIndex(fx);
  const project = fakeProject(fx);
  const registry = fakeRegistry([project]);
  const store = fakeStore();
  const ai = fakeAI(fx, { brief });
  const calls = [];
  const scout = new S.Scout({ ai, index, registry, store, home: HOME_DIR, callAI: callAI || (async (args) => (calls.push(args), { ok: true, data: { candidates: [] }, model: 'sonnet' })) });
  return { fx, index, project, registry, store, ai, scout, calls };
}

const cand = (title, extra = {}) => ({ title, kind: 'spin-off', pitch: `${title}: a standalone thing for freelancers that sends guarded messages`, why: 'It already exists in tools/wa.', evidence: ['tools/wa: 42 edits'], threadName: 'whatsapp BRIDGE', firstSteps: ['Copy tools/wa out'], confidence: 'high', ...extra });

// ---------------------------------------------------------------- idea language

test('idea language: EN and FR, accents folded, ordinary "later" ignored', () => {
  const yes = [
    'we could turn this into a SaaS',
    'This should be its own project honestly',
    'make it a separate repo',
    "let's spin it off",
    'I want to build something to manage my projects',
    'I have an idea for clinics',
    'a tool for dentists',
    'On pourrait en faire un produit',
    'il faudrait un projet séparé pour ça',
    "J'ai une idée : un outil pour les pharmacies",
    'Il faudrait faire un outil qui relance les clients',
    'ça serait bien de le vendre',
    'we can build the app later',
    'would this bridge be a good open source project?',
  ];
  for (const s of yes) assert.ok(S.ideaHit(s), s);
  const no = ['remind me later', 'call them later', 'Fix the footer', 'the product page is broken', 'make sure it works', 'separate the two lists'];
  for (const s of no) assert.equal(S.ideaHit(s), null, s);
  assert.equal(S.ideaHit('good idea, do it').tier, 2, 'a reaction is weaker than an idea');
  assert.equal(S.ideaHit('I have an idea').tier, 1);
  // offsets survive the folding (used to cut the context window)
  const s = 'Écoute: il faudrait un projet à part';
  assert.equal(S.fold(s).length, s.length);
  assert.equal(s.slice(S.ideaHit(s).index, S.ideaHit(s).index + 11), 'il faudrait');
  assert.match(S.windowAround('x '.repeat(400) + 'IDEA HERE ' + 'y '.repeat(400), 800, 100), /IDEA HERE/);
});

test('titles: similar / generic checks', () => {
  assert.ok(S.similarTitle('WhatsApp Bridge', 'Guarded WhatsApp Bridge'));
  assert.ok(S.similarTitle('WhatsApp outreach tool', 'WhatsApp Outreach'));
  assert.ok(!S.similarTitle('WhatsApp Bridge', 'Clinic Booking Widget'));
  assert.ok(!S.similarTitle('Lead Desk', 'Meta Ads Runner'));
  for (const t of ['Analytics Dashboard', 'Add tests', 'Mobile app', 'Improve docs', 'CI pipeline', 'Admin panel v2']) assert.ok(S.isGenericTitle(t), t);
  for (const t of ['WhatsApp Bridge', 'Clinic Reminder SMS', 'Pilotage']) assert.ok(!S.isGenericTitle(t), t);
  assert.equal(S.candidateId(P, 'WhatsApp Bridge'), S.candidateId(P, 'whatsapp  bridge!'));
  assert.notEqual(S.candidateId(P, 'WhatsApp Bridge'), S.candidateId('/x', 'WhatsApp Bridge'));
});

// ---------------------------------------------------------------- input building

test('input: prompts newest first and deduped, idea prompts with context, caps, secrets and automation left out', () => {
  const { scout, project } = setup();
  const { input, stats } = scout.inputFor(project);
  const section = (title) => {
    const i = input.indexOf(title);
    if (i < 0) return '';
    const j = input.indexOf('\n## ', i + 1);
    return input.slice(i, j < 0 ? undefined : j);
  };
  const ideas = section("## Sam's prompts that sound like an idea");
  const others = section("## Sam's other prompts");
  assert.match(ideas, /WhatsApp bridge into its own product/);
  assert.match(ideas, /On pourrait en faire un projet à part/);
  assert.match(ideas, /Claude replied: "Possible: the bridge in tools\/wa/);
  assert.doesNotMatch(ideas, /remind me later/);
  assert.doesNotMatch(input, /buy our SaaS product/, 'pasted text is not the user\'s own words');
  assert.doesNotMatch(input, /AUTOMATION_PROMPT/, 'automated runs are skipped');
  assert.doesNotMatch(input, /e8100fa9cf55d02d00e39793b93d91b4f6f0cca8/);
  assert.doesNotMatch(input, /abcd efgh ijkl mnop/);
  assert.equal(input.split(/send the second batch to the clinics in Springfield/i).length - 1, 1, 'deduped');
  // newest first; the oldest are cut by the budget, not the newest
  assert.ok(others.indexOf('Filler prompt number 299') < others.indexOf('Filler prompt number 290'));
  assert.doesNotMatch(others, /Filler prompt number 3 about/);
  assert.match(others, /older prompts not listed/);
  assert.ok(others.length <= S.BUDGET.prompts + 400, `prompts section ${others.length}`);
  for (const l of others.split('\n').filter((x) => x.startsWith('- ['))) assert.ok(l.length <= S.BUDGET.promptChars + 20, l);
  assert.ok(ideas.length <= S.BUDGET.ideas + 200);
  assert.ok(stats.chars <= S.BUDGET.evidence);
  // brief + threads, blocks newest first
  assert.match(input, /Its own next steps \(this project's roadmap, not candidates\):\n- Call the two referring doctors/);
  assert.match(input, /- WhatsApp bridge \(active\): Guarded bridge\./);
  assert.match(input, /## Work blocks/);
});

test('input: sub-folders and edit counts, never reading sensitive files, links, node_modules or huge folders', () => {
  const { scout, project } = setup();
  const { input } = scout.inputFor(project);
  assert.match(input, /- tools\/wa\/ \[README\.md, package\.json\] package\.json "acme-wa-bridge: Guarded one-shot WhatsApp bridge for listed prospects"; README: "tools\/wa: guarded WhatsApp bridge: A small linked-device bridge/);
  assert.match(input, /tools\/wa\/ .*; 42 edits in Sam's sessions/);
  assert.match(input, /- tools\/meta\/ \[README\.md\]/);
  assert.doesNotMatch(input, new RegExp(SECRET), 'neither .env nor a README linked from outside is read');
  for (const name of ['left-pad-should-not-appear', 'dist-should-not-appear', 'hidden-should-not-appear', 'deep-in-big-should-not-appear', 'linkdir']) assert.ok(!input.includes(name), name);
  const subs = S.findSubProjects(P);
  assert.ok(!subs.some((s) => s.rel === 'linked'), 'a README that is a link does not make a sub-project');
  // edits by folder: sensitive files, node_modules and files outside the project are not counted
  assert.match(input, /- tools\/ — 46 edits to 3 files; most in wa\/ \(42\), meta\/ \(4\)/);
  assert.match(input, /- top-level files — 11 edits: mail\.py \(11\)/);
  assert.doesNotMatch(input, /\.env\.local|credentials|node_modules|MEMORY\.md/);
  // readSmall itself refuses sensitive names and links out of the root
  assert.equal(S.readSmall(path.join(P, 'tools/wa/.env'), P), '');
  assert.equal(S.readSmall(path.join(P, 'linked/README.md'), P), '');
  assert.match(S.readSmall(path.join(P, 'tools/wa/README.md'), P), /guarded WhatsApp bridge/);
});

test('input: the hash ignores today, the other projects and the user\'s decisions; it changes with a new prompt', () => {
  const { scout, project, fx, store, registry } = setup();
  const a = scout.inputFor(project, NOW);
  const b = scout.inputFor(project, NOW + 2 * DAY);
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.input, b.input);
  registry.projects.set('/elsewhere/other', { id: 'x', path: '/elsewhere/other', name: 'other', sessionIds: [], worktrees: new Map(), lastAt: NOW });
  store.data.scout.abc123abc123 = { status: 'dismissed', at: NOW, from: P, title: 'Old thing', candidate: { title: 'Old thing', pitch: 'p' } };
  const c = scout.inputFor(project, NOW);
  assert.equal(c.hash, a.hash);
  assert.match(c.input, /## Sam's other projects[\s\S]*- other \(\/elsewhere\/other\)/);
  assert.match(c.input, /"Old thing" \(dismissed by Sam\)/);
  fx.turns.S2.push({ t: NOW - DAY, o: 'h', p: 'Brand new prompt about invoices', a: '' });
  fx.metas[1].lastAt = NOW - DAY;
  fx.metas[1].turnCount++;
  assert.notEqual(scout.inputFor(project, NOW).hash, a.hash);
});

// ---------------------------------------------------------------- runs, ids, decisions

test('run: candidates cleaned (generic dropped, max 3, thread name canonical), ids stable across runs', async () => {
  let reply = { candidates: [cand('WhatsApp Bridge'), cand('Analytics Dashboard'), cand('Clinic Follow-up Tool', { kind: 'idea', threadName: 'nope' }), cand('Meta Ads Runner'), cand('Fourth One')] };
  const { scout, project, calls, ai } = setup({ callAI: async (args) => (calls.push(args), { ok: true, data: reply, model: 'claude-sonnet' }) });
  const r = await scout.run(project);
  assert.equal(r.ok, true);
  assert.equal(calls[0].purpose, 'scout', 'per-purpose model override applies (providers.js PURPOSE_MODEL)');
  assert.equal(calls[0].model, 'sonnet');
  assert.ok(calls[0].schema.properties.candidates);
  const st = ai.state.scout[P];
  assert.deepEqual(st.candidates.map((c) => c.title), ['WhatsApp Bridge', 'Clinic Follow-up Tool', 'Meta Ads Runner']);
  assert.equal(st.candidates[0].threadName, 'WhatsApp bridge');
  assert.equal(st.candidates[1].threadName, '');
  assert.equal(st.candidates[1].kind, 'idea');
  assert.equal(st.model, 'claude-sonnet');
  assert.ok(st.hash && st.at);
  const id = st.candidates[0].id;
  assert.equal(id, S.candidateId(P, 'WhatsApp Bridge'));
  // next run: a close title keeps the id and the first-seen date
  reply = { candidates: [cand('Guarded WhatsApp Bridge')] };
  await scout.run(project);
  assert.equal(ai.state.scout[P].candidates.length, 1);
  assert.equal(ai.state.scout[P].candidates[0].id, id);
  assert.equal(ai.state.scout[P].candidates[0].firstAt, st.candidates[0].firstAt);
  // an empty answer is valid
  reply = { candidates: [] };
  await scout.run(project);
  assert.deepEqual(ai.state.scout[P].candidates, []);
});

test('a dismissed candidate never comes back for that project (same title or a close one)', async () => {
  let reply = { candidates: [cand('WhatsApp Bridge'), cand('Clinic Follow-up Tool')] };
  const { scout, project, ai } = setup({ callAI: async () => ({ ok: true, data: reply, model: 'm' }) });
  await scout.run(project);
  const id = ai.state.scout[P].candidates[0].id;
  const v = scout.decide(id, 'dismissed');
  assert.equal(v.status, 'dismissed');
  assert.equal(scout.list().find((c) => c.id === id).status, 'dismissed');
  reply = { candidates: [cand('WhatsApp Bridge'), cand('The WhatsApp bridge tool'), cand('Clinic Follow-up Tool')] };
  await scout.run(project);
  const titles = ai.state.scout[P].candidates.map((c) => c.title);
  assert.deepEqual(titles, ['Clinic Follow-up Tool']);
  const open = scout.list().filter((c) => c.status === 'new');
  assert.deepEqual(open.map((c) => c.title), ['Clinic Follow-up Tool']);
  assert.equal(scout.list().filter((c) => c.status === 'dismissed').length, 1, 'still listed once, as dismissed');
  assert.match(scout.inputFor(project).input, /"WhatsApp Bridge" \(dismissed by Sam\)/, 'the model is told too');
  // undo the dismissal: back to new (kept from its snapshot, since the latest run no longer has it)
  assert.equal(scout.decide(id, 'new').status, 'new');
  assert.equal(scout.list().find((c) => c.id === id).status, 'new');
  assert.throws(() => scout.decide(id, 'bogus'), (e) => e.status === 400);
  assert.throws(() => scout.decide('ffffffffffff', 'dismissed'), (e) => e.status === 404);
});

test('save → a normal idea (source ai) and the candidate marked saved; idempotent', async () => {
  const { scout, project, ai, store } = setup({ callAI: async () => ({ ok: true, data: { candidates: [cand('WhatsApp Bridge')] }, model: 'm' }) });
  await scout.run(project);
  const id = ai.state.scout[P].candidates[0].id;
  const r = scout.save(id);
  assert.equal(r.created, true);
  assert.equal(store.data.ideas.length, 1);
  const idea = store.data.ideas[0];
  assert.equal(idea.source, 'ai');
  assert.equal(idea.projectPath, P);
  assert.equal(idea.scoutId, id);
  assert.match(idea.text, /^WhatsApp Bridge: WhatsApp Bridge: a standalone thing[\s\S]*Why: It already exists in tools\/wa\./);
  assert.equal(r.candidate.status, 'saved');
  assert.equal(r.candidate.ideaId, idea.id);
  assert.equal(scout.save(id).created, false);
  assert.equal(store.data.ideas.length, 1);
  assert.throws(() => scout.decide(id, 'new'), (e) => e.status === 409, 'saved as an idea: delete the idea first');
  // the overview counts only open ones
  assert.equal(scout.overview().newCount, 0);
});

test('failures: input errors count against the project, provider-wide ones do not; old candidates are kept', async () => {
  let next = { ok: true, data: { candidates: [cand('WhatsApp Bridge')] }, model: 'm' };
  const { scout, project, ai } = setup({ callAI: async () => next });
  await scout.run(project);
  next = { ok: false, error: 'no structured output' };
  await assert.rejects(scout.run(project), (e) => e.aiClass === 'input');
  assert.equal(ai.state.scout[P].failures, 1);
  assert.ok(ai.state.scout[P].failedAt);
  assert.equal(ai.state.scout[P].candidates.length, 1, 'the earlier candidates stay');
  next = { ok: false, error: 'Claude usage limit reached', capped: true };
  await assert.rejects(scout.run(project), (e) => e.aiClass === 'busy');
  assert.equal(ai.state.scout[P].failures, 1);
});

// ---------------------------------------------------------------- scheduling

test('scheduling: activity window, brief needed, 3-day rule, input hash, failure backoff', () => {
  const ok = { ok: true };
  assert.deepEqual(S.scoutDue({ eligible: { ok: false, reason: 'no brief yet' }, prev: null }), { due: false, reason: 'no brief yet' });
  assert.equal(S.scoutDue({ eligible: ok, prev: null, hash: 'h' }).due, true);
  assert.equal(S.scoutDue({ eligible: ok, prev: { at: NOW - DAY, hash: 'old' }, hash: 'new', now: NOW }).due, false, 'changed, but < 3 days');
  assert.equal(S.scoutDue({ eligible: ok, prev: { at: NOW - 4 * DAY, hash: 'same' }, hash: 'same', now: NOW }).due, false, 'old, but nothing new');
  assert.equal(S.scoutDue({ eligible: ok, prev: { at: NOW - 4 * DAY, hash: 'old' }, hash: 'new', now: NOW }).due, true);
  assert.equal(S.scoutDue({ eligible: ok, prev: { failedAt: NOW - 60e3 }, hash: 'h', now: NOW }).due, false);
  assert.equal(S.scoutDue({ eligible: ok, prev: { failures: 3, failHash: 'h', failSig: 's', failedAt: NOW - DAY }, hash: 'h', sig: 's', now: NOW }).due, false);
  assert.equal(S.scoutDue({ eligible: ok, prev: { failures: 3, failHash: 'h', failSig: 's', failedAt: NOW - DAY }, hash: 'h2', sig: 's', now: NOW }).due, true, 'new input: try again');

  const { scout, project, fx, store, ai } = setup();
  assert.equal(scout.eligible(project).ok, true);
  assert.equal(scout.due(project).due, true);
  // 121 days without a typed prompt (automated runs don't count)
  const old = NOW - 121 * DAY;
  for (const m of fx.metas) {
    if (m.id !== 'A1') m.lastHumanAt = old;
    m.lastAt = m.id === 'A1' ? NOW : old;
  }
  assert.match(scout.eligible(project).reason, /120 days/);
  for (const m of fx.metas) m.lastHumanAt = m.lastAt = NOW - 2 * DAY;
  delete ai.state.projects[P];
  assert.equal(scout.eligible(project).reason, 'no brief yet');
  ai.state.projects[P] = { hash: 'b', at: NOW, brief: BRIEF };
  store.data.projects[P] = { hidden: true };
  assert.equal(scout.eligible(project).ok, false);
  store.data.projects[P] = {};
  assert.equal(scout.eligible({ ...project, path: HOME_DIR }).reason, 'home folder');
  // a fresh scout with the current input: not due; same input 4 days later: still not due; new input then: due
  const h = scout.inputFor(project).hash;
  ai.state.scout[P] = { at: NOW - DAY, hash: h, candidates: [] };
  assert.equal(scout.due(project).due, false);
  ai.state.scout[P].at = NOW - 4 * DAY;
  assert.equal(scout.due(project).due, false);
  ai.state.scout[P].hash = 'something-else';
  assert.equal(scout.due(project).due, true);
  // daily cap on automatic attempts
  ai.state.scoutAutoLog = Array.from({ length: S.AUTO_PER_DAY }, () => NOW - 3600e3); // the cap counts attempts, not projects
  assert.deepEqual(scout.autoJobs(), []);
});

test('engine: the scout runs from tick, last (after digests and briefs), through the queue and guard', async () => {
  const fx = sessions();
  const index = fakeIndex(fx);
  const project = fakeProject(fx);
  const registry = fakeRegistry([project]);
  const store = fakeStore();
  const engine = new AIEngine({ index, registry, store, live: { get: () => null } });
  // every block digested, the brief fresh: nothing else to do
  for (const m of fx.metas) for (const b of engine.blocksOf(m)) engine.state.blocks[b.key] = { hash: b.hash, digest: { title: 't', summary: 's', status: 'done', topic: 'x' }, projectPath: P, sessionId: m.id, startAt: b.startAt, endAt: b.endAt };
  engine.state.projects[P] = { hash: 'b', at: Date.now(), brief: BRIEF };
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  engine.scout = new S.Scout({ ai: engine, index, registry, store, home: HOME_DIR, callAI: async (args) => (calls.push(args), await gate, { ok: true, data: { candidates: [cand('WhatsApp Bridge')] }, model: 'm', cost: 0 }) });
  engine.pausedByUser = true;
  engine.tick();
  assert.equal(engine.running.size + engine.queue.length, 0, 'the guard holds automatic work');
  engine.pausedByUser = false;
  engine.tick();
  assert.equal(engine.running.size, 1);
  const job = [...engine.running.values()][0];
  assert.equal(job.kind, 'scout');
  assert.ok(job.priority < 1, 'below the daily brief');
  assert.equal(job.manual, false);
  release();
  for (let i = 0; i < 50 && engine.running.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.equal(engine.state.scout[P].candidates[0].title, 'WhatsApp Bridge');
  assert.equal(engine.state.scout[P].auto, true);
  assert.equal(engine.status().scouted, 1);
  engine.tick();
  assert.equal(engine.running.size + engine.queue.length, 0, 'just scouted: not due again');
  // a manual "run now" is a manual job
  assert.equal(engine.scout.queueOne(project), true);
  const manual = [...engine.running.values(), ...engine.queue].find((j) => j.kind === 'scout');
  assert.equal(manual.manual, true);
  for (let i = 0; i < 50 && engine.running.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2);
  engine._save.flush?.();
});

// ---------------------------------------------------------------- routes

function harness(mod, ctx) {
  const routes = [];
  mod({ route: (method, pattern, fn) => routes.push({ method, rx: new RegExp(`^${pattern}$`), fn }), ctx });
  return async (method, url, body = {}) => {
    for (const r of routes) {
      const u = new URL(`http://x${url}`);
      const m = r.method === method && r.rx.exec(u.pathname);
      if (m) {
        const res = {};
        await r.fn({ headers: {} }, res, { m, body, url: u, dev: { name: 'test' } });
        return res;
      }
    }
    throw new Error(`no route ${method} ${url}`);
  };
}

test('routes: list/run/dismiss/save, overview, and a spin-off or new project with scoutId marks it accepted', async () => {
  const fx = sessions();
  const index = fakeIndex(fx);
  const project = fakeProject(fx);
  const registry = fakeRegistry([project]);
  const store = fakeStore();
  const ai = fakeAI(fx);
  const listeners = [];
  ai.on = (ev, fn) => listeners.push(fn);
  const events = [];
  const extenders = [];
  const ctx = {
    index,
    registry,
    store,
    ai,
    live: { refresh: async () => false, get: () => null },
    views: { sessionTitle: () => 'session', threadsOf: () => [], lastActivity: () => NOW },
    broadcast: (k) => events.push(k),
    json: (res, body, status = 200) => Object.assign(res, { status, body }),
    fail: (res, status, error) => Object.assign(res, { status, body: { error } }),
    log: { info() {}, warn() {}, error() {} },
    every() {},
    extendOverview: (fn) => extenders.push(fn),
  };
  const scoutCall = harness(scoutRoutes, ctx);
  const workCall = harness(workRoutes, ctx);
  assert.ok(ctx.scout instanceof S.Scout);
  assert.equal(ai.scout, ctx.scout);
  ctx.scout.callAI = async () => ({ ok: true, data: { candidates: [cand('WhatsApp Bridge'), cand('Clinic Follow-up Tool', { kind: 'idea' }), cand('Meta Ads Runner')] }, model: 'm' });

  let r = await scoutCall('GET', '/api/scout');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.candidates, []);
  assert.equal(r.body.pending[0].state, 'due');
  r = await scoutCall('POST', '/api/scout/run', { projectId: project.id });
  assert.equal(r.body.queued, 1);
  assert.equal(ai.queue[0].manual, true);
  assert.ok(events.includes('scout'));
  r = await scoutCall('POST', '/api/scout/run', { projectId: 'nope000000' });
  assert.equal(r.status, 404);
  await ai.queue[0].run();
  listeners.forEach((fn) => fn({ kind: 'scout' }));
  r = await scoutCall('GET', `/api/scout?projectId=${project.id}`);
  assert.equal(r.body.candidates.length, 3);
  const [c1, c2, c3] = r.body.candidates;
  for (const k of ['id', 'projectId', 'projectName', 'projectPath', 'displayPath', 'kind', 'title', 'pitch', 'why', 'evidence', 'threadName', 'firstSteps', 'confidence', 'at', 'status']) assert.ok(k in c1, k);
  assert.equal(c1.status, 'new');
  assert.equal(c1.displayPath, '~/Acme');
  assert.ok(r.body.lastRunAt > 0);
  assert.equal(extenders[0]().scout.newCount, 3);
  assert.equal(extenders[0]().scout.top.length, 3);

  r = await scoutCall('PATCH', `/api/scout/${c3.id}`, { status: 'dismissed' });
  assert.equal(r.body.status, 'dismissed');
  r = await scoutCall('PATCH', `/api/scout/${c3.id}`, { status: 'weird' });
  assert.equal(r.status, 400);
  r = await scoutCall('POST', `/api/scout/${c2.id}/save`);
  assert.equal(r.body.created, true);
  assert.equal(store.data.ideas.length, 1);
  assert.ok(events.includes('ideas'));
  r = await scoutCall('GET', '/api/scout');
  assert.deepEqual(r.body.candidates.map((c) => c.status), ['new', 'saved', 'dismissed'], 'open first');
  assert.equal(extenders[0]().scout.newCount, 1);

  // spin-off from the WhatsApp candidate (template handoff, no AI): accepted, with the new folder
  r = await workCall('POST', '/api/spinoff', { fromProjectId: project.id, name: 'WhatsApp Bridge', goal: 'Run the guarded bridge as its own tool.', useAI: false, scoutId: c1.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.project.path, path.join(HOME_DIR, 'whatsapp-bridge'));
  assert.deepEqual(r.body.scout, { id: c1.id, status: 'accepted' });
  assert.match(fs.readFileSync(path.join(HOME_DIR, 'whatsapp-bridge', 'CLAUDE.md'), 'utf8'), /Original idea: \(Suggested by Pilotage's project scout[^)]*\) WhatsApp Bridge: /);
  r = await scoutCall('GET', '/api/scout');
  const acc = r.body.candidates.find((c) => c.id === c1.id);
  assert.equal(acc.status, 'accepted');
  assert.equal(acc.acceptedProjectPath, path.join(HOME_DIR, 'whatsapp-bridge'));
  // new project from the saved idea candidate: goal defaults to its pitch; its idea is closed
  r = await workCall('POST', '/api/projects/new', { name: 'Clinic Follow-up', useAI: false, scoutId: c2.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.scout.status, 'accepted');
  assert.ok(store.data.ideas[0].doneAt, 'the saved idea is done');
  assert.match(fs.readFileSync(path.join(HOME_DIR, 'clinic-follow-up', 'CLAUDE.md'), 'utf8'), /## Goal\n\nClinic Follow-up Tool: a standalone thing/);
  // an unknown scoutId changes nothing and never blocks creation
  r = await workCall('POST', '/api/projects/new', { name: 'Plain One', goal: 'Something.', useAI: false, scoutId: 'ffffffffffff' });
  assert.equal(r.status, 200);
  assert.equal(r.body.scout, undefined);
  // dismissed stays dismissed on the next scout of that project
  await ctx.scout.run(project);
  r = await scoutCall('GET', '/api/scout');
  assert.equal(r.body.candidates.filter((c) => c.status === 'new').length, 0);
  assert.deepEqual(r.body.candidates.map((c) => c.status).sort(), ['accepted', 'accepted', 'dismissed']);
  // the debug input route
  r = await scoutCall('GET', `/api/scout/input?projectId=${project.id}`);
  assert.equal(r.status, 200);
  assert.match(r.body.input, /## Brief/);
});

test('scout input: prompts that hand over a password are left out whole', async () => {
  const { cleanText } = await import('../server/ai/scout.js');
  const a = cleanText('here is the app password someuser abcde-fghij-klmno-pqrst-uvwxy for the mailbox', { dropCredentials: true });
  const b = cleanText('here is the email x@y.z here is the password Hunter2', { dropCredentials: true });
  const c = cleanText('voici le mot de passe azerty123', { dropCredentials: true });
  for (const r of [a, b, c]) assert.ok(!/abcde|Hunter2|azerty/.test(r), r);
  assert.equal(cleanText('Build the WhatsApp bridge as its own repo', { dropCredentials: true }), 'Build the WhatsApp bridge as its own repo');
});

test('engine: automatic digests cover recent work only; year-old sessions and session-less repos wait for a manual run', () => {
  const fx = sessions(); // S1 ended ~20 days ago, S2 2 days ago
  const oldTurns = [
    { t: NOW - 400 * DAY, o: 'h', p: 'Rewrite the old landing page', a: 'Done.' },
    { t: NOW - 400 * DAY + 60e3, o: 'h', p: 'Add the pricing table', a: 'Added.' },
  ];
  fx.turns.OLD = oldTurns;
  fx.metas.push({ id: 'OLD', cwd: P, startedAt: oldTurns[0].t, lastAt: oldTurns[1].t, lastHumanAt: oldTurns[1].t, turnCount: 2, counts: { h: 2, s: 0 }, entrypoint: 'cli', files: {} });
  const project = fakeProject(fx);
  const cloned = { id: hash('/x/cloned', 10), path: path.join(HOME_DIR, 'cloned-lib'), name: 'cloned-lib', workspace: 'cloned-lib', isGit: true, worktrees: new Map(), sessionIds: [], lastAt: 0, stack: [] };
  const engine = new AIEngine({ index: fakeIndex(fx), registry: fakeRegistry([project, cloned]), store: fakeStore(), live: { get: () => null } });
  const auto = engine.pendingBlocks().map((p) => p.meta.id);
  assert.ok(auto.includes('S2'), 'recent work is summarized');
  assert.ok(!auto.includes('OLD'), 'a 400-day-old session is not summarized automatically');
  assert.ok(engine.pendingBlocks({ manual: true }).some((p) => p.meta.id === 'OLD'), '"Summarize now" still covers it');
  assert.equal(engine.status().pendingBlocks, engine.pendingBlocks().length, 'the "left" count matches what will run');
  assert.ok(!engine.pendingBriefs([]).some((b) => b.project.path === cloned.path), 'no automatic brief for a repo without sessions');
});

test('engine: automatic project briefs follow the same window; a longer window in Settings reaches older projects', () => {
  const fx = sessions();
  const oldTurns = [
    { t: NOW - 400 * DAY, o: 'h', p: 'Port the old site to Astro', a: 'Done.' },
    { t: NOW - 400 * DAY + 60e3, o: 'h', p: 'Fix the RSS feed', a: 'Fixed.' },
  ];
  fx.turns.OLD = oldTurns;
  const oldPath = path.join(HOME_DIR, 'old-site');
  fx.metas.push({ id: 'OLD', cwd: oldPath, startedAt: oldTurns[0].t, lastAt: oldTurns[1].t, lastHumanAt: oldTurns[1].t, turnCount: 2, counts: { h: 2, s: 0 }, entrypoint: 'cli', files: {} });
  const recent = fakeProject(fx);
  recent.sessionIds = recent.sessionIds.filter((id) => id !== 'OLD');
  const old = { id: hash(oldPath, 10), path: oldPath, name: 'old-site', workspace: 'old-site', isGit: false, worktrees: new Map(), sessionIds: ['OLD'], lastAt: oldTurns[1].t, stack: [] };
  const engine = new AIEngine({ index: fakeIndex(fx), registry: fakeRegistry([recent, old]), store: fakeStore(), live: { get: () => null } });
  const briefed = () => engine.pendingBriefs([]).map((b) => b.project.name);
  assert.ok(!briefed().includes('old-site'), 'a project untouched for 400 days gets no automatic brief on a first run');
  engine.settings.backfillDays = 500;
  assert.ok(briefed().includes('old-site'), 'a 500-day window reaches it');
  assert.ok(engine.pendingBlocks().some((p) => p.meta.id === 'OLD'), 'and its sessions');
});

test('engine: "Pause" is kept in the settings, so a restart does not resume AI work', () => {
  const fx = sessions();
  const store = fakeStore();
  let saves = 0;
  store.save = () => saves++;
  const first = new AIEngine({ index: fakeIndex(fx), registry: fakeRegistry([fakeProject(fx)]), store, live: { get: () => null } });
  first.pausedByUser = true;
  assert.equal(store.settings.ai.paused, true);
  assert.ok(saves > 0, 'saved with the settings');
  // A restart: a new engine over the same (saved) settings.
  const second = new AIEngine({ index: fakeIndex(fx), registry: fakeRegistry([fakeProject(fx)]), store, live: { get: () => null } });
  assert.equal(second.pausedByUser, true);
  assert.equal(second.guard().ok, false);
  second.pausedByUser = false;
  assert.equal(store.settings.ai.paused, false);
});

// ---------------------------------------------------------------- AI queue (engine.enqueue / pump)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms; ) await sleep(5);
  return cond();
}

test('engine: "Summarize now" writes the project brief after the digests it is meant to include', async () => {
  const fx = sessions();
  const project = fakeProject(fx);
  const engine = new AIEngine({ index: fakeIndex(fx), registry: fakeRegistry([project]), store: fakeStore(), live: { get: () => null } });
  engine.state.blocks = {}; // nothing digested yet (earlier tests save data/ai.json)
  const log = [];
  engine.digestBlock = async ({ block }) => {
    log.push(`start ${block.key}`);
    await sleep(40);
    log.push(`end ${block.key}`);
    return { cost: 0 };
  };
  engine.briefProject = async () => (log.push('brief'), { cost: 0 });
  const blocks = engine.pendingBlocks({ manual: true }).length;
  assert.ok(blocks >= 2, 'the fixture has several blocks to digest');
  assert.equal(engine.summarizeProject(project), blocks + 1);
  assert.ok(await until(() => log.includes('brief')), 'the brief is written');
  const before = log.slice(0, log.indexOf('brief'));
  assert.equal(before.filter((e) => e.startsWith('end ')).length, blocks, `the brief starts once every digest is done: ${log.map((e) => e.split(' ')[0]).join(', ')}`);
  await until(() => engine.running.size === 0);
});

test('engine: a manual job is not stuck behind automatic work the guard holds back', async () => {
  const fx = sessions();
  const project = fakeProject(fx);
  const engine = new AIEngine({ index: fakeIndex(fx), registry: fakeRegistry([project]), store: fakeStore(), live: { get: () => null } });
  engine.state.blocks = {};
  engine.pausedByUser = true; // the guard holds automatic jobs back (as when usage is over the limit)
  const ran = [];
  engine.enqueue({ id: 'auto', kind: 'block', priority: 10, run: async () => (ran.push('auto'), { cost: 0 }) });
  engine.enqueue({ id: 'manual', kind: 'block', priority: 5, manual: true, run: async () => (ran.push('manual'), { cost: 0 }) });
  await until(() => ran.length > 0, 300);
  assert.deepEqual(ran, ['manual'], 'the manual job runs; the automatic one at the head of the queue waits for the guard');
  assert.deepEqual(engine.queue.map((j) => j.id), ['auto']);
  // "Summarize now" while one of the project's blocks already waits as a guarded automatic job: that digest runs
  // (as a manual job now), and the brief comes after it.
  const [first] = engine.pendingBlocks({ manual: true });
  engine.digestBlock = async ({ block }) => (await sleep(20), ran.push(`digest ${block.key}`), { cost: 0 });
  engine.briefProject = async () => (ran.push('brief'), { cost: 0 });
  engine.enqueue({ id: `block:${first.block.key}`, kind: 'block', priority: 10, run: () => engine.digestBlock(first) });
  engine.summarizeProject(project);
  assert.ok(await until(() => ran.includes('brief')), 'the brief is written');
  assert.ok(ran.indexOf(`digest ${first.block.key}`) > 0 && ran.indexOf(`digest ${first.block.key}`) < ran.indexOf('brief'), `the waiting digest ran first: ${ran.join(', ')}`);
  assert.deepEqual(engine.queue.map((j) => j.id), ['auto'], 'automatic work still waits for the guard');
});

test('engine: a CV entry is a manual queue job: within the concurrency limit, counted, one in flight per project', async () => {
  const fx = sessions();
  const projects = ['Acme', 'Beta', 'Gamma'].map((name) => fakeProject(fx, { id: name, name, path: path.join(HOME_DIR, name) }));
  const engine = new AIEngine({ index: fakeIndex(fx), registry: fakeRegistry(projects), store: fakeStore(), live: { get: () => null } }); // concurrency 2
  engine.state.callLog = [];
  engine.state.stats = { calls: 0, cost: 0, errors: 0, lastError: null, lastRunAt: 0, byKind: {} };
  let active = 0;
  let peak = 0;
  const calls = [];
  engine.runCV = async (project, lang) => {
    calls.push(project.name);
    peak = Math.max(peak, ++active);
    await sleep(60);
    active--;
    if (project.name === 'Gamma') throw new Error('the model returned nothing');
    engine.state.cv[project.path] = { lang, at: Date.now(), model: 'sonnet', entry: { title: project.name } };
    return { ok: true, cost: 0.01 };
  };
  const [acme, beta, gamma] = projects;
  // A double tap or a retrying client: three requests for Acme at once, plus one for each other project.
  const out = await Promise.allSettled([engine.writeCV(acme), engine.writeCV(acme), engine.writeCV(acme), engine.writeCV(beta), engine.writeCV(gamma)]);
  assert.deepEqual([...calls].sort(), ['Acme', 'Beta', 'Gamma'], 'one call per project');
  assert.ok(peak <= 2, `at most "concurrency" calls at once (saw ${peak})`);
  assert.equal(engine.state.callLog.length, 3, 'each call counts toward the call caps');
  assert.equal(engine.state.stats.byKind.cv, 2, 'each entry written is counted once');
  for (const r of out.slice(0, 3)) assert.equal(r.value?.entry?.title, 'Acme', 'every Acme request gets the entry');
  assert.equal(out[3].value?.entry?.title, 'Beta');
  assert.equal(out[4].status, 'rejected');
  assert.match(out[4].reason.message, /returned nothing/);
  await engine.writeCV(acme);
  assert.equal(calls.length, 4, 'once done, a new request writes it again');
});
