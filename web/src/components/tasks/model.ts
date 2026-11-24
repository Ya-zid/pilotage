// Shared task (work item) vocabulary + mutations for Today and Tasks. See docs/API-WORK.md.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { taskDismiss, taskToday, tasksRestore, type DismissReason } from '../../api-extra';
import { useToast } from '../ui';
import type { Overview } from '../../types';
import type { LaunchRecord, WorkItem, WorkList, WorkStatus } from '../../types-extra';
import { fmtDate, isoDay } from '../../util';

/** Board columns (SIMPLIFY §6): Suggested items live in their own triage tab, never on the board. */
export const BOARD_COLUMNS: WorkStatus[] = ['todo', 'doing', 'done'];
export const OPEN_STATUSES: WorkStatus[] = ['inbox', 'todo', 'doing'];

/** Task status → label + glyph from the shared status vocabulary (ui.tsx STATUS). */
export const TASK_STATUS: Record<WorkStatus, { label: string; glyph: string; hint: string }> = {
  inbox: { label: 'Suggested', glyph: 'queued', hint: 'Suggested by AI from your sessions; keep or dismiss it' },
  todo: { label: 'To do', glyph: 'todo', hint: 'Planned' },
  doing: { label: 'Doing', glyph: 'in_progress', hint: 'In progress' },
  done: { label: 'Done', glyph: 'done', hint: 'Finished' },
  dropped: { label: 'Dropped', glyph: 'abandoned', hint: 'Not doing it' },
};

