// Running sessions of a project, as one compact line under the header ("1 working · <title> · All N · 📱").
import React from 'react';
import { Link } from 'react-router-dom';
import type { SessionSummary } from '../../types';
import { StatusIcon } from '../ui';
import { runLabel, runState, runSummary, sortRunning } from '../session/shared';
import { AppLink } from '../session/LiveRows';

export function RunningStrip({ sessions, onSeeAll }: { sessions: SessionSummary[]; onSeeAll: () => void }) {
  const live = sortRunning(sessions.filter((s) => s.live));
  if (!live.length) return null;
  const top = live[0];
  const st = runState(top);
  const url = top.live?.bridgeUrl;
  return (
    <div className={`pj-run st-${st}`} role="status" aria-label={`Running: ${runSummary(live)}`}>
      <StatusIcon status={st} title={runLabel(top)} />
      <div className="pj-run-text">
        <span className="pj-run-count">{runSummary(live)}</span>
        <Link to={`/sessions/${top.id}`} className="pj-run-title truncate" title={top.title}>
          {top.title}
        </Link>
      </div>
      <div className="pj-run-actions">
        {live.length > 1 && (
          <button type="button" className="btn sm ghost" onClick={onSeeAll}>
            All {live.length}
          </button>
        )}
        <AppLink url={url} />
      </div>
    </div>
  );
}
