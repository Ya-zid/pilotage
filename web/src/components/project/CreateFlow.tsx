// Shared pieces of the "New project" and "Spin off" dialogs: dry-run preview, options, result screen.
import React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Cloud, FileText, FolderPlus, GitBranch, ListTodo, Monitor, Sparkles, TriangleAlert, XCircle } from 'lucide-react';
import type { CreatedProject } from '../../types-extra';
import { Button, Callout, Field, SegmentedControl, Spinner, Switch } from '../ui';
import { plural } from '../../util';
import { LaunchStatus } from './LaunchStatus';
import { terminalPlace, useTerminal } from '../../api';
import { errMsg, request, RequestError, useDebounced, type WorkspaceOption } from './lib';

export type DryRun = {
  ok: true;
  dryRun: true;
  path: string;
  newParent?: string | null; // first folder on the way that doesn't exist yet (created too)
  displayPath: string;
  slug: string;
  parent: string;
  insideRepo: string | null;
  workspace: string | null;
  goal: string;
  related?: string[];
  source?: {
    projectId: string;
    name: string;
    session: { id: string; title: string } | null;
    thread: { name: string; summary: string } | null;
    blocks: number;
    files: number;
  };
};

export type LaunchChoice = 'none' | 'terminal' | 'background';

/** Prefill for the Spin off / New project dialogs, e.g. from a possible project the scout spotted (API-SCOUT.md).
 *  `scoutId` is sent with the real create call; the server then marks that candidate accepted. */
export type CreatePrefill = { name?: string; goal?: string; thread?: string; scoutId?: string };

/** One quiet line under the form when the dialog was opened from a possible project. */
export function ScoutOrigin({ prefill }: { prefill?: CreatePrefill }) {
  if (!prefill?.scoutId) return null;
  return (
    <div className="hint row" style={{ gap: 6, alignItems: 'flex-start' }}>
      <Sparkles size={13} className="faint" style={{ flex: 'none', marginTop: 2 }} aria-hidden="true" />
      <span>From Possible projects. Its pitch, why and evidence also go into the new CLAUDE.md as the original idea.</span>
    </div>
  );
}

const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, '~');

/** Dry-run the create call while the user types (debounced). `body` null = not ready yet. */
export function usePlan(endpoint: string, body: Record<string, unknown> | null) {
  const key = body ? JSON.stringify(body) : '';
  const debounced = useDebounced(key, 450);
  const q = useQuery({
    queryKey: ['plan', endpoint, debounced],
    queryFn: () => request<DryRun>(endpoint, { method: 'POST', body: { ...JSON.parse(debounced), dryRun: true } }),
    enabled: !!debounced,
    retry: false,
    staleTime: 4000,
    placeholderData: keepPreviousData,
  });
  const settling = !!key && (key !== debounced || q.isFetching);
  return { plan: debounced && q.data && !q.isError ? q.data : null, error: debounced ? q.error : null, settling, ready: !!key && key === debounced && !q.isFetching && !!q.data && !q.isError };
}

/** Target folder + what will happen, or why it can't. */
export function PlanPreview({ plan, error, settling, gitInit, onUseSuggestion, children }: { plan: DryRun | null; error: unknown; settling: boolean; gitInit: boolean; onUseSuggestion: (s: string) => void; children?: React.ReactNode }) {
  if (error) {
    const re = error instanceof RequestError ? error : null;
    const suggestion = re && re.status === 409 && typeof re.data.suggestion === 'string' ? (re.data.suggestion as string) : null;
    return (
      <Callout tone="warn" icon={<TriangleAlert />} title={re?.status === 409 ? errMsg(error) : 'Can’t create it there'} action={suggestion ? <Button size="sm" onClick={() => onUseSuggestion(suggestion)}>Use “{suggestion}”</Button> : undefined}>
        {re?.status === 409 ? 'Pick another name, or take the suggestion.' : errMsg(error)}
      </Callout>
    );
  }
  if (!plan)
    return (
      <div className="pj-plan muted">
        <span className="pj-plan-ico">{settling ? <Spinner size={16} /> : <FolderPlus size={17} />}</span>
        <div className="small faint">{settling ? 'Checking the folder…' : 'Type a name to see where the folder goes.'}</div>
      </div>
    );
  return (
    <div className={`pj-plan${settling ? ' settling' : ''}`} aria-live="polite">
      <span className="pj-plan-ico">{settling ? <Spinner size={16} /> : <FolderPlus size={17} />}</span>
      <div className="grow stack-sm">
        <div className="overline">{plan.newParent ? 'New folders' : 'New folder'}</div>
        <div className="pj-plan-path mono break" title={plan.path}>
          {plan.displayPath}
        </div>
        {plan.newParent && <div className="hint">Also creates {plan.newParent}.</div>}
        {plan.insideRepo && gitInit && <div className="hint">Inside the git repo {tilde(plan.insideRepo)}; it gets its own repository.</div>}
        {children}
      </div>
    </div>
  );
}

