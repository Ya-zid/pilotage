// "Spin off": move part of a project (a workstream, a session, or its recent work) into a new project folder.
// Flow: dry run while typing (target folder + hand-off size) → Create → result (CLAUDE.md, starter tasks, launch).
// Opens by itself from `/projects/:id?spinoff=1[&thread=<name>|&session=<id>]` (see pages/Project.tsx).
import React, { useMemo, useState } from 'react';
import { GitFork } from 'lucide-react';
import { useInvalidate } from '../../api';
import type { ProjectDetail } from '../../types';
import type { CreatedProject } from '../../types-extra';
import { Button, Field, Meta, Modal, ProjectGlyph, SegmentedControl, useToast } from '../ui';
import { ago, plainText, plural } from '../../util';
import { CreateOptions, CreateResult, CreatingState, OpenProjectLink, PlanPreview, ScoutOrigin, usePlan, WorkspaceSelect, type CreatePrefill, type LaunchChoice } from './CreateFlow';
import { errMsg, request, useIsPhone, useWorkspaceOptions } from './lib';

type Source = 'project' | 'thread' | 'session';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function SpinoffDialog({ p, thread: threadIn, session, prefill, onClose }: { p: ProjectDetail; thread?: string | null; session?: string | null; prefill?: CreatePrefill; onClose: () => void }) {
  const thread = prefill?.thread || threadIn;
  const phone = useIsPhone();
  const toast = useToast();
  const inv = useInvalidate();
  const workspaces = useWorkspaceOptions();
  const threads = p.threads.filter((t) => t.blocks.length > 0);
  const sessions = useMemo(() => p.sessions.filter((s) => s.kind !== 'automation').sort((a, b) => b.lastAt - a.lastAt), [p.sessions]);
  const initialThread = thread ? threads.find((t) => t.name.toLowerCase() === thread.toLowerCase()) : undefined;
  const [source, setSource] = useState<Source>(thread ? 'thread' : session ? 'session' : 'project');
  const [threadName, setThreadName] = useState(initialThread?.name || thread || threads[0]?.name || '');
  const [sessionId, setSessionId] = useState(session || sessions[0]?.id || '');
  const suggestedName = (src: Source, tn: string, sid: string) => (src === 'thread' ? tn : src === 'session' ? clip(sessions.find((s) => s.id === sid)?.title || '', 60) : '');
  const suggestedGoal = (src: Source, tn: string, sid: string) =>
    src === 'thread' ? plainText(threads.find((t) => t.name === tn)?.summary || '') : src === 'session' ? plainText(sessions.find((s) => s.id === sid)?.digest?.summary || '') : '';
  const [name, setName] = useState(() => prefill?.name || suggestedName(source, threadName, sessionId));
  const [goal, setGoal] = useState(() => prefill?.goal || suggestedGoal(source, threadName, sessionId));
  // a prefilled name/goal counts as typed: switching the source must not overwrite it
  const [touched, setTouched] = useState({ name: !!prefill?.name, goal: !!prefill?.goal });
  const [workspace, setWorkspace] = useState(p.workspace);
  const [parentDir, setParentDir] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [useAI, setUseAI] = useState(true);
  const [launch, setLaunch] = useState<LaunchChoice>(phone ? 'background' : 'terminal');
  const [trust, setTrust] = useState(false); // never pre-ticked
  const [phase, setPhase] = useState<'form' | 'creating' | 'done'>('form');
  const [result, setResult] = useState<CreatedProject | null>(null);

  // Changing the source refreshes the prefilled name/goal, unless the user typed their own.
  const reseed = (src: Source, tn: string, sid: string) => {
    if (!touched.name) setName(suggestedName(src, tn, sid));
    if (!touched.goal) setGoal(suggestedGoal(src, tn, sid));
  };
  const pickSource = (src: Source) => {
    setSource(src);
    reseed(src, threadName, sessionId);
  };

  const sourceBody = source === 'thread' && threadName ? { threadName } : source === 'session' && sessionId ? { fromSessionId: sessionId } : {};
  const body = name.trim() ? { fromProjectId: p.id, name: name.trim(), ...sourceBody, workspace: workspace || null, parentDir: parentDir.trim() || undefined, gitInit } : null;
  const { plan, error, settling, ready } = usePlan('/api/spinoff', body);
  const src = plan?.source;

  const create = async () => {
    if (!body) return;
    setPhase('creating');
    try {
      const r = await request<CreatedProject>('/api/spinoff', { method: 'POST', body: { ...body, goal: goal.trim() || undefined, launch: launch === 'none' ? null : launch, useAI, trust: launch !== 'none' && trust, ...(prefill?.scoutId ? { scoutId: prefill.scoutId } : {}) } });
      setResult(r);
      setPhase('done');
      inv('projects', 'project', 'work', 'spinoffs', 'live', 'overview');
    } catch (e) {
      toast(errMsg(e), true);
      setPhase('form');
    }
  };

  const sessionMissing = source === 'session' && sessionId && !sessions.some((s) => s.id === sessionId);
  return (
    <Modal
      title={phase === 'done' ? 'Spun off' : 'Spin off a new project'}
      onClose={phase === 'creating' ? () => {} : onClose}
      footer={
        phase === 'done' && result ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <OpenProjectLink r={result} onNavigate={onClose} />
          </>
        ) : phase === 'creating' ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon={<GitFork />} disabled={!ready || phase !== 'form'} onClick={create}>
              Create project
            </Button>
          </>
        )
      }
    >
      <div className="modal-body">
        {phase === 'creating' ? (
          <CreatingState name={name.trim()} useAI={useAI} />
        ) : phase === 'done' && result ? (
          <CreateResult r={result} onNavigate={onClose} />
        ) : (
          <>
            <div className="pj-source">
              <div className="pj-source-head">
                <ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={28} />
                <div className="grow">
                  <div className="overline">From</div>
                  <div className="medium truncate">{p.name}</div>
                </div>
              </div>
              <SegmentedControl
                value={source}
                onChange={pickSource}
                label="Take"
                block
                options={[
                  { value: 'project', label: 'Recent work', title: 'The latest summarized work of the whole project' },
                  ...(threads.length || source === 'thread' ? [{ value: 'thread' as Source, label: 'A workstream' }] : []),
                  ...(sessions.length ? [{ value: 'session' as Source, label: 'A session' }] : []),
                ]}
              />
              {source === 'thread' && (
                <select
                  className="select"
                  aria-label="Workstream"
                  value={threadName}
                  onChange={(e) => {
                    setThreadName(e.target.value);
                    reseed('thread', e.target.value, sessionId);
                  }}
                >
                  {threads.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                  {threadName && !threads.some((t) => t.name === threadName) && <option value={threadName}>{threadName}</option>}
                </select>
              )}
              {source === 'session' && (
                <select
                  className="select"
                  aria-label="Session"
                  value={sessionId}
                  onChange={(e) => {
                    setSessionId(e.target.value);
                    reseed('session', threadName, e.target.value);
                  }}
                >
                  {sessionMissing && <option value={sessionId}>Session {sessionId.slice(0, 8)}</option>}
                  {sessions.slice(0, 60).map((s) => (
                    <option key={s.id} value={s.id}>
                      {clip(s.title, 70)} · {ago(s.lastAt)}
                    </option>
                  ))}
                </select>
              )}
              {src && (
                <div aria-live="polite">
                  <Meta
                    className="pj-context"
                    items={[
                      <span>Hands off the summarized work</span>,
                      src.files ? (
                        <span>
                          <b className="num">{plural(src.files, 'relevant file')}</b>
                        </span>
                      ) : null,
                      p.brief ? 'the project summary' : null,
                    ]}
                  />
                </div>
              )}
            </div>
            <Field label="Name" htmlFor="so-name">
              <input
                id="so-name"
                className="input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setTouched((t) => ({ ...t, name: true }));
                }}
                placeholder="e.g. WhatsApp module"
                maxLength={80}
                autoFocus={!phone}
                autoComplete="off"
              />
            </Field>
            <Field label="Goal" htmlFor="so-goal" hint="Strongly suggested: it seeds CLAUDE.md and the first tasks.">
              <textarea
                id="so-goal"
                className="textarea"
                rows={3}
                value={goal}
                onChange={(e) => {
                  setGoal(e.target.value);
                  setTouched((t) => ({ ...t, goal: true }));
                }}
                placeholder={plan?.goal || 'What should the new project achieve on its own?'}
              />
            </Field>
            <div className="pj-form-2">
              <Field label="Workspace" htmlFor="so-ws">
                <WorkspaceSelect id="so-ws" value={workspace} onChange={setWorkspace} options={workspaces} noneLabel="Its own workspace" />
              </Field>
              <Field label="Parent folder" htmlFor="so-parent">
                <input id="so-parent" className="input mono" value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder={plan ? plan.parent.replace(/^\/home\/[^/]+/, '~') : '~'} autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <PlanPreview plan={plan} error={error} settling={settling} gitInit={gitInit} onUseSuggestion={(s) => (setName(s), setTouched((t) => ({ ...t, name: true })))}>
              {plan && <div className="hint">{workspace ? `Grouped under ${workspaces.find((w) => w.key === workspace)?.name || workspace}` : 'Its own workspace'} · linked back to {p.name}</div>}
            </PlanPreview>
            <CreateOptions gitInit={gitInit} setGitInit={setGitInit} launch={launch} setLaunch={setLaunch} useAI={useAI} setUseAI={setUseAI} trust={trust} setTrust={setTrust} />
            <ScoutOrigin prefill={prefill} />
          </>
        )}
      </div>
    </Modal>
  );
}
