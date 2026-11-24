// Task (work item) building blocks: priority glyph, status menu, row, board card, detail sheet, start flow.
// Follows docs/DESIGN.md: status = glyph, metadata = <Meta>, one primary line, tokens only (tasks.css).
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Bot, Check, Cloud, CornerDownRight, Hourglass, Monitor, MoreHorizontal, Play, RotateCcw, Sparkles, Sun, SunDim, Trash2, Undo2, User, X } from 'lucide-react';
import { terminalPlace, useBootstrap, useProjects, useTerminal } from '../../api';
import { SkipPromptsNote } from '../NewSession';
import { LaunchStatus } from '../project/LaunchStatus';
import { Button, IconButton, Meta, Modal, ProjectGlyph, SegmentedControl, StatusIcon, Switch } from '../ui';
import type { Launch, ProjectSummary } from '../../types';
import type { WorkItem, WorkStatus } from '../../types-extra';
import { ago, fmtDate, fmtDateTime, isPhone } from '../../util';
import { aiHint, dateInputToMs, dateInputValue, dismissUndo, dueInfo, isAutoClosed, isPlannedToday, PRIORITIES, runUndo, TASK_STATUS, useMedia, useTaskActions, useUndoSlot, WHO_LABEL } from './model';
import './tasks.css';

// ---------------------------------------------------------------- small bits

/** Linear-style priority glyph. Normal priority shows nothing (the exception, not the default). */
export function PriorityIcon({ p, always = false }: { p: number; always?: boolean }) {
  if (p === 1 && !always) return null;
  const label = `${PRIORITIES[p]?.label || 'Normal'} priority`;
  if (p >= 3)
    return (
      <svg className="prio urgent" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
        <title>{label}</title>
        <rect x="1" y="1" width="12" height="12" rx="3.2" fill="currentColor" />
        <path d="M7 3.8v3.7M7 9.9v.2" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  const on = p + 1; // low = 1 bar, normal = 2, high = 3
  return (
    <svg className={`prio${p >= 2 ? ' high' : ''}`} width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
      <title>{label}</title>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1.5 + i * 4} y={11 - (i + 1) * 3} width="3" height={(i + 1) * 3 + 1} rx="1" fill="currentColor" opacity={i < on ? 1 : 0.25} />
      ))}
    </svg>
  );
}

export function AiTag({ iconOnly = false }: { iconOnly?: boolean }) {
  return (
    <span className="task-ai" title="Found by Pilotage in your sessions" aria-label={iconOnly ? 'From AI' : undefined}>
      <Sparkles />
      {!iconOnly && 'AI'}
    </span>
  );
}

/** Who does it (the AI's guess): "You" / "Claude" / "Waiting", a quiet marker in the meta line. */
export function WhoTag({ who }: { who?: WorkItem['who'] }) {
  if (!who || !WHO_LABEL[who]) return null;
  const Icon = who === 'you' ? User : who === 'claude' ? Bot : Hourglass;
  return (
    <span className={`task-who ${who}`} title={WHO_LABEL[who].hint}>
      <Icon aria-hidden="true" />
      {WHO_LABEL[who].label}
    </span>
  );
}

/** Small "Today" tag on tasks flagged for Home › Today. The one tag a task row/card may carry. */
export function TodayChip({ it }: { it: Pick<WorkItem, 'status' | 'plannedFor'> }) {
  if (!isPlannedToday(it)) return null;
  return (
    <span className="task-today" title="Planned for today (shown on Home)">
      <Sun aria-hidden="true" />
      Today
    </span>
  );
}

/** "Add to today" / "Remove from today" for a task menu (open tasks only). */
export function todayMenuItem(it: Pick<WorkItem, 'id' | 'status' | 'plannedFor'>, setToday: (id: string, on: boolean) => unknown): MenuItem | null {
  if (it.status === 'done' || it.status === 'dropped') return null;
  const on = isPlannedToday(it);
  return {
    key: 'today',
    sep: true,
    label: on ? 'Remove from today' : 'Add to today',
    icon: on ? <SunDim /> : <Sun />,
    sub: !on && it.status === 'inbox' ? 'Also keeps it in To do' : undefined,
    onSelect: () => setToday(it.id, !on),
  };
}

