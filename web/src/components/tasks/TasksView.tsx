// The Tasks UI (SIMPLIFY §6), shared by /tasks and Project › Tasks (same components, same two tabs):
//   To do      a list by status (Doing · To do · Done) by default, or a board (drag between columns), or by project.
//              "Today" chip on flagged tasks. Tasks Pilotage closed by itself stay out of sight behind one toggle.
//   Suggested  the triage list (components/tasks/Suggested.tsx). Never on the board, never in the To do counts.
// Search sits in one row with a Filter button (project, workspace, who added it, grouping) and the view switch.
// Dropped tasks sit in a fold at the bottom, restorable from the task sheet.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, Columns3, List, ListChecks, Search, SlidersHorizontal, X } from 'lucide-react';
import { useProjects } from '../../api';
import { tasksDismissOld, tasksRestore, useWork } from '../../api-extra';
import { Board, BoardColumn, Button, Card, Disclosure, EmptyState, Kbd, LoadingCard, ProjectGlyph, SegmentedControl, Section, StatusIcon, Tabs, Toolbar, ToolbarSpacer, useToast } from '../ui';
import type { WorkItem, WorkStatus } from '../../types-extra';
import { plural } from '../../util';
import { TaskCard, TaskSheet, TaskUndoToast, useProjectIndex } from './TaskBits';
import { TaskLine } from './TaskLine';
import { TaskQuickAdd } from './TaskQuickAdd';
import { SuggestedList } from './Suggested';
import { BOARD_COLUMNS, friendly, isAutoClosed, isOldSuggestion, isPlannedToday, isSnoozed, isSuggested, offerUndo, OLD_DAYS, TASK_STATUS, useMedia, usePref, useTaskActions, useTick } from './model';
import './tasks.css';

export type TasksTabValue = 'todo' | 'suggested';
type Who = 'all' | 'ai' | 'mine';
type View = 'board' | 'list';
type GroupBy = 'status' | 'project';
const COL_CAP = 12;
const STATUS_RANK: Record<WorkStatus, number> = { doing: 0, todo: 1, inbox: 2, done: 3, dropped: 4 };

/** The tab lives in the URL: `?tab=suggested` on /tasks, `?tasks=suggested` on a project page (its ?tab= is taken). */
export function useTasksTab(param = 'tab'): [TasksTabValue, (t: TasksTabValue) => void] {
  const [params, setParams] = useSearchParams();
  const tab: TasksTabValue = params.get(param) === 'suggested' ? 'suggested' : 'todo';
  const set = useCallback(
    (t: TasksTabValue) =>
      setParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (t === 'suggested') n.set(param, 'suggested');
          else n.delete(param);
          return n;
        },
        { replace: true },
      ),
    [param, setParams],
  );
  return [tab, set];
}

/** Tab counts: To do = To do + Doing (the badge everywhere); Suggested = visible suggestions (snoozed ones excluded). */
export function taskCounts(items: WorkItem[], now = Date.now()) {
  let todo = 0;
  let doing = 0;
  let suggested = 0;
  for (const it of items) {
    if (it.status === 'todo') todo++;
    else if (it.status === 'doing') doing++;
    else if (isSuggested(it, now)) suggested++;
  }
  return { open: todo + doing, todo, doing, suggested };
}

/** "To do 7 · Suggested 12" as page tabs (Tasks header) or as a segmented control (inside a project tab). */
export function TasksTabs({ value, onChange, counts, inline = false }: { value: TasksTabValue; onChange: (t: TasksTabValue) => void; counts?: { open: number; suggested: number }; inline?: boolean }) {
  if (inline)
    return (
      <SegmentedControl
        value={value}
        onChange={onChange}
        label="Tasks view"
        options={[
          { value: 'todo', label: <>To do {counts && <span className="num faint">{counts.open}</span>}</>, title: 'Tasks you decided to do' },
          { value: 'suggested', label: <>Suggested {counts && <span className="num faint">{counts.suggested}</span>}</>, title: 'Suggested by AI from your sessions: keep or dismiss them' },
        ]}
      />
    );
  return (
    <Tabs
      value={value}
      onChange={onChange}
      className="tasks-tabs"
      items={[
        { value: 'todo', label: 'To do', count: counts?.open },
        { value: 'suggested', label: 'Suggested', count: counts?.suggested },
      ]}
    />
  );
}

