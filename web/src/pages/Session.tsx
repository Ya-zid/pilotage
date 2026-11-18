// Session detail: continue the work (phone-first), read the summary, then the conversation at its latest turn.
// Blueprint: docs/DESIGN.md §8 "Session".
import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Bot, ChevronLeft, Copy, Eye, EyeOff, MessageSquareOff, Pencil, Split } from 'lucide-react';
import { api, ApiError, useInvalidate, useSession } from '../api';
import { liveLabel, liveState } from '../components/cards';
import { Badge, Button, Callout, EmptyState, IconButton, LiveStatus, LoadingCard, Meta, PageHeader, ProjectGlyph, Skeleton, Snippet, WorkStatus, useToast } from '../components/ui';
import { ago, copy, fmtDateTime } from '../util';
import type { SessionDetail } from '../types';
import { Conversation } from '../components/session/Conversation';
import { SessionSummary } from '../components/session/SessionSummary';
import { SessionDetails } from '../components/session/SessionDetails';
import { HeaderActions, PhoneFab, useSessionActions } from '../components/session/SessionActions';
import { BranchBit } from '../components/session/LiveRows';
import type { MenuEntry } from '../components/project/Menu';
import { HARNESS_LABEL, branchOf, harnessOf, useMedia } from '../components/session/shared';
import './Session.css';

function StatusOf({ s }: { s: SessionDetail }) {
  const st = liveState(s);
  if (st) return <LiveStatus state={st} label={liveLabel(s)} />;
  if (s.kind === 'archived') return <span title="Transcript removed by Claude Code, your prompts kept"><WorkStatus status="archived" label="Archived" /></span>;
  if (s.kind === 'automation')
    return (
      <span className="wstatus">
        <Bot size={13} /> Automation
      </span>
    );
  if (s.digest) return <WorkStatus status={s.digest.status} />;
  return null;
}

function RenameField({ s, onDone }: { s: SessionDetail; onDone: () => void }) {
  const [title, setTitle] = useState(s.title);
  const [busy, setBusy] = useState(false);
  const inv = useInvalidate();
  const toast = useToast();
  const save = () => {
    const next = title.trim();
    if (next === s.title) return onDone();
    setBusy(true);
    api(`/api/sessions/${s.id}`, { method: 'PATCH', body: { title: next } })
      .then(() => {
        toast(next ? 'Renamed in Pilotage' : 'Back to the original title');
        inv('session', 'sessions', 'overview', 'project', 'live', 'day');
        onDone();
      })
      .catch((e) => toast(e.message, true))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="sx-rename"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        className="input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onDone()}
        maxLength={120}
        autoFocus
        aria-label="Session title"
        placeholder="Empty restores the original title"
      />
      <div className="sx-rename-actions">
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <span className="hint">Renames it in Pilotage only, not in Claude Code.</span>
      </div>
    </form>
  );
}

/** Project · branch (only when it isn't main/master) · last active. Everything else is in Details. */
function HeaderMeta({ s }: { s: SessionDetail }) {
  const branch = branchOf(s);
  return (
    <Meta
      items={[
        s.projectId && s.projectName ? (
          <Link to={`/projects/${s.projectId}`} className="sx-proj">
            <ProjectGlyph name={s.projectName} ws={s.workspace} size={14} />
            {s.projectName}
          </Link>
        ) : (
          <span className="mono truncate" title={s.cwd}>
            {s.cwd.replace(/^\/home\/[^/]+/, '~')}
          </span>
        ),
        branch ? <BranchBit name={branch} /> : null,
        <span title={fmtDateTime(s.lastAt)}>last active {ago(s.lastAt)}</span>,
      ]}
    />
  );
}

/** The ⋯ entries that belong to the page rather than to running/resuming: rename, spin off, hide, copy command. */
function usePageExtras(s: SessionDetail, onRename: () => void, set: ReturnType<typeof useSessionActions>): MenuEntry[] {
  const inv = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const toggleHidden = () =>
    api(`/api/sessions/${s.id}`, { method: 'PATCH', body: { hidden: !s.hidden } })
      .then(() => {
        toast(s.hidden ? 'Shown in lists again' : 'Hidden from lists');
        inv('session', 'sessions', 'overview', 'project', 'day');
      })
      .catch((e) => toast(e.message, true));
  const hasCopy = set.primary?.key === 'copy' || set.secondary.some((a) => a.key === 'copy');
  return [
    { label: 'Rename…', icon: <Pencil />, hint: 'In Pilotage only', onSelect: onRename },
    ...(s.projectId ? [{ label: 'Spin off into a new project…', icon: <Split />, onSelect: () => navigate(`/projects/${s.projectId}?spinoff=1&session=${encodeURIComponent(s.id)}`) } as MenuEntry] : []),
    ...(hasCopy ? [] : [{ label: 'Copy resume command', icon: <Copy />, onSelect: () => copy(s.resumeCommand).then(() => toast('Resume command copied')) } as MenuEntry]),
    { label: s.hidden ? 'Show in lists again' : 'Hide from lists', icon: s.hidden ? <Eye /> : <EyeOff />, hint: s.hidden ? undefined : 'It stays searchable', onSelect: toggleHidden },
  ];
}