/** Where a task came from, as one quiet line. */
export function SourceLine({ it, link = true }: { it: Pick<WorkItem, 'source' | 'ai'>; link?: boolean }) {
  const s = it.source;
  if (s.kind === 'brief') return <span className="task-src">from the project summary</span>;
  if (s.kind === 'idea') return <span className="task-src">from an idea</span>;
  if (s.kind === 'spinoff') return <span className="task-src">spin-off kickoff</span>;
  if (s.sessionId && s.sessionTitle)
    return link ? (
      <Link to={`/sessions/${s.sessionId}`} className="task-src above" onClick={(e) => e.stopPropagation()} title="Open the session it came from">
        <CornerDownRight />
        <span className="truncate">{s.sessionTitle}</span>
      </Link>
    ) : (
      <span className="task-src">
        <CornerDownRight />
        <span className="truncate">{s.sessionTitle}</span>
      </span>
    );
  return null;
}

type ProjLite = Pick<ProjectSummary, 'id' | 'name' | 'workspace' | 'color'>;
/** projectId → project, for glyph colors when an item lacks its workspace (overview.work.topNext). */
export function useProjectIndex() {
  const { data } = useProjects();
  return useMemo(() => new Map<string, ProjLite>((data || []).map((p) => [p.id, p])), [data]);
}

export function taskWhen(it: Partial<WorkItem> & Pick<WorkItem, 'sourceAt'>, short = false) {
  if (it.status === 'done' && it.doneAt)
    return { text: short ? ago(it.doneAt) : it.closedBy === 'ai' ? `closed by AI ${ago(it.doneAt)}` : `done ${ago(it.doneAt)}`, title: `Done ${fmtDateTime(it.doneAt)}` };
  return { text: ago(it.sourceAt), title: `Seen ${fmtDateTime(it.sourceAt)}` };
}

export function TaskMeta({
  it,
  project,
  showProject = true,
  showSource = false,
  compact = false,
  noTime = false,
  who = false,
}: {
  it: Partial<WorkItem> & Pick<WorkItem, 'projectName' | 'ai' | 'sourceAt'>;
  project?: ProjLite;
  showProject?: boolean;
  showSource?: boolean;
  compact?: boolean;
  noTime?: boolean;
  /** show the You / Claude marker instead of the AI tag (Tasks page) */
  who?: boolean;
}) {
  const due = dueInfo(it.dueAt);
  const ws = it.workspace ?? project?.workspace ?? null;
  return (
    <Meta
      items={[
        showProject ? (
          <span className="task-proj">
            <ProjectGlyph name={it.projectName} ws={ws} color={project?.color} size={14} />
            <span className="truncate">{it.projectName}</span>
          </span>
        ) : null,
        who ? (it.who ? <WhoTag who={it.who} /> : null) : it.ai ? <AiTag iconOnly={compact} /> : null,
        due ? (
          <span className={due.warn ? 'tone-amber' : ''} title={due.title}>
            {due.label}
          </span>
        ) : null,
        showSource && it.source && it.source.kind !== 'ai' && it.source.kind !== 'user' ? <SourceLine it={it as WorkItem} /> : null,
        noTime ? null : <span title={taskWhen(it).title}>{taskWhen(it).text}</span>,
      ]}
    />
  );
}

