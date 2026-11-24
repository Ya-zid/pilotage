// Home building blocks shared by the sections: the "catching up" line, live-session helpers, Home's undo toast.
// (HarnessTag and sortLive are also used by the Sessions/Live pages.)
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Sparkles, Undo2 } from 'lucide-react';
import { liveState } from '../cards';
import { Spinner } from '../ui';
import type { Overview, SessionSummary } from '../../types';
import { aiHold, fmtDate, fmtTime, plural } from '../../util';
import './today.css';

// ---------------------------------------------------------------- one global "AI is catching up" line

export function CatchingUp({ o }: { o: Overview }) {
  const ai = o.ai;
  const firstIndex = o.index.running && !o.index.firstDone;
  const pending = ai.enabled ? ai.pendingBlocks : 0;
  if (!firstIndex && pending <= 0) return null;
  const paused = !ai.guard.ok || ai.pausedByUser;
  // The guard's own reason: a logged-out Claude or a bad key is not "usage", and only the user can fix it.
  const hold = aiHold(ai.guard.reason);
  const resumes = ai.guard.until && ai.guard.until > Date.now() ? `, resumes ${fmtTime(ai.guard.until)}` : '';
  const recentError = !!ai.stats.lastError && Date.now() - ai.stats.lastError.at < 3 * 3600e3;
  return (
    <div className="catchup" role="status">
      {paused ? <Sparkles size={14} /> : <Spinner size={14} />}
      <span>
        {firstIndex ? (
          <>
            Reading your Claude history for the first time <span className="num faint">· {o.index.done} of {plural(o.index.total, 'session')}</span>
          </>
        ) : (
          <>
            Claude is catching up on your history <span className="num faint">({pending} left)</span>
          </>
        )}
        {paused && !firstIndex && (
          <span className="faint">
            {' · '}
            {ai.pausedByUser ? (
              'paused in Settings'
            ) : hold === 'provider' ? (
              <>
                {ai.guard.reason} ·{' '}
                <Link to="/settings#ai" className="link">
                  Fix in Settings
                </Link>
              </>
            ) : (
              `${ai.guard.reason || 'paused for now'}${resumes}`
            )}
          </span>
        )}
        {recentError && !paused && <span className="faint catchup-extra"> · some summaries failed and will be retried</span>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- live sessions

const LIVE_ORDER: Record<string, number> = { 'needs-you': 0, working: 1, idle_live: 2 };
export function sortLive(list: SessionSummary[]) {
  return [...list].sort((a, b) => (LIVE_ORDER[liveState(a) || 'idle_live'] ?? 3) - (LIVE_ORDER[liveState(b) || 'idle_live'] ?? 3) || b.lastAt - a.lastAt);
}

export function HarnessTag({ s }: { s: SessionSummary }) {
  if (!s.harness || s.harness === 'claude') return null;
  return <span className="harness-tag">{s.harness === 'codex' ? 'Codex' : s.harness === 'gemini' ? 'Gemini' : s.harness}</span>;
}

/** "waiting 14 min" / "waiting 2 h" / "waiting since 12 Nov" for a session that needs an answer. */
export function waited(t: number, now = Date.now()) {
  const m = Math.max(0, Math.round((now - t) / 60e3));
  if (m < 1) return 'waiting just now';
  if (m < 60) return `waiting ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `waiting ${h} h`;
  return `waiting since ${fmtDate(t)}`;
}

/** A session name from a plan title: whole words only, within the 60 characters the server and the
 *  New session dialog allow, and no "…" (the server strips punctuation from names anyway). */
export function sessionName(title: string, max = 60) {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const i = cut.lastIndexOf(' ');
  return (i >= max / 2 ? cut.slice(0, i) : t.slice(0, max)).replace(/[\s,.;:–—-]+$/, '');
}

// ---------------------------------------------------------------- undo (one slot, Home only)
// Same look as the Tasks undo toast. `commit` (optional) is a deferred server call: it runs when the toast expires,
// is replaced by another one, or Home unmounts, and never runs if the user pressed Undo.

const UNDO_MS = 5000;
type UndoEntry = { id: number; text: string; until: number; undo: () => void; commit?: () => void };
let slot: UndoEntry | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const settle = (e: UndoEntry | null) => {
  const c = e?.commit;
  if (!e || !c) return;
  e.commit = undefined;
  c();
};

export function offerHomeUndo(text: string, undo: () => void, commit?: () => void) {
  settle(slot);
  slot = { id: Date.now() + Math.random(), text, until: Date.now() + UNDO_MS, undo, commit };
  emit();
}

/** Close the toast (only if it still shows entry `id`, when given) and run its deferred commit. */
export function expireHomeUndo(id?: number) {
  if (!slot || (id !== undefined && slot.id !== id)) return;
  const e = slot;
  slot = null;
  emit();
  settle(e);
}

function runHomeUndo() {
  const e = slot;
  if (!e || e.until < Date.now()) return;
  slot = null;
  emit();
  e.undo();
}

function useHomeUndo() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => slot,
  );
}

/** Mount once on Home. Joins the app's toast stack. */
export function HomeUndoToast() {
  const u = useHomeUndo();
  const [stack, setStack] = useState<HTMLElement | null>(null);
  useEffect(() => setStack(document.querySelector<HTMLElement>('.toasts')), []);
  useEffect(() => () => expireHomeUndo(), []); // leaving Home commits whatever is pending
  useEffect(() => {
    if (!u) return;
    const t = setTimeout(() => expireHomeUndo(u.id), Math.max(0, u.until - Date.now()));
    return () => clearTimeout(t);
  }, [u]);
  if (!u) return null;
  const toast = (
    <div key={u.id} className="toast task-undo home-undo">
      <span className="grow">{u.text}</span>
      <button type="button" className="task-undo-btn" onClick={runHomeUndo}>
        <Undo2 />
        Undo
      </button>
    </div>
  );
  return createPortal(
    stack ? (
      toast
    ) : (
      <div className="toasts" role="status" aria-live="polite">
        {toast}
      </div>
    ),
    stack || document.body,
  );
}
