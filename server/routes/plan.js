// Today's plan + triage of suggested tasks (docs/SIMPLIFY.md §4, §6, §10).
// - A task can be flagged for today (plannedFor = local day). Home › Today shows open tasks planned for today or
//   earlier (unfinished ones roll over), plus the AI's focus items for today that the user hasn't accepted or declined yet.
// - Suggested tasks (status 'inbox') can be kept, dismissed with a reason, or snoozed; untouched AI suggestions
//   expire after 7 days (dropped, closedBy 'expired', recoverable).
import { hash, clip, isoDay } from '../util.js';
import { getWorkStore, OPEN_STATUSES, AI_KINDS } from '../work/store.js';
import { similar } from '../work/extract.js';

const DAY = 86400e3;
export const EXPIRE_DAYS = 7;
const SNOOZE_DAYS = 7;
const REASONS = new Set(['not-a-task', 'done', 'duplicate', 'snooze', 'unsnooze']);
const KEY = '([a-f0-9]{12})';

/** Untouched AI suggestions first made more than `days` ago, or whose project has been quiet that long → dropped/expired.
 *  (createdAt, not sourceAt: every summary refresh bumps sourceAt.) Returns the ids. Exported for tests. */
export function expireSuggestions(items, { days = EXPIRE_DAYS, now = Date.now(), onlyAi = true, projectLastAt = null } = {}) {
  const ids = [];
  for (const it of items) {
    if (it.status !== 'inbox' || it.userEdited) continue;
    if (onlyAi && !AI_KINDS.has(it.source.kind)) continue;
    if (it.snoozeUntil && it.snoozeUntil > now) continue;
    // Age counts from when it was suggested, restored by the user, or came back from a snooze ("Not now" must not
    // silently turn into a drop).
    const made = Math.max(it.createdAt || it.sourceAt || now, it.restoredAt || 0, it.snoozeUntil || 0);
    const quietSince = projectLastAt ? projectLastAt(it.projectPath) : null; // null/0 = unknown (e.g. a brand-new project)
    const projectQuiet = !!quietSince && now - quietSince > days * DAY;
    if (now - made <= days * DAY && !projectQuiet) continue;
    it.status = 'dropped';
    it.closedBy = 'expired';
    it.closedEvidenceAt = now;
    it.updatedAt = now;
    ids.push(it.id);
  }
  return ids;
}

