// Task text: short to-do titles from the AI (digest.todo, brief.todos), extraction limits (recent sessions only, top 2
// brief steps, 3 suggestions per project, cross-folder dedupe), the one-time cleanup pass and starter tasks of a new
// project. Pure: no server, no AI (fake callers), no real $HOME writes. All names and projects are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PILOTAGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-tasks-'));
(await import('../server/store.js')).getStore().settings.profile.name = 'Sam';
const { reconcile, toTitle, shortTitle, capSuggestions, LOOP_DAYS, MAX_OPEN_SUGGESTIONS } = await import('../server/work/extract.js');
const { normalizeItem } = await import('../server/work/store.js');
const { sanitizeDigest, briefSteps } = await import('../server/ai/engine.js');
const { dropOldSuggestions, buildCleanupInput, applyCleanup, cleanupTargets, makeCleanup } = await import('../server/work/retitle.js');
const { buildHandoff, MAX_STARTER_TASKS } = await import('../server/work/spinoff.js');
const { EXPIRE_DAYS } = await import('../server/routes/plan.js');

const DAY = 86400e3;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const P = '/home/u/bakery';
const SUB = '/home/u/bakery/admin';
const Q = '/home/u/garage';

const digest = (nextStep, extra = {}) => ({ title: 'Some work', summary: 's', outcome: 'o', status: 'in_progress', nextStep, todo: '', who: null, topic: 't', kind: 'build', cvWorthy: false, highlights: [], ...extra });
const blk = (sid, i, ageDays, projectPath, d) => [`${sid}:${i}`, { sessionId: sid, projectPath, startAt: NOW - ageDays * DAY - 3600e3, endAt: NOW - ageDays * DAY, digest: d }];
const inputOf = (blocks, briefs = {}, activity = {}) => ({
  blocks,
  briefs,
  projectOfSession: (sid, fallback) => fallback,
  project: (p) => ({ lastActivityAt: activity[p] ?? NOW - DAY, hidden: false, closed: false }),
  sessionHidden: () => false,
  launchSession: () => null,
});
const open = (data) => data.items.filter((i) => i.status === 'inbox');

test('digest and brief keep the short to-do and who; unknown who is dropped', () => {
  const d = sanitizeDigest(digest('Update the oven schedule in `schedule.yml`, then redeploy with `npm run ship`.', { todo: '  Update the oven schedule and redeploy the site for the weekend opening hours  ', who: 'claude' }));
  assert.ok(d.todo.length <= 60);
  assert.equal(d.who, 'claude');
  assert.equal(sanitizeDigest(digest('x', { who: 'the user' })).who, null);
  const b = briefSteps({ nextSteps: ['Step one for Claude, with the details', '', 'Step two', 'Step three', 'Step four'], todos: ['Do one', 'skipped', 'Do two', 'Do three'], whos: ['you', 'claude', 'claude', 'nobody'] });
  assert.deepEqual(b.nextSteps, ['Step one for Claude, with the details', 'Step two', 'Step three']);
  assert.deepEqual(b.todos, ['Do one', 'Do two', 'Do three'], 'todos stay parallel to the steps they belong to');
  assert.deepEqual(b.whos, ['you', 'claude', null]);
});

test('titles: the AI to-do wins; old summaries fall back to a shortened step without conditions or reasons', () => {
  assert.equal(shortTitle('fix the double reminder emails.', 'A long step about reminder emails in mailer.js'), 'Fix the double reminder emails');
  assert.ok(shortTitle('x'.repeat(200), '').length <= 60);
  assert.equal(toTitle('Only after the cause is clear, propose a patch and ask Sam to confirm before flashing the firmware'), 'Propose a patch and ask Sam to confirm');
  assert.equal(toTitle('Rotate the payment webhook secret since the old one was pasted in a public chat'), 'Rotate the payment webhook secret');
  assert.equal(toTitle('Once the printer replies, compare the two quotes for the menu cards'), 'Compare the two quotes for the menu cards');
  assert.equal(toTitle('Mark the March invoice from the flour supplier as paid'), 'Mark the March invoice from the flour supplier as paid', '"as" alone is not a cut');
});

