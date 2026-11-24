// `pilotage standup` / GET /api/standup: which period a standup covers, and the report as text or markdown (pure; tested).
// The data comes from views.standup() (work blocks + their AI summaries) and the work store (tasks); nothing here calls AI.

/** Local midnight of the day `t` falls in. */
export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight `n` days after the midnight `t` (calendar days: right across DST changes). */
export function addDays(t, n) {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Midnight of the previous working day: Friday on a Monday or a weekend, else yesterday. */
export function previousWorkday(now) {
  const today = startOfDay(now);
  const dow = new Date(today).getDay();
  return addDays(today, dow === 1 ? -3 : dow === 0 ? -2 : -1);
}

const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;
/** 'YYYY-MM-DD' → local midnight, or null when it isn't a real date. */
export function parseDay(s) {
  if (!DAY_RX.test(String(s || ''))) return null;
  const t = new Date(`${s}T00:00:00`).getTime();
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return back === s ? t : null; // 2026-02-31 rolls over to March: refuse it
}

export function fmtDay(t) {
  return new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const RANGES = ['recent', 'today', 'yesterday', 'week'];

/**
 * The period a standup covers: { from, to, label } ([from, to) in ms), or { error }.
 * recent (default): the previous working day and today so far · yesterday: the previous working day (Monday: Friday to
 * Sunday) · today · week: the last 7 days, today included · since: that day to now (or to the end of `until`).
 */
export function standupRange({ range, since, until } = {}, now = Date.now()) {
  const today = startOfDay(now);
  if (since) {
    const from = parseDay(since);
    if (from == null) return { error: 'since must be a date like 2026-11-20' };
    let to = now;
    if (until) {
      const u = parseDay(until);
      if (u == null) return { error: 'until must be a date like 2026-11-20' };
      to = Math.min(now, addDays(u, 1));
    }
    if (from >= to) return { error: 'since must be before until (and not in the future)' };
    const one = to - from <= 25 * 3600e3 && startOfDay(to - 1) === from;
    return { from, to, label: one ? fmtDay(from) : to === now ? `Since ${fmtDay(from)}` : `${fmtDay(from)} to ${fmtDay(to - 1)}` };
  }
  const r = range || 'recent';
  if (!RANGES.includes(r)) return { error: `range must be one of ${RANGES.join(', ')}` };
  if (r === 'today') return { from: today, to: now, label: `Today (${fmtDay(today)})` };
  if (r === 'week') return { from: addDays(today, -6), to: now, label: `Last 7 days (since ${fmtDay(addDays(today, -6))})` };
  const prev = previousWorkday(now);
  if (r === 'yesterday') return { from: prev, to: today, label: prev === addDays(today, -1) ? `Yesterday (${fmtDay(prev)})` : `${fmtDay(prev)} to ${fmtDay(today - 1)}` };
  return { from: prev, to: now, label: `Since ${fmtDay(prev)}` };
}

const STATUS_WORD = { in_progress: 'in progress', blocked: 'blocked', abandoned: 'dropped', ongoing: 'ongoing' };

/** The report as plain text (default) or markdown (`md`), for a terminal or a paste into Slack / a standup doc. */
export function renderStandup(r, { md = false } = {}) {
  const L = [];
  const head = (s) => (md ? `**${s}**` : s);
  const bullet = md ? '- ' : '  • ';
  const sameProject = !!r.project;
  L.push(md ? `**Standup: ${r.label}${r.project ? ` · ${r.project.name}` : ''}**` : `Standup: ${r.label}${r.project ? ` · ${r.project.name}` : ''}`);
  L.push('');
  if (!r.projects.length) {
    L.push(md ? '_Nothing recorded in this period._' : 'Nothing recorded in this period.');
    L.push('');
  }
  for (const p of r.projects) {
    if (!sameProject) L.push(head(p.name));
    for (const it of p.items) {
      let s = it.title;
      if (it.status && STATUS_WORD[it.status]) s += ` (${STATUS_WORD[it.status]})`;
      if (it.detail && it.detail !== it.title) s += `: ${it.detail}`;
      if (it.next) s += `${/[.!?…]$/.test(s) ? '' : '.'} Next: ${it.next}`;
      L.push(bullet + s);
    }
    L.push('');
  }
  const tasks = (title, list, more) => {
    if (!list.length) return;
    L.push(head(title));
    for (const t of list) L.push(`${bullet}${t.title}${!sameProject && t.projectName ? ` (${t.projectName})` : ''}${t.dueAt ? `, due ${fmtDay(t.dueAt)}` : ''}`);
    if (more) L.push(`${bullet}and ${more} more`);
    L.push('');
  };
  tasks('Doing', r.doing || [], r.doingMore || 0);
  tasks('To do', r.todo || [], r.todoMore || 0);
  if (r.needsYou?.length) {
    L.push(head('Needs you'));
    for (const s of r.needsYou) L.push(`${bullet}${s.title}${!sameProject && s.projectName ? ` (${s.projectName})` : ''}: ${s.detail}`);
    L.push('');
  }
  while (L.length && L[L.length - 1] === '') L.pop();
  return L.join('\n');
}
