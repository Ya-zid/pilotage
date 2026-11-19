// Progress of a session launch (task start, new project, spin-off): polls until the phone link exists.
import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Smartphone, TriangleAlert } from 'lucide-react';
import { api, terminalPlace } from '../../api';
import type { Launch } from '../../types';
import type { LaunchRecord } from '../../types-extra';
import { Callout, CopyButton, Spinner } from '../ui';

type AnyLaunch = (Launch | LaunchRecord) & { note?: string; detail?: string; createdAt?: number; harness?: string };
const GIVE_UP = 4 * 60_000;

export function LaunchStatus({ launch, compact = false, onNavigate }: { launch: AnyLaunch; compact?: boolean; onNavigate?: () => void }) {
  const started = (launch as Launch).createdAt || Date.now();
  const { data } = useQuery({
    queryKey: ['launch', launch.id],
    queryFn: () => api<AnyLaunch>(`/api/launch/${launch.id}`),
    initialData: launch,
    refetchInterval: (q) => {
      const d = q.state.data as AnyLaunch | undefined;
      if (!d) return 1500;
      if (d.bridgeUrl || d.state === 'error' || (d.state === 'launched' && d.note) || Date.now() - (d.createdAt || started) > GIVE_UP) return false;
      return 1500;
    },
  });
  const l = (data || launch) as AnyLaunch;
  const ready = !!l.bridgeUrl;
  const timedOut = !ready && l.state !== 'error' && Date.now() - (l.createdAt || started) > GIVE_UP;
  if (l.state === 'error')
    return (
      <Callout tone="warn" icon={<TriangleAlert />} title="Could not start the session">
        {l.error || 'The launch failed.'}
      </Callout>
    );
  const viewLink = l.sessionId ? (
    <Link className="btn sm ghost" to={`/sessions/${l.sessionId}`} onClick={onNavigate}>
      View in Pilotage
    </Link>
  ) : null;
  const title = ready ? `“${l.name}” is running` : timedOut ? 'Still starting' : l.mode === 'terminal' ? `Opening ${terminalPlace((l as Launch).terminal ?? null)} on your PC…` : 'Starting in the background…';
  const body = ready
    ? l.mode === 'terminal'
      ? `It is open in ${(l as Launch).terminal || 'a terminal'}, and you can continue it from your phone.`
      : 'It runs on your PC without a window. Continue it in the Claude app.'
    : timedOut
      ? 'No phone link yet. It may still be connecting; check Sessions in a moment.'
      : l.note || l.detail || 'Waiting for Claude to connect Remote Control…';
  if (compact)
    return (
      <div className="pj-launch-row" aria-live="polite">
        <span className={`pj-launch-ico${ready ? ' ok' : ''}`}>{ready ? <CheckCircle2 size={18} /> : <Spinner size={16} />}</span>
        <div className="grow stack-sm">
          <div className="medium">{title}</div>
          <div className="small faint">{body}</div>
          {(ready || viewLink) && (
            <div className="cluster pj-launch-actions">
              {ready && (
                <a className="btn sm" href={l.bridgeUrl!} target="_blank" rel="noreferrer">
                  <Smartphone size={14} /> Open in Claude app <ExternalLink size={12} />
                </a>
              )}
              {viewLink}
            </div>
          )}
        </div>
      </div>
    );
  return (
    <div className="launch-state" aria-live="polite">
      <div className={`launch-icon${ready ? ' ok' : ''}`}>{ready ? <CheckCircle2 size={26} /> : <Spinner size={24} />}</div>
      <div className="stack">
        <div className="launch-title">{title}</div>
        <div className="small muted readable pj-center">{body}</div>
      </div>
      {ready && (
        <div className="stack pj-launch-cta">
          <a className="btn primary block lg" href={l.bridgeUrl!} target="_blank" rel="noreferrer">
            <Smartphone size={16} /> Open in Claude app <ExternalLink size={14} />
          </a>
          <div className="cluster pj-center-row">
            <CopyButton text={l.bridgeUrl!} label="Copy link" />
            {viewLink}
          </div>
        </div>
      )}
      {!ready && viewLink}
    </div>
  );
}
