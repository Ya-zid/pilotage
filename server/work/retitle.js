// One-time cleanup of the task suggestions made before the short-title rules (titles were Claude's working
// instructions: long, with file names, conditions and the user's name; duplicates across folders; stale ones).
//
// Phase 1, no AI: open suggestions whose source is older than LOOP_DAYS are dropped (closedBy 'ai', restorable).
// Phase 2, ONE batched AI call through the engine queue (so the usage guard, the call caps, Settings › AI and
//   PILOTAGE_NO_AI all apply): every remaining untouched suggestion gets a short to-do title (titleBy 'short', which
//   extraction never overwrites), a "who", and is dropped when it is a rule/doubt/stale, or merged into a duplicate.
// The state lives in work.json meta.cleanup; once done it never runs again. Failures retry a few times, then give up.
import { clip, oneLine } from '../util.js';
import { OPEN_STATUSES, AI_KINDS, WHO } from './store.js';
import { LOOP_DAYS, TODO_MAX, stepText } from './extract.js';
import { userName } from '../profile.js';

export const CLEANUP_VERSION = 1;
const DAY = 86400e3;
const MAX_ITEMS = 120; // one call; anything beyond (unlikely) is left to the normal 7-day expiry
const MAX_ATTEMPTS = 3; // failures of this input (not a busy/logged-out provider) before giving up

const CLEANUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description: 'One entry per task line on stdin, same ids.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'The id from stdin, copied exactly' },
          todo: { type: 'string', description: '3-7 words, verb first, plain words. No file names, paths, commands, env vars, dates, reasons or conditions.' },
          who: { type: 'string', enum: WHO },
          keep: { type: 'boolean', description: 'false for a standing rule or a guardrail for Claude, a doubt ("check whether X is still true"), git housekeeping, or something done or no longer relevant' },
          dupOf: { type: 'string', description: 'The id of another task on stdin that is the same piece of work (the one to keep), else empty string' },
        },
        required: ['id', 'todo', 'who', 'keep', 'dupOf'],
      },
    },
  },
  required: ['items'],
};

/** Fictional examples (the repo is public): what a Claude-facing step becomes. */
const EXAMPLES = [
  ['Only after the cause is clear, propose a patch and ask Sam to confirm before flashing the firmware', 'keep: false (a guardrail for Claude)'],
  ['Confirm in the hosting dashboard that the API keys, the broker password and the mail token were rotated', '"Finish rotating the hosting secrets", you'],
  ['Start a new SEO site scan named "shop-after" with a page limit of 100', '"Run a new SEO site scan", you'],
  ['Get the exact error log and firmware version from the client\'s tablet so the crash can be reproduced', '"Get the crash log from the client", waiting'],
  ['Check whether the spring promo code is still meant to be active', 'keep: false (a doubt, not a task)'],
  ['Run npm run lint before any further publishing', 'keep: false (a standing rule)'],
  ['Build 4 fps contact sheets of v3 and of the reference film before showing v3', '"Compare v3 with the reference film", claude'],
];

const isTarget = (it) => AI_KINDS.has(it.source.kind) && !it.userEdited && !it.plannedFor && (it.status === 'inbox' || (it.status === 'todo' && !it.startedAt));
/** Never chosen by the user: may be dropped. (An AI item in To do was kept by the user, unless a spin-off made it there.) */
const droppable = (it) => it.status === 'inbox' || (it.source.kind === 'spinoff' && it.status === 'todo' && it.aiBucket === 'todo');

/** Untouched AI suggestions the cleanup rewrites, newest evidence first. */
export function cleanupTargets(items) {
  return items.filter(isTarget).sort((a, b) => (b.sourceAt || 0) - (a.sourceAt || 0));
}

function close(it, reason, now) {
  it.status = 'dropped';
  it.closedBy = 'ai'; // shown as "closed automatically", restorable
  it.aiStatus = 'stale'; // with closedEvidenceAt: extraction only reopens it on newer evidence (extract.js)
  it.closedEvidenceAt = now;
  it.dismissReason = reason;
  it.plannedFor = null;
  it.updatedAt = now;
}

/** Phase 1: drop untouched suggestions whose source is older than `days`. Returns how many. */
export function dropOldSuggestions(items, now = Date.now(), days = LOOP_DAYS) {
  let n = 0;
  for (const it of items) {
    if (it.status !== 'inbox' || it.userEdited || it.restoredAt || !AI_KINDS.has(it.source.kind) || (it.snoozeUntil && it.snoozeUntil > now)) continue;
    if (now - (it.sourceAt || it.createdAt || now) <= days * DAY) continue;
    close(it, 'old', now);
    n++;
  }
  return n;
}

/** The prompt for phase 2. `projectName(path)` gives display names. Returns {instruction, input, ids}. */
export function buildCleanupInput(items, projectName = (p) => p.split('/').pop(), name = userName()) {
  const targets = cleanupTargets(items).slice(0, MAX_ITEMS);
  const lines = targets.map((it) => {
    const step = clip(oneLine(stepText(it.detail)), 280);
    return `${it.id} | ${projectName(it.projectPath)} | ${oneLine(it.title)}${step && step !== oneLine(it.title) ? ` | ${step}` : ''}`;
  });
  const instruction =
    `You tidy the task list ${name} keeps in Pilotage, a cockpit for Claude Code sessions. Each line on stdin is one task (id | project | title | full step). ` +
    `They were written as working notes for Claude, not for ${name}. Fill the JSON schema with one entry per id. ` +
    `todo: the task as a to-do ${name} reads on a phone, 3-7 words, verb first, plain words; never "${name}", "the user" or "Claude"; keep a name or product only when it is needed to know which thing. ` +
    `who: you = ${name} acts by hand (call, decide, send, pay, test on a device); claude = a Claude session can do it; waiting = blocked on someone else. ` +
    'keep: false for a standing rule or a guardrail for Claude ("run X before publishing", "only after X, do Y", "ask before…"), a doubt ("check whether X is still true"), git housekeeping, or something that looks done or stale. ' +
    'dupOf: when tasks (often in the same project or a folder inside it) are the same piece of work, give the others the id of the one to keep; else "". ' +
    `Examples:\n${EXAMPLES.map(([a, b]) => `- "${a}" → ${b}`).join('\n')}`;
  return { instruction, input: lines.join('\n'), ids: targets.map((it) => it.id) };
}

