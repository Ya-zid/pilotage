// Small helpers shared by the Session / Sessions / Project pages (kept local: ui.tsx and util.ts are owned elsewhere).
import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../types';
import { liveState } from '../cards';

export type HarnessId = 'claude' | 'codex' | 'gemini';

export const HARNESS_LABEL: Record<HarnessId, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

export const harnessOf = (s: Pick<SessionSummary, 'harness'>): HarnessId => (s.harness || 'claude') as HarnessId;

/** Name of the assistant that wrote the replies ("Claude", "Codex", "Gemini"). */
export const assistantName = (s: Pick<SessionSummary, 'harness'>) => HARNESS_LABEL[harnessOf(s)];

/** Session kinds, same words everywhere (SIMPLIFY.md §2). URL values stay interactive|automation|archived|all. */
export type SessionKind = 'interactive' | 'automation' | 'archived' | 'all';
export const KINDS: { value: SessionKind; label: string; title: string }[] = [
  { value: 'interactive', label: 'With you', title: 'Sessions where you typed the prompts' },
  { value: 'automation', label: 'Automations', title: 'Scheduled and headless runs' },
  { value: 'archived', label: 'Archived', title: 'Transcript removed by Claude Code, your prompts kept' },
  { value: 'all', label: 'All', title: 'Everything' },
];
export const ARCHIVED_HINT = 'Claude Code removes transcripts after about 30 days. Archived sessions keep only the prompts you typed, so your history isn’t lost.';

// ---------- running sessions (SIMPLIFY.md §2: Needs you · Working · Open) ----------
export type RunState = 'needs-you' | 'working' | 'idle_live';
export const RUN_LABEL: Record<RunState, string> = { 'needs-you': 'Needs you', working: 'Working', idle_live: 'Open' };
export const runState = (s: SessionSummary): RunState => liveState(s) || 'idle_live';
export const runLabel = (s: SessionSummary) => RUN_LABEL[runState(s)];
const RUN_ORDER: Record<RunState, number> = { 'needs-you': 0, working: 1, idle_live: 2 };
/** Needs you first, then working, then open; newest first inside each. */
export function sortRunning(list: SessionSummary[]) {
  return [...list].sort((a, b) => RUN_ORDER[runState(a)] - RUN_ORDER[runState(b)] || b.lastAt - a.lastAt);
}
/** "1 needs you · 2 working · 3 open" (only the non-zero parts). */
export function runSummary(list: SessionSummary[]) {
  const n = { 'needs-you': 0, working: 0, idle_live: 0 } as Record<RunState, number>;
  for (const s of list) n[runState(s)]++;
  return [n['needs-you'] ? `${n['needs-you']} ${n['needs-you'] === 1 ? 'needs' : 'need'} you` : '', n.working ? `${n.working} working` : '', n.idle_live ? `${n.idle_live} open` : ''].filter(Boolean).join(' · ');
}

// ---------- quiet row metadata (calm redesign, principle 7: drop default/noise metadata) ----------
/** Branch names that are just "the usual one": never shown on rows. */
export const USUAL_BRANCHES = new Set(['main', 'master']);
/** The worktree, or the branch when it isn't main / master / the repo default; null otherwise. */
export function branchOf(s: Pick<SessionSummary, 'worktree' | 'branch'>, defaultBranch?: string | null): string | null {
  if (s.worktree) return s.worktree;
  if (s.branch && !USUAL_BRANCHES.has(s.branch) && s.branch !== defaultBranch) return s.branch;
  return null;
}
/** The project a session belongs to, as a short name (falls back to the folder name). */
export const projectNameOf = (s: Pick<SessionSummary, 'projectName' | 'cwd'>) => s.projectName || s.cwd.split('/').filter(Boolean).pop() || s.cwd;
/** True when the title already says the project ("northwind-shop" in project northwind-shop). */
export function sameName(a: string | null | undefined, b: string | null | undefined) {
  const n = (x: string | null | undefined) => (x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return !!n(a) && n(a) === n(b);
}
/** A running session's detail line, only when it's worth a line: what it waits for, or a short status. */
export function usefulDetail(detail: string | null | undefined, needsYou: boolean) {
  const t = (detail || '').trim();
  if (!t) return '';
  if (needsYou) return t;
  return t.length <= 72 ? t : '';
}

/** Tracks a media query (defaults to the shell's phone breakpoint). */
export function useMedia(query = '(max-width: 860px)') {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Re-render every `ms` so relative times ("3 min ago") stay fresh. */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Plain-language error text: never raw codes. */
export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e || '');
  if (!msg || /^HTTP \d+$/.test(msg) || /^[a-z_]+$/.test(msg)) return 'That didn’t work. Try again in a moment.';
  if (/failed to fetch|network/i.test(msg)) return 'Pilotage isn’t reachable right now.';
  return msg;
}

/** Clip to n characters at a word boundary, with an ellipsis. */
export function clipWords(text: string, n: number) {
  const t = (text || '').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** Local-day key (YYYY-MM-DD) for a timestamp. */
export function dayKey(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const sameDay = (a: number, b: number) => dayKey(a) === dayKey(b);

// ---------- list buckets: Today · Yesterday · This week · Earlier ----------
export type Bucket = 'today' | 'yesterday' | 'week' | 'earlier';
export const BUCKET_LABEL: Record<Bucket, string> = { today: 'Today', yesterday: 'Yesterday', week: 'This week', earlier: 'Earlier' };
export const BUCKET_TITLE: Record<Bucket, string> = { today: '', yesterday: '', week: 'The 7 days before yesterday', earlier: 'More than a week ago' };
export function bucketOf(t: number, now = Date.now()): Bucket {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 86400e3;
  if (t >= start.getTime()) return 'today';
  if (t >= start.getTime() - day) return 'yesterday';
  if (t >= start.getTime() - 7 * day) return 'week';
  return 'earlier';
}
/** Groups an already newest-first list into consecutive buckets. */
export function groupByBucket<T>(list: T[], at: (x: T) => number): { key: Bucket; label: string; items: T[] }[] {
  const out: { key: Bucket; label: string; items: T[] }[] = [];
  const now = Date.now();
  for (const x of list) {
    const key = bucketOf(at(x), now);
    const g = out.find((o) => o.key === key);
    if (g) g.items.push(x);
    else out.push({ key, label: BUCKET_LABEL[key], items: [x] });
  }
  return out;
}
