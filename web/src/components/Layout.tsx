import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Briefcase, CircleHelp, FolderKanban, History, Home, Lightbulb, ListChecks, MessagesSquare, MoreHorizontal, Network, Play, Plus, Search, Settings, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useBootstrap, useOverview, useProjects } from '../api';
import type { ProjectSummary, SessionDetail, SessionSummary } from '../types';
import { useApp } from './AppContext';
import { EmptyState, Kbd, Meter, ProjectGlyph, USAGE_LABELS } from './ui';
import { fmtTime, plural } from '../util';
import { liveState, runningWord, useRunningByProject } from './cards';
import { NewSessionModal } from './NewSession';
import { CommandPalette } from './CommandPalette';
import { Menu } from './tasks/TaskBits';
import { InstallHint } from './InstallHint';

const RECENT_PROJECTS = 5;

/** Running sessions by state: what the Sessions badge and the workspace presence dots show. */
export function runningCounts(live: SessionSummary[] | undefined) {
  let needs = 0;
  let working = 0;
  let open = 0;
  for (const s of live || []) {
    const st = liveState(s);
    if (st === 'needs-you') needs++;
    else if (st === 'working') working++;
    else open++;
  }
  return { needs, working, open, total: needs + working + open };
}

/** Sessions badge: needs-you count (amber) when something waits for you, else the working count (accent). */
function SessionsBadge({ live, phone = false }: { live: SessionSummary[] | undefined; phone?: boolean }) {
  const c = runningCounts(live);
  if (!c.needs && !c.working) return null;
  const needs = c.needs > 0;
  const n = needs ? c.needs : c.working;
  const title = needs ? `${plural(c.needs, 'session')} need${c.needs === 1 ? 's' : ''} you` : `${plural(c.working, 'session')} working`;
  if (phone)
    return (
      <span className={`pip${needs ? ' needs' : ' working'}`} aria-label={title} title={title}>
        {n}
      </span>
    );
  return (
    <span className={`count num ${needs ? 'needs' : 'live'}`} title={title} aria-label={title}>
      <span className="live-pip" />
      {n}
    </span>
  );
}

/** Tasks that matter today: planned for today (open) plus anything in Doing. Shown on the phone's More tab. */
export function useTodayTaskCount() {
  const { data: o } = useOverview();
  const today = o?.plan?.today || [];
  const doing = o?.work?.doingCount || 0;
  return today.length + doing - today.filter((t) => t.status === 'doing').length;
}

function UsageBox() {
  const { data } = useOverview();
  const u = data?.usage;
  if (!u || (!u.five && !u.seven)) return null;
  const row = (label: string, pct: number, resetsAt?: number) => (
    <div className="usage-row" title={resetsAt ? `Resets at ${fmtTime(resetsAt)}` : undefined}>
      <span>{label}</span>
      <span className="v">{Math.round(pct)}%</span>
      <Meter pct={pct} label={label} size="sm" />
    </div>
  );
  return (
    <div className="usage" aria-label="Claude usage">
      {u.five && row(USAGE_LABELS.five, u.five.pct, u.five.resetsAt)}
      {u.seven && row(USAGE_LABELS.seven, u.seven.pct, u.seven.resetsAt)}
    </div>
  );
}

/** The projects worked on most recently, running ones first. */
function recentProjects(projects: ProjectSummary[] | undefined, n = RECENT_PROJECTS) {
  const now = Date.now();
  const at = (p: ProjectSummary) => (p.liveCount > 0 ? now : p.lastSessionAt || p.lastAt);
  return [...(projects || [])]
    .filter((p) => p.status !== 'archived')
    .sort((a, b) => at(b) - at(a))
    .slice(0, n);
}

/** Sidebar "Recent projects": one click to a project, one more (▶ on hover) to start a session there. */
function RecentProjects({ recent, curProject }: { recent: ProjectSummary[]; curProject: string | null }) {
  const { openNewSession } = useApp();
  const running = useRunningByProject();
  if (!recent.length) return null;
  return (
    <div className="nav-recent">
      <div className="nav-section">
        <span>Recent projects</span>
      </div>
      {recent.map((p) => {
        const run = runningWord(running.get(p.id), p.liveCount);
        const st = run ? (run.state === 'idle_live' ? 'open' : run.state) : null;
        return (
          <div key={p.id} className={`nav-item proj${curProject === p.id ? ' active' : ''}`}>
            <Link to={`/projects/${p.id}`} className="nav-proj-link" title={run ? `${p.name}: ${run.title}` : p.name}>
              <span className="ws-wrap">
                <ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={18} />
                {st && run && <span className={`presence ${st}`} aria-label={run.title} />}
              </span>
              <span className="truncate">{p.name}</span>
            </Link>
            <button type="button" className="nav-proj-new" onClick={() => openNewSession({ projectId: p.id })} aria-label={`New session in ${p.name}`} title="New session here">
              <Play size={13} />
            </button>
          </div>
        );
      })}
      <Link to="/projects" className="nav-item more">
        <span className="ws-more-ico">
          <ArrowRight size={14} />
        </span>
        <span>All projects</span>
      </Link>
    </div>
  );
}

