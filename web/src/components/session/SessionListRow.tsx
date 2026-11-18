// One session in a list (Sessions page, project Sessions tab, project Overview, workstreams).
// Calm row: project glyph with the work status as a corner badge · title · project · time. One line on a PC, title +
// meta on a phone. The AI summary line shows only for a search match. No quoted prompts.
import React from 'react';
import { Link } from 'react-router-dom';
import { Archive, Bot, Play } from 'lucide-react';
import type { SessionSummary } from '../../types';
import { IconButton, Meta, Snippet, StatusIcon, statusInfo } from '../ui';
import { ago, fmtDate, fmtDateTime, fmtTime } from '../../util';
import { GlyphStatus } from '../cards';
import { useApp } from '../AppContext';
import { AppLink, BranchBit, HarnessTag } from './LiveRows';
import { branchOf, harnessOf, projectNameOf, runLabel, runState, sameName } from './shared';
import './live.css';

/** State of the session for the lead: running state, else the AI summary's status (how the work stood back then). */
function leadState(s: SessionSummary): { status?: string; badge?: React.ReactNode; title: string } {
  if (s.live) return { status: runState(s), title: runLabel(s) };
  if (s.kind === 'automation') return { badge: <Bot aria-hidden="true" />, title: 'Automation' };
  if (s.kind === 'archived') return { badge: <Archive aria-hidden="true" />, title: 'Archived' };
  if (s.digest) return { status: s.digest.status, title: `Summary: ${statusInfo(s.digest.status).label.toLowerCase()}` };
  return { title: 'No summary yet' };
}

function Lead({ s, glyph }: { s: SessionSummary; glyph: boolean }) {
  const st = leadState(s);
  if (glyph) return <GlyphStatus name={projectNameOf(s)} ws={s.workspace} size={24} status={st.status} badge={st.badge} statusTitle={st.title} />;
  if (st.status) return <StatusIcon status={st.status} title={st.title} />;
  if (s.kind === 'automation') return <Bot size={14} className="faint" aria-label="Automation" />;
  if (s.kind === 'archived') return <Archive size={14} className="faint" aria-label="Archived" />;
  return <span className="sx-nodot" aria-label="No summary yet" />;
}

export function SessionListRow({
  s,
  showProject = true,
  defaultBranch,
  when = 'ago',
}: {
  s: SessionSummary;
  showProject?: boolean;
  /** Kept for callers: the branch now shows on every row when it isn't main/master/the default. */
  showBranch?: boolean;
  defaultBranch?: string | null;
  /** Trailing time: relative, clock time (Today / Yesterday buckets) or date (older buckets). */
  when?: 'ago' | 'time' | 'date';
}) {
  const { openNewSession } = useApp();
  const proj = projectNameOf(s);
  const branch = branchOf(s, defaultBranch);
  const trail = when === 'time' ? fmtTime(s.lastAt) : when === 'date' ? fmtDate(s.lastAt) : ago(s.lastAt);
  const canResume = !s.live && s.kind !== 'archived' && harnessOf(s) === 'claude';
  const meta = [
    showProject && s.projectName && !sameName(proj, s.title) ? <span className="truncate sx-proj-name">{proj}</span> : null,
    branch ? <BranchBit name={branch} /> : null,
  ];
  const hasMeta = meta.some(Boolean);
  return (
    <div className={`lrow clickable sx-lrow${s.match ? ' has-match' : ''}${hasMeta ? '' : ' no-meta'}`}>
      <Link to={`/sessions/${s.id}`} className="lrow-link" aria-label={s.title} />
      <div className="lrow-lead">
        <Lead s={s} glyph={showProject} />
      </div>
      <div className="lrow-body">
        <div className="sx-line">
          <div className="lrow-title">
            <span className="t">{s.title}</span>
            <HarnessTag s={s} />
          </div>
          {hasMeta && <Meta className="sx-meta" items={meta} />}
        </div>
        {s.match && <Snippet text={s.match} lines={2} className="lrow-sub" />}
      </div>
      <div className="lrow-trail">
        <span className="sx-row-acts">
          {s.live ? (
            <AppLink url={s.live.bridgeUrl} />
          ) : canResume ? (
            <IconButton icon={<Play />} label="Resume" title="Resume this session" onClick={() => openNewSession({ resumeId: s.id })} className="sx-resume-btn" />
          ) : null}
        </span>
        {s.live ? (
          <span className={`live-word st-word-${runState(s)}`}>{runLabel(s)}</span>
        ) : (
          <span className="num sx-when" title={fmtDateTime(s.lastAt)}>
            {trail}
          </span>
        )}
      </div>
    </div>
  );
}
