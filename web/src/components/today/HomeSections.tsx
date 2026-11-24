// Home (route `/`): the sections, top to bottom (docs/SIMPLIFY.md §4). First glance = state: pulse tiles, then short
// one-line rows led by the project glyph (status as its corner badge). Sentences only on tap. Each section renders
// nothing when it has nothing to show (Today keeps one quiet line so planning stays one tap away).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, MoreHorizontal, Play, Plus, Smartphone, Sparkles, SquareTerminal, SunDim, X } from 'lucide-react';
import { useBootstrap, useDevices, useNet } from '../../api';
import { pickupHide, planFocus, useWork } from '../../api-extra';
import { useApp } from '../AppContext';
import { Button, Callout, Card, EmptyState, Meta, PageHeader, ProjectGlyph, Section, StatusIcon, useToast } from '../ui';
import { Menu, TaskRow, TaskSheet, useProjectIndex } from '../tasks/TaskBits';
import { friendly, usePref, useTaskActions } from '../tasks/model';
import type { Overview, SessionSummary } from '../../types';
import type { WorkItem } from '../../types-extra';
import type { PickupItem, PlanProposal } from '../../types-v3';
import { ago, fmtDateTime, isoDay, plural } from '../../util';
import { HarnessTag, offerHomeUndo, sessionName, waited } from './TodayBits';
import { liveState } from '../cards';

// ---------------------------------------------------------------- shared bits

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
/** "Good evening, Sam" (name from Settings → Your name, else detected on the server). */
export const homeTitle = (name?: string) => (name ? `${greeting()}, ${name}` : greeting());
export const useUserName = () => useBootstrap().data?.user?.name;
const dateLine = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

/** Optimistic edits of the cached overview (SSE refetches the truth right after). */
function useOverviewCache() {
  const qc = useQueryClient();
  return {
    patch: (fn: (o: Overview) => Overview) => qc.setQueryData<Overview>(['overview'], (o) => (o ? fn(o) : o)),
    refresh: () => qc.invalidateQueries({ queryKey: ['overview'] }),
  };
}

/** Keys hidden on this screen until the server agrees. A key the server no longer sends is forgotten, so the same
 *  row can come back later (e.g. a proposal reappears once its task is taken off today). */