test('extraction: to-do titles, step as detail, waiting skipped, only recent sessions, who kept', () => {
  const blocks = Object.fromEntries([
    blk('S1', 0, 1, P, digest('Open checkout.ts and retry the card flow on staging with the test card; the 3DS popup closes too early.', { todo: 'Fix the card checkout popup', who: 'claude' })),
    blk('S2', 0, 2, P, digest('Get the supplier to send the new price list for the spring menu.', { todo: 'Get the new supplier price list', who: 'waiting', status: 'blocked' })),
    blk('S3', 0, LOOP_DAYS + 2, Q, digest('Replace the brake light relay on the demo car.', { todo: 'Replace the brake light relay', who: 'you' })),
    blk('S4', 0, 3, Q, digest('Sam to call the paint shop about the delivery date of the red primer.')),
  ]);
  const data = { items: [], tombstones: [] };
  reconcile(data, inputOf(blocks), NOW);
  const titles = data.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Call the paint shop about the delivery date of the red primer', 'Fix the card checkout popup']);
  const card = data.items.find((i) => i.title === 'Fix the card checkout popup');
  assert.equal(card.detail, 'Open checkout.ts and retry the card flow on staging with the test card; the 3DS popup closes too early.', 'detail = the step only, no outcome recap');
  assert.equal(card.who, 'claude');
  assert.equal(data.items.find((i) => /paint shop/.test(i.title)).who, null);
});

test('extraction: top 2 brief steps, their own to-do even after a git-hygiene step is skipped', () => {
  const briefs = {
    [P]: {
      at: NOW - 3600e3,
      brief: {
        nextSteps: ['Commit the 12 uncommitted changes in the admin folder', 'Write the allergen labels for the new pastries with the regulator wording', 'Order the new display fridge', 'Plan the summer opening hours'],
        todos: ['Commit the changes', 'Write the allergen labels', 'Order the display fridge', 'Plan summer hours'],
        whos: ['claude', 'you', 'you', 'you'],
      },
    },
  };
  const data = { items: [], tombstones: [] };
  reconcile(data, inputOf({}, briefs), NOW);
  assert.deepEqual(data.items.map((i) => i.title), ['Write the allergen labels', 'Order the display fridge']);
  assert.equal(data.items[0].detail, 'Write the allergen labels for the new pastries with the regulator wording');
  assert.equal(data.items[0].priority, 2);
  assert.equal(data.items[0].who, 'you');
});

test('extraction: the same step in a subfolder project merges into one task (title or step text)', () => {
  const step = 'Merge the pull request for the order dashboard once the reviewer approves the layout changes';
  const blocks = Object.fromEntries([blk('S1', 0, 1, P, digest(step, { todo: 'Get the dashboard PR merged' })), blk('S2', 0, 0.5, SUB, digest(`${step}.`, { todo: 'Merge the order dashboard PR' }))]);
  const data = { items: [], tombstones: [] };
  reconcile(data, inputOf(blocks), NOW);
  assert.equal(data.items.length, 1, JSON.stringify(data.items.map((i) => [i.projectPath, i.title])));
  assert.equal(data.items[0].keys.length, 2);
  // unrelated folders stay apart
  const other = { items: [], tombstones: [] };
  reconcile(other, inputOf(Object.fromEntries([blk('S1', 0, 1, P, digest(step)), blk('S2', 0, 0.5, Q, digest(step))])), NOW);
  assert.equal(other.items.length, 2);
});

test('extraction: at most 3 open suggestions per project, the oldest expire; snoozed and edited ones are not counted', () => {
  const blocks = Object.fromEntries(['Bake the test batch', 'Price the wedding cake', 'Print the new menu', 'Book the oven repair', 'Call the flour mill'].map((t, i) => blk(`S${i}`, 0, 5 - i, P, digest(`${t} for the shop.`, { todo: t }))));
  const data = { items: [], tombstones: [] };
  const st = reconcile(data, inputOf(blocks), NOW);
  assert.equal(MAX_OPEN_SUGGESTIONS, 3);
  assert.equal(open(data).length, 3);
  assert.equal(st.expired, 2);
  assert.deepEqual(open(data).map((i) => i.title).sort(), ['Book the oven repair', 'Call the flour mill', 'Print the new menu'], 'the newest stay');
  const gone = data.items.filter((i) => i.status === 'dropped');
  assert.ok(gone.every((i) => i.closedBy === 'expired'), 'expired = restorable, not the user saying no');
  // a second pass changes nothing (expired items keep their keys, so they are not recreated)
  const again = reconcile(data, inputOf(blocks), NOW + 60e3);
  assert.equal(again.created + again.expired, 0);
  // the user's own picks don't count toward the cap
  const items = [1, 2, 3, 4].map((n) => normalizeItem({ id: `ai_${n}`, projectPath: Q, title: `T${n}`, status: 'inbox', source: { kind: 'ai' }, sourceAt: NOW - n * DAY, snoozeUntil: n === 4 ? NOW + DAY : null }));
  assert.equal(capSuggestions(items, NOW), 0);
});

