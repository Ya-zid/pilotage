// Running sessions: one calm row per running session (glyph + state badge · title · project · time) with one icon
// action (open in the Claude app); Attach on PC / Stop sit in a ⋯ menu. Groups: Needs you · Running (working first,
// then open/idle, the idle tail folded). Also the "Started from Pilotage" launches. Used by Sessions and the project page.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, GitBranch, Monitor, MoreHorizontal, Smartphone, Square } from 'lucide-react';
import { api, useInvalidate, useWsl } from '../../api';
import { Card, Disclosure, IconButton, Meta, Section, Snippet, Spinner, StatusIcon, useToast } from '../ui';
import type { Launch, SessionSummary } from '../../types';
import { ago, fmtDateTime } from '../../util';
import { GlyphStatus } from '../cards';
import { Menu, type MenuEntry } from '../project/Menu';
import { HARNESS_LABEL, branchOf, errText, harnessOf, projectNameOf, runLabel, runState, sameName, sortRunning, usefulDetail } from './shared';
import './live.css';

export function HarnessTag({ s }: { s: Pick<SessionSummary, 'harness'> }) {
  const h = harnessOf(s);
  if (h === 'claude') return null;
  return <span className="sx-harness">{HARNESS_LABEL[h]}</span>;
}

/** The one row action: open the session in the Claude app (icon only). Nothing when there's no app link. */
export function AppLink({ url, className = '' }: { url: string | null | undefined; className?: string }) {
  if (!url) return null;
  return (
    <a className={`btn ghost icon sx-app ${className}`} href={url} target="_blank" rel="noreferrer" aria-label="Open in Claude app" title="Open in Claude app">
      <Smartphone />
    </a>
  );
}

