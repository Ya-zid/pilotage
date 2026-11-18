// Tasks › Suggested: the triage list (SIMPLIFY §6). AI suggestions stay apart from commitments until the user decides.
// A row is the short title + one meta line (age, who); the full step and where it came from are in the task sheet
// (tap the row). One visible action, Keep (on hover on PC), and a ⋯ menu: Today · Not now · Not a task · Already
// done · Duplicate. Grouped by project (3 shown, "+N more") on /tasks; a flat list inside a project.
// Keys (desktop): J/K move · 1 Keep · 2 Today · 3 Dismiss (then 1–3 picks the reason) · H Not now · Enter opens.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Clock, Copy, Inbox, MoreHorizontal, Plus, Sun, Undo2, X } from 'lucide-react';
import { Button, Card, Disclosure, EmptyState, Kbd, Meta, ProjectGlyph } from '../ui';
import type { WorkItem } from '../../types-extra';
import { ago, fmtDate, fmtDateTime, plural } from '../../util';
import { Menu, type MenuItem, useProjectIndex, WhoTag } from './TaskBits';
import { DISMISS_REASONS, SNOOZE_DAYS, suggestedAt, useMedia, useTaskActions } from './model';
import './tasks.css';

const PAGE = 10; // flat list (project page)
const PER_GROUP = 3; // grouped list (/tasks)
/** Dismiss reasons offered as chips after the "3" key; "Not now" (snooze) is H. */
const CHIP_REASONS = DISMISS_REASONS.filter((r) => r.value !== 'snooze');