test('extraction: a shortened title is never replaced by the long wording again', () => {
  const step = 'Ask the landlord whether the new shop sign can go above the door, and send the drawing from signs/v2.pdf.';
  const blocks = Object.fromEntries([blk('S1', 0, 1, P, digest(step))]);
  const data = { items: [], tombstones: [] };
  reconcile(data, inputOf(blocks), NOW);
  const it = data.items[0];
  it.title = 'Ask the landlord about the shop sign';
  it.titleBy = 'short';
  blocks['S1:0'].digest = digest(`${step} Mention the lighting too.`);
  reconcile(data, inputOf(blocks), NOW + 60e3);
  assert.equal(it.title, 'Ask the landlord about the shop sign');
  assert.match(it.detail, /lighting/, 'the step text itself still follows the summary');
  assert.equal(normalizeItem(it).titleBy, 'short', 'kept on save/load');
});

test('suggestions expire after 7 days', () => {
  assert.equal(EXPIRE_DAYS, 7);
});

// ---------------------------------------------------------------- one-time cleanup (work/retitle.js)

function oldBoard() {
  const mk = (id, title, detail, extra = {}) => normalizeItem({ id, projectPath: P, title, detail, status: 'inbox', source: { kind: 'brief' }, keys: [`brf:x:${id}`], createdAt: NOW - 3 * DAY, sourceAt: NOW - 2 * DAY, ...extra });
  return [
    mk('ai_old', 'Retest the delivery zone map on the old tablet', 'Retest the delivery zone map on the old tablet with the Friday orders.', { sourceAt: NOW - 20 * DAY, source: { kind: 'ai', sessionId: 'S9' } }),
    mk('ai_rule', 'Run npm run lint before any further publishing', 'Run npm run lint before any further publishing.\n\nFrom the project summary.'),
    mk('ai_long', 'Confirm in the hosting dashboard that the API keys, the broker password and the mail…', 'Confirm in the hosting dashboard that the API keys, the broker password and the mail token were rotated.'),
    mk('ai_dup', 'Check the hosting dashboard for the rotated keys', 'Check the hosting dashboard that the keys were rotated after the leak.', { projectPath: SUB }),
    mk('ai_mine', 'Call the bank about the card reader fee', 'Call the bank about the card reader fee.', { userEdited: true }),
    mk('k_spin', 'Only after the cause is clear, propose a patch and ask Sam to confirm', 'Only after the cause is clear, propose a patch and ask Sam to confirm.', { status: 'todo', aiBucket: 'todo', source: { kind: 'spinoff' } }),
    mk('ai_kept', 'Write the onboarding email for the first wholesale clients', 'Write the onboarding email for the first wholesale clients.', { status: 'todo', source: { kind: 'ai' } }),
  ];
}

test('cleanup phase 1: suggestions from sources older than 10 days are dropped, restorable, and stay dropped', () => {
  const items = oldBoard();
  assert.equal(dropOldSuggestions(items, NOW), 1);
  const old = items.find((i) => i.id === 'ai_old');
  assert.equal(old.status, 'dropped');
  assert.equal(old.closedBy, 'ai');
  // extraction: the loop is still the session's latest (old) block → evidence "open", but not newer than the drop
  const data = { items, tombstones: [] };
  old.keys = ['blk:S9:0'];
  reconcile(data, inputOf(Object.fromEntries([blk('S9', 0, 20, P, digest('Retest the delivery zone map on the old tablet with the Friday orders.'))])), NOW + 60e3);
  assert.equal(old.status, 'dropped');
});