export function BranchBit({ name }: { name: string }) {
  return (
    <span className="sx-branch" title={`Branch or worktree ${name}`}>
      <GitBranch aria-hidden="true" />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function LiveSessionRow({ s, showProject = true }: { s: SessionSummary; showProject?: boolean }) {
  const toast = useToast();
  const inv = useInvalidate();
  const wsl = useWsl();
  const l = s.live!;
  const st = runState(s);
  const bg = l.kind === 'background';
  const detail = usefulDetail(l.detail, st === 'needs-you');
  const proj = projectNameOf(s);
  const branch = branchOf(s);
  const stop = () => {
    if (!confirm(`Stop “${s.title}”? The conversation is kept and can be resumed later.`)) return;
    api(`/api/sessions/${s.id}/stop`, { method: 'POST' })
      .then(() => {
        toast('Stopped');
        inv('live', 'overview', 'project');
      })
      .catch((e) => toast(errText(e), true));
  };
  const attach = () =>
    api(`/api/sessions/${s.id}/attach`, { method: 'POST' })
      .then(() => toast('Opened in Windows Terminal'))
      .catch((e) => toast(errText(e), true));
  const menu: MenuEntry[] = [];
  if (bg && l.bgId) {
    if (wsl) menu.push({ label: 'Attach on PC', icon: <Monitor />, hint: 'Bring it into a Windows Terminal tab', onSelect: attach });
    menu.push({ label: 'Stop', icon: <Square />, danger: true, hint: 'The conversation is kept', onSelect: stop });
  }
  return (
    <div className={`lrow clickable live-srow st-${st}`}>
      <Link to={`/sessions/${s.id}`} className="lrow-link" aria-label={`${s.title} (${runLabel(s)})`} />
      <div className="lrow-lead">{showProject ? <GlyphStatus name={proj} ws={s.workspace} size={24} status={st} statusTitle={runLabel(s)} /> : <StatusIcon status={st} title={runLabel(s)} />}</div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{s.title}</span>
          <HarnessTag s={s} />
        </div>
        {detail && <Snippet text={detail} lines={st === 'needs-you' ? 2 : 1} className="lrow-sub sx-detail-line" />}
        <Meta
          items={[
            showProject && !sameName(proj, s.title) ? <span className="truncate sx-proj-name">{proj}</span> : null,
            bg ? <span title="Runs in the background on your PC, no window">Background</span> : null,
            branch ? <BranchBit name={branch} /> : null,
            <span title={`Last activity ${fmtDateTime(s.lastAt)}`}>{ago(s.lastAt)}</span>,
          ]}
        />
      </div>
      {st === 'working' && <span className="live-word st-word-working sx-state-word">Working</span>}
      {(l.bridgeUrl || menu.length > 0) && (
        <div className="live-srow-actions">
          <AppLink url={l.bridgeUrl} />
          {menu.length > 0 && (
            <span className="hide-mobile">
              <Menu label="Session actions" sheetTitle={s.title} items={menu} trigger={(t) => <IconButton {...t} icon={<MoreHorizontal />} label="More actions" />} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function LaunchRow({ l }: { l: Launch }) {
  const ready = !!l.bridgeUrl;
  const failed = l.state === 'error';
  const project = l.cwd.split('/').filter(Boolean).pop() || l.cwd;
  return (
    <div className={`lrow launch-row live-srow${l.sessionId ? ' clickable' : ''}`}>
      {l.sessionId && <Link to={`/sessions/${l.sessionId}`} className="lrow-link" aria-label={l.name} />}
      <div className="lrow-lead">{failed ? <StatusIcon status="error" title="Didn’t start" /> : ready ? <CheckCircle2 size={15} className="faint" aria-label="Running" /> : <Spinner size={14} />}</div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{l.name}</span>
        </div>
        {failed ? (
          <Snippet text={`Didn’t start: ${errText(new Error(l.error || ''))}`} className="lrow-sub tone-red" />
        ) : !ready ? (
          <div className="lrow-sub">{l.note || l.detail || 'Starting… waiting for Claude to connect.'}</div>
        ) : null}
        <Meta
          items={[
            sameName(project, l.name) ? null : <span title={l.cwd}>{project}</span>,
            l.mode === 'background' ? 'Background' : null,
            <span title={fmtDateTime(l.createdAt)}>started {ago(l.createdAt)}</span>,
          ]}
        />
      </div>
      {ready && (
        <div className="live-srow-actions">
          <AppLink url={l.bridgeUrl} />
        </div>
      )}
    </div>
  );
}

/** Idle sessions shown before the rest fold behind "+N idle". */
const IDLE_SHOWN = 4;

/** Needs you (amber, only when any) · Running (working first, then open/idle; a long idle tail folds). */
export function RunningGroups({ live, showProject = true }: { live: SessionSummary[]; showProject?: boolean; foldOpen?: number }) {
  const [allIdle, setAllIdle] = useState(false);
  const list = sortRunning(live);
  const needs = list.filter((s) => runState(s) === 'needs-you');
  const running = list.filter((s) => runState(s) !== 'needs-you');
  const idle = running.filter((s) => runState(s) === 'idle_live');
  const working = running.length - idle.length;
  const fold = !allIdle && idle.length > IDLE_SHOWN + 1;
  const shown = fold ? running.slice(0, working + IDLE_SHOWN) : running;
  return (
    <>
      {needs.length > 0 && (
        <Section title="Needs you" count={needs.length}>
          <Card flush className="live-group live-needs-you">
            {needs.map((s) => (
              <LiveSessionRow key={s.id} s={s} showProject={showProject} />
            ))}
          </Card>
        </Section>
      )}
      {running.length > 0 && (
        <Section title="Running" count={running.length}>
          <Card flush className="live-group">
            {shown.map((s) => (
              <LiveSessionRow key={s.id} s={s} showProject={showProject} />
            ))}
            {idle.length > IDLE_SHOWN + 1 && (
              <button type="button" className="live-fold" onClick={() => setAllIdle(!allIdle)} aria-expanded={allIdle}>
                {allIdle ? 'Show fewer' : `+${idle.length - IDLE_SHOWN} idle`}
              </button>
            )}
          </Card>
        </Section>
      )}
    </>
  );
}

/** Recent launches from Pilotage, as a small folded section (open while one is still starting). */
export function LaunchesSection({ launches, max = 6 }: { launches: Launch[]; max?: number }) {
  const list = [...launches].sort((a, b) => b.createdAt - a.createdAt).slice(0, max);
  if (!list.length) return null;
  const starting = list.some((l) => !l.bridgeUrl && l.state !== 'error' && Date.now() - l.createdAt < 10 * 60e3);
  return (
    <Disclosure
      className="sx-launches"
      defaultOpen={starting}
      summary={
        <>
          Started from Pilotage <span className="faint num">{list.length}</span>
          {starting && <Spinner size={12} />}
        </>
      }
    >
      <Card flush>
        {list.map((l) => (
          <LaunchRow key={l.id} l={l} />
        ))}
      </Card>
    </Disclosure>
  );
}