function useGone(present: string[]) {
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const sig = present.join('|');
  useEffect(() => {
    setGone((g) => {
      if (!g.size) return g;
      const keep = new Set([...g].filter((k) => present.includes(k)));
      return keep.size === g.size ? g : keep;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const add = (k: string) => setGone((g) => new Set(g).add(k));
  const drop = (k: string) =>
    setGone((g) => {
      const n = new Set(g);
      n.delete(k);
      return n;
    });
  return { gone, add, drop };
}

const sessionProject = (s: SessionSummary) => s.projectName || s.cwd.split('/').pop() || s.cwd;
const norm = (x: string) => x.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
/** The project name, unless the row's title already says it ("northwind-shop" twice is noise). */
const projectUnlessTitle = (project: string, title: string) => (project && norm(project) !== norm(title) ? project : null);

/** A ⋯ button that opens a small action menu (popover on PC, sheet on phone). */
function RowMenu({ title, items, hoverOnly = false }: { title: string; items: { key: string; label: string; sub?: string; icon: React.ReactNode; onSelect: () => void }[]; hoverOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className={`btn row-icon${hoverOnly ? ' hover' : ''}`} aria-label={`More actions for “${title}”`} title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(true)}>
        <MoreHorizontal />
      </button>
      {open && <Menu anchor={ref.current} title={title} onClose={() => setOpen(false)} items={items} />}
    </>
  );
}

// ---------------------------------------------------------------- 1. header + pulse

export function HomeHeader() {
  const name = useUserName();
  return <PageHeader className="home-head" eyebrow={dateLine()} title={homeTitle(name)} />;
}

/** Today's progress as a small ring: done / planned. */
function TodayRing({ done, total }: { done: number; total: number }) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  const f = total ? Math.min(1, done / total) : 0;
  return (
    <svg className="pt-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.75" />
      {f > 0 && <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="1.75" strokeDasharray={`${c * f} ${c}`} strokeLinecap="round" transform="rotate(-90 7 7)" />}
    </svg>
  );
}

/** Tasks planned for today that are already done (the plan only lists open ones). */
function useDoneToday(day: string | undefined) {
  const { data } = useWork({ status: 'done' });
  return useMemo(() => (day && data ? data.items.filter((it) => it.status === 'done' && it.plannedFor && it.doneAt && isoDay(it.doneAt) === day).length : 0), [data, day]);
}

/** Four numbers that say how things stand, each a link: Working · Needs you · Today x/y · To do. */
export function PulseTiles({ o, needs, working }: { o: Overview; needs: number; working: number }) {
  const planned = o.plan?.today.length || 0;
  const done = useDoneToday(o.plan?.day);
  const total = planned + done;
  const todo = (o.work?.todoCount || 0) + (o.work?.doingCount || 0);
  const toToday = (e: React.MouseEvent) => {
    const el = document.getElementById('today');
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <nav className="pulse" aria-label="How things stand">
      <Link to="/sessions" className={`pulse-tile${working ? ' t-accent' : ''}`} title={working ? `${plural(working, 'session')} working right now` : 'Nothing is working right now'}>
        <span className="pt-label">
          <StatusIcon status={working ? 'working' : 'open'} size={12} title="Working" />
          Working
        </span>
        <span className="pt-value num">{working}</span>
      </Link>
      <Link to="/sessions" className={`pulse-tile${needs ? ' t-amber' : ''}`} title={needs ? `${plural(needs, 'session')} waiting for your answer` : 'Nothing is waiting for you'}>
        <span className="pt-label">
          <StatusIcon status={needs ? 'needs-you' : 'open'} size={12} title="Needs you" />
          Needs you
        </span>
        <span className="pt-value num">{needs}</span>
      </Link>
      <a href="#today" onClick={toToday} className="pulse-tile" title={total ? `${done} of ${plural(total, 'task')} for today done` : 'Nothing planned for today'}>
        <span className="pt-label">
          <TodayRing done={done} total={total} />
          Today
        </span>
        <span className="pt-value num">
          {total ? (
            <>
              {done}
              <span className="pt-of">/{total}</span>
            </>
          ) : (
            0
          )}
        </span>
      </a>
      <Link to="/tasks" className="pulse-tile" title={`${plural(todo, 'task')} to do or in progress`}>
        <span className="pt-label">
          <StatusIcon status="todo" size={12} title="To do" />
          To do
        </span>
        <span className="pt-value num">{todo}</span>
      </Link>
    </nav>
  );
}

// ---------------------------------------------------------------- 1b. first run (no session indexed yet)

/** In place of the pulse tiles while there is no session at all: why the page is empty and the one next step. */
export function Welcome({ phone }: { phone: boolean }) {
  const { openNewSession } = useApp();
  return (
    <Card className="home-welcome">
      <EmptyState
        icon={<SquareTerminal />}
        title={`No Claude Code sessions on ${phone ? 'your computer' : 'this computer'} yet`}
        body={
          <>
            Home fills in as you work: what is running, what needs you, your tasks for today and where you left off. Start a first session here, or run <span className="mono">claude</span> in any
            terminal and it shows up by itself.
          </>
        }
        action={
          <>
            <Button variant="primary" icon={<Plus />} onClick={() => openNewSession({})}>
              New session
            </Button>
            <p className="home-welcome-guide">
              New to Pilotage?{' '}
              <Link to="/guide" className="link">
                How Pilotage works
              </Link>
            </p>
          </>
        }
      />
    </Card>
  );
}

// ---------------------------------------------------------------- 2. phone setup (PC only, until a phone is paired)

export function PhoneSetup() {
  const { data: devs } = useDevices();
  const { data: net } = useNet();
  const [dismissed, setDismissed] = usePref<'0' | '1'>('pilotage.today.phoneSetupDismissed', '0');
  if (!devs || !net || dismissed === '1') return null;
  if (devs.devices.some((d) => /android|iphone|ipad|mobile/i.test(d.ua))) return null;
  return (
    <Callout
      icon={<Smartphone size={18} />}
      title="Put Pilotage on your phone"
      action={
        <div className="row">
          <Link to="/settings" className="btn sm">
            Set up
          </Link>
          <Button size="sm" variant="ghost" onClick={() => setDismissed('1')}>
            Not now
          </Button>
        </div>
      }
    >
      {net.firewallRule ? 'Pair it in Settings → Devices and scan the QR code.' : 'Enable phone access in Settings, then pair it with a QR code.'} About two minutes.
    </Callout>
  );
}

// ---------------------------------------------------------------- 3. needs you

function NeedsRow({ s, color }: { s: SessionSummary; color?: string | null }) {
  const url = s.live?.bridgeUrl;
  const question = s.live?.detail?.replace(/\s+/g, ' ').trim();
  const proj = sessionProject(s);
  return (
    <div className="lrow clickable home-row needs-row">
      <Link to={`/sessions/${s.id}`} className="lrow-link" aria-label={`${s.title}: view the session`} />
      <div className="lrow-lead">
        <ProjectGlyph name={proj} ws={s.workspace} color={color} size={24} status="needs-you" statusTitle="Needs you" />
      </div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{s.title}</span>
          <HarnessTag s={s} />
        </div>
        {question && (
          <div className="lrow-sub clamp-1 needs-q" title={question}>
            {question}
          </div>
        )}
        <Meta
          items={[
            projectUnlessTitle(proj, s.title),
            <span className="tone-amber" title={fmtDateTime(s.lastAt)}>
              {waited(s.lastAt)}
            </span>,
          ]}
        />
      </div>
      <div className="row-acts">
        {url ? (
          <a className="btn sm needs-open" href={url} target="_blank" rel="noreferrer" aria-label={`Open “${s.title}” in the Claude app`} title="Answer it in the Claude app">
            <Smartphone />
            <span className="hide-mobile">Open in Claude app</span>
            <span className="hide-desktop">Open</span>
          </a>
        ) : (
          <Link className="btn sm needs-open" to={`/sessions/${s.id}`} aria-label={`View “${s.title}”`}>
            View
          </Link>
        )}
      </div>
    </div>
  );
}

export function NeedsYou({ list }: { list: SessionSummary[] }) {
  const pindex = useProjectIndex();
  if (!list.length) return null;
  return (
    <Section title="Needs you" count={list.length} countTone="amber">
      <Card flush className="home-card needs-card">
        {list.map((s) => (
          <NeedsRow key={s.id} s={s} color={s.projectId ? pindex.get(s.projectId)?.color : null} />
        ))}
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------- 4. running (working + open)

const RUNNING_MAX = 6;

function RunRow({ s, color }: { s: SessionSummary; color?: string | null }) {
  const st = liveState(s);
  const url = s.live?.bridgeUrl;
  const proj = sessionProject(s);
  const word = st === 'working' ? 'Working' : 'Open (idle)';
  return (
    <div className={`lrow clickable home-row run-row${st === 'working' ? ' is-working' : ''}`}>
      <Link to={`/sessions/${s.id}`} className="lrow-link" aria-label={`${s.title}: ${word}. Open the session`} />
      <div className="lrow-lead">
        <ProjectGlyph name={proj} ws={s.workspace} color={color} size={24} status={st === 'working' ? 'working' : 'open'} statusTitle={word} />
      </div>
      <div className="lrow-body run-body">
        <div className="lrow-title">
          <span className="t">{s.title}</span>
          <HarnessTag s={s} />
        </div>
        <Meta
          items={[
            projectUnlessTitle(proj, s.title),
            <span className="num" title={fmtDateTime(s.lastAt)}>
              {ago(s.lastAt)}
            </span>,
          ]}
        />
      </div>
      {url && (
        <div className="row-acts hover">
          <a className="btn row-icon" href={url} target="_blank" rel="noreferrer" aria-label={`Open “${s.title}” in the Claude app`} title="Open in Claude app">
            <Smartphone />
          </a>
        </div>
      )}
    </div>
  );
}

/** Running sessions: working first, then open (idle) ones, one line each. More than six: the rest behind "+N open". */
export function Running({ working, idle }: { working: SessionSummary[]; idle: SessionSummary[] }) {
  const pindex = useProjectIndex();
  const all = [...working, ...idle];
  if (!all.length) return null;
  const shown = all.length > RUNNING_MAX ? [...working, ...idle.slice(0, Math.max(0, RUNNING_MAX - 1 - working.length))] : all;
  const rest = all.length - shown.length;
  const restIdle = idle.length - shown.filter((s) => liveState(s) !== 'working').length;
  return (
    <Section
      title="Running"
      count={all.length}
      actions={
        <Link to="/sessions" className="small">
          Sessions
        </Link>
      }
    >
      <Card flush className="home-card">
        {shown.map((s) => (
          <RunRow key={s.id} s={s} color={s.projectId ? pindex.get(s.projectId)?.color : null} />
        ))}
        {rest > 0 && (
          <Link to="/sessions" className="lrow clickable home-more">
            <span>{restIdle === rest ? `+${rest} open` : `+${rest} more`}</span>
            <ChevronRight />
          </Link>
        )}
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------- 5. today

function PlannedTask({ it, onOpen, onUnplan }: { it: WorkItem; onOpen: () => void; onUnplan: () => void }) {
  const pindex = useProjectIndex();
  return (
    <div className="home-task">
      <TaskRow it={it} project={pindex.get(it.projectId)} showSource={false} onOpen={onOpen} />
      <div className="row-acts hover home-unplan">
        <button type="button" className="btn row-icon" onClick={onUnplan} aria-label={`Remove “${it.title}” from today`} title="Remove from today">
          <SunDim />
        </button>
      </div>
    </div>
  );
}

/** Where the look-alike task already is. A Suggested one isn't "your" task yet, so say which list it sits in. */
function matchLine(p: PlanProposal) {
  if (!p.matchId) return null;
  if (p.matchStatus === 'inbox') return 'in Suggested tasks';
  if (p.matchStatus === 'todo' || p.matchStatus === 'doing') return 'in your To do';
  return 'in your tasks';
}

/** One suggestion: glyph + short title, "＋ Today" and ⋯ (Start, Not today). Tap the row for the why. */
function SuggestionRow({ p, open, onToggle, onAccept, onDismiss }: { p: PlanProposal; open: boolean; onToggle: () => void; onAccept: () => void; onDismiss: () => void }) {
  const { openNewSession } = useApp();
  const pindex = useProjectIndex();
  const proj = p.projectId ? pindex.get(p.projectId) : undefined;
  const name = p.projectName || proj?.name || '';
  return (
    <div className={`lrow clickable home-row sug-row${open ? ' open' : ''}`}>
      <button type="button" className="lrow-link" aria-expanded={open} aria-label={`${p.title}: ${open ? 'hide' : 'show'} why Claude suggests it`} onClick={onToggle} />
      <div className="lrow-lead">
        <ProjectGlyph name={name || '?'} ws={p.workspace ?? proj?.workspace} color={proj?.color} size={24} />
      </div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{p.title}</span>
        </div>
        {open && (
          <>
            {p.why && <p className="sug-why">{p.why}</p>}
            <Meta items={[name, matchLine(p)]} />
          </>
        )}
      </div>
      <div className="row-acts">
        <Button size="sm" icon={<Plus />} onClick={onAccept} aria-label={`Add “${p.title}” to today`} title="Add to today">
          Today
        </Button>
        <RowMenu
          title={p.title}
          hoverOnly
          items={[
            {
              key: 'start',
              label: 'Start a session',
              sub: 'With Claude’s suggested first message',
              icon: <Play size={15} />,
              onSelect: () => openNewSession({ projectId: p.projectId || undefined, prompt: p.action, name: sessionName(p.title) }),
            },
            { key: 'dismiss', label: 'Not today', sub: 'Hide it until tomorrow', icon: <X size={15} />, onSelect: onDismiss },
          ]}
        />
      </div>
    </div>
  );
}

export function TodayPlan({ o }: { o: Overview }) {
  const toast = useToast();
  const cache = useOverviewCache();
  const plan = o.plan;
  const tasks = plan?.today || [];
  const proposals = plan?.proposals || [];
  const { setToday } = useTaskActions();
  const goneProps = useGone(proposals.map((p) => p.key));
  const [openId, setOpenId] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = usePref<'0' | '1'>('pilotage.home.suggestionsOpen', '0');
  const [whyKey, setWhyKey] = useState<string | null>(null);
  const lastOpen = useRef<WorkItem | null>(null);

  const shownProps = proposals.filter((p) => !goneProps.gone.has(p.key)).slice(0, 3);
  const openItem = openId ? tasks.find((t) => t.id === openId) || (lastOpen.current?.id === openId ? lastOpen.current : undefined) : undefined;
  if (openItem) lastOpen.current = openItem;

  // Same action (and undo toast, Ctrl+Z) as "Remove from today" in the task menus; the row leaves at once.
  const unplan = (it: WorkItem) => {
    cache.patch((o) => (o.plan ? { ...o, plan: { ...o.plan, today: o.plan.today.filter((t) => t.id !== it.id) } } : o));
    setToday(it.id, false);
  };

  const accept = (p: PlanProposal) => {
    goneProps.add(p.key);
    planFocus(p.key, 'accept')
      .then((r) => {
        const it = r as WorkItem;
        if (it && 'id' in it)
          cache.patch((o) => (o.plan && !o.plan.today.some((t) => t.id === it.id) ? { ...o, plan: { ...o.plan, today: [...o.plan.today, it] } } : o));
        toast('Added to today');
      })
      .catch((e) => {
        goneProps.drop(p.key);
        toast(friendly(e), true);
      })
      .finally(cache.refresh);
  };

  // "Not today" waits for the undo toast to run out before it tells the server (there's no server-side undo).
  const dismiss = (p: PlanProposal) => {
    goneProps.add(p.key);
    offerHomeUndo(
      'Hidden until tomorrow',
      () => goneProps.drop(p.key),
      () =>
        planFocus(p.key, 'dismiss')
          .catch((e) => {
            goneProps.drop(p.key);
            toast(friendly(e), true);
          })
          .finally(cache.refresh),
    );
  };

  const showSuggest = shownProps.length > 0 && tasks.length < 3;
  const open = suggestOpen === '1';
  return (
    <Section
      id="today"
      title="Today"
      count={tasks.length || undefined}
      actions={
        <Link to="/tasks" className="small">
          Tasks
        </Link>
      }
    >
      {tasks.length > 0 && (
        <Card flush className="home-card home-today">
          {tasks.map((t) => (
            <PlannedTask key={t.id} it={t} onOpen={() => setOpenId(t.id)} onUnplan={() => unplan(t)} />
          ))}
        </Card>
      )}
      {!tasks.length && !showSuggest && (
        <p className="home-empty">
          Nothing planned.{' '}
          <Link to="/tasks" className="link">
            Pick from Tasks
          </Link>
        </p>
      )}
      {showSuggest && (
        <div className={`suggest${open ? ' open' : ''}`}>
          <button type="button" className="suggest-toggle" aria-expanded={open} onClick={() => setSuggestOpen(open ? '0' : '1')}>
            <Sparkles className="suggest-ico" />
            <span>
              Claude suggests {shownProps.length} {tasks.length ? 'more ' : ''}for today
            </span>
            <ChevronRight className="chev" />
          </button>
          {open && (
            <Card flush className="home-card suggest-card">
              {shownProps.map((p) => (
                <SuggestionRow key={p.key} p={p} open={whyKey === p.key} onToggle={() => setWhyKey(whyKey === p.key ? null : p.key)} onAccept={() => accept(p)} onDismiss={() => dismiss(p)} />
              ))}
            </Card>
          )}
        </div>
      )}
      {openItem && <TaskSheet key={openItem.id} it={openItem} onClose={() => setOpenId(null)} />}
    </Section>
  );
}

// ---------------------------------------------------------------- 6. pick up

/** Only the states worth a badge: blocked (amber), done, dropped. "In progress" is what every Pick up row is. */
const PICK_BADGE = new Set(['blocked', 'done', 'abandoned']);

function PickupRow({ p, phone, onHide }: { p: PickupItem; phone: boolean; onHide: () => void }) {
  const { openNewSession } = useApp();
  const pindex = useProjectIndex();
  const resume = () => openNewSession({ resumeId: p.sessionId });
  const badge = p.status && PICK_BADGE.has(p.status) ? p.status : null;
  return (
    <div className="lrow clickable home-row pick-row">
      <Link to={`/sessions/${p.sessionId}`} className="lrow-link" aria-label={`${p.title}: open the session`} />
      <div className="lrow-lead">
        <ProjectGlyph name={p.projectName || '?'} ws={p.workspace} color={pindex.get(p.projectId)?.color} size={24} status={badge} />
      </div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{p.title}</span>
        </div>
        <Meta
          items={[
            projectUnlessTitle(p.projectName, p.title),
            p.quietDays > 0 ? (
              <span className="num" title={`Last active ${fmtDateTime(p.lastAt)}`}>
                Gone quiet {p.quietDays} d
              </span>
            ) : (
              <span className="num" title={fmtDateTime(p.lastAt)}>
                {ago(p.lastAt)}
              </span>
            ),
          ]}
        />
      </div>
      <div className={`row-acts${phone ? '' : ' hover'}`}>
        {!phone && p.resumable && (
          <Button size="sm" variant="ghost" className="pick-resume" icon={<Play />} onClick={resume} aria-label={`Resume “${p.title}”`} title="Continue this conversation">
            Resume
          </Button>
        )}
        <RowMenu
          title={p.title}
          items={[
            ...(phone && p.resumable ? [{ key: 'resume', label: 'Resume', sub: 'Continue this conversation', icon: <Play size={15} />, onSelect: resume }] : []),
            { key: 'hide', label: 'Not now', sub: 'Hide it from Home until it changes', icon: <X size={15} />, onSelect: onHide },
          ]}
        />
      </div>
    </div>
  );
}

export function PickUp({ items, phone }: { items: PickupItem[]; phone: boolean }) {
  const toast = useToast();
  const cache = useOverviewCache();
  const gone = useGone(items.map((p) => p.key));
  const list = useMemo(() => items.filter((p) => !gone.gone.has(p.key)).slice(0, 5), [items, gone.gone]);
  if (!list.length) return null;
  const hide = (p: PickupItem) => {
    gone.add(p.key);
    pickupHide(p.key)
      .then(() =>
        offerHomeUndo('Hidden from Home', () => {
          cache.patch((o) => (o.pickup && !o.pickup.some((x) => x.key === p.key) ? { ...o, pickup: [...o.pickup, p].sort((a, b) => b.lastAt - a.lastAt) } : o));
          gone.drop(p.key);
          pickupHide(p.key, false)
            .catch((e) => toast(friendly(e), true))
            .finally(cache.refresh);
        }),
      )
      .catch((e) => {
        gone.drop(p.key);
        toast(friendly(e), true);
      });
  };
  return (
    <Section title="Pick up">
      <Card flush className="home-card">
        {list.map((p) => (
          <PickupRow key={p.key} p={p} phone={phone} onHide={() => hide(p)} />
        ))}
      </Card>
    </Section>
  );
}
