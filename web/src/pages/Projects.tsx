// Projects: every project grouped by workspace, filtered by lifecycle, as a card grid or a dense list.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight, EyeOff, FolderKanban, FolderPlus, LayoutGrid, List, Search, Sparkles, X } from 'lucide-react';
import { useOverview, useProjects } from '../api';
import { useWork } from '../api-extra';
import type { ProjectSummary } from '../types';
import { Button, Callout, Card, EmptyState, IconButton, Kbd, PageHeader, SegmentedControl, Skeleton, Spinner, Toolbar, ToolbarSpacer, WorkspaceAvatar } from '../components/ui';
import { HiddenProjectRow, ProjectRow, ProjectTile } from '../components/project/ProjectTile';
import { NewProjectDialog } from '../components/project/NewProjectDialog';
import { errMsg, storageGet, storageSet, useIsPhone } from '../components/project/lib';
import { plural } from '../util';
import { runningWord, useRunningByProject, type RunCounts } from '../components/cards';
import './Projects.css';

type Lifecycle = 'current' | 'quiet' | 'all' | 'done';
type Filter = Lifecycle | 'hidden';
type View = 'grid' | 'list';
// Same words in the filter, the header ("11 current") and the workspace groups ("3 current of 12").
const FILTERS: { value: Lifecycle; label: string; word: string; title: string; empty: string }[] = [
  { value: 'current', label: 'Current', word: 'current', title: 'Running, worked on in the last 14 days, or paused', empty: 'No current projects' },
  { value: 'quiet', label: 'Quiet', word: 'quiet', title: 'Nothing for 14 days or more', empty: 'Nothing quiet' },
  { value: 'done', label: 'Done', word: 'done', title: 'Marked done or archived', empty: 'Nothing finished or archived' },
  { value: 'all', label: 'All', word: '', title: 'Every project (hidden ones excepted)', empty: 'No projects' },
];
/** Projects hidden with Edit project → "Hide this project". Not a lifecycle: they're outside every other filter. */
const HIDDEN = { value: 'hidden' as const, label: 'Hidden', word: 'hidden', title: 'Hidden from your lists and the sidebar', empty: 'No hidden projects' };
const isFilter = (v: string | null): v is Filter => v === HIDDEN.value || FILTERS.some((f) => f.value === v);

function matches(p: ProjectSummary, f: Lifecycle) {
  const live = p.liveCount > 0;
  if (f === 'current') return live || p.status === 'active' || p.status === 'paused';
  if (f === 'quiet') return !live && (p.status === 'idle' || p.status === 'dormant');
  if (f === 'done') return !live && (p.status === 'done' || p.status === 'archived');
  return true;
}

function haystack(p: ProjectSummary) {
  return `${p.name} ${p.folderName} ${p.displayPath} ${p.oneLiner || ''} ${p.workspaceName} ${p.stack.join(' ')} ${p.git?.branch || ''}`.toLowerCase();
}

type Group = { key: string; name: string; items: ProjectSummary[]; live: number; last: number };
function groupByWorkspace(list: ProjectSummary[]): Group[] {
  const m = new Map<string, Group>();
  for (const p of list) {
    const g = m.get(p.workspace) || { key: p.workspace, name: p.workspaceName, items: [], live: 0, last: 0 };
    g.items.push(p);
    g.live += p.liveCount;
    g.last = Math.max(g.last, p.lastAt || 0);
    m.set(p.workspace, g);
  }
  for (const g of m.values()) g.items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.liveCount > 0) - Number(a.liveCount > 0) || (b.lastAt || 0) - (a.lastAt || 0));
  return [...m.values()].sort((a, b) => Number(b.items.some((p) => p.pinned)) - Number(a.items.some((p) => p.pinned)) || Number(b.live > 0) - Number(a.live > 0) || b.last - a.last);
}

