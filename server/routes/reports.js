// Read-only developer reports built from data Pilotage already has (no AI calls): standups, session exports, tokens.
// Contract: docs/API-REPORTS.md.
import { HOME } from '../config.js';
import { hash, isoDay } from '../util.js';
import { getWorkStore } from '../work/store.js';
import { standupRange, renderStandup, parseDay, addDays, startOfDay, fmtDay } from '../standup.js';
import { renderSessionMarkdown } from '../export.js';

const MAX_TASKS = 8;

export default function ({ route, ctx }) {
  const { index, registry, store, views, json, fail } = ctx;
  const work = getWorkStore();

  /** Open tasks in one status, most important first (the Tasks page order; routes/work.js shares it), with how many
   * were left out. */
  function tasks(status, projectId) {
    const all = work.items.filter((it) => it.status === status && !store.project(it.projectPath).hidden && (!projectId || hash(it.projectPath, 10) === projectId)).sort(ctx.workSort);
    const list = all.slice(0, MAX_TASKS).map((it) => {
      const v = ctx.workView(it);
      return { id: v.id, title: v.title, status: v.status, priority: v.priority, projectId: v.projectId, projectName: v.projectName, dueAt: v.dueAt || null, who: v.who || null };
    });
    return { list, more: all.length - list.length };
  }

  route('GET', '/api/standup', async (req, res, { url }) => {
    const q = url.searchParams;
    const r = standupRange({ range: q.get('range') || undefined, since: q.get('since') || undefined, until: q.get('until') || undefined });
    if (r.error) return fail(res, 400, r.error);
    const projectId = q.get('project') || null;
    let project = null;
    if (projectId) {
      const p = registry.byId(projectId);
      if (!p) return fail(res, 404, 'Project not found');
      project = { id: p.id, name: store.project(p.path).name || p.name };
    }
    const { projects, needsYou } = views.standup({ from: r.from, to: r.to, projectId });
    const doing = tasks('doing', projectId);
    const todo = tasks('todo', projectId);
    const out = { from: r.from, to: r.to, label: r.label, project, projects, doing: doing.list, doingMore: doing.more, todo: todo.list, todoMore: todo.more, needsYou };
    json(res, { ...out, markdown: renderStandup(out, { md: true }) });
  });

  // The conversation as markdown: the turns the session page lists, each one's prompt and final reply read from the
  // transcript at its stored offset (index.turnDetail). `last=N`: only the last N turns.
  route('GET', '/api/sessions/([\\w.-]{8,160})/export', async (req, res, { m, url }) => {
    const d = views.sessionDetail(m[1]);
    if (!d) return fail(res, 404, 'Session not found');
    const last = Math.floor(Number(url.searchParams.get('last')));
    const { turns, shown } = views.turns(m[1], { limit: last > 0 ? last : Number.MAX_SAFE_INTEGER });
    const details = [];
    for (const t of turns) details.push(t.hasDetail ? await index.turnDetail(m[1], t.i) : null);
    json(res, { id: d.id, title: d.title, turns: turns.length, total: shown, markdown: renderSessionMarkdown(d, turns, details, { home: HOME, total: shown }) });
  });

  // Tokens per day, per project and the top sessions. `days=N` (default 30, today included) or `since`/`until` days.
  route('GET', '/api/usage', async (req, res, { url }) => {
    const q = url.searchParams;
    const today = startOfDay(Date.now());
    let from;
    let to = today;
    if (q.get('since')) {
      from = parseDay(q.get('since'));
      if (from == null) return fail(res, 400, 'since must be a date like 2026-11-20');
      if (q.get('until')) {
        to = parseDay(q.get('until'));
        if (to == null) return fail(res, 400, 'until must be a date like 2026-11-20');
      }
      if (from > to || from > today) return fail(res, 400, 'since must be before until (and not in the future)');
    } else {
      const n = q.get('days') == null ? 30 : Number(q.get('days'));
      if (!Number.isInteger(n) || n < 1 || n > 800) return fail(res, 400, 'days must be 1 to 800');
      from = addDays(today, -(n - 1));
    }
    if (to - from > 800 * 86400e3) return fail(res, 400, 'At most 800 days');
    const projectId = q.get('project') || null;
    if (projectId && !registry.byId(projectId)) return fail(res, 404, 'Project not found');
    const top = Math.max(1, Math.min(Number(q.get('top')) || 10, 50));
    const label = from === to ? fmtDay(from) : `${fmtDay(from)} to ${fmtDay(to)}`;
    json(res, { label, ...views.usage({ fromDay: isoDay(from), toDay: isoDay(to), projectId, top }) });
  });
}