export default function ({ route, ctx }) {
  const { store, ai, registry, broadcast, json, fail, every, extendOverview, log } = ctx;
  const work = getWorkStore();
  const today = () => isoDay(Date.now());
  const view = (it) => (ctx.workView ? ctx.workView(it) : it);
  const changed = () => {
    work.save();
    broadcast('work');
  };
  const item = (id, res) => {
    const it = work.get(id);
    if (!it) fail(res, 404, 'Task not found');
    return it;
  };

  /** The AI's focus items for today (only from a brief written in the last 24 h). */
  function focusItems() {
    const d = ai.state.daily;
    if (!d?.brief?.focus?.length || Date.now() - (d.at || 0) > DAY) return [];
    return d.brief.focus.map((f, index) => ({ ...f, index, key: hash(`${f.projectPath || ''}|${f.title || ''}`, 12) }));
  }
  const openIn = (projectPath) => work.items.filter((it) => OPEN_STATUSES.has(it.status) && (!projectPath || it.projectPath === projectPath));
  const matchFor = (f) => openIn(f.projectPath).find((it) => similar(it.title, f.title, { loose: true })) || null;
  /** A task matching this proposal that the user already finished (or dropped) today: the proposal is handled. */
  const closedToday = (f, day) =>
    work.items.some((it) => !OPEN_STATUSES.has(it.status) && it.projectPath === f.projectPath && isoDay(it.doneAt || it.updatedAt || 0) === day && similar(it.title, f.title, { loose: true }));
  const dayList = (map, day) => new Set(store.data[map]?.[day] || []);
  function remember(map, day, key) {
    const pd = (store.data[map] ||= {});
    pd[day] = [...new Set([...(pd[day] || []), key])];
    for (const k of Object.keys(pd)) if (k < isoDay(Date.now() - 7 * DAY)) delete pd[k];
    store.save();
  }
  const rank = (it) => (it.status === 'doing' ? 0 : 1);

  function plan() {
    const day = today();
    const planned = work.items
      .filter((it) => OPEN_STATUSES.has(it.status) && it.plannedFor && it.plannedFor <= day && !store.project(it.projectPath).hidden)
      .sort((a, b) => rank(a) - rank(b) || (b.plannedFor || '').localeCompare(a.plannedFor || '') || b.priority - a.priority);
    const dismissed = dayList('planDismissed', day);
    const accepted = dayList('planAccepted', day);
    const proposals = [];
    for (const f of focusItems()) {
      if (dismissed.has(f.key) || accepted.has(f.key)) continue;
      const m = matchFor(f);
      if (m && m.plannedFor && m.plannedFor <= day) continue; // already in Today
      if (!m && closedToday(f, day)) continue; // done already
      const p = f.projectPath ? registry.projects.get(f.projectPath) : null;
      proposals.push({
        index: f.index,
        key: f.key,
        projectId: p ? p.id : null,
        projectName: p ? store.project(p.path).name || p.name : '',
        workspace: p?.workspace || null,
        title: f.title,
        why: f.why,
        action: f.action,
        matchId: m ? m.id : null,
        matchStatus: m ? m.status : null,
      });
    }
    return { day, today: planned.map(view), proposals };
  }

  extendOverview(() => {
    const now = Date.now();
    const suggested = work.items.filter((it) => it.status === 'inbox' && !(it.snoozeUntil > now) && !store.project(it.projectPath).hidden).length;
    return { plan: plan(), suggestedCount: suggested };
  });

  // Expire stale suggestions on boot and every 30 min.
  const lastAtMap = () => {
    const m = new Map();
    for (const p of ctx.projectsList ? ctx.projectsList() : []) m.set(p.path, p.lastAt || 0);
    return (path) => (m.has(path) ? m.get(path) : null);
  };
  const expire = (why) => {
    // v3 one-time move: AI items the extractor used to put straight into To do become suggestions (the user never picked them).
    if (!work.data.meta.v3Suggested) {
      let moved = 0;
      for (const it of work.items) {
        if (it.status === 'todo' && it.aiBucket === 'todo' && (it.source.kind === 'ai' || it.source.kind === 'brief') && !it.userEdited && !it.plannedFor && !it.startedAt) {
          it.status = 'inbox';
          it.aiBucket = 'inbox';
          moved++;
        }
      }
      work.data.meta.v3Suggested = Date.now();
      log.info(`work: ${moved} AI to-dos moved to Suggested (v3)`);
      changed();
      return; // expire on the next pass, not in the same one
    }
    const visible = work.items.filter((it) => !store.project(it.projectPath).hidden);
    const ids = expireSuggestions(visible, { projectLastAt: lastAtMap() });
    if (ids.length) {
      log.info(`work: ${ids.length} suggestions expired (${why}, untouched > ${EXPIRE_DAYS} d)`);
      changed();
    }
  };
  setTimeout(() => expire('startup'), 15_000).unref?.();
  every(30 * 60e3, async () => expire('periodic'));

  route('POST', '/api/work/([\\w-]{4,40})/today', async (req, res, { m, body }) => {
    const it = item(m[1], res);
    if (!it) return;
    if (body.on) {
      it.plannedFor = today();
      if (it.status === 'inbox') it.status = 'todo';
      it.snoozeUntil = null;
      it.userEdited = true; // planned = the user's; the AI only gives hints from now on
    } else it.plannedFor = null;
    it.updatedAt = Date.now();
    changed();
    json(res, view(it));
  });

  route('POST', '/api/work/([\\w-]{4,40})/dismiss', async (req, res, { m, body }) => {
    const it = item(m[1], res);
    if (!it) return;
    if (!REASONS.has(body.reason)) return fail(res, 400, 'Unknown reason');
    const reason = body.reason;
    const now = Date.now();
    if (reason === 'snooze') {
      it.snoozeUntil = now + SNOOZE_DAYS * DAY;
    } else if (reason === 'unsnooze') {
      it.snoozeUntil = null;
    } else {
      it.status = reason === 'done' ? 'done' : 'dropped';
      it.doneAt = reason === 'done' ? now : it.doneAt;
      it.dismissReason = reason;
      it.closedBy = 'user';
      it.userEdited = true;
      it.plannedFor = null;
    }
    it.updatedAt = now;
    changed();
    json(res, view(it));
  });

  route('POST', '/api/work/dismiss-old', async (req, res, { body }) => {
    const days = Math.max(1, Math.min(365, Number(body.days) || EXPIRE_DAYS));
    const ids = expireSuggestions(work.items.filter((it) => !store.project(it.projectPath).hidden), { days });
    for (const id of ids) {
      const it = work.get(id);
      it.closedBy = 'user';
      it.dismissReason = 'old';
    }
    if (ids.length) changed();
    json(res, { ok: true, ids });
  });

  route('POST', '/api/work/restore', async (req, res, { body }) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 1000) : [];
    let n = 0;
    for (const id of ids) {
      const it = work.get(id);
      if (!it || OPEN_STATUSES.has(it.status)) continue;
      it.status = 'inbox';
      it.closedBy = null;
      it.dismissReason = null;
      it.doneAt = null;
      it.restoredAt = Date.now(); // expiry counts from here, so it doesn't go away again
      it.updatedAt = Date.now();
      n++;
    }
    if (n) changed();
    json(res, { ok: true, restored: n });
  });

  route('POST', `/api/plan/focus/${KEY}`, async (req, res, { m, body }) => {
    const f = focusItems().find((x) => x.key === m[1]);
    if (!f) return fail(res, 404, 'That suggestion is no longer in today’s plan');
    const day = today();
    if (body.action === 'dismiss') {
      remember('planDismissed', day, f.key);
      broadcast('overview');
      return json(res, { ok: true });
    }
    if (body.action !== 'accept') return fail(res, 400, 'action must be accept or dismiss');
    let it = matchFor(f);
    if (it) {
      it.plannedFor = day;
      if (it.status === 'inbox') it.status = 'todo';
      it.userEdited = true;
      it.snoozeUntil = null;
      it.updatedAt = Date.now();
    } else {
      if (!f.projectPath || !registry.projects.get(f.projectPath)) return fail(res, 400, 'This suggestion has no project');
      it = work.add({
        projectPath: f.projectPath,
        title: clip(f.title, 200),
        detail: [f.why, f.action ? `First prompt: ${f.action}` : ''].filter(Boolean).join('\n\n'),
        status: 'todo',
        priority: 2,
        source: { kind: 'user', from: 'focus' },
        userEdited: true,
        plannedFor: day,
      });
    }
    remember('planAccepted', day, f.key); // done or removed later, it doesn't come back as a proposal today
    changed();
    json(res, view(it));
  });
}