function SuggestionRow({
  it,
  showProject,
  focused,
  chips,
  snoozed = false,
  onChips,
  onFocusRow,
  onOpen,
  rowRef,
}: {
  it: WorkItem;
  showProject: boolean;
  focused: boolean;
  chips: boolean;
  snoozed?: boolean;
  onChips: (open: boolean) => void;
  onFocusRow?: () => void;
  onOpen: () => void;
  rowRef?: (el: HTMLDivElement | null) => void;
}) {
  const { setStatus, setToday, dismiss } = useTaskActions();
  const phone = useMedia();
  const pindex = useProjectIndex();
  const project = pindex.get(it.projectId);
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const items: MenuItem[] = [
    { key: 'today', label: 'Add to today', icon: <Sun />, sub: 'Also keeps it in To do', hint: phone ? undefined : '2', onSelect: () => setToday(it.id, true) },
    snoozed
      ? { key: 'back', label: 'Bring back now', icon: <Undo2 />, onSelect: () => dismiss(it.id, 'unsnooze') }
      : { key: 'snooze', label: 'Not now', icon: <Clock />, sub: `Hidden for ${SNOOZE_DAYS} days`, hint: phone ? undefined : 'H', onSelect: () => dismiss(it.id, 'snooze') },
    { key: 'not-a-task', sep: true, label: 'Not a task', icon: <X />, onSelect: () => dismiss(it.id, 'not-a-task') },
    { key: 'done', label: 'Already done', icon: <Check />, onSelect: () => dismiss(it.id, 'done') },
    { key: 'duplicate', label: 'Duplicate', icon: <Copy />, onSelect: () => dismiss(it.id, 'duplicate') },
  ];
  return (
    <div ref={rowRef} className={`lrow sg-row clickable${focused ? ' focused' : ''}${chips ? ' chips-open' : ''}${menu ? ' menu-open' : ''}`} tabIndex={-1} onFocus={onFocusRow} role="listitem" aria-label={it.title}>
      <button type="button" className="lrow-link" aria-label={`Open: ${it.title}`} onClick={onOpen} tabIndex={-1} />
      <div className="lrow-body">
        <span className="sg-title">{it.title}</span>
        <Meta
          items={[
            showProject ? (
              <span className="task-proj">
                <ProjectGlyph name={it.projectName} ws={it.workspace ?? project?.workspace} color={project?.color} size={14} />
                <span className="truncate">{it.projectName}</span>
              </span>
            ) : null,
            it.who ? <WhoTag who={it.who} /> : null,
            snoozed && it.snoozeUntil ? (
              <span title={fmtDateTime(it.snoozeUntil)}>Back {fmtDate(it.snoozeUntil)}</span>
            ) : (
              <span title={`Seen ${fmtDateTime(suggestedAt(it))}`}>{ago(suggestedAt(it))}</span>
            ),
          ]}
        />
      </div>
      <div className="sg-actions above" role="group" aria-label="Decide" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" icon={<Plus />} className="sg-keep" onClick={() => setStatus(it.id, 'todo')} title={phone ? undefined : 'Keep it in To do (1)'}>
          Keep
        </Button>
        <button ref={moreRef} type="button" className="btn sm ghost icon sg-more" aria-label="More: today, not now, dismiss" aria-haspopup="menu" aria-expanded={menu} title="Today, Not now, Dismiss…" onClick={() => setMenu(true)}>
          <MoreHorizontal />
        </button>
        {menu && <Menu anchor={moreRef.current} title={it.title} items={items} onClose={() => setMenu(false)} />}
      </div>
      {chips && (
        <div className="sg-chips above" role="group" aria-label="Why dismiss it?">
          <span className="sg-chips-label">Why?</span>
          {CHIP_REASONS.map((r, i) => (
            <button
              key={r.value}
              type="button"
              className="sg-chip"
              title={r.hint}
              onClick={() => {
                onChips(false);
                dismiss(it.id, r.value);
              }}
            >
              {r.label}
              {!phone && <Kbd>{i + 1}</Kbd>}
            </button>
          ))}
          <button type="button" className="sg-chip ghost" onClick={() => onChips(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

type Group = { id: string; name: string; workspace: string | null; items: WorkItem[]; at: number };

/** The triage list. `items` = suggestions to show (already filtered); `snoozed` = hidden ones, in a fold below.
 *  showProject = the cross-project page: grouped by project. */
export function SuggestedList({
  items,
  snoozed,
  showProject = true,
  active,
  onOpen,
  emptyAction,
  filtered = false,
  footer,
}: {
  items: WorkItem[];
  snoozed: WorkItem[];
  showProject?: boolean;
  /** The keyboard shortcuts listen only while the tab is on screen. */
  active: boolean;
  onOpen: (id: string) => void;
  emptyAction?: React.ReactNode;
  /** a search/filter is narrowing the list (changes the empty state) */
  filtered?: boolean;
  /** quiet extras under the list (e.g. "Dismiss the old ones") */
  footer?: React.ReactNode;
}) {
  const phone = useMedia();
  const pindex = useProjectIndex();
  const { setStatus, setToday, dismiss } = useTaskActions();
  const sorted = useMemo(() => [...items].sort((a, b) => suggestedAt(b) - suggestedAt(a)), [items]);
  const snoozedSorted = useMemo(() => [...snoozed].sort((a, b) => (a.snoozeUntil || 0) - (b.snoozeUntil || 0)), [snoozed]);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const grouped = showProject;
  const groups: Group[] = useMemo(() => {
    if (!grouped) return [];
    const m = new Map<string, Group>();
    for (const it of sorted) {
      const g = m.get(it.projectId) || { id: it.projectId, name: it.projectName, workspace: it.workspace, items: [], at: 0 };
      g.items.push(it);
      g.at = Math.max(g.at, suggestedAt(it));
      m.set(it.projectId, g);
    }
    return [...m.values()].sort((a, b) => b.at - a.at);
  }, [sorted, grouped]);
  // Rows on screen, in display order (the keyboard walks this list).
  const shown = useMemo(() => (grouped ? groups.flatMap((g) => (open[g.id] ? g.items : g.items.slice(0, PER_GROUP))) : sorted.slice(0, limit)), [grouped, groups, open, sorted, limit]);
  const [focusIdx, setFocusIdx] = useState(0);
  const [kb, setKb] = useState(false);
  const [chipsFor, setChipsFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const refs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const idx = Math.max(0, Math.min(focusIdx, shown.length - 1));

  const focusRow = (i: number) => {
    const el = shown[i] ? refs.current.get(shown[i].id) : null;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  };
  // A decided row leaves the list; keep the keyboard on the same slot (the next suggestion moves up).
  const n = shown.length;
  const shownKey = shown.map((x) => x.id).join(',');
  useEffect(() => {
    if (phone || !kb || !n) return;
    if (document.activeElement === document.body || !document.activeElement) focusRow(Math.min(focusIdx, n - 1));
  }, [shownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // latest values for the key handler
  const st = useRef({ shown, idx, kb, chipsFor });
  st.current = { shown, idx, kb, chipsFor };
  useEffect(() => {
    if (!active || phone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector('.overlay, .menu-pop')) return;
      const { shown, idx, kb, chipsFor } = st.current;
      if (!shown.length) return;
      const k = e.key.toLowerCase();
      const cur = shown[idx];
      const inList = !!listRef.current?.contains(document.activeElement);
      if (chipsFor && cur && chipsFor === cur.id) {
        if (/^[1-3]$/.test(k)) {
          e.preventDefault();
          const r = CHIP_REASONS[Number(k) - 1];
          setChipsFor(null);
          dismiss(cur.id, r.value);
          return;
        }
        if (k === 'escape') {
          e.preventDefault();
          setChipsFor(null);
          focusRow(idx);
          return;
        }
      }
      const arrow = k === 'arrowdown' || k === 'arrowup';
      if (arrow && !inList) return; // don't hijack page scrolling
      if (k === 'enter' && document.activeElement !== refs.current.get(cur?.id)) return; // Enter on a button presses the button
      if (!['j', 'k', 'arrowdown', 'arrowup', '1', '2', '3', 'h', 'enter'].includes(k)) return;
      e.preventDefault();
      if (!kb) {
        // the first key only picks the first row (never acts on a row the user can't see highlighted)
        setKb(true);
        setFocusIdx(0);
        focusRow(0);
        return;
      }
      if (k === 'j' || k === 'arrowdown') {
        const i = Math.min(shown.length - 1, idx + 1);
        setFocusIdx(i);
        setChipsFor(null);
        focusRow(i);
      } else if (k === 'k' || k === 'arrowup') {
        const i = Math.max(0, idx - 1);
        setFocusIdx(i);
        setChipsFor(null);
        focusRow(i);
      } else if (k === '1') setStatus(cur.id, 'todo');
      else if (k === '2') setToday(cur.id, true);
      else if (k === '3') setChipsFor(cur.id);
      else if (k === 'h') dismiss(cur.id, 'snooze');
      else if (k === 'enter') onOpen(cur.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, phone, dismiss, setStatus, setToday, onOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = (it: WorkItem, opts: { showProject: boolean; snoozed?: boolean }) => {
    const i = shown.indexOf(it);
    return (
      <SuggestionRow
        key={it.id}
        it={it}
        showProject={opts.showProject}
        snoozed={opts.snoozed}
        focused={!phone && kb && i === idx && i >= 0}
        chips={chipsFor === it.id}
        onChips={(o) => setChipsFor(o ? it.id : null)}
        onFocusRow={
          i >= 0
            ? () => {
                setFocusIdx(i);
                setKb(true);
              }
            : undefined
        }
        onOpen={() => onOpen(it.id)}
        rowRef={i >= 0 ? (el) => refs.current.set(it.id, el) : undefined}
      />
    );
  };

  const snoozedFold =
    snoozedSorted.length > 0 ? (
      <Disclosure summary={<>Snoozed <span className="num faint">{snoozedSorted.length}</span></>} className="task-fold">
        <Card flush className="sg-list">
          {snoozedSorted.map((it) => row(it, { showProject, snoozed: true }))}
        </Card>
      </Disclosure>
    ) : null;

  if (!sorted.length)
    return (
      <>
        <Card>
          {filtered ? (
            <EmptyState compact icon={<Inbox />} title="No suggestions match" body="Try another search or project." action={emptyAction} />
          ) : (
            <EmptyState icon={<Inbox />} title="Nothing suggested" body="Pilotage suggests tasks from your sessions. They show up here." action={emptyAction} />
          )}
        </Card>
        {snoozedFold}
        {footer}
      </>
    );

  return (
    <>
      {grouped ? (
        <div ref={listRef} className="sg-groups" role="list" aria-label="Suggested tasks">
          {groups.map((g) => {
            const p = pindex.get(g.id);
            const more = g.items.length - PER_GROUP;
            return (
              <section key={g.id} className="sg-group" aria-label={g.name}>
                <div className="sg-group-head">
                  <ProjectGlyph name={g.name} ws={g.workspace ?? p?.workspace} color={p?.color} size={22} />
                  {p ? (
                    <Link to={`/projects/${g.id}`} className="sg-group-name truncate">
                      {g.name}
                    </Link>
                  ) : (
                    <span className="sg-group-name truncate">{g.name}</span>
                  )}
                  {g.items.length > 1 && <span className="count-pill num">{g.items.length}</span>}
                </div>
                <Card flush className="sg-list">
                  {(open[g.id] ? g.items : g.items.slice(0, PER_GROUP)).map((it) => row(it, { showProject: false }))}
                  {more > 0 && (
                    <div className="task-more-row">
                      <button type="button" className="task-more" onClick={() => setOpen((x) => ({ ...x, [g.id]: !x[g.id] }))}>
                        {open[g.id] ? 'Show fewer' : `+${more} more`}
                      </button>
                    </div>
                  )}
                </Card>
              </section>
            );
          })}
        </div>
      ) : (
        <Card flush className="sg-list">
          <div ref={listRef} role="list" aria-label="Suggested tasks">
            {shown.map((it) => row(it, { showProject: false }))}
          </div>
          {sorted.length > limit && (
            <div className="task-more-row">
              <button type="button" className="task-more" onClick={() => setLimit(sorted.length)}>
                Show {plural(sorted.length - limit, 'more suggestion')}
              </button>
            </div>
          )}
        </Card>
      )}
      {snoozedFold}
      {footer}
    </>
  );
}
