// Domain cards and rows shared across pages. Follow docs/DESIGN.md: one strong primary line,
// at most two lines of secondary text, metadata as quiet middot-separated text, status as a glyph.
import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bot, Cloud, CornerDownRight, ExternalLink, GitBranch, Info, Monitor, Pin, Play, Smartphone, Square } from 'lucide-react';
import type { AttentionItem, BlockView, ProjectSummary, SessionSummary } from '../types';
import { Dot, LiveStatus, Meta, ProjectGlyph, Snippet, StatusIcon, WorkStatus, statusInfo, useToast } from './ui';
import { useApp } from './AppContext';
import { api, useInvalidate, useOverview, useTerminal } from '../api';
import { ago, fmtDate, wsColor, shortModel, plural } from '../util';
import './cards.css';

/** Project glyph (identity) with a state as a small corner badge: the anchor that leads session and project rows
 *  (calm redesign, principle 5). `status` uses the StatusIcon vocabulary; `badge` takes any small icon instead. */
export function GlyphStatus({ name, ws, color, size = 24, status, statusTitle, badge, className = '' }: { name: string; ws?: string | null; color?: string | null; size?: number; status?: string | null; statusTitle?: string; badge?: React.ReactNode; className?: string }) {
  return (
    <span className={`gstat ${className}`} style={{ width: size, height: size }}>
      <ProjectGlyph name={name} ws={ws} color={color} size={size} title={statusTitle ? `${name} · ${statusTitle}` : name} />
      {(status || badge) && (
        <span className={`gstat-badge${status ? ` gs-${status}` : ''}`}>{status ? <StatusIcon status={status} size={12} title={statusTitle} /> : badge}</span>
      )}
    </span>
  );
}

/** Process state of a running session, in the shared status vocabulary (see ui.tsx STATUS):
 *  needs-you (amber) · working (accent) · idle_live = "Open" (grey). */
export function liveState(s: SessionSummary): 'working' | 'needs-you' | 'idle_live' | null {
  if (!s.live) return null;
  if (s.live.kind === 'background') return s.live.state === 'working' ? 'working' : s.live.state === 'blocked' ? 'needs-you' : 'idle_live';
  // terminal sessions: 'waiting' = Claude asked for your input or a permission
  return s.live.status === 'waiting' ? 'needs-you' : s.live.status === 'busy' ? 'working' : 'idle_live';
}

export function liveDot(s: SessionSummary) {
  const st = liveState(s);
  if (!st) return null;
  return <Dot kind={st === 'working' ? 'busy' : st === 'needs-you' ? 'warn' : ''} />;
}

/** The state word for a running session: Needs you · Working · Open (idle). */
export function liveLabel(s: SessionSummary) {
  if (!s.live) return '';
  const st = liveState(s);
  return st === 'needs-you' ? 'Needs you' : st === 'working' ? 'Working' : 'Open';
}

/** How many running sessions are in each state. */
export type RunCounts = { needs: number; working: number; open: number };

export function countRunning(live: SessionSummary[] | undefined): RunCounts {
  const c: RunCounts = { needs: 0, working: 0, open: 0 };
  for (const s of live || []) {
    const st = liveState(s);
    if (st === 'needs-you') c.needs++;
    else if (st === 'working') c.working++;
    else if (st) c.open++;
  }
  return c;
}

/** Running sessions per project id, from the overview's live list (already loaded by the sidebar). */
export function useRunningByProject(): Map<string, RunCounts> {
  const { data } = useOverview();
  const live = data?.live;
  return React.useMemo(() => {
    const m = new Map<string, RunCounts>();
    for (const s of live || []) {
      if (!s.projectId) continue;
      const c = m.get(s.projectId) || { needs: 0, working: 0, open: 0 };
      const one = countRunning([s]);
      c.needs += one.needs;
      c.working += one.working;
      c.open += one.open;
      m.set(s.projectId, c);
    }
    return m;
  }, [live]);
}

/** The one state word a project/workspace shows, in the Sessions/Home words: "1 needs you" (amber) when something
 *  waits for you, else "2 working" (accent) when any is working, else "3 open" (grey, idle). `fallback` = a live count
 *  without states (e.g. ProjectSummary.liveCount before the live list has loaded): shown as open. */