function LoadingGrid() {
  return (
    <div className="pp-groups" aria-busy="true" aria-label="Loading projects">
      {[0, 1].map((g) => (
        <section key={g} className="pp-group">
          <div className="pp-group-head">
            <Skeleton h={22} w={22} />
            <Skeleton h={14} w={120} />
          </div>
          <div className="grid-cards">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card pcard">
                <div className="pcard-head">
                  <Skeleton h={32} w={32} />
                  <div className="grow stack-sm">
                    <Skeleton h={14} w="55%" />
                    <Skeleton h={11} w="40%" />
                  </div>
                </div>
                <Skeleton h={12} w="92%" />
                <Skeleton h={12} w="70%" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function Projects() {
  const [params, setParams] = useSearchParams();
  const ws = params.get('ws');
  const fParam = params.get('f');
  const filter: Filter = isFilter(fParam) ? fParam : 'current';
  const isHidden = filter === 'hidden';
  const phone = useIsPhone();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [views, setViews] = useState<{ desktop: View; phone: View }>(() => ({
    desktop: storageGet('pl.projects.view') === 'list' ? 'list' : 'grid',
    phone: storageGet('pl.projects.view.phone') === 'grid' ? 'grid' : 'list',
  }));
  const view = phone ? views.phone : views.desktop;
  const searchRef = useRef<HTMLInputElement>(null);
  const { data, error, isLoading, refetch } = useProjects();
  // The summaries carry no "hidden" flag: hidden projects are the ones only the ?hidden=1 list has.
  const { data: withHidden } = useProjects(true);
  const { data: work } = useWork({ status: 'open' });
  const { data: overview } = useOverview();
  const running = useRunningByProject();

  // "/" focuses the search box (desktop habit), unless typing somewhere already.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setFilter = (f: Filter) => {
    const n = new URLSearchParams(params);
    if (f === 'current') n.delete('f');
    else n.set('f', f);
    setParams(n, { replace: true });
  };
  const setView = (v: View) => {
    setViews((s) => ({ ...s, [phone ? 'phone' : 'desktop']: v }));
    storageSet(phone ? 'pl.projects.view.phone' : 'pl.projects.view', v);
  };

  const all = data || [];
  const scoped = useMemo(() => (ws ? all.filter((p) => p.workspace === ws) : all), [all, ws]);
  const hiddenScoped = useMemo(() => {
    if (!data || !withHidden) return [];
    const visible = new Set(data.map((p) => p.id));
    return withHidden.filter((p) => !visible.has(p.id) && (!ws || p.workspace === ws)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  }, [data, withHidden, ws]);
  const ql = q.trim().toLowerCase();
  const searched = useMemo(() => (ql ? scoped.filter((p) => haystack(p).includes(ql)) : scoped), [scoped, ql]);
  const shown = useMemo(
    () => (filter === 'hidden' ? (ql ? hiddenScoped.filter((p) => haystack(p).includes(ql)) : hiddenScoped) : searched.filter((p) => matches(p, filter))),
    [searched, hiddenScoped, filter, ql],
  );
  const groups = useMemo(() => groupByWorkspace(shown), [shown]);
  const counts = useMemo(
    () => ({ ...(Object.fromEntries(FILTERS.map((f) => [f.value, scoped.filter((p) => matches(p, f.value)).length])) as Record<Lifecycle, number>), hidden: hiddenScoped.length }),
    [scoped, hiddenScoped],
  );
  // On phones the filter scrolls sideways: keep the chosen one in view (e.g. a link straight to "Hidden").
  useEffect(() => {
    if (!phone) return;
    const el = document.querySelector<HTMLElement>('.pp-filters .seg button[aria-checked="true"]');
    const box = el?.parentElement; // the .seg track is what scrolls
    if (!el || !box) return;
    const over = el.getBoundingClientRect().right - box.getBoundingClientRect().right;
    if (over > 0) box.scrollLeft += over + 4;
  }, [filter, phone, counts.hidden]);
  const tasksBy = useMemo(() => {
    const m = new Map<string, number>();
    // To do + Doing, like the Tasks badge (Suggested ones aren't commitments yet)
    for (const it of work?.items || []) if (it.status === 'todo' || it.status === 'doing') m.set(it.projectId, (m.get(it.projectId) || 0) + 1);
    return m;
  }, [work]);
  const elsewhere = ql ? (isHidden ? searched.length : searched.length - shown.length) : 0;
  const dupNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of withHidden || all) seen.set(p.name.toLowerCase(), (seen.get(p.name.toLowerCase()) || 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  }, [all, withHidden]);

  const wsName = ws ? scoped[0]?.workspaceName || ws : null;
  // Running sessions in the same words as Sessions and Home: "2 working", else "3 open" (idle).
  const runWord = (list: ProjectSummary[]) => {
    const c: RunCounts = { needs: 0, working: 0, open: 0 };
    for (const p of list) {
      if (!p.liveCount) continue;
      const r = running.get(p.id);
      if (!r) c.open += p.liveCount; // the live list hasn't loaded yet: no state known
      else (c.needs += r.needs), (c.working += r.working), (c.open += r.open);
    }
    return runningWord(c);
  };
  // per workspace: every visible project, the same number the sidebar shows next to the workspace
  const wsTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of all) m.set(p.workspace, (m.get(p.workspace) || 0) + 1);
    return m;
  }, [all]);
  const filterWord = [...FILTERS, HIDDEN].find((f) => f.value === filter)!.word;
  const groupCount = (key: string, n: number) => {
    const total = wsTotals.get(key) || n;
    if (filter === 'all' || filter === 'hidden' || ql || n === total) return { text: plural(n, 'project'), title: ql ? `${plural(n, 'project')} match` : n === total && filter !== 'all' && filter !== 'hidden' ? `All ${plural(total, 'project')} in this workspace are ${filterWord}` : undefined };
    return { text: `${n} ${filterWord} of ${total}`, title: `${n} ${filterWord} out of ${plural(total, 'project')} in this workspace` };
  };
  const ai = overview?.ai;
  const scoutN = overview?.scout?.newCount || 0;
  const catchingUp = ai && ai.enabled && !ai.pausedByUser && ai.pendingBlocks + ai.queueLength > 0 && shown.some((p) => !p.oneLiner && p.sessionCount > 0);
  const showStatus = true;

  const header = ws ? (
    <PageHeader
      className="pj-ph"
      crumbs={[{ label: 'Projects', to: '/projects' }]}
      glyph={<WorkspaceAvatar ws={ws} name={wsName || ws} size={40} />}
      title={wsName}
      actions={
        <Button icon={<FolderPlus />} onClick={() => setCreating(true)}>
          New project
        </Button>
      }
    />
  ) : (
    <PageHeader
      className="pj-ph pp-ph"
      title="Projects"
      // phone: the button sits in the title row instead of taking a row of its own
      status={
        phone ? (
          <Button size="sm" variant="ghost" icon={<FolderPlus />} onClick={() => setCreating(true)} className="pp-new">
            New project
          </Button>
        ) : undefined
      }
      actions={
        phone ? undefined : (
          <Button icon={<FolderPlus />} onClick={() => setCreating(true)}>
            New project
          </Button>
        )
      }
    />
  );

  // "Hidden" only shows up once something is hidden (or when the link asks for it).
  const filterOptions = [...FILTERS, ...(counts.hidden > 0 || isHidden ? [HIDDEN] : [])].map((f) => ({
    value: f.value as Filter,
    title: f.title,
    label: (
      <>
        {f.label} <span className="num pp-count">{counts[f.value] ?? 0}</span>
      </>
    ),
  }));

  let body: React.ReactNode;
  if (isLoading || (isHidden && !withHidden)) body = <LoadingGrid />;
  else if (error)
    body = (
      <Callout tone="danger" title="Couldn’t load projects" action={<Button size="sm" onClick={() => refetch()}>Try again</Button>}>
        {errMsg(error)}
      </Callout>
    );
  else if (!all.length && !isHidden)
    body = (
      <Card>
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          body="Pilotage finds projects from your Claude sessions, git repositories and folders. Start one here, or run a session anywhere."
          action={
            <Button icon={<FolderPlus />} onClick={() => setCreating(true)}>
              New project
            </Button>
          }
        />
      </Card>
    );
  else if (!shown.length)
    body = (
      <Card>
        {ql ? (
          <EmptyState
            icon={<Search />}
            title={`Nothing matches “${q.trim()}”`}
            body={elsewhere ? `${plural(elsewhere, 'project')} match in other filters.` : 'Try a folder name, a stack or a workspace.'}
            action={
              <>
                {elsewhere > 0 && (
                  <Button size="sm" onClick={() => setFilter('all')}>
                    Search all projects
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setQ('')}>
                  Clear search
                </Button>
              </>
            }
          />
        ) : isHidden ? (
          <EmptyState
            icon={<EyeOff />}
            title={`${HIDDEN.empty}${wsName ? ` in ${wsName}` : ''}`}
            body="To hide one, open it and use … → Edit project → Hide this project. It comes back here."
            action={
              <Button size="sm" onClick={() => setFilter('current')}>
                Back to current projects
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<FolderKanban />}
            title={`${FILTERS.find((f) => f.value === filter)!.empty}${wsName ? ` in ${wsName}` : ''}`}
            body={filter === 'current' ? 'Nothing has moved here in the last two weeks.' : undefined}
            action={
              filter !== 'all' && counts.all > 0 ? (
                <Button size="sm" onClick={() => setFilter('all')}>
                  Show all {counts.all}
                </Button>
              ) : undefined
            }
          />
        )}
      </Card>
    );
  else if (isHidden)
    body = (
      <div className="stack-lg">
        <div className="hint pp-hidden-hint">Hidden projects stay out of your project lists and the sidebar. Open one to look at it, or show it again.</div>
        <Card flush>
          {shown.map((p) => (
            <HiddenProjectRow key={p.id} p={p} showPath={dupNames.has(p.name.toLowerCase())} />
          ))}
        </Card>
      </div>
    );
  else
    body = (
      <div className="pp-groups">
        {groups.map((g) => (
          <section key={g.key} className="pp-group" aria-label={g.name}>
            {!ws && (
              <div className="pp-group-head">
                <WorkspaceAvatar ws={g.key} name={g.name} size={22} />
                <Link to={`/projects?ws=${encodeURIComponent(g.key)}${filter !== 'current' ? `&f=${filter}` : ''}`} className="pp-group-name">
                  <h2>{g.name}</h2>
                </Link>
                <span className="faint num pp-group-count" title={groupCount(g.key, g.items.length).title}>
                  {groupCount(g.key, g.items.length).text}
                </span>
                {g.live > 0 &&
                  (() => {
                    const w = runWord(g.items);
                    return w ? (
                      <span className="pp-group-live num" title={w.title}>
                        {w.label}
                      </span>
                    ) : null;
                  })()}
              </div>
            )}
            {view === 'grid' ? (
              <div className="grid-cards">
                {g.items.map((p) => (
                  <ProjectTile key={p.id} p={p} tasks={tasksBy.get(p.id) || 0} showStatus={showStatus} />
                ))}
              </div>
            ) : (
              <Card flush>
                {g.items.map((p) => (
                  <ProjectRow key={p.id} p={p} tasks={tasksBy.get(p.id) || 0} showStatus={showStatus} showPath={dupNames.has(p.name.toLowerCase())} />
                ))}
              </Card>
            )}
          </section>
        ))}
        {!ql && !ws && scoutN > 0 && (
          <Link to="/ideas" className="pp-scout">
            <Sparkles aria-hidden="true" />
            <span>
              Claude spotted {plural(scoutN, 'possible project')}
            </span>
            <ChevronRight aria-hidden="true" className="pp-scout-chev" />
          </Link>
        )}
        {elsewhere > 0 && (
          <div className="pp-elsewhere small faint">
            {plural(elsewhere, 'more project')} {elsewhere === 1 ? 'matches' : 'match'} in other filters.{' '}
            <button type="button" className="more-link" onClick={() => setFilter('all')}>
              Search all
            </button>
          </div>
        )}
      </div>
    );

  return (
    <>
      {header}
      <Toolbar className="pp-toolbar">
        <div className="input-wrap pp-search">
          <Search />
          <input
            ref={searchRef}
            className="input"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQ('')}
            placeholder="Search name, folder, stack…"
            aria-label="Search projects"
            enterKeyHint="search"
          />
          {q ? <IconButton className="pp-clear" icon={<X />} label="Clear search" onClick={() => setQ('')} /> : !phone && <Kbd>/</Kbd>}
        </div>
        <div className="pp-filters">
          <SegmentedControl value={filter} onChange={setFilter} options={filterOptions} label="Show" />
        </div>
        <ToolbarSpacer />
        {!isHidden && (
          <SegmentedControl
            value={view}
            onChange={setView}
            size="sm"
            label="Layout"
            options={[
              { value: 'grid', label: <LayoutGrid aria-label="Grid" />, title: 'Grid' },
              { value: 'list', label: <List aria-label="List" />, title: 'List' },
            ]}
          />
        )}
      </Toolbar>
      {catchingUp && (
        <div className="pp-catchup small faint" role="status">
          <Spinner size={13} />
          Claude is catching up on your history ({ai!.pendingBlocks + ai!.queueLength} left). Summaries appear as they’re written.
        </div>
      )}
      {body}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} defaultWorkspace={ws || ''} />}
    </>
  );
}