function sortTodo(list: WorkItem[]) {
  // today-flagged first, then the server's order (priority, due date, newest)
  return list.map((it, i) => ({ it, i, t: isPlannedToday(it) ? 0 : 1 })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.it);
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

export function TasksView({
  projectId,
  tab,
  onTab,
  inlineTabs = false,
  addRef: addRefIn,
  initialOpenId = null,
  onSheetClose,
  initialProject = '',
  initialWorkspace = '',
}: {
  /** Only this project's tasks (Project › Tasks). Hides the project filters and glyphs. */
  projectId?: string;
  tab: TasksTabValue;
  onTab: (t: TasksTabValue) => void;
  /** Render the To do / Suggested switch here (project page). The Tasks page puts it in its header. */
  inlineTabs?: boolean;
  addRef?: React.RefObject<HTMLInputElement>;
  initialOpenId?: string | null;
  onSheetClose?: () => void;
  initialProject?: string;
  initialWorkspace?: string;
}) {
  useTick();
  const scoped = !!projectId;
  const { data, error, isLoading, refetch } = useWork(scoped ? { project: projectId } : {});
  const { data: projects } = useProjects();
  const pindex = useProjectIndex();
  const phone = useMedia();
  const toast = useToast();
  const { setStatus } = useTaskActions();
  // List is the default now (v2 keys, so an older "board" choice doesn't stick); Board stays one click away.
  const [view, setView] = usePref<View>(scoped ? 'pilotage.project.tasks.view2' : 'pilotage.tasks.view2', 'list');
  const [groupBy, setGroupBy] = usePref<GroupBy>('pilotage.tasks.groupBy', 'status');
  const [who, setWho] = usePref<Who>('pilotage.tasks.who', 'all');
  const [q, setQ] = useState('');
  const [proj, setProj] = useState(initialProject);
  const [ws, setWs] = useState(initialWorkspace);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [showFilters, setShowFilters] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<WorkStatus | null>(null);
  const [dismissingOld, setDismissingOld] = useState(false);
  const ownAddRef = useRef<HTMLInputElement>(null);
  const addRef = addRefIn || ownAddRef;
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setOpenId(initialOpenId), [initialOpenId]);
  useEffect(() => setProj(initialProject), [initialProject]);

  // keyboard (desktop, To do tab): N = new task, / = search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector('.overlay')) return;
      if ((e.key === 'n' || e.key === 'N') && tab === 'todo') {
        e.preventDefault();
        addRef.current?.focus();
      } else if (e.key === '/' && !scoped) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, scoped, addRef]);

  const items = data?.items || [];
  const now = Date.now();
  const counts = taskCounts(items, now);
  const wsNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects || []) m.set(p.workspace, p.workspaceName);
    return m;
  }, [projects]);
  const projOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string; workspaceName: string }>();
    for (const it of items) if (!m.has(it.projectId)) m.set(it.projectId, { id: it.projectId, name: it.projectName, workspaceName: (it.workspace && wsNames.get(it.workspace)) || it.workspace || 'Other' });
    return [...m.values()].sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.name.localeCompare(b.name));
  }, [items, wsNames]);
  const wsOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) if (it.workspace) m.set(it.workspace, (m.get(it.workspace) || 0) + 1);
    return [...m.entries()].map(([key, n]) => ({ key, name: wsNames.get(key) || key, n })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, wsNames]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (proj && it.projectId !== proj) return false;
      if (ws && it.workspace !== ws) return false;
      if (tab === 'todo' && who === 'ai' && !it.ai) return false;
      if (tab === 'todo' && who === 'mine' && it.ai) return false;
      if (needle && !`${it.title} ${it.detail} ${it.projectName}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [items, proj, ws, who, q, tab]);

  // Closed by Pilotage itself: out of sight unless asked for (one toggle instead of a Restore on every card).
  const autoClosed = useMemo(() => filtered.filter(isAutoClosed), [filtered]);
  const visible = useMemo(() => (showAuto ? filtered : filtered.filter((it) => !isAutoClosed(it))), [filtered, showAuto]);

  const byStatus = useMemo(() => {
    const m: Record<WorkStatus, WorkItem[]> = { inbox: [], todo: [], doing: [], done: [], dropped: [] };
    for (const it of visible) m[it.status].push(it);
    m.todo = sortTodo(m.todo);
    m.doing = sortTodo(m.doing);
    m.done.sort((a, b) => (b.doneAt || b.updatedAt) - (a.doneAt || a.updatedAt));
    m.dropped.sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [visible]);
  const suggestions = byStatus.inbox.filter((it) => !isSnoozed(it, now));
  const snoozed = byStatus.inbox.filter((it) => isSnoozed(it, now));
  const oldOnes = scoped ? [] : items.filter((it) => isOldSuggestion(it, now));

  const nFilters = [proj, ws, tab === 'todo' && who !== 'all' ? who : ''].filter(Boolean).length;
  const filtersOn = !!(nFilters || q.trim());
  const clearFilters = () => {
    setProj('');
    setWs('');
    setWho('all');
    setQ('');
  };
  const openItem = openId ? items.find((x) => x.id === openId) : undefined;
  const closeSheet = useCallback(() => {
    setOpenId(null);
    onSheetClose?.();
  }, [onSheetClose]);

  const dismissOld = async () => {
    if (dismissingOld) return;
    setDismissingOld(true);
    try {
      const r = await tasksDismissOld(OLD_DAYS);
      refetch();
      if (!r.ids.length) toast(`Nothing older than ${OLD_DAYS} days`);
      else {
        offerUndo(`Dismissed ${plural(r.ids.length, 'suggestion')} older than ${OLD_DAYS} days`, async () => {
          try {
            const back = await tasksRestore(r.ids);
            toast(`${plural(back.restored, 'suggestion')} back in Suggested`);
          } catch (e) {
            toast(friendly(e), true);
          } finally {
            refetch();
          }
        });
      }
    } catch (e) {
      toast(friendly(e), true);
    } finally {
      setDismissingOld(false);
    }
  };

  const drop = (s: WorkStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setOver(null);
    setDragId(null);
    const it = items.find((x) => x.id === id);
    if (it && it.status !== s) setStatus(it.id, s);
  };
  const more = (key: string, total: number, cap: number) =>
    total > cap ? (
      <button type="button" className="task-more" onClick={() => setExpanded((x) => ({ ...x, [key]: !x[key] }))}>
        {expanded[key] ? 'Show fewer' : `Show ${total - cap} more`}
      </button>
    ) : null;
  const capped = (key: string, list: WorkItem[], cap: number) => (expanded[key] ? list : list.slice(0, cap));
  const showProject = !scoped;
  const line = (it: WorkItem, withProject = showProject) => <TaskLine key={it.id} it={it} project={pindex.get(it.projectId)} showProject={withProject} onOpen={() => setOpenId(it.id)} />;

  // ---------- To do content
  const todoTotal = byStatus.todo.length + byStatus.doing.length + byStatus.done.length;
  const statusSections = (
    <div className="task-groups">
      {(['doing', 'todo', 'done'] as WorkStatus[]).map((s) => {
        const list = byStatus[s];
        if (!list.length) return null;
        const cap = s === 'done' ? 3 : 12;
        return (
          <Section key={s} title={<><StatusIcon status={TASK_STATUS[s].glyph} />{TASK_STATUS[s].label}</>} count={list.length}>
            <Card flush className="task-list">
              {capped(s, list, cap).map((it) => line(it))}
              {list.length > cap && <div className="task-more-row">{more(s, list.length, cap)}</div>}
            </Card>
          </Section>
        );
      })}
    </div>
  );

  let todoContent: React.ReactNode;
  if (!todoTotal && !filtersOn)
    todoContent = (
      <Card>
        <EmptyState
          icon={<ListChecks />}
          title="Nothing to do yet"
          body={counts.suggested ? 'Keep a suggestion, or add your own task above.' : 'Add a task above.'}
          action={
            counts.suggested ? (
              <Button size="sm" onClick={() => onTab('suggested')}>
                See {plural(counts.suggested, 'suggestion')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  else if (!todoTotal)
    todoContent = (
      <Card>
        <EmptyState compact icon={<Search />} title="No tasks match" action={<Button size="sm" variant="ghost" icon={<X />} onClick={clearFilters}>Clear filters</Button>} />
      </Card>
    );
  else if (view === 'board' && !phone)
    todoContent = (
      <Board>
        {BOARD_COLUMNS.map((s) => {
          const list = byStatus[s];
          return (
            <div
              key={s}
              className={`task-col${over === s && dragId ? ' over' : ''}`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== s) setOver(s);
              }}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o === s ? null : o));
              }}
              onDrop={drop(s)}
            >
              <BoardColumn title={TASK_STATUS[s].label} status={TASK_STATUS[s].glyph} count={list.length} empty={dragId ? 'Drop here' : s === 'doing' ? 'Drag a task here' : 'Nothing here'}>
                {capped(s, list, COL_CAP).map((it) => (
                  <TaskCard
                    key={it.id}
                    it={it}
                    project={pindex.get(it.projectId)}
                    showProject={showProject}
                    onOpen={() => setOpenId(it.id)}
                    dragging={dragId === it.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', it.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(it.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOver(null);
                    }}
                  />
                ))}
                {more(s, list.length, COL_CAP)}
              </BoardColumn>
            </div>
          );
        })}
      </Board>
    );
  else if (scoped || groupBy === 'status') todoContent = statusSections;
  else {
    // list grouped by project
    const groups = new Map<string, WorkItem[]>();
    for (const it of visible) {
      if (it.status === 'dropped' || it.status === 'inbox') continue;
      const g = groups.get(it.projectId) || [];
      g.push(it);
      groups.set(it.projectId, g);
    }
    const ordered = [...groups.entries()]
      .map(([id, list]) => ({ id, list: list.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || Number(isPlannedToday(b)) - Number(isPlannedToday(a)) || b.priority - a.priority || b.sourceAt - a.sourceAt) }))
      .sort((a, b) => {
        const score = (l: WorkItem[]) => l.filter((x) => x.status === 'doing').length * 100 + l.filter((x) => x.status === 'todo').length * 10;
        return score(b.list) - score(a.list) || a.list[0].projectName.localeCompare(b.list[0].projectName);
      });
    todoContent = (
      <div className="task-groups">
        {ordered.map(({ id, list }) => {
          const first = list[0];
          const p = pindex.get(id);
          const openN = list.filter((x) => x.status !== 'done').length;
          const cap = 8;
          return (
            <section key={id} className="section">
              <div className="task-proj-head">
                <ProjectGlyph name={first.projectName} ws={first.workspace} color={p?.color} size={22} />
                {p ? (
                  <Link to={`/projects/${id}`} className="task-proj-name">
                    {first.projectName}
                  </Link>
                ) : (
                  <span className="task-proj-name">{first.projectName}</span>
                )}
                <span className="faint small num">{openN ? `${openN} open` : 'all done'}</span>
              </div>
              <Card flush className="task-list">
                {capped(`p:${id}`, list, cap).map((it) => line(it, false))}
                {list.length > cap && <div className="task-more-row">{more(`p:${id}`, list.length, cap)}</div>}
              </Card>
            </section>
          );
        })}
      </div>
    );
  }

  // ---------- toolbar: [search] [Filter] [List | Board], one row (one 44px row on a phone)
  const filterPanel = scoped ? null : (
    <div className="task-filter-panel" role="group" aria-label="Filters">
      <label className="tfp-field">
        <span className="tfp-label">Project</span>
        <select className="select task-filter" value={proj} onChange={(e) => setProj(e.target.value)} aria-label="Filter by project">
          <option value="">All projects</option>
          {projOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {wsOptions.length > 1 && (
        <label className="tfp-field">
          <span className="tfp-label">Workspace</span>
          <select className="select task-filter" value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Filter by workspace">
            <option value="">All workspaces</option>
            {wsOptions.map((w) => (
              <option key={w.key} value={w.key}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {tab === 'todo' && (
        <div className="tfp-field">
          <span className="tfp-label">Added by</span>
          <SegmentedControl
            size="sm"
            label="Who added it"
            value={who}
            onChange={setWho}
            options={[
              { value: 'all', label: 'Anyone' },
              { value: 'ai', label: 'Pilotage', title: 'Suggested by Pilotage and kept by you' },
              { value: 'mine', label: 'You', title: 'Tasks you added yourself' },
            ]}
          />
        </div>
      )}
      {tab === 'todo' && (view === 'list' || phone) && (
        <div className="tfp-field">
          <span className="tfp-label">Group by</span>
          <SegmentedControl
            size="sm"
            label="Group by"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: 'status', label: 'Status' },
              { value: 'project', label: 'Project' },
            ]}
          />
        </div>
      )}
      {filtersOn && (
        <Button size="sm" variant="ghost" icon={<X />} onClick={clearFilters} className="tfp-clear">
          Clear
        </Button>
      )}
    </div>
  );
  const viewToggle =
    !phone && tab === 'todo' ? (
      <SegmentedControl
        size="sm"
        label="View"
        value={view}
        onChange={setView}
        options={[
          { value: 'list', label: <><List />List</>, title: 'One list by status' },
          { value: 'board', label: <><Columns3 />Board</>, title: 'Columns by status (drag cards between them)' },
        ]}
      />
    ) : null;

  const toolbar = scoped ? (
    inlineTabs || viewToggle ? (
      <Toolbar className="task-toolbar">
        {inlineTabs && <TasksTabs inline value={tab} onChange={onTab} counts={counts} />}
        <ToolbarSpacer />
        {viewToggle}
      </Toolbar>
    ) : null
  ) : (
    <Toolbar className="task-toolbar">
      <div className="input-wrap task-search">
        <Search />
        <input
          ref={searchRef}
          className="input"
          placeholder={tab === 'suggested' ? 'Search suggestions' : 'Search tasks'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && (setQ(''), (e.target as HTMLInputElement).blur())}
          aria-label="Search tasks"
          type="search"
        />
        {!phone && !q && <Kbd>/</Kbd>}
      </div>
      <Button size={phone ? 'md' : 'sm'} variant={nFilters ? 'subtle' : 'ghost'} icon={<SlidersHorizontal />} onClick={() => setShowFilters((x) => !x)} aria-expanded={showFilters} className="task-filter-toggle">
        {nFilters ? `Filter · ${nFilters}` : 'Filter'}
      </Button>
      {!phone && <ToolbarSpacer />}
      {viewToggle}
    </Toolbar>
  );

  let body: React.ReactNode;
  if (isLoading) body = <LoadingCard lines={6} />;
  else if (error)
    body = (
      <Card>
        <EmptyState icon={<ListChecks />} title="Tasks didn’t load" body={friendly(error)} action={<Button size="sm" onClick={() => refetch()}>Try again</Button>} />
      </Card>
    );
  else if (tab === 'suggested')
    body = (
      <SuggestedList
        items={suggestions}
        snoozed={snoozed}
        showProject={showProject}
        active={tab === 'suggested' && !openItem}
        onOpen={setOpenId}
        filtered={filtersOn}
        emptyAction={filtersOn ? <Button size="sm" variant="ghost" icon={<X />} onClick={clearFilters}>Clear filters</Button> : undefined}
        footer={
          !scoped ? (
            <div className="task-foot">
              {oldOnes.length > 0 && (
                <Button size="sm" variant="ghost" icon={<Archive />} loading={dismissingOld} onClick={dismissOld} title={`Dismiss the ${plural(oldOnes.length, 'suggestion')} nobody touched for ${OLD_DAYS} days (you can undo)`}>
                  Dismiss {oldOnes.length} older than {OLD_DAYS} days
                </Button>
              )}
              <Disclosure summary="Where suggestions come from" className="task-fold">
                <div className="stack small muted readable">
                  <p>Each summarized session can suggest its next step, and each project summary its top two. Only recent work counts, near-duplicates are merged, and a project shows three suggestions at most.</p>
                  <p>
                    Untouched suggestions go away after {OLD_DAYS} days; you can bring them back. Once you keep one it’s yours.{' '}
                    <Link to="/guide" className="link">
                      How Pilotage works
                    </Link>
                  </p>
                  {!phone && (
                    <p className="sg-keys" aria-hidden="true">
                      <Kbd>J</Kbd>
                      <Kbd>K</Kbd> move · <Kbd>1</Kbd> Keep · <Kbd>2</Kbd> Today · <Kbd>3</Kbd> Dismiss · <Kbd>H</Kbd> Not now
                    </p>
                  )}
                </div>
              </Disclosure>
            </div>
          ) : undefined
        }
      />
    );
  else body = todoContent;

  const dropped = byStatus.dropped;
  return (
    <div className="tasks-view">
      {scoped && toolbar}
      {tab === 'todo' && <TaskQuickAdd projectId={projectId} defaultProject={proj} inputRef={addRef} />}
      {!scoped && (
        <div className="task-toolbar-wrap">
          {toolbar}
          {showFilters && filterPanel}
        </div>
      )}

      {body}

      {tab === 'todo' && !isLoading && (dropped.length > 0 || autoClosed.length > 0) && (
        <div className="task-foot">
          {dropped.length > 0 && (
            <Disclosure summary={<>Dropped <span className="num faint">{dropped.length}</span></>} className="task-fold">
              <Card flush className="task-list">
                {capped('dropped', dropped, 8).map((it) => line(it))}
                {dropped.length > 8 && <div className="task-more-row">{more('dropped', dropped.length, 8)}</div>}
              </Card>
            </Disclosure>
          )}
          {autoClosed.length > 0 && (
            <button type="button" className="task-more task-auto-toggle" onClick={() => setShowAuto((x) => !x)} aria-pressed={showAuto}>
              {showAuto ? `Hide the ${autoClosed.length} closed automatically` : `Show ${autoClosed.length} closed automatically`}
            </button>
          )}
        </div>
      )}

      {openItem && <TaskSheet key={openItem.id} it={openItem} onClose={closeSheet} />}
      <TaskUndoToast />
    </div>
  );
}