export function runningWord(c: RunCounts | undefined, fallback = 0): { state: 'needs-you' | 'working' | 'idle_live'; label: string; title: string } | null {
  const needs = c?.needs || 0;
  const working = c?.working || 0;
  const open = c ? c.open : fallback;
  if (!needs && !working && !open) return null;
  const title = [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '', working ? `${working} working` : '', open ? `${open} open (idle)` : ''].filter(Boolean).join(' · ');
  if (needs) return { state: 'needs-you', label: `${needs} needs you`, title };
  if (working) return { state: 'working', label: `${working} working`, title };
  return { state: 'idle_live', label: `${open} open`, title };
}

/** A project's running state as a small pill (cards, tiles, rows): "N needs you" · "N working" · "N open". */
export function ProjectRunning({ p, counts }: { p: ProjectSummary; counts: Map<string, RunCounts> }) {
  if (!p.liveCount) return null;
  const w = runningWord(counts.get(p.id), p.liveCount);
  if (!w) return null;
  return (
    <span title={w.title}>
      <LiveStatus state={w.state} label={w.label} size="sm" />
    </span>
  );
}

/** Days since a timestamp, rounded down. */
export const daysSince = (t: number | null | undefined, now = Date.now()) => (t ? Math.max(0, Math.floor((now - t) / 86400e3)) : 0);

/** Neutral grey tag for work that stopped moving: "Gone quiet 12 d". Replaces warning prose (SIMPLIFY.md §2). */
export function QuietTag({ days, className = '' }: { days: number; className?: string }) {
  if (!days || days < 1) return null;
  return (
    <span className={`quiet-tag num ${className}`} title={`No activity for ${plural(days, 'day')}`}>
      Gone quiet {days} d
    </span>
  );
}

/** A project's quiet days, or 0: current projects with nothing new for a week, or work the AI saw left open 3+ days ago. */
export function projectQuietDays(p: ProjectSummary, now = Date.now()) {
  if (p.liveCount > 0) return 0;
  const d = daysSince(p.lastAt, now);
  const current = p.status === 'active' || p.status === 'paused';
  const leftOpen = p.attention.some((a) => a.kind === 'left' || a.kind === 'idle');
  return (current && d >= 7) || (leftOpen && d >= 3) ? d : 0;
}

/** Project lifecycle status as a quiet work-status tag. */
export function ProjectStatusBadge({ status }: { status: string }) {
  return <WorkStatus status={status} />;
}

function GitMeta({ git }: { git: NonNullable<ProjectSummary['git']> }) {
  const dirty = git.dirty + git.untracked;
  return (
    <span title={git.lastCommitMsg ? `Last commit: ${git.lastCommitMsg}` : undefined}>
      <GitBranch />
      <span className="truncate" style={{ maxWidth: 130 }}>
        {git.branch || 'detached'}
      </span>
      {dirty > 0 && <span className="tone-amber num">±{dirty}</span>}
      {git.ahead > 0 && <span className="tone-accent num">↑{git.ahead}</span>}
    </span>
  );
}

export function ProjectCard({ p, showWorkspace = false, showStack = false }: { p: ProjectSummary; showWorkspace?: boolean; showStack?: boolean }) {
  const running = useRunningByProject();
  const sessions = Math.max(0, p.sessionCount - p.automationRuns);
  const quiet = projectQuietDays(p);
  return (
    <Link to={`/projects/${p.id}`} className="card pcard">
      <div className="pcard-head">
        <ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={32} title={p.workspaceName} />
        <div className="grow">
          <div className="row" style={{ gap: 6 }}>
            <span className="title truncate">{p.name}</span>
            {p.pinned && <Pin size={12} className="faint" aria-label="Pinned" />}
          </div>
          <div className="sub truncate" title={p.displayPath}>
            {showWorkspace ? `${p.workspaceName} · ${p.displayPath}` : p.displayPath}
          </div>
        </div>
        {p.liveCount > 0 ? <ProjectRunning p={p} counts={running} /> : p.status !== 'active' ? <WorkStatus status={p.status} /> : null}
      </div>
      {p.oneLiner ? (
        <Snippet text={p.oneLiner} lines={2} className="desc" />
      ) : (
        <div className="desc empty-desc">{p.sessionCount ? '' : p.isGit ? 'Git repository, no sessions yet' : 'Folder, no sessions yet'}</div>
      )}
      {showStack && p.stack.length > 0 && <div className="tiny faint truncate">{p.stack.slice(0, 5).join(' · ')}</div>}
      <Meta
        items={[
          <span title={`Last activity ${fmtDate(p.lastAt)}`}>{ago(p.lastAt)}</span>,
          sessions > 0 ? <span title={p.automationRuns ? `${plural(p.automationRuns, 'automation')} not counted` : undefined}>{plural(sessions, 'session')}</span> : null,
          p.git ? <GitMeta git={p.git} /> : null,
          quiet ? <QuietTag days={quiet} /> : null,
        ]}
      />
    </Link>
  );
}