/** Desktop: a slim bar under the top bar once the page header has scrolled away. */
function CompactHeader({ s, visible, actions }: { s: SessionDetail; visible: boolean; actions: React.ReactNode }) {
  return (
    <div className="sx-sticky hide-mobile" aria-hidden={!visible}>
      <div className={`sx-sticky-bar${visible ? ' on' : ''}`}>
        {s.projectName && <ProjectGlyph name={s.projectName} ws={s.workspace} size={20} />}
        <span className="sx-sticky-title truncate">{s.title}</span>
        <StatusOf s={s} />
        <span className="grow" />
        {visible && actions}
      </div>
    </div>
  );
}

/** Phone: the page opens at the latest turn, far below the header, so a title strip under the top bar says
 *  which session this is (and where it lives) before you tap Resume, with a way back. */
function PhoneTitleBar({ s, visible }: { s: SessionDetail; visible: boolean }) {
  const navigate = useNavigate();
  const loc = useLocation();
  const fallback = s.projectId ? `/projects/${s.projectId}` : '/sessions';
  // Opened straight from a link (no in-app history): go up to the project instead of leaving Pilotage.
  const back = () => (loc.key !== 'default' ? navigate(-1) : navigate(fallback));
  const where = s.projectName || s.cwd.replace(/^\/home\/[^/]+/, '~');
  return (
    <div className="sx-ptitle hide-desktop" aria-hidden={!visible}>
      <div className={`sx-ptitle-bar${visible ? ' on' : ''}`}>
        <IconButton icon={<ChevronLeft />} label="Back" onClick={back} className="sx-ptitle-back" tabIndex={visible ? undefined : -1} />
        {s.projectName && <ProjectGlyph name={s.projectName} ws={s.workspace} size={24} />}
        <div className="sx-ptitle-text">
          <span className="sx-ptitle-name truncate">{s.title}</span>
          <span className="sx-ptitle-sub truncate">{where}</span>
        </div>
        <StatusOf s={s} />
      </div>
    </div>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="card">
      <EmptyState
        icon={<MessageSquareOff />}
        title="Session not found"
        body="It may have been removed by Claude Code, or the link is wrong."
        action={
          <>
            <Button size="sm" icon={<ArrowLeft />} onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/sessions'))}>
              Back
            </Button>
            <Link className="btn sm ghost" to="/sessions">
              All sessions
            </Link>
          </>
        }
      />
    </div>
  );
}

function Loading() {
  return (
    <>
      <div className="stack" aria-busy="true">
        <Skeleton h={13} w={160} />
        <Skeleton h={28} w="55%" />
        <Skeleton h={13} w="40%" />
      </div>
      <div className="grid-main">
        <div className="stack-lg">
          <LoadingCard lines={3} />
          <LoadingCard lines={6} />
        </div>
        <LoadingCard lines={4} />
      </div>
    </>
  );
}

function SessionView({ s }: { s: SessionDetail }) {
  const phone = useMedia();
  const set = useSessionActions(s);
  const [editing, setEditing] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => setEditing(false), [s.id]);
  useEffect(() => {
    const el = headRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting && e.boundingClientRect.top < 0), { rootMargin: '-52px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const harness = harnessOf(s);
  const st = liveState(s);
  const showSummary = s.kind !== 'automation' && (s.blocksDetail.length > 0 || !!s.recap);
  const extras = usePageExtras(s, () => setEditing(true), set);

  return (
    <>
      <CompactHeader s={s} visible={scrolled && !phone} actions={<HeaderActions set={set} extras={extras} title={s.title} size="sm" />} />
      <PhoneTitleBar s={s} visible={scrolled && phone} />
      <div ref={headRef}>
        <PageHeader
          className="sx-head"
          crumbs={[{ label: 'Sessions', to: '/sessions' }]}
          title={editing ? <RenameField s={s} onDone={() => setEditing(false)} /> : s.title}
          status={
            editing ? undefined : (
              <>
                <StatusOf s={s} />
                {harness !== 'claude' && <Badge>{HARNESS_LABEL[harness]}</Badge>}
                {s.hidden && <Badge tone="plain">Hidden from lists</Badge>}
              </>
            )
          }
          subtitle={<HeaderMeta s={s} />}
          actions={<HeaderActions set={set} extras={extras} title={s.title} primary={!phone} />}
        />
      </div>

      {s.live?.detail &&
        (st === 'needs-you' ? (
          <Callout tone="warn" title="Claude is waiting for you">
            <Snippet text={s.live.detail} lines={3} />
          </Callout>
        ) : (
          <div className="sx-livedetail">
            <Snippet text={s.live.detail} lines={2} />
          </div>
        ))}

      <div className="grid-main sx-grid">
        <div className="stack-lg sx-main">
          {showSummary && <SessionSummary s={s} collapsible />}
          <Conversation s={s} />
        </div>
        <SessionDetails s={s} />
      </div>
      <PhoneFab set={set} />
    </>
  );
}

export default function Session() {
  const { id } = useParams();
  const { data: s, error, isLoading, refetch } = useSession(id);
  if (isLoading) return <Loading />;
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  if (error || !s)
    return (
      <div className="card">
        <EmptyState
          title="Couldn’t load this session"
          body={error instanceof Error ? error.message : 'Unknown error'}
          action={
            <>
              <Button size="sm" onClick={() => refetch()}>
                Try again
              </Button>
              <Link className="btn sm ghost" to="/sessions">
                All sessions
              </Link>
            </>
          }
        />
      </div>
    );
  return <SessionView key={s.id} s={s} />;
}
