export function ago(t: number | null | undefined, now = Date.now()): string {
  if (!t) return 'never';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  const w = Math.round(d / 7);
  if (d < 60) return `${w} weeks ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} months ago`;
  const y = Math.round(d / 365);
  return `${y} year${y > 1 ? 's' : ''} ago`;
}

export function shortAgo(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(d / 365)}y`;
}

// One date style everywhere: "11 Nov" (this year) / "11 Nov 2025" (other years), 24-hour clock.
const LOCALE = 'en-GB';
export function fmtDate(t: number | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!t) return '—';
  const d = new Date(t);
  const o = opts || (d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return d.toLocaleDateString(LOCALE, o);
}

export function fmtDateTime(t: number | null | undefined): string {
  if (!t) return '—';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(LOCALE, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** "Today", "Yesterday", or "11 Nov" — for day headers. Never mixes weekdays with relative times. */
export function fmtDay(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 86400e3);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return fmtDate(t);
}

export function fmtMonth(t: number, lang = 'en'): string {
  if (!t) return '';
  return new Date(t).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { month: 'short', year: 'numeric' });
}

export function plural(n: number, word: string, pluralWord?: string) {
  return `${n} ${n === 1 ? word : pluralWord || `${word}s`}`;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function isoDay(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shortModel(m: string | null | undefined) {
  if (!m) return '';
  const x = /claude-(\w+)-(\d+)-(\d+)/.exec(m);
  if (x) return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}`;
  return m;
}

/** What holds background AI back, from the reason of the server's guard (server/ai/engine.js guard()). A provider
 *  setup error ("AI provider problem: Claude is logged out…") needs the user in Settings → AI; the rest clear by
 *  themselves (a temporary error, Pilotage's own call cap, or the 5-hour / 7-day usage limits). */
export type AiHold = 'provider' | 'error' | 'cap' | 'usage';
export function aiHold(reason: string | null | undefined): AiHold {
  const r = reason || '';
  if (r.startsWith('AI provider problem')) return 'provider';
  if (/temporary error/i.test(r)) return 'error';
  if (/\bcap\b/i.test(r)) return 'cap';
  return 'usage';
}

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  idle: 'Idle',
  dormant: 'Dormant',
  paused: 'Paused',
  done: 'Done',
  archived: 'Archived',
};

export const DIGEST_STATUS: Record<string, { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'ok' },
  in_progress: { label: 'In progress', tone: 'muted' }, // past work: never the accent (that means working right now)
  ongoing: { label: 'Ongoing', tone: 'muted' },
  blocked: { label: 'Blocked', tone: 'warn' },
  abandoned: { label: 'Dropped', tone: '' },
};

// Workspace identity hues: 16 well-separated, mid-luminance colors that read on both themes.
const WS_COLORS = [
  '#7b8cff', // periwinkle
  '#2bbfae', // teal
  '#eda23a', // amber
  '#e86aa6', // pink
  '#9b7cf4', // violet
  '#45be6c', // green
  '#f06a64', // coral
  '#45a6ec', // sky
  '#cdb23a', // mustard
  '#c56fe0', // orchid
  '#f0853c', // orange
  '#8fb34a', // olive
  '#5c7ce0', // cobalt
  '#d9867a', // clay
  '#3fc7e0', // cyan
  '#b48df0', // lilac
];
function wsHash(key: string) {
  let h = 0;
  for (const c of key || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
// Distinct-color assignment: every known workspace gets its own hue (until the palette runs out).
// Deterministic for a given set of workspaces: keys are processed alphabetically and each takes its
// hashed slot, or the next free one. Call registerWorkspaces() whenever a list of workspaces arrives.
const wsKnown = new Set<string>();
let wsAssigned = new Map<string, string>();
export function registerWorkspaces(keys: (string | null | undefined)[]) {
  let added = false;
  for (const k of keys) if (k && !wsKnown.has(k)) (wsKnown.add(k), (added = true));
  if (!added) return;
  const next = new Map<string, string>();
  const used = new Set<number>();
  for (const k of [...wsKnown].sort()) {
    let i = wsHash(k) % WS_COLORS.length;
    if (used.size < WS_COLORS.length) while (used.has(i)) i = (i + 1) % WS_COLORS.length;
    used.add(i);
    next.set(k, WS_COLORS[i]);
  }
  wsAssigned = next;
}
export function wsColor(key: string) {
  return wsAssigned.get(key) || WS_COLORS[wsHash(key) % WS_COLORS.length];
}

/** Strip Markdown to plain text for one-line snippets (headings, emphasis, code, links, lists, tables, HTML). */
export function plainText(md: string | null | undefined): string {
  if (!md) return '';
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a path for display: file name + a short tail of its folder ("…/-home-alex-x/memory"). */
export function splitPath(path: string, home = '/home/'): { name: string; dir: string; full: string } {
  const full = path || '';
  let p = full.replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^\/home\/[^/]+/.exec(p);
  if (m && home) p = '~' + p.slice(m[0].length);
  const parts = p.split('/');
  const name = parts.pop() || p;
  const dirParts = parts.filter(Boolean);
  let dir = dirParts.slice(-2).join('/');
  if (dirParts.length > 2) dir = `…/${dir}`;
  else if (p.startsWith('/') && dir) dir = `/${dir}`;
  return { name, dir, full };
}

export function copy(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
  return Promise.resolve();
}

export function isPhone() {
  return window.matchMedia('(max-width: 860px)').matches;
}