export const PRIORITIES = [
  { value: 0, label: 'Low' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Urgent' },
] as const;

const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Due today" / "Overdue · 12 Nov" / "Due 18 Nov". `warn` = needs attention (amber). */
export function dueInfo(dueAt: number | null | undefined, now = Date.now()): { label: string; warn: boolean; title: string } | null {
  if (!dueAt) return null;
  const days = Math.round((dayStart(dueAt) - dayStart(now)) / 86400e3);
  const title = `Due ${fmtDate(dueAt)}`;
  if (days < 0) return { label: `Overdue · ${fmtDate(dueAt)}`, warn: true, title };
  if (days === 0) return { label: 'Due today', warn: true, title };
  if (days === 1) return { label: 'Due tomorrow', warn: false, title };
  return { label: `Due ${fmtDate(dueAt)}`, warn: false, title };
}

/** The AI's opinion when it differs from the board (only matters for open items). */
export function aiHint(it: Pick<WorkItem, 'status' | 'aiStatus'>): { kind: 'done' | 'moved-on'; label: string } | null {
  if (!OPEN_STATUSES.includes(it.status)) return null;
  if (it.aiStatus === 'done') return { kind: 'done', label: 'Looks done' };
  if (it.aiStatus === 'superseded' || it.aiStatus === 'removed') return { kind: 'moved-on', label: 'AI moved on' };
  return null;
}

/** YYYY-MM-DD for <input type="date">. */
export function dateInputValue(t: number | null | undefined) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Local noon of a full YYYY-MM-DD, so the day never shifts with the time zone.
 *  `undefined` for anything that isn't a real date in 2000–2099 (the range the server accepts), such as the
 *  "0002-11-20" Chrome reports while a year is still being typed. setFullYear keeps years 0–99 from becoming 19xx. */
export function dateInputToMs(v: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (y < 2000 || y > 2099) return undefined;
  const t = new Date(2000, 0, 1, 12, 0, 0);
  t.setFullYear(y, mo, d);
  return t.getMonth() === mo && t.getDate() === d ? t.getTime() : undefined;
}

// ---------------------------------------------------------------- Today flag + Suggested (SIMPLIFY §6, §10)

const DAY_MS = 86400e3;
/** Suggestions untouched for this long are dropped by the server (EXPIRE_DAYS in server/routes/plan.js). */
export const OLD_DAYS = 7;
export const SNOOZE_DAYS = 7;

/** Local YYYY-MM-DD, the same day string the server uses for plannedFor. */
export const localDay = (t = Date.now()) => isoDay(t);

/** Flagged for Home › Today (unfinished ones roll over until done). */
export function isPlannedToday(it: Pick<WorkItem, 'status' | 'plannedFor'>, day = localDay()) {
  return !!it.plannedFor && it.plannedFor <= day && (it.status === 'todo' || it.status === 'doing');
}
/** A suggestion hidden with "Not now" until snoozeUntil. */
export function isSnoozed(it: Pick<WorkItem, 'status' | 'snoozeUntil'>, now = Date.now()) {
  return it.status === 'inbox' && !!it.snoozeUntil && it.snoozeUntil > now;
}
/** Shown in Tasks › Suggested. */
export function isSuggested(it: Pick<WorkItem, 'status' | 'snoozeUntil'>, now = Date.now()) {
  return it.status === 'inbox' && !isSnoozed(it, now);
}
/** What POST /api/work/dismiss-old {days} would drop: the same rule as expireSuggestions() in server/routes/plan.js.
 *  AI suggestions only, still in Suggested, never edited, not snoozed, and first suggested more than `days` ago
 *  (createdAt, not sourceAt: every summary refresh bumps sourceAt), or restored / back from a snooze that long ago.
 *  Hidden projects: the unscoped GET /api/work already leaves them out, like the server's dismiss-old. */
export function isOldSuggestion(it: WorkItem, now = Date.now(), days = OLD_DAYS) {
  if (it.status !== 'inbox' || !it.ai || it.userEdited || isSnoozed(it, now)) return false;
  const made = Math.max(it.createdAt || it.sourceAt || now, it.restoredAt || 0, it.snoozeUntil || 0);
  return now - made > days * DAY_MS;
}
/** Closed by Pilotage itself (the session said done, the summary moved on, expired, tidied up): hidden behind
 *  "Show N closed automatically" in Tasks, restorable from the task sheet. */
export function isAutoClosed(it: Pick<WorkItem, 'status' | 'closedBy'>) {
  return (it.status === 'done' || it.status === 'dropped') && (it.closedBy === 'ai' || it.closedBy === 'expired');
}

/** Who does it, as the AI sees it: a small marker on task rows. */
export const WHO_LABEL: Record<'you' | 'claude' | 'waiting', { label: string; hint: string }> = {
  you: { label: 'You', hint: 'Something you do yourself' },
  claude: { label: 'Claude', hint: 'A Claude session can do this' },
  waiting: { label: 'Waiting', hint: 'Waiting on someone else' },
};

/** When the suggestion was seen (the evidence time, else when it was created). */
export const suggestedAt = (it: Pick<WorkItem, 'sourceAt' | 'createdAt'>) => it.sourceAt || it.createdAt;

export const DISMISS_REASONS: { value: DismissReason; label: string; hint: string }[] = [
  { value: 'not-a-task', label: 'Not a task', hint: 'Drop it' },
  { value: 'done', label: 'Already done', hint: 'Mark it done' },
  { value: 'duplicate', label: 'Duplicate', hint: 'Drop it' },
  { value: 'snooze', label: 'Not now', hint: `Hide it for ${SNOOZE_DAYS} days` },
];

// ---------------------------------------------------------------- undo (one slot: the latest status change)

export const UNDO_MS = 5000;
type UndoEntry = { id: number; text: string; until: number; run: () => void };
let undoSlot: UndoEntry | null = null;
const undoSubs = new Set<() => void>();
const emitUndo = () => undoSubs.forEach((f) => f());
/** Show "<text> · Undo" in <TaskUndoToast> (5 s, or Ctrl+Z). One slot: a newer offer replaces the older one. */
export function offerUndo(text: string, run: () => void) {
  const id = Date.now() + Math.random();
  undoSlot = { id, text, until: Date.now() + UNDO_MS, run };
  emitUndo();
  return id;
}
/** Hide the undo toast (only if it still shows entry `id`, when given). */
export function dismissUndo(id?: number) {
  if (!undoSlot || (id !== undefined && undoSlot.id !== id)) return;
  undoSlot = null;
  emitUndo();
}
/** Undo the latest status change, if its toast is still up. */
export function runUndo() {
  const u = undoSlot;
  if (!u || u.until < Date.now()) return;
  dismissUndo(u.id);
  u.run();
}
/** The pending undo, for <TaskUndoToast>. Module-level so it survives the row that triggered it unmounting. */
export function useUndoSlot() {
  return useSyncExternalStore(
    (cb) => {
      undoSubs.add(cb);
      return () => {
        undoSubs.delete(cb);
      };
    },
    () => undoSlot,
  );
}

type Patch = Partial<Pick<WorkItem, 'title' | 'detail' | 'status' | 'priority' | 'dueAt' | 'projectId'>>;

/** Optimistic task mutations shared by Today and Tasks. SSE 'work' events refetch the truth afterwards. */
export function useTaskActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const sync = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['work'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
  }, [qc]);
  const applyLocal = useCallback(
    (id: string, fn: (it: WorkItem) => WorkItem | null) => {
      qc.setQueriesData<WorkList>({ queryKey: ['work'] }, (old) => {
        if (!old) return old;
        const items: WorkItem[] = [];
        for (const it of old.items) {
          if (it.id !== id) items.push(it);
          else {
            const n = fn(it);
            if (n) items.push(n);
          }
        }
        return { ...old, items };
      });
      qc.setQueryData<Overview>(['overview'], (o) => {
        if (!o?.work) return o;
        const topNext = o.work.topNext
          .map((t) => (t.id === id ? fn({ ...(t as WorkItem) }) : t))
          .filter((t): t is NonNullable<typeof t> => !!t && OPEN_STATUSES.includes(t.status));
        return { ...o, work: { ...o.work, topNext } };
      });
    },
    [qc],
  );

  const patch = useCallback(
    async (id: string, body: Patch, okMsg?: string) => {
      applyLocal(id, (it) => ({ ...it, ...body, ...(body.status === 'done' ? { doneAt: Date.now() } : {}) }));
      try {
        const r = await api<WorkItem>(`/api/work/${id}`, { method: 'PATCH', body });
        if (okMsg) toast(okMsg);
        return r;
      } catch (e) {
        toast(friendly(e), true);
        return null;
      } finally {
        sync();
      }
    },
    [applyLocal, sync, toast],
  );

  /** Where the item sits now (any cached list, else Today's top list) and its slot in Today's top list. */
  const snapshot = useCallback(
    (id: string) => {
      let status: WorkStatus | undefined;
      for (const [, d] of qc.getQueriesData<WorkList>({ queryKey: ['work'] })) {
        status = d?.items?.find((x) => x.id === id)?.status;
        if (status) break;
      }
      const top = qc.getQueryData<Overview>(['overview'])?.work?.topNext || [];
      const index = top.findIndex((t) => t.id === id);
      return { status: status || top[index]?.status, index, topItem: index >= 0 ? top[index] : undefined };
    },
    [qc],
  );

  /** Status change with a 5 s "Undo" toast: one tap on a phone row must never lose a task. */
  const setStatus = useCallback(
    (id: string, status: WorkStatus) => {
      const before = snapshot(id);
      const prev = before.status;
      const msg = status === 'done' ? 'Marked done' : status === 'dropped' ? 'Dropped' : prev === 'inbox' && status === 'todo' ? 'Kept in To do' : `Moved to ${TASK_STATUS[status].label}`;
      if (!prev || prev === status) return patch(id, { status }, msg);
      const req = patch(id, { status });
      const undoId = offerUndo(msg, async () => {
        if (!(await req)) return; // the change itself failed: nothing to undo
        const { index, topItem } = before;
        if (topItem && index >= 0)
          qc.setQueryData<Overview>(['overview'], (o) => {
            if (!o?.work || o.work.topNext.some((t) => t.id === id)) return o;
            const topNext = [...o.work.topNext];
            topNext.splice(Math.min(index, topNext.length), 0, { ...topItem, status: prev });
            return { ...o, work: { ...o.work, topNext } };
          });
        await patch(id, { status: prev }, `Moved back to ${TASK_STATUS[prev].label}`);
      });
      req.then((r) => !r && dismissUndo(undoId));
      return req;
    },
    [patch, qc, snapshot],
  );

  /** The item as any cached list has it (for undo). */
  const findCached = useCallback(
    (id: string) => {
      for (const [, d] of qc.getQueriesData<WorkList>({ queryKey: ['work'] })) {
        const it = d?.items?.find((x) => x.id === id);
        if (it) return it;
      }
      return undefined;
    },
    [qc],
  );

  /** Add to / remove from Today. Adding a suggestion also keeps it (server: inbox → todo). Undo-able. */
  const setToday = useCallback(
    (id: string, on: boolean) => {
      const prev = findCached(id);
      applyLocal(id, (it) => ({ ...it, plannedFor: on ? localDay() : null, status: on && it.status === 'inbox' ? 'todo' : it.status, snoozeUntil: on ? null : it.snoozeUntil }));
      const req = taskToday(id, on)
        .then((r) => {
          applyLocal(id, () => r);
          return r;
        })
        .catch((e) => {
          toast(friendly(e), true);
          return null;
        })
        .finally(sync);
      const undoId = offerUndo(on ? (prev?.status === 'inbox' ? 'Kept and added to today' : 'Added to today') : 'Removed from today', async () => {
        if (!(await req)) return;
        try {
          await taskToday(id, !on);
          if (on && prev?.status === 'inbox') await api(`/api/work/${id}`, { method: 'PATCH', body: { status: 'inbox' } });
          toast(on ? (prev?.status === 'inbox' ? 'Back in Suggested' : 'Removed from today') : 'Back in today');
        } catch (e) {
          toast(friendly(e), true);
        } finally {
          sync();
        }
      });
      req.then((r) => !r && dismissUndo(undoId));
      return req;
    },
    [applyLocal, findCached, sync, toast],
  );

  /** Dismiss a suggestion with a reason. 'snooze' hides it for 7 days (it stays in Suggested › Snoozed). */
  const dismiss = useCallback(
    (id: string, reason: DismissReason) => {
      const prev = findCached(id);
      const now = Date.now();
      applyLocal(id, (it) =>
        reason === 'snooze'
          ? { ...it, snoozeUntil: now + SNOOZE_DAYS * DAY_MS }
          : reason === 'unsnooze'
            ? { ...it, snoozeUntil: null }
            : { ...it, status: reason === 'done' ? 'done' : 'dropped', dismissReason: reason, closedBy: 'user', doneAt: reason === 'done' ? now : it.doneAt, plannedFor: null },
      );
      const req = taskDismiss(id, reason)
        .then((r) => {
          applyLocal(id, () => r);
          return r;
        })
        .catch((e) => {
          toast(friendly(e), true);
          return null;
        })
        .finally(sync);
      if (reason === 'snooze') {
        req.then((r) => r && toast(`Hidden for ${SNOOZE_DAYS} days. It’s under Snoozed until then.`));
        return req;
      }
      if (reason === 'unsnooze') {
        req.then((r) => r && toast('Back in Suggested'));
        return req;
      }
      const msg = reason === 'done' ? 'Marked done' : reason === 'duplicate' ? 'Dismissed as a duplicate' : 'Dismissed';
      const undoId = offerUndo(msg, async () => {
        if (!(await req)) return;
        if (prev) applyLocal(id, () => prev);
        try {
          await tasksRestore([id]);
          toast('Back in Suggested');
        } catch (e) {
          toast(friendly(e), true);
        } finally {
          sync();
        }
      });
      req.then((r) => !r && dismissUndo(undoId));
      return req;
    },
    [applyLocal, findCached, sync, toast],
  );

  const remove = useCallback(
    async (id: string) => {
      applyLocal(id, () => null);
      try {
        await api(`/api/work/${id}`, { method: 'DELETE' });
        toast('Task deleted');
        return true;
      } catch (e) {
        toast(friendly(e), true);
        return false;
      } finally {
        sync();
      }
    },
    [applyLocal, sync, toast],
  );

  const create = useCallback(
    async (body: { projectId: string; title: string; detail?: string; status?: WorkStatus; priority?: number; dueAt?: number | null }) => {
      try {
        const it = await api<WorkItem>('/api/work', { method: 'POST', body });
        qc.setQueriesData<WorkList>({ queryKey: ['work'] }, (old) => (old ? { ...old, items: [it, ...old.items.filter((x) => x.id !== it.id)] } : old));
        toast('Task added');
        return it;
      } catch (e) {
        toast(friendly(e), true);
        return null;
      } finally {
        sync();
      }
    },
    [qc, sync, toast],
  );

  /** Starts a Claude session for the item. Acts on the real PC. */
  const start = useCallback(
    async (id: string, mode: 'terminal' | 'background', resume = false, trust = false) => {
      try {
        const r = await api<{ item: WorkItem; launch: LaunchRecord }>(`/api/work/${id}/start`, { method: 'POST', body: { mode, resume, trust } });
        applyLocal(id, () => r.item);
        qc.invalidateQueries({ queryKey: ['live'] });
        return r;
      } catch (e) {
        toast(friendly(e), true);
        return null;
      } finally {
        sync();
      }
    },
    [applyLocal, qc, sync, toast],
  );

  return { patch, setStatus, remove, create, start, setToday, dismiss };
}

/** Plain-language error text: never raw codes. */
export function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e || '');
  if (!msg || /^HTTP \d+$/.test(msg) || /^[a-z_]+$/.test(msg)) return 'That didn’t work. Try again in a moment.';
  if (/failed to fetch|network/i.test(msg)) return 'Pilotage isn’t reachable right now.';
  if (/^invalid dueAt$/i.test(msg)) return 'That due date isn’t valid. Pick a day between 2000 and 2099.';
  return msg;
}

/** Re-render every `ms` so relative times ("3 min ago") stay fresh without data changes. */
export function useTick(ms = 60_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Reactive media query (phone layout ≤ 860px, same breakpoint as styles.css). */
export function useMedia(q = '(max-width: 860px)') {
  const get = () => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

/** Small persisted preference (per browser). Never required for correctness. */
export function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, nv);
      } catch {}
    },
    [key],
  );
  return [v, set];
}