function Sidebar() {
  const { data: overview } = useOverview();
  const { data: projects } = useProjects();
  const loc = useLocation();
  const work = overview?.work;
  const tasksOpen = work ? (work.todoCount || 0) + (work.doingCount || 0) : 0;
  const possible = overview?.scout?.newCount || 0;
  const curProject = loc.pathname.startsWith('/projects/') ? decodeURIComponent(loc.pathname.slice('/projects/'.length)) : null;
  const recent = recentProjects(projects);
  // a project page lights its Recent projects row; Projects stays lit for the others
  const inRecent = !!curProject && recent.some((p) => p.id === curProject);
  const nav = (to: string, icon: React.ReactNode, label: string, badge?: React.ReactNode, opts: { end?: boolean; title?: string } = {}) => (
    <NavLink to={to} end={opts.end} title={opts.title} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
      {icon}
      <span>{label}</span>
      {badge}
    </NavLink>
  );
  const sub = (to: string, icon: React.ReactNode, label: string, badge?: React.ReactNode) => (
    <NavLink to={to} className={({ isActive }) => `nav-item sub${isActive ? ' active' : ''}`}>
      {icon}
      <span>{label}</span>
      {badge}
    </NavLink>
  );
  const count = (n: number, title: string) => (n > 0 ? <span className="count num" title={title}>{n}</span> : undefined);
  const c = overview?.counts;
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/icon.svg" alt="" />
        Pilotage
      </div>
      <nav className="nav-primary" aria-label="Main">
        {nav('/', <Home size={16} />, 'Home', undefined, { end: true })}
        {nav('/sessions', <MessagesSquare size={16} />, 'Sessions', <SessionsBadge live={overview?.live} />, {
          title: c?.interactive !== undefined ? `${plural(c.interactive, 'session')} with you${c.automated ? ` · ${plural(c.automated, 'automation')}` : ''}` : undefined,
        })}
        {nav('/projects', <FolderKanban size={16} />, 'Projects', undefined, { end: inRecent })}
        {nav('/tasks', <ListChecks size={16} />, 'Tasks', count(tasksOpen, `${work?.todoCount || 0} to do · ${work?.doingCount || 0} doing`))}
      </nav>
      <RecentProjects recent={recent} curProject={curProject} />
      <div className="sidebar-foot">
        <nav className="nav-secondary" aria-label="More">
          {sub('/ideas', <Lightbulb size={15} />, 'Ideas', count(possible, plural(possible, 'new possible project')))}
          {sub('/map', <Network size={15} />, 'Map')}
          {sub('/history', <History size={15} />, 'History')}
          {sub('/portfolio', <Briefcase size={15} />, 'Portfolio & CV')}
          {sub('/settings', <Settings size={15} />, 'Settings')}
          {sub('/guide', <CircleHelp size={15} />, 'How Pilotage works')}
        </nav>
        <UsageBox />
      </div>
    </aside>
  );
}

/** The current project when on a project page (or a session of one): ＋ actions start from it. */
function useCurrentProjectId() {
  const qc = useQueryClient();
  const projectMatch = useMatch('/projects/:id');
  const sessionMatch = useMatch('/sessions/:id');
  const sid = sessionMatch?.params.id;
  return projectMatch?.params.id || (sid ? qc.getQueryData<SessionDetail>(['session', sid])?.projectId : null) || undefined;
}

/** Phone ＋: a small action sheet (New session · Add task · Capture idea). On a project page (or a session of one)
 *  it starts from that project. */