/** Phase 2: apply the model's answer. Only items still untouched are changed. Returns counts. */
export function applyCleanup(items, answer, now = Date.now()) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const ans = new Map();
  for (const a of Array.isArray(answer?.items) ? answer.items : []) if (a && typeof a.id === 'string' && byId.has(a.id)) ans.set(a.id, a);
  const stats = { retitled: 0, dropped: 0, merged: 0 };
  const rootOf = (id) => {
    const seen = new Set([id]);
    let t = String(ans.get(id)?.dupOf || '');
    while (t && ans.get(t)?.dupOf && !seen.has(t)) {
      seen.add(t);
      t = String(ans.get(t).dupOf);
    }
    return t && t !== id ? t : '';
  };
  const retitle = (it, a) => {
    const todo = clip(oneLine(a.todo).replace(/[\s.;:,–—-]+$/, ''), TODO_MAX);
    if (todo) {
      it.title = todo[0].toUpperCase() + todo.slice(1);
      it.titleBy = 'short';
    }
    if (WHO.includes(a.who)) it.who = a.who;
    it.updatedAt = now;
    stats.retitled++;
  };
  // Keepers first (titles, drops), then duplicates, so a duplicate only merges into an item that is still open.
  const order = [...ans.values()].sort((a, b) => Number(!!rootOf(a.id)) - Number(!!rootOf(b.id)));
  for (const a of order) {
    const it = byId.get(a.id);
    if (!isTarget(it)) continue;
    const root = rootOf(a.id);
    const keeper = root ? byId.get(root) : null;
    // The same work in unrelated folders (one secret rotated in three apps) is one task for the user too.
    if (keeper && droppable(it) && OPEN_STATUSES.has(keeper.status)) {
      // Its sources attach to the kept item from now on, so extraction neither recreates nor reopens this one.
      for (const k of it.keys) if (!keeper.keys.includes(k)) keeper.keys.push(k);
      it.keys = [];
      close(it, 'duplicate', now);
      stats.merged++;
      continue;
    }
    if (a.keep === false && droppable(it)) {
      close(it, 'not-a-task', now);
      stats.dropped++;
      continue;
    }
    retitle(it, a);
  }
  return stats;
}

/**
 * The scheduler: tick() runs phase 1 once and queues phase 2 when the AI may run. Safe to call often.
 * deps: { work (WorkStore), ai (AIEngine: settings, guard(), enqueue()), callAI, projectName, changed(), log, now() }
 */
export function makeCleanup({ work, ai, callAI, projectName, changed = () => {}, log = console, now = () => Date.now(), classify = () => 'input' }) {
  const meta = () => (work.data.meta.cleanup ||= { v: CLEANUP_VERSION, attempts: 0 });
  const save = (patch) => {
    Object.assign(meta(), patch);
    changed();
  };
  function tick() {
    const st = meta();
    if (st.doneAt) return 'done';
    if (!st.droppedAt) {
      const n = dropOldSuggestions(work.data.items, now());
      save({ droppedAt: now(), dropped: n });
      if (n) log.info(`work cleanup: ${n} suggestions from sessions older than ${LOOP_DAYS} days dropped (restorable)`);
    }
    if (process.env.PILOTAGE_NO_AI === '1') return 'no-ai';
    if (!ai?.settings?.enabled || ai.settings.autoDigest === false) return 'off';
    if ((st.attempts || 0) >= MAX_ATTEMPTS) {
      save({ doneAt: now(), gaveUp: true });
      log.warn('work cleanup: gave up on shortening the old task titles');
      return 'gave-up';
    }
    const { instruction, input, ids } = buildCleanupInput(work.data.items, projectName);
    if (!ids.length) {
      save({ doneAt: now(), retitled: 0 });
      return 'done';
    }
    const g = ai.guard();
    if (!g.ok) return 'guard'; // usage limit, paused, call cap: tried again on the next tick
    const queued = ai.enqueue({
      id: `work-cleanup:v${CLEANUP_VERSION}`,
      kind: 'cleanup',
      priority: 4, // after session summaries and project briefs, before the daily plan
      label: 'Tidy task titles',
      run: async () => {
        if (meta().doneAt) return { cost: 0 };
        const r = await callAI({ purpose: 'digest', instruction, input, schema: CLEANUP_SCHEMA, model: ai.settings.digestModel || 'haiku', timeout: 200_000 });
        if (!r?.ok) {
          const cls = classify(r || {});
          if (cls === 'input' || cls === 'flaky') save({ attempts: (meta().attempts || 0) + 1, lastError: clip(String(r?.error || 'failed'), 200) });
          const e = new Error(r?.error || 'cleanup call failed');
          e.aiClass = cls;
          throw e;
        }
        const s = applyCleanup(work.data.items, r.data, now());
        save({ doneAt: now(), ...s });
        log.info(`work cleanup: ${s.retitled} titles shortened, ${s.dropped} dropped, ${s.merged} merged`);
        return r;
      },
    });
    return queued ? 'queued' : 'pending';
  }
  return { tick, state: meta };
}