/** Overlays go to <body>: the sticky top bar (backdrop-filter) and the page fade-in (transform) would trap `position: fixed`. */
export function Portal({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}

// ---------------------------------------------------------------- menu (popover on desktop, sheet on phone)

export type MenuItem = { key: string; label: React.ReactNode; icon?: React.ReactNode; checked?: boolean; danger?: boolean; hint?: React.ReactNode; sub?: React.ReactNode; sep?: boolean; onSelect: () => void };

export function Menu({ anchor, items, title, onClose, className = '' }: { anchor: HTMLElement | null; items: MenuItem[]; title: string; onClose: () => void; className?: string }) {
  const phone = useMedia();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (phone || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = 220;
    const h = ref.current?.offsetHeight || 200;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    setPos({ top, left });
  }, [anchor, phone]);
  useEffect(() => {
    if (phone) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    ref.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"], button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [anchor, onClose, phone]);
  const body = items.map((m) => (
    <React.Fragment key={m.key}>
      {m.sep && <div className="menu-sep" role="separator" />}
      <button
        type="button"
        role={m.checked === undefined ? 'menuitem' : 'menuitemradio'}
        aria-checked={m.checked === undefined ? undefined : m.checked}
        className={`menu-item${m.danger ? ' danger' : ''}${m.checked ? ' on' : ''}${m.sub ? ' two-line' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
          m.onSelect();
        }}
      >
        <span className="mi-icon">{m.icon}</span>
        <span className="mi-label">
          {m.label}
          {m.sub && <span className="mi-sub">{m.sub}</span>}
        </span>
        {m.hint && <span className="mi-hint">{m.hint}</span>}
        {m.checked && <Check size={15} className="mi-check" />}
      </button>
    </React.Fragment>
  ));
  if (phone)
    return (
      <Portal>
        <Modal title={title} onClose={onClose} className={`menu-sheet ${className}`}>
          <div className="menu-sheet-list" role="menu" aria-label={title}>
            {body}
          </div>
        </Modal>
      </Portal>
    );
  return createPortal(
    <div
      ref={ref}
      className={`menu-pop ${className}`}
      role="menu"
      aria-label={title}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </div>,
    document.body,
  );
}

/** Items for "move to status". */
export function statusMenuItems(current: WorkStatus, pick: (s: WorkStatus) => void): MenuItem[] {
  return (['inbox', 'todo', 'doing', 'done', 'dropped'] as WorkStatus[]).map((s) => ({
    key: s,
    label: TASK_STATUS[s].label,
    icon: <StatusIcon status={TASK_STATUS[s].glyph} size={15} />,
    checked: s === current,
    onSelect: () => s !== current && pick(s),
  }));
}

/** The leading status glyph as a button that opens the status menu. */
export function StatusButton({ it }: { it: Pick<WorkItem, 'id' | 'status' | 'title'> & Partial<Pick<WorkItem, 'plannedFor'>> }) {
  const { setStatus, setToday } = useTaskActions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="task-status-btn above"
        aria-label={`Status: ${TASK_STATUS[it.status].label}. Change status`}
        title={`${TASK_STATUS[it.status].label}: change status`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <StatusIcon status={TASK_STATUS[it.status].glyph} size={16} title={TASK_STATUS[it.status].label} />
      </button>
      {open && (
        <Menu
          anchor={ref.current}
          title="Move to"
          items={[...statusMenuItems(it.status, (s) => setStatus(it.id, s)), ...(it.plannedFor !== undefined ? [todayMenuItem({ ...it, plannedFor: it.plannedFor ?? null }, setToday)].filter((x): x is MenuItem => !!x) : [])]}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** "Marked done · Undo" for the latest status change (5 s, or Ctrl+Z outside text fields).
 *  Mount once on each page that changes task status. It joins the app's toast stack so the two never overlap. */
let toastOwners: number[] = [];
let toastOwnerSeq = 0;
const ownerSubs = new Set<() => void>();
/** Several components may mount <TaskUndoToast> (a page and a card list on it); only the first one renders. */
function useToastOwner() {
  const id = useRef(0);
  if (!id.current) id.current = ++toastOwnerSeq;
  const [, force] = useState(0);
  useEffect(() => {
    const me = id.current;
    const on = () => force((n) => n + 1);
    ownerSubs.add(on);
    toastOwners = [...toastOwners, me];
    ownerSubs.forEach((f) => f());
    return () => {
      ownerSubs.delete(on);
      toastOwners = toastOwners.filter((x) => x !== me);
      ownerSubs.forEach((f) => f());
    };
  }, []);
  return toastOwners[0] === id.current;
}

export function TaskUndoToast() {
  const u = useUndoSlot();
  const owner = useToastOwner();
  const [stack, setStack] = useState<HTMLElement | null>(null);
  useEffect(() => setStack(document.querySelector<HTMLElement>('.toasts')), []);
  useEffect(() => {
    if (!u || !owner) return;
    const t = setTimeout(() => dismissUndo(u.id), Math.max(0, u.until - Date.now()));
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      runUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [u, owner]);
  if (!owner || !u || u.until <= Date.now()) return null;
  const toast = (
    <div key={u.id} className="toast task-undo">
      <span className="grow">{u.text}</span>
      <button type="button" className="task-undo-btn" onClick={runUndo} title="Undo (Ctrl+Z)">
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

/** "Looks done → Mark done" / "AI moved on → Drop": one tap to agree with the AI. */
export function AiHintLine({ it }: { it: Pick<WorkItem, 'id' | 'status' | 'aiStatus'> }) {
  const { setStatus } = useTaskActions();
  const h = aiHint(it);
  if (!h) return null;
  return (
    <div className="ai-hint above" onClick={(e) => e.stopPropagation()}>
      <Sparkles />
      <span>{h.kind === 'done' ? 'Looks done in your latest session' : 'The AI moved on from this'}</span>
      <button type="button" className="ai-hint-btn" onClick={() => setStatus(it.id, h.kind === 'done' ? 'done' : 'dropped')}>
        {h.kind === 'done' ? 'Mark done' : 'Drop it'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- row (lists: Today "Next up", Tasks list / phone)

type RowItem = Pick<WorkItem, 'id' | 'title' | 'status' | 'priority' | 'projectId' | 'projectName' | 'ai' | 'aiStatus' | 'dueAt' | 'sourceAt'> & Partial<WorkItem>;

export function TaskRow({
  it,
  project,
  onOpen,
  quick = false,
  hoverQuick = false,
  showProject = true,
  showSource = true,
}: {
  it: RowItem;
  project?: ProjLite;
  onOpen?: () => void;
  quick?: boolean;
  /** quick actions shown on hover only (dense desktop lists) */
  hoverQuick?: boolean;
  showProject?: boolean;
  showSource?: boolean;
}) {
  const { setStatus } = useTaskActions();
  const closed = it.status === 'done' || it.status === 'dropped';
  return (
    <div className={`lrow task-row${onOpen ? ' clickable' : ''}${closed ? ' closed' : ''}`}>
      {onOpen && <button type="button" className="lrow-link task-open" aria-label={`Open task: ${it.title}`} onClick={onOpen} />}
      <div className="lrow-lead">
        <StatusButton it={it} />
      </div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t task-t">{it.title}</span>
          <PriorityIcon p={it.priority} />
          <TodayChip it={{ status: it.status, plannedFor: it.plannedFor ?? null }} />
        </div>
        <TaskMeta it={it} project={project} showProject={showProject} />
        {showSource && it.source?.kind === 'ai' && (
          <div className="task-src-line">
            <SourceLine it={it as WorkItem} />
          </div>
        )}
        <AiHintLine it={it} />
      </div>
      {quick && !closed && (
        <div className={`task-quick above${hoverQuick ? ' hover-only' : ''}`} onClick={(e) => e.stopPropagation()}>
          {it.status !== 'doing' && (
            <button type="button" className="btn sm ghost task-qbtn" onClick={() => setStatus(it.id, 'doing')} aria-label="Move to Doing" title="Move to Doing">
              <StatusIcon status="in_progress" size={14} title="Doing" />
              <span className="qlabel">Doing</span>
            </button>
          )}
          <button type="button" className="btn sm ghost task-qbtn" onClick={() => setStatus(it.id, 'done')} aria-label="Mark done" title="Mark done">
            <Check />
            <span className="qlabel">Done</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- board card (desktop board)

export function TaskCard({
  it,
  project,
  showProject = true,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  it: WorkItem;
  project?: ProjLite;
  showProject?: boolean;
  onOpen: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}) {
  const { setStatus, setToday } = useTaskActions();
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const todayItem = todayMenuItem(it, setToday);
  const triage: { s: WorkStatus; label: string }[] =
    it.status === 'inbox'
      ? [
          { s: 'todo', label: 'To do' },
          { s: 'dropped', label: 'Drop' },
        ]
      : it.status === 'todo'
        ? [
            { s: 'doing', label: 'Doing' },
            { s: 'done', label: 'Done' },
          ]
        : it.status === 'doing'
          ? [{ s: 'done', label: 'Done' }]
          : [];
  return (
    <div
      className={`board-card clickable task-card${dragging ? ' dragging' : ''}${it.status === 'done' ? ' closed' : ''}`}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen();
      }}
      tabIndex={0}
      role="button"
      aria-label={`${it.title}. ${TASK_STATUS[it.status].label}. Open`}
    >
      <div className="task-card-head">
        <span className="t clamp-2">{it.title}</span>
        <PriorityIcon p={it.priority} />
      </div>
      {isPlannedToday(it) && (
        <div className="task-card-tags">
          <TodayChip it={it} />
        </div>
      )}
      <div className={`task-card-meta${menu ? ' menu-open' : ''}`}>
        <TaskMeta it={it} project={project} showProject={showProject} compact noTime who />
        {!it.dueAt && (
          <span className="task-when" title={taskWhen(it).title}>
            {taskWhen(it, true).text}
          </span>
        )}
        <div className="task-card-actions" onClick={(e) => e.stopPropagation()}>
          {triage.map((t, i) => (
            <button
              key={t.s}
              type="button"
              className={`btn sm ghost${i > 0 ? ' icon' : ''}`}
              onClick={() => setStatus(it.id, t.s)}
              title={t.s === 'dropped' ? 'Drop' : `Move to ${TASK_STATUS[t.s].label}`}
              aria-label={t.s === 'dropped' ? 'Drop' : `Move to ${TASK_STATUS[t.s].label}`}
            >
              <StatusIcon status={TASK_STATUS[t.s].glyph} size={13} title={t.label} />
              {i === 0 && t.label}
            </button>
          ))}
          <button ref={moreRef} type="button" className="btn sm ghost icon" aria-label="More actions" title="Move to, Today…" onClick={() => setMenu(true)}>
            <MoreHorizontal />
          </button>
          {menu && <Menu anchor={moreRef.current} title="Move to" items={[...statusMenuItems(it.status, (s) => setStatus(it.id, s)), ...(todayItem ? [todayItem] : [])]} onClose={() => setMenu(false)} />}
        </div>
      </div>
      <AiHintLine it={it} />
    </div>
  );
}

// ---------------------------------------------------------------- detail sheet (inline edit + start)

/** Due date field. Saves only a full, real date (a pick in the native picker, or the 4th digit of a typed year),
 *  so a half-typed year ("0002" → 1902) never reaches the server, and waits for a short pause (or blur) so typing
 *  over a date doesn't send every intermediate one. An empty field (picker's Clear, or every part deleted) saves
 *  "no date"; leaving it half-typed (Chrome reports "" + badInput) or out of range puts the saved date back. */
function DueInput({ value, onCommit }: { value: number | null | undefined; onCommit: (t: number | null) => void }) {
  const saved = dateInputValue(value);
  const [v, setV] = useState(saved);
  useEffect(() => setV(saved), [saved]);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const pending = useRef<{ t: number | null; timer: number } | null>(null);
  const cancel = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  };
  const flush = () => {
    const p = pending.current;
    if (!p) return false;
    cancel();
    commit.current(p.t);
    return true;
  };
  const schedule = (t: number | null) => {
    cancel();
    pending.current = { t, timer: window.setTimeout(flush, 700) };
  };
  useEffect(() => () => void flush(), []); // closing the sheet mid-pause still saves
  return (
    <input
      type="date"
      className="input task-date"
      aria-label="Due date"
      min="2000-01-01"
      max="2099-12-31"
      value={v}
      onChange={(e) => {
        const nv = e.target.value;
        setV(nv);
        const t = nv ? dateInputToMs(nv) : e.target.validity.badInput ? undefined : null;
        if (nv === saved || t === undefined) cancel();
        else schedule(t);
      }}
      onBlur={(e) => {
        if (flush() || v === saved) return;
        if (!v && !e.currentTarget.validity.badInput) commit.current(null); // every part emptied with the keyboard
        else if (dateInputToMs(v) === undefined) setV(saved);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function AutoText({
  value,
  onCommit,
  className,
  placeholder,
  label,
  minRows = 1,
}: {
  value: string;
  onCommit: (v: string) => void;
  className: string;
  placeholder?: string;
  label: string;
  minRows?: number;
}) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [v]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={v}
      rows={minRows}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && v !== value) {
          e.stopPropagation();
          setV(value);
        }
        if (minRows === 1 && e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

export function TaskSheet({ it, onClose }: { it: WorkItem; onClose: () => void }) {
  const { patch, setStatus, remove, start, setToday } = useTaskActions();
  const { data: projects } = useProjects();
  const { data: boot } = useBootstrap();
  const phone = boot?.device.isPhone ?? isPhone();
  const term = useTerminal(); // no terminal on this PC: background only
  const [stage, setStage] = useState<'edit' | 'start' | 'launch'>('edit');
  const [mode, setMode] = useState<'terminal' | 'background'>(
    (!term ? 'background' : (phone ? boot?.settings.launch.phoneMode : boot?.settings.launch.pcMode) || (phone ? 'background' : 'terminal')) as 'terminal' | 'background',
  );
  const [resume, setResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const closed = it.status === 'done' || it.status === 'dropped';
  const projList = useMemo(
    () => (projects || []).filter((p) => p.status !== 'archived' || p.id === it.projectId).sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.name.localeCompare(b.name)),
    [projects, it.projectId],
  );
  const project = projects?.find((p) => p.id === it.projectId);
  const hint = aiHint(it);

  const doStart = async () => {
    setBusy(true);
    const r = await start(it.id, mode, resume);
    setBusy(false);
    if (r) {
      setLaunch(r.launch as unknown as Launch);
      setStage('launch');
    }
  };

  const title =
    stage === 'edit' ? (
      <span className="row" style={{ gap: 8 }}>
        <ProjectGlyph name={it.projectName} ws={it.workspace} color={project?.color} size={20} />
        <span className="truncate">{it.projectName}</span>
      </span>
    ) : stage === 'start' ? (
      'Start a session for this task'
    ) : (
      'Session'
    );

  const footer =
    stage === 'edit' ? (
      <>
        <IconButton
          icon={<Trash2 />}
          label="Delete task"
          className="task-del"
          onClick={async () => {
            if (!confirm(it.ai ? `Delete “${it.title}”? Pilotage won’t suggest it again. To keep it restorable, use Drop instead.` : `Delete “${it.title}”?`)) return;
            if (await remove(it.id)) onClose();
          }}
        />
        {it.status === 'dropped' || isAutoClosed(it) ? (
          <Button variant="ghost" size="sm" icon={<RotateCcw />} onClick={() => setStatus(it.id, 'todo')} title="Back to To do">
            Restore
          </Button>
        ) : (
          <Button variant="ghost" size="sm" icon={<X />} onClick={() => setStatus(it.id, 'dropped')}>
            Drop
          </Button>
        )}
        <span className="grow" />
        {!closed && (
          <Button size="sm" icon={<Play />} onClick={() => setStage('start')}>
            Start session
          </Button>
        )}
        {it.status !== 'done' ? (
          <Button
            size="sm"
            icon={<Check />}
            onClick={() => {
              setStatus(it.id, 'done');
              onClose();
            }}
          >
            Mark done
          </Button>
        ) : (
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        )}
      </>
    ) : stage === 'start' ? (
      <>
        <Button variant="ghost" onClick={() => setStage('edit')}>
          Back
        </Button>
        <Button variant="primary" icon={<Play />} loading={busy} onClick={doStart}>
          Start session
        </Button>
      </>
    ) : (
      <Button onClick={onClose}>Close</Button>
    );

  return (
    <Portal>
      <Modal title={title} onClose={onClose} footer={footer} className="task-sheet">
        {stage === 'edit' && (
          <div className="modal-body task-sheet-body">
            <AutoText className="task-title-edit" value={it.title} label="Title" onCommit={(v) => v.trim() && patch(it.id, { title: v.trim() })} />
            <div className="task-props">
              <span className="tp-label">Status</span>
              <div className="tp-val">
                {it.status === 'dropped' ? (
                  <span className="row small muted" style={{ gap: 6 }}>
                    <StatusIcon status="abandoned" /> Dropped
                  </span>
                ) : (
                  <SegmentedControl
                    size="sm"
                    label="Status"
                    value={it.status}
                    onChange={(s) => setStatus(it.id, s)}
                    options={(['inbox', 'todo', 'doing', 'done'] as WorkStatus[]).map((s) => ({ value: s, label: TASK_STATUS[s].label, title: TASK_STATUS[s].hint }))}
                  />
                )}
              </div>
              {!closed && (
                <>
                  <span className="tp-label">Today</span>
                  <div className="tp-val task-today-toggle">
                    <Switch on={isPlannedToday(it)} onChange={(on) => setToday(it.id, on)} label={isPlannedToday(it) ? 'Remove from today' : 'Add to today'} />
                    <span className="small muted">{isPlannedToday(it) ? 'On Home › Today until it’s done' : it.status === 'inbox' ? 'Add to today (also keeps it in To do)' : 'Add to today'}</span>
                  </div>
                </>
              )}
              <span className="tp-label">Priority</span>
              <div className="tp-val">
                <SegmentedControl
                  size="sm"
                  label="Priority"
                  value={String(it.priority)}
                  onChange={(v) => patch(it.id, { priority: Number(v) as 0 | 1 | 2 | 3 })}
                  options={PRIORITIES.map((p) => ({
                    value: String(p.value),
                    label: (
                      <>
                        {p.value !== 1 && <PriorityIcon p={p.value} />}
                        {p.label}
                      </>
                    ),
                  }))}
                />
              </div>
              <span className="tp-label">Due</span>
              <div className="tp-val row" style={{ gap: 6 }}>
                <DueInput value={it.dueAt} onCommit={(dueAt) => patch(it.id, { dueAt })} />
                {it.dueAt && (
                  <Button variant="ghost" size="sm" onClick={() => patch(it.id, { dueAt: null })}>
                    Clear
                  </Button>
                )}
              </div>
              <span className="tp-label">Project</span>
              <div className="tp-val">
                <ProjectSelect value={it.projectId} projects={projList} onChange={(id) => id && id !== it.projectId && patch(it.id, { projectId: id }, 'Moved')} label="Project" />
              </div>
            </div>
            <div className="task-detail-wrap">
              {it.ai && !!it.detail && <span className="task-detail-cap">The full step · sent to Claude when you start a session</span>}
              <AutoText
                className="textarea task-detail-edit"
                value={it.detail}
                label="Details"
                placeholder="Add details, links, acceptance criteria…"
                minRows={3}
                onCommit={(v) => patch(it.id, { detail: v })}
              />
            </div>
            {hint && <AiHintLine it={it} />}
            <div className="task-sheet-src">
              <Meta
                items={[
                  it.ai ? <AiTag /> : <span>Added by you</span>,
                  it.who ? <WhoTag who={it.who} /> : null,
                  it.source.kind === 'ai' && it.source.sessionId ? (
                    it.source.sessionTitle ? (
                      <Link to={`/sessions/${it.source.sessionId}`} onClick={onClose} className="link">
                        from “{it.source.sessionTitle}”
                      </Link>
                    ) : (
                      <span>from a session that no longer exists</span>
                    )
                  ) : it.source.kind !== 'user' && it.source.kind !== 'ai' ? (
                    <SourceLine it={it} link={false} />
                  ) : null,
                  <span title={fmtDateTime(it.createdAt)}>created {fmtDate(it.createdAt)}</span>,
                  isAutoClosed(it) ? <span>{it.closedBy === 'expired' ? 'expired' : 'closed automatically'}</span> : null,
                  it.launches.length ? <span>{it.launches.length === 1 ? 'started once' : `started ${it.launches.length} times`}</span> : null,
                ]}
              />
              {it.autoManaged && (
                <div className="hint">Pilotage keeps this one up to date from your sessions until you edit it. Moving it between Suggested, To do and Doing doesn’t count as an edit.</div>
              )}
            </div>
          </div>
        )}
        {stage === 'start' && (
          <div className="modal-body">
            <div className="focus-card">
              <div className="medium">{it.title}</div>
              <div className="tiny faint">Claude gets the title and details as its first prompt, and is asked to check in before anything risky.</div>
            </div>
            {boot?.settings.launch.permissionMode === 'bypassPermissions' && <SkipPromptsNote />}
            {term && (
              <div className="field">
                <label>Where</label>
                <div className="choice-grid" role="radiogroup" aria-label="Where">
                  {(
                    [
                      { value: 'terminal', icon: <Monitor size={17} />, title: 'Terminal on PC', hint: `${terminalPlace(term, true)} with Remote Control, so it also shows on your phone.` },
                      { value: 'background', icon: <Cloud size={17} />, title: 'Background', hint: 'No window on the PC. Continue it in the Claude app.' },
                    ] as const
                  ).map((o) => (
                    <button type="button" key={o.value} role="radio" aria-checked={mode === o.value} className={`choice${mode === o.value ? ' on' : ''}`} onClick={() => setMode(o.value)}>
                      <span className="choice-icon">{o.icon}</span>
                      <span className="choice-title">{o.title}</span>
                      <span className="choice-hint">{o.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {it.source.kind === 'ai' && it.source.sessionId && it.source.sessionTitle && (
              <label className="row small check-row">
                <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
                Continue “{it.source.sessionTitle}” instead of a fresh session
              </label>
            )}
          </div>
        )}
        {stage === 'launch' && launch && (
          <div className="modal-body" style={{ paddingTop: 10 }}>
            <LaunchStatus launch={launch} onNavigate={onClose} />
          </div>
        )}
      </Modal>
    </Portal>
  );
}

/** Project picker grouped by workspace. */
export function ProjectSelect({
  value,
  projects,
  onChange,
  label,
  allLabel,
  className = '',
}: {
  value: string;
  projects: Pick<ProjectSummary, 'id' | 'name' | 'workspaceName'>[];
  onChange: (id: string) => void;
  label: string;
  allLabel?: string;
  className?: string;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, typeof projects>();
    for (const p of projects) {
      const g = m.get(p.workspaceName) || [];
      g.push(p);
      m.set(p.workspaceName, g);
    }
    return [...m.entries()];
  }, [projects]);
  return (
    <select className={`select ${className}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {allLabel !== undefined && <option value="">{allLabel}</option>}
      {groups.map(([ws, ps]) => (
        <optgroup key={ws} label={ws}>
          {ps.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