export function WorkspaceSelect({ id, value, onChange, options, noneLabel = 'No workspace' }: { id: string; value: string; onChange: (v: string) => void; options: WorkspaceOption[]; noneLabel?: string }) {
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{noneLabel}</option>
      {options.map((w) => (
        <option key={w.key} value={w.key}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

/** Git init + launch + AI hand-off options, shared by both dialogs. */
export function CreateOptions({ gitInit, setGitInit, launch, setLaunch, useAI, setUseAI }: { gitInit: boolean; setGitInit: (v: boolean) => void; launch: LaunchChoice; setLaunch: (v: LaunchChoice) => void; useAI: boolean; setUseAI: (v: boolean) => void }) {
  const term = useTerminal();
  return (
    <>
      <div className="pj-setting">
        <div className="grow">
          <div className="pj-setting-label">Create a git repository</div>
          <div className="hint">Recommended. Needed when the parent folder is already inside a repo.</div>
        </div>
        <Switch on={gitInit} onChange={setGitInit} label="Create a git repository" />
      </div>
      <div className="pj-setting">
        <div className="grow">
          <div className="pj-setting-label">Write CLAUDE.md with AI</div>
          <div className="hint">Takes up to a minute. Off, or if AI is busy, a template is used instead.</div>
        </div>
        <Switch on={useAI} onChange={setUseAI} label="Write CLAUDE.md with AI" />
      </div>
      <Field label="Start a session in it">
        <SegmentedControl
          value={!term && launch === 'terminal' ? 'background' : launch}
          onChange={setLaunch}
          label="Start a session"
          block
          options={[
            { value: 'none', label: 'Not now' },
            // No terminal on this PC (headless, over SSH): sessions start in the background.
            ...(term ? [{ value: 'terminal' as const, label: <><Monitor size={14} /> Terminal</>, title: `${terminalPlace(term, true)} on your PC, with Remote Control` }] : []),
            { value: 'background', label: <><Cloud size={14} /> Background</>, title: 'No window on the PC; continue in the Claude app' },
          ]}
        />
      </Field>
    </>
  );
}

export function CreatingState({ name, useAI }: { name: string; useAI: boolean }) {
  return (
    <div className="launch-state" aria-live="polite" aria-busy="true">
      <div className="launch-icon">
        <Spinner size={24} />
      </div>
      <div className="stack">
        <div className="launch-title">Creating “{name}”…</div>
        <div className="small muted readable pj-center">{useAI ? 'Claude is writing the CLAUDE.md hand-off and the first tasks. This can take up to a minute.' : 'Writing CLAUDE.md and the first tasks.'}</div>
      </div>
    </div>
  );
}

/** Never show raw error codes. */
function friendlyAiError(e: string) {
  if (/^[\w.:-]+$/.test(e.trim())) return 'AI wasn’t available, so the template was used. You can ask Claude to refine CLAUDE.md later.';
  return `AI wasn’t used: ${e.replace(/\s+/g, ' ').slice(0, 160)}`;
}

export function CreateResult({ r, onNavigate }: { r: CreatedProject; onNavigate: () => void }) {
  const ai = r.claudeMd.generatedBy === 'ai';
  return (
    <div className="pj-result">
      <div className="pj-result-head">
        <div className="launch-icon ok">
          <CheckCircle2 size={26} />
        </div>
        <div className="launch-title break">“{r.project.name}” is ready</div>
        <div className="small faint mono break">{r.project.displayPath}</div>
      </div>
      <ul className="pj-result-list">
        <li>
          {ai ? <Sparkles className="tone-accent" /> : <FileText />}
          <div className="grow">
            <div>CLAUDE.md {ai ? 'written by AI' : 'written from a template'}</div>
            {!ai && r.claudeMd.aiError && <div className="hint">{friendlyAiError(r.claudeMd.aiError)}</div>}
          </div>
        </li>
        {r.git && (
          <li>
            {r.git.ok ? <GitBranch /> : <XCircle className="tone-amber" />}
            <div className="grow">{r.git.ok ? 'Git repository created' : <>Git init failed{r.git.error ? `: ${r.git.error}` : ''}</>}</div>
          </li>
        )}
        <li>
          <ListTodo />
          <div className="grow stack-sm">
            <div>{r.items.length ? `${plural(r.items.length, 'starter task')} on its board` : 'No starter tasks'}</div>
            {r.items.length > 0 && (
              <ol className="pj-result-tasks">
                {r.items.map((t) => (
                  <li key={t.id} className="clamp-2">
                    {t.title}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </li>
      </ul>
      {r.launch && <LaunchStatus launch={r.launch} compact onNavigate={onNavigate} />}
      {!r.project.registered && <div className="hint">The folder is outside Pilotage’s scan, so it shows in Projects once a session runs there.</div>}
    </div>
  );
}

export function OpenProjectLink({ r, onNavigate }: { r: CreatedProject; onNavigate: () => void }) {
  if (!r.project.registered) return null;
  return (
    <Link className="btn primary" to={`/projects/${r.project.id}`} onClick={onNavigate}>
      Open project
    </Link>
  );
}