test('cleanup phase 2: one prompt with every untouched task; answers retitle, drop rules and merge duplicates', () => {
  const items = oldBoard();
  dropOldSuggestions(items, NOW);
  const { instruction, input, ids } = buildCleanupInput(items, (p) => path.basename(p));
  assert.deepEqual(ids.sort(), ['ai_dup', 'ai_kept', 'ai_long', 'ai_rule', 'k_spin']);
  assert.match(instruction, /never "Sam"/, "the user's name comes from Settings");
  assert.match(input, /^ai_long \| bakery \| Confirm in the hosting dashboard/m);
  assert.ok(!input.includes('From the project summary'), 'only the step text, not the old recap');
  assert.ok(!/ai_mine|ai_old/.test(input), 'edited and dropped items are left alone');
  const answer = {
    items: [
      { id: 'ai_rule', todo: 'Run the lint', who: 'claude', keep: false, dupOf: '' },
      { id: 'ai_long', todo: 'finish rotating the hosting secrets.', who: 'you', keep: true, dupOf: '' },
      { id: 'ai_dup', todo: 'Check the rotated keys', who: 'you', keep: true, dupOf: 'ai_long' },
      { id: 'k_spin', todo: 'Propose a patch', who: 'claude', keep: false, dupOf: '' },
      { id: 'ai_kept', todo: 'Write the wholesale onboarding email', who: 'claude', keep: false, dupOf: '' },
      { id: 'ai_mine', todo: 'Call the bank', who: 'you', keep: false, dupOf: '' },
      { id: 'nope', todo: 'x', who: 'you', keep: true, dupOf: '' },
    ],
  };
  const st = applyCleanup(items, answer, NOW);
  const get = (id) => items.find((i) => i.id === id);
  assert.deepEqual(st, { retitled: 2, dropped: 2, merged: 1 });
  assert.equal(get('ai_long').title, 'Finish rotating the hosting secrets');
  assert.equal(get('ai_long').titleBy, 'short');
  assert.equal(get('ai_long').who, 'you');
  assert.deepEqual(get('ai_long').keys.sort(), ['brf:x:ai_dup', 'brf:x:ai_long'], 'the duplicate’s sources attach to the kept task');
  assert.equal(get('ai_dup').status, 'dropped');
  assert.equal(get('ai_dup').dismissReason, 'duplicate');
  assert.equal(get('ai_rule').status, 'dropped');
  assert.equal(get('ai_rule').closedBy, 'ai', 'restorable');
  assert.equal(get('k_spin').status, 'dropped', 'a spin-off guardrail the user never picked goes too');
  assert.equal(get('ai_kept').status, 'todo', 'a task the user kept is only retitled, never dropped');
  assert.equal(get('ai_kept').title, 'Write the wholesale onboarding email');
  assert.equal(get('ai_mine').title, 'Call the bank about the card reader fee', 'user-edited tasks are never touched');
  assert.equal(cleanupTargets(items).filter((i) => i.titleBy !== 'short').length, 0);
});

function cleanupHarness({ guard = { ok: true }, enabled = true, answer = null, fail = null } = {}) {
  const work = { data: { items: oldBoard(), meta: {} } };
  const jobs = [];
  const calls = [];
  const ai = { settings: { enabled, autoDigest: true, digestModel: 'haiku' }, guard: () => guard, enqueue: (job) => (jobs.some((j) => j.id === job.id) ? false : (jobs.push(job), true)) };
  const callAI = async (args) => {
    calls.push(args);
    if (fail) return { ok: false, error: fail };
    return { ok: true, data: answer || { items: [{ id: 'ai_long', todo: 'Finish rotating the hosting secrets', who: 'you', keep: true, dupOf: '' }] } };
  };
  let saves = 0;
  const c = makeCleanup({ work, ai, callAI, projectName: (p) => path.basename(p), changed: () => saves++, log: { info() {}, warn() {} }, now: () => NOW, classify: (r) => (/limit/.test(r.error) ? 'busy' : 'input') });
  return { c, work, jobs, calls, saves: () => saves };
}

test('cleanup scheduler: goes through the AI queue once, respects PILOTAGE_NO_AI, Settings and the usage guard', async () => {
  const prev = process.env.PILOTAGE_NO_AI;
  try {
    process.env.PILOTAGE_NO_AI = '1';
    let h = cleanupHarness();
    assert.equal(h.c.tick(), 'no-ai');
    assert.equal(h.jobs.length, 0);
    assert.ok(h.work.data.meta.cleanup.droppedAt, 'phase 1 needs no AI');
    delete process.env.PILOTAGE_NO_AI;

    assert.equal(cleanupHarness({ enabled: false }).c.tick(), 'off');
    h = cleanupHarness({ guard: { ok: false, reason: '5-hour usage at 90%' } });
    assert.equal(h.c.tick(), 'guard');
    assert.equal(h.jobs.length, 0, 'nothing queued while the usage guard says no');

    h = cleanupHarness();
    assert.equal(h.c.tick(), 'queued');
    assert.equal(h.c.tick(), 'pending', 'never queued twice');
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].manual, undefined, 'not a manual job: the engine applies the guard before running it');
    await h.jobs[0].run();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].model, 'haiku');
    assert.ok(h.calls[0].schema);
    assert.equal(h.work.data.items.find((i) => i.id === 'ai_long').title, 'Finish rotating the hosting secrets');
    assert.ok(h.work.data.meta.cleanup.doneAt);
    assert.equal(h.c.tick(), 'done', 'runs once');
  } finally {
    if (prev === undefined) delete process.env.PILOTAGE_NO_AI;
    else process.env.PILOTAGE_NO_AI = prev;
  }
});