function SessionLead({ s }: { s: SessionSummary }) {
  const st = liveState(s);
  if (st) return <StatusIcon status={st} title={liveLabel(s)} />;
  if (s.digest) return <StatusIcon status={s.digest.status} />;
  if (s.kind === 'automation') return <Bot size={14} className="faint" aria-label="Automation" />;
  return <Dot />;
}

export function SessionRow({ s, showProject = true }: { s: SessionSummary; showProject?: boolean }) {
  const st = liveState(s);
  const text = s.match || s.digest?.summary || s.lastPrompt;
  return (
    <div className="lrow clickable">
      <Link to={`/sessions/${s.id}`} className="lrow-link" aria-label={s.title} />
      <div className="lrow-lead">
        <SessionLead s={s} />
      </div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{s.title}</span>
          {s.harness && s.harness !== 'claude' && <span className="chip harness-chip">{s.harness === 'codex' ? 'Codex' : 'Gemini'}</span>}
        </div>
        {text && <Snippet text={text} lines={s.match ? 2 : 1} className="lrow-sub" />}
        <Meta
          items={[
            showProject && s.projectName ? (
              <>
                {s.workspace && <ProjectGlyph name={s.projectName} ws={s.workspace} size={14} />}
                {s.projectName}
              </>
            ) : null,
            s.worktree ? <span className="truncate" style={{ maxWidth: 160 }}>{s.worktree}</span> : null,
            s.humanPrompts > 0 ? plural(s.humanPrompts, 'prompt') : null,
            s.model ? shortModel(s.model) : null,
            s.kind === 'automation' ? 'Automation' : null,
            s.kind === 'archived' ? <span title="Transcript removed by Claude Code; your prompts are kept">Archived</span> : null,
          ]}
        />
      </div>
      <div className="lrow-trail">{st ? <span className={`live-word t-${statusInfo(st).tone}`}>{liveLabel(s)}</span> : <span title={fmtDate(s.lastAt)}>{ago(s.lastAt)}</span>}</div>
    </div>
  );
}