function CreateSheet({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const { openNewSession } = useApp();
  const navigate = useNavigate();
  const projectId = useCurrentProjectId();
  return (
    <Menu
      anchor={anchor}
      title="Create"
      className="create-sheet"
      onClose={onClose}
      items={[
        { key: 'session', label: 'New session', sub: projectId ? 'Start Claude in this project' : 'Start Claude in a project', icon: <SquareTerminal />, onSelect: () => openNewSession(projectId ? { projectId } : {}) },
        { key: 'task', label: 'Add task', sub: projectId ? "To this project's tasks" : 'Something you’ve decided to do', icon: <ListChecks />, onSelect: () => navigate(projectId ? `/tasks?new=1&project=${encodeURIComponent(projectId)}` : '/tasks?new=1') },
        { key: 'idea', label: 'Capture idea', sub: 'Something you might do later', icon: <Lightbulb />, onSelect: () => navigate('/ideas?new=1') },
      ]}
    />
  );
}

function BottomNav() {
  const { data: overview } = useOverview();
  const loc = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const moreActive = ['/tasks', '/ideas', '/map', '/history', '/timeline', '/portfolio', '/settings', '/guide', '/more'].some((p) => loc.pathname.startsWith(p));
  const todayTasks = useTodayTaskCount();
  const item = (to: string, icon: React.ReactNode, label: string, extra?: React.ReactNode, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span className="ico">{icon}</span>
      {label}
      {extra}
    </NavLink>
  );
  return (
    <nav className="bottom-nav" aria-label="Main">
      {item('/', <Home />, 'Home', undefined, true)}
      {item('/sessions', <MessagesSquare />, 'Sessions', <SessionsBadge live={overview?.live} phone />)}
      <button ref={plusRef} type="button" className={`tab-create${createOpen ? ' active' : ''}`} onClick={() => setCreateOpen(true)} aria-label="New: session, task or idea" aria-haspopup="menu" aria-expanded={createOpen}>
        <span className="ico">
          <Plus />
        </span>
        New
      </button>
      {item('/projects', <FolderKanban />, 'Projects')}
      <NavLink to="/more" className={() => (moreActive ? 'active' : '')}>
        <span className="ico">
          <MoreHorizontal />
        </span>
        More
        {todayTasks > 0 && (
          <span className="pip count-pip" aria-label={`${plural(todayTasks, 'task')} for today or in progress`}>
            {todayTasks}
          </span>
        )}
      </NavLink>
      {createOpen && <CreateSheet anchor={plusRef.current} onClose={() => setCreateOpen(false)} />}
    </nav>
  );
}

/** One page's render error stays inside the page: the sidebar and tab bar keep working, and navigating clears it. */
class PageBoundary extends React.Component<{ resetKey: string; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    // a lazy page chunk that is gone after a rebuild: only a reload fixes it
    const stale = /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(e.message);
    return (
      <EmptyState
        icon={<TriangleAlert />}
        title={stale ? 'Pilotage was updated' : 'This page hit a problem'}
        body={
          <>
            {stale ? 'Reload to get the new version of this page.' : 'The rest of Pilotage still works. Reloading usually fixes it.'}
            {!stale && <span className="page-crash-detail mono">{e.message}</span>}
          </>
        }
        action={
          <>
            <button className="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
            <Link className="btn" to="/">
              Back to Home
            </Link>
          </>
        }
      />
    );
  }
}

// Browser toolbar / status bar color. index.html keys it on the OS scheme; a forced theme overrides both metas.
const CHROME_COLOR = { dark: '#0b0c0f', light: '#f8f8fa' } as const;
function applyThemeColor(theme: string) {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const media = m.getAttribute('media') || '';
    const own = media.includes('light') ? CHROME_COLOR.light : CHROME_COLOR.dark;
    m.content = theme === 'light' || theme === 'dark' ? CHROME_COLOR[theme] : own;
  });
}

/** After a deploy, pages that were already open still run the old code. Offer a reload, and do it by itself when
 *  the page comes back to the foreground (phone unlocked, tab revisited) with nothing being typed or open. */
function UpdateNotice() {
  const { data: boot } = useBootstrap();
  const first = React.useRef<string | null>(null);
  if (boot?.build && first.current === null) first.current = boot.build;
  const updated = !!boot?.build && !!first.current && boot.build !== first.current;
  useEffect(() => {
    if (!updated) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const busy = document.querySelector('.modal, [role="dialog"]') || (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
      if (!busy) window.location.reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [updated]);
  if (!updated) return null;
  return (
    <div className="update-notice" role="status">
      <span>Pilotage was updated</span>
      <button className="btn sm primary" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

export function Layout() {
  const { openNewSession, openPalette, newSession, paletteOpen } = useApp();
  const { data: boot } = useBootstrap();
  const loc = useLocation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  useEffect(() => {
    const theme = boot?.settings.ui.theme || 'system';
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    applyThemeColor(theme);
  }, [boot?.settings.ui.theme]);
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <div className="mobile-brand">
            <img src="/icon.svg" alt="" />
            Pilotage
          </div>
          <button className="search-trigger" onClick={openPalette} aria-label="Search">
            <Search size={15} />
            <span className="label">Search or jump to…</span>
            <Kbd>Ctrl K</Kbd>
          </button>
          <div className="topbar-right">
            <button className="btn primary hide-mobile" onClick={() => openNewSession({})}>
              <Plus size={16} />
              New session
            </button>
          </div>
        </header>
        <main className="content">
          <InstallHint />
          <PageBoundary resetKey={loc.pathname}>
            <Outlet />
          </PageBoundary>
        </main>
      </div>
      <BottomNav />
      <UpdateNotice />
      {newSession && <NewSessionModal />}
      {paletteOpen && <CommandPalette />}
    </div>
  );
}