test('cleanup scheduler: a busy provider does not count; repeated bad answers give up', async () => {
  const prev = process.env.PILOTAGE_NO_AI;
  delete process.env.PILOTAGE_NO_AI;
  try {
    const busy = cleanupHarness({ fail: 'usage limit reached' });
    busy.c.tick();
    await assert.rejects(busy.jobs[0].run());
    assert.equal(busy.work.data.meta.cleanup.attempts, 0);
    const bad = cleanupHarness({ fail: 'no structured output' });
    for (let i = 0; i < 3; i++) {
      bad.jobs.length = 0;
      assert.equal(bad.c.tick(), 'queued');
      await assert.rejects(bad.jobs[0].run());
    }
    assert.equal(bad.c.tick(), 'gave-up');
    assert.equal(bad.c.tick(), 'done');
  } finally {
    if (prev !== undefined) process.env.PILOTAGE_NO_AI = prev;
  }
});

// ---------------------------------------------------------------- Pick up + new-project tasks

test('Pick up shows the short to-do; the Claude-facing step stays available', async () => {
  const { Views } = await import('../server/views.js');
  const meta = { id: 's1', cwd: P, customTitle: 'Shop site', counts: { h: 3 }, lastAt: Date.now() - 3600e3, startedAt: Date.now() - 7200e3 };
  const proj = { id: 'pb', path: P, name: 'bakery', workspace: null, attention: [] };
  const b = { key: 's1:0', startAt: meta.startedAt, endAt: meta.lastAt };
  const mk = (d) =>
    new Views({
      index: { list: () => [meta], get: () => meta, loadTurns: () => [] },
      registry: { projects: new Map([[P, proj]]), projectOfSession: () => proj, resolve: () => null, gitOf: () => ({}), byId: () => null },
      store: { project: () => ({}), session: () => ({}), data: { ideas: [], workspaces: {}, pickupHidden: {} }, settings: {} },
      live: { get: () => null },
      ai: { blocksOf: () => [b], blockView: () => ({}), digestOf: () => d, state: { projects: {}, blocks: { 's1:0': { digest: d } }, cv: {}, daily: null } },
      processes: () => [],
    });
  const step = 'Open menu.ts and add the gluten-free badge to the three new pastries, then redeploy with npm run ship.';
  let row = mk(digest(step, { todo: 'Add the gluten-free badges' })).pickup([proj])[0];
  assert.equal(row.todo, 'Add the gluten-free badges');
  assert.equal(row.nextStep, step);
  row = mk(digest(step)).pickup([proj])[0];
  assert.equal(row.todo, 'Open menu.ts and add the gluten-free badge to the three new pastries', 'older summaries: a shortened step');
});

test('new projects: at most 2 starter tasks, the AI’s to-dos for the user (never Claude’s first steps)', async () => {
  const ai = await buildHandoff({
    name: 'Catering',
    goal: 'Take catering orders online',
    callAI: async () => ({ ok: true, data: { background: '', relevantFiles: [], openQuestions: [], firstSteps: ['Read this file', 'Sketch the order form', 'Ask Sam before adding payments'], tasks: ['Pick the catering menu', 'Set the minimum order', 'Choose a payment provider'] } }),
  });
  assert.equal(MAX_STARTER_TASKS, 2);
  assert.deepEqual(ai.tasks.map((t) => t.title), ['Pick the catering menu', 'Set the minimum order']);
  assert.ok(ai.markdown.includes('Sketch the order form'), 'first steps stay in CLAUDE.md');
  const none = await buildHandoff({ name: 'Catering', goal: 'g', callAI: async () => ({ ok: true, data: { background: '', relevantFiles: [], openQuestions: [], firstSteps: ['Read this file'], tasks: [] } }) });
  assert.deepEqual(none.tasks.map((t) => t.title), ['Plan the first version of Catering']);
  const tpl = await buildHandoff({ name: 'Catering', goal: 'g' });
  assert.equal(tpl.tasks.length, 1);
});