export function LiveCard({ s }: { s: SessionSummary }) {
  const toast = useToast();
  const inv = useInvalidate();
  const term = useTerminal();
  const l = s.live!;
  const st = liveState(s) || 'idle_live';
  return (
    <div className="card pcard live-card">
      <div className="spread">
        <LiveStatus state={st} label={liveLabel(s)} />
        <span className="row tiny faint" style={{ gap: 5 }} title={l.kind === 'background' ? 'Runs in the background on your PC' : 'Runs in a terminal on your PC'}>
          {l.kind === 'background' ? <Cloud size={13} /> : <Monitor size={13} />}
          {l.kind === 'background' ? 'Background' : 'Terminal'}
          <span className="fainter">·</span>
          <span className="num">{ago(s.lastAt)}</span>
        </span>
      </div>
      <div className="stack-sm">
        <Link to={`/sessions/${s.id}`} className="title clamp-2">
          {s.title}
        </Link>
        <Meta
          items={[
            <>
              {s.workspace && <ProjectGlyph name={s.projectName || s.cwd} ws={s.workspace} size={14} />}
              <span className="truncate" style={{ maxWidth: 220 }}>
                {s.projectName || s.cwd}
              </span>
            </>,
            s.worktree,
          ]}
        />
      </div>
      {(l.detail || s.lastPrompt) && <Snippet text={l.detail || s.lastPrompt} lines={2} className="desc" quote={!l.detail} />}
      <div className="actions">
        {l.bridgeUrl ? (
          <a className="btn sm" href={l.bridgeUrl} target="_blank" rel="noreferrer">
            <Smartphone size={14} /> Open in Claude app
          </a>
        ) : (
          <span className="small faint">No Remote Control link</span>
        )}
        <Link className="btn sm ghost" to={`/sessions/${s.id}`}>
          View
        </Link>
        {l.kind === 'background' && l.bgId && (
          <>
            <span className="grow" />
            {term && (
              <button
                className="btn sm ghost hide-mobile"
                onClick={() =>
                  api(`/api/sessions/${s.id}/attach`, { method: 'POST' })
                    .then(() => toast(`Opened in ${term}`))
                    .catch((e) => toast(e.message, true))
                }
              >
                <Monitor size={14} /> Attach on PC
              </button>
            )}
            <button
              className="btn sm ghost"
              onClick={() => {
                if (!confirm(`Stop “${s.title}”? The conversation is kept and can be resumed.`)) return;
                api(`/api/sessions/${s.id}/stop`, { method: 'POST' })
                  .then(() => {
                    toast('Stopped');
                    inv('live', 'overview');
                  })
                  .catch((e) => toast(e.message, true));
              }}
            >
              <Square size={13} /> Stop
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function BlockRow({ b, showProject = true, showSession = true }: { b: BlockView; showProject?: boolean; showSession?: boolean }) {
  const { openNewSession } = useApp();
  const d = b.digest;
  const title = b.title || d?.title || b.fallbackTitle;
  const open = !!d && d.status !== 'done' && d.status !== 'abandoned';
  const range = b.endAt - b.startAt > 86400e3 ? `${fmtDate(b.startAt)} → ${fmtDate(b.endAt)}` : fmtDate(b.endAt);
  return (
    <div className="lrow clickable block-row">
      <Link to={`/sessions/${b.sessionId}`} className="lrow-link" aria-label={title} />
      <div className="lrow-lead">{b.live ? <StatusIcon status="live" title="Session is running" /> : d ? <StatusIcon status={d.status} /> : <Dot />}</div>
      <div className="lrow-body" style={{ gap: 4 }}>
        <div className="lrow-title">
          <span className="t">{title}</span>
        </div>
        {d ? <Snippet text={d.outcome || d.summary} lines={2} className="lrow-sub" /> : b.lastText ? <Snippet text={b.lastText} lines={2} className="lrow-sub" /> : null}
        {d?.nextStep && open && (
          <div className="next-step">
            <CornerDownRight size={13} />
            <Snippet text={d.nextStep} lines={1} />
          </div>
        )}
        <Meta
          items={[
            showProject && b.projectName ? (
              b.projectId ? (
                <Link to={`/projects/${b.projectId}`} className="above">
                  {b.projectName}
                </Link>
              ) : (
                b.projectName
              )
            ) : null,
            <span title={range}>{ago(b.endAt)}</span>,
            b.prompts > 0 ? plural(b.prompts, 'prompt') : null,
            showSession && b.sessionTitle && b.sessionTitle !== title ? (
              <span className="truncate" style={{ maxWidth: 200 }} title={b.sessionTitle}>
                in “{b.sessionTitle}”
              </span>
            ) : null,
            d?.topic ? (
              <span className="truncate" style={{ maxWidth: 180 }} title={d.topic}>
                {d.topic}
              </span>
            ) : null,
          ]}
        />
      </div>
      {!b.live && open && (
        <button
          className="btn sm ghost block-action on-hover above"
          onClick={() => openNewSession({ resumeId: b.sessionId })}
          title="Resume this session"
        >
          <Play size={13} /> Continue
        </button>
      )}
    </div>
  );
}

export function AttentionRow({ a }: { a: AttentionItem }) {
  return (
    <div className="lrow clickable dense-top">
      <Link to={a.sessionId ? `/sessions/${a.sessionId}` : `/projects/${a.projectId}`} className="lrow-link" aria-label={a.projectName} />
      <div className="lrow-lead">{a.severity === 'warn' ? <AlertTriangle size={15} className="tone-amber" /> : <Info size={15} className="faint" />}</div>
      <div className="lrow-body" style={{ gap: 2 }}>
        <div className="lrow-title" style={{ fontSize: 'var(--fs-sm)' }}>
          <span className="t">{a.projectName}</span>
        </div>
        <Snippet text={a.text} lines={2} className="lrow-sub" />
      </div>
    </div>
  );
}

export function ExternalA({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="link row" style={{ display: 'inline-flex', gap: 4 }}>
      {children}
      <ExternalLink size={12} />
    </a>
  );
}

export function WsSwatch({ ws }: { ws: string }) {
  return <span className="ws-swatch" style={{ background: wsColor(ws) }} />;
}

