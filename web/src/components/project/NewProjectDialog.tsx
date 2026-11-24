// "New project": name + goal → dry run shows the exact folder → create → result (CLAUDE.md, starter tasks, launch).
import React, { useState } from 'react';
import { useInvalidate } from '../../api';
import type { CreatedProject } from '../../types-extra';
import { Button, Field, Modal, useToast } from '../ui';
import { CreateOptions, CreateResult, CreatingState, OpenProjectLink, PlanPreview, ScoutOrigin, usePlan, WorkspaceSelect, type CreatePrefill, type LaunchChoice } from './CreateFlow';
import { errMsg, request, useIsPhone, useWorkspaceOptions } from './lib';

export function NewProjectDialog({ onClose, defaultWorkspace = '', prefill, note }: { onClose: () => void; defaultWorkspace?: string; prefill?: CreatePrefill; note?: string }) {
  const phone = useIsPhone();
  const toast = useToast();
  const inv = useInvalidate();
  const workspaces = useWorkspaceOptions();
  const [name, setName] = useState(prefill?.name || '');
  const [goal, setGoal] = useState(prefill?.goal || '');
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [parentDir, setParentDir] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [useAI, setUseAI] = useState(true);
  const [launch, setLaunch] = useState<LaunchChoice>(phone ? 'background' : 'terminal');
  const [trust, setTrust] = useState(false); // never pre-ticked
  const [phase, setPhase] = useState<'form' | 'creating' | 'done'>('form');
  const [result, setResult] = useState<CreatedProject | null>(null);

  // The dry run only checks the folder; the goal is sent with the real call (so typing it doesn't re-check).
  const body = name.trim() ? { name: name.trim(), goal: '-', workspace: workspace || null, parentDir: parentDir.trim() || undefined, gitInit } : null;
  const { plan, error, settling, ready } = usePlan('/api/projects/new', body);
  const wsName = workspaces.find((w) => w.key === workspace)?.name;

  const create = async () => {
    if (!body) return;
    setPhase('creating');
    try {
      const r = await request<CreatedProject>('/api/projects/new', { method: 'POST', body: { ...body, goal: goal.trim(), launch: launch === 'none' ? null : launch, useAI, trust: launch !== 'none' && trust, ...(prefill?.scoutId ? { scoutId: prefill.scoutId } : {}) } });
      setResult(r);
      setPhase('done');
      inv('projects', 'work', 'spinoffs', 'live', 'overview');
    } catch (e) {
      toast(errMsg(e), true);
      setPhase('form');
    }
  };

  const canCreate = ready && !!goal.trim() && phase === 'form';
  return (
    <Modal
      title={phase === 'done' ? 'Project created' : 'New project'}
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
            <Button variant="primary" disabled={!canCreate} onClick={create}>
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
            {note && <div className="hint tone-amber">{note}</div>}
            <Field label="Name" htmlFor="np-name">
              <input id="np-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. WhatsApp module" maxLength={80} autoFocus={!phone} autoComplete="off" />
            </Field>
            <Field label="Goal" htmlFor="np-goal" hint="What should it do? This seeds CLAUDE.md and the first tasks.">
              <textarea id="np-goal" className="textarea" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Send appointment reminders over WhatsApp for the clinics, reusing the SMS queue design." />
            </Field>
            <div className="pj-form-2">
              <Field label="Workspace" htmlFor="np-ws" hint={workspace ? 'Other projects there are used as background.' : undefined}>
                <WorkspaceSelect id="np-ws" value={workspace} onChange={setWorkspace} options={workspaces} />
              </Field>
              <Field label="Parent folder" htmlFor="np-parent">
                <input id="np-parent" className="input mono" value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder="~" autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <PlanPreview plan={plan} error={error} settling={settling} gitInit={gitInit} onUseSuggestion={setName}>
              {plan && (
                <div className="hint">
                  {wsName ? `Grouped under ${wsName}` : 'Its own workspace'}
                  {plan.related && plan.related.length > 0 ? ` · background from ${plan.related.slice(0, 3).join(', ')}${plan.related.length > 3 ? ` and ${plan.related.length - 3} more` : ''}` : ''}
                </div>
              )}
            </PlanPreview>
            <CreateOptions gitInit={gitInit} setGitInit={setGitInit} launch={launch} setLaunch={setLaunch} useAI={useAI} setUseAI={setUseAI} trust={trust} setTrust={setTrust} />
            <ScoutOrigin prefill={prefill} />
          </>
        )}
      </div>
    </Modal>
  );
}
