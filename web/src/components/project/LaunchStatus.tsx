// Progress of a session launch (New session, task start, new project, spin-off): polls until the phone link exists,
// links the session in Pilotage as soon as its id is known, and stops spinning after 4 minutes ("Still starting").
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Hourglass, Smartphone, SquareTerminal, TriangleAlert } from 'lucide-react';
import { api, terminalPlace } from '../../api';
import type { Launch } from '../../types';
import type { LaunchRecord } from '../../types-extra';
import { Callout, CopyButton, Spinner } from '../ui';

type AnyLaunch = (Launch | LaunchRecord) & { note?: string; detail?: string; createdAt?: number; harness?: string };
const GIVE_UP = 4 * 60_000;
const HARNESS_NAME: Record<string, string> = { codex: 'Codex', gemini: 'Gemini' };

/** Codex / Gemini are not live-tracked: once their terminal is open there is no phone link to wait for. (Claude's
 *  no-terminal fallback is also "launched" with a note, but its phone link is still on the way.) */
const untracked = (l: AnyLaunch) => !!l.harness && l.harness !== 'claude' && l.state === 'launched';

export function LaunchStatus({ launch, compact = false, onNavigate }: { launch: AnyLaunch; compact?: boolean; onNavigate?: () => void }) {
  const [started] = useState(() => launch.createdAt || Date.now());
  const [, bump] = useState(0);
  const { data } = useQuery({
    queryKey: ['launch', launch.id],
    queryFn: () => api<AnyLaunch>(`/api/launch/${launch.id}`),
    initialData: launch,
    refetchInterval: (q) => {
      const d = q.state.data as AnyLaunch | undefined;
      if (!d) return 1500;
      if (d.bridgeUrl || d.state === 'error' || untracked(d) || Date.now() - (d.createdAt || started) > GIVE_UP) return false;
      return 1500;
    },
  });
  const l = (data || launch) as AnyLaunch;
  const ready = !!l.bridgeUrl;
  const giveUpAt = (l.createdAt || started) + GIVE_UP;
  // The polled record often stops changing (no phone link coming): re-render once at the give-up moment anyway.
  useEffect(() => {
    if (ready || l.state === 'error') return;
    const t = window.setTimeout(() => bump((n) => n + 1), Math.max(0, giveUpAt - Date.now()) + 100);
    return () => window.clearTimeout(t);
  }, [ready, l.state, giveUpAt]);
  const done = !ready && untracked(l);
  const timedOut = !ready && !done && l.state !== 'error' && Date.now() > giveUpAt;
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
  const sz = compact ? 16 : 24;
  const icon = ready ? <CheckCircle2 size={compact ? 18 : 26} /> : done ? <SquareTerminal size={sz} /> : timedOut ? <Hourglass size={sz} /> : <Spinner size={sz} />;
  const title = ready
    ? `“${l.name}” is running`
    : done
      ? `${HARNESS_NAME[l.harness || ''] || 'It'} is open in ${terminalPlace((l as Launch).terminal ?? null)}`
      : timedOut
        ? 'Still starting'
        : l.mode === 'terminal'
          ? `Opening ${terminalPlace((l as Launch).terminal ?? null)} on your PC…`
          : 'Starting in the background…';
  const body = ready
    ? l.mode === 'terminal'
      ? `It is open in ${(l as Launch).terminal || 'a terminal'}, and you can continue it from your phone.`
      : 'It runs on your PC without a window. Continue it in the Claude app.'
    : timedOut
      ? `No phone link yet. It may still be connecting; ${l.sessionId ? 'you can follow it in Pilotage meanwhile' : 'check Sessions in a moment'}.`
      : l.note || l.detail || 'Waiting for Claude to connect Remote Control…';
  if (compact)
    return (
      <div className="pj-launch-row" aria-live="polite">
        <span className={`pj-launch-ico${ready ? ' ok' : ''}`}>{icon}</span>
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
      <div className={`launch-icon${ready ? ' ok' : ''}`}>{icon}</div>
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
