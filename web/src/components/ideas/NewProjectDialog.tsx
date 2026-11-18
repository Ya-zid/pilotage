// "Start a project from this idea": name + goal + workspace, a live dry run that shows the folder it will create,
// then POST /api/projects/new { fromIdeaId }. Nothing is written until "Create project".
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, FolderPlus, GitBranch, Play, Sparkles, TriangleAlert } from 'lucide-react';
import { useInvalidate } from '../../api';
import type { ProjectSummary } from '../../types';
import type { CreatedProject } from '../../types-extra';
import { Button, Disclosure, Field, Modal, Spinner, Switch, useToast } from '../ui';
import { useApp } from '../AppContext';
import { plural } from '../../util';
import { IdeaX, errMsg, postRaw, suggestName } from './shared';

type DryRun = { ok: true; dryRun: true; path: string; displayPath: string; slug: string; parent: string; newParent?: string | null; insideRepo: string | null; workspace: string | null; goal: string; related: string[] };
type Preview = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; d: DryRun } | { state: 'error'; msg: string; suggestion?: string | null };

export function NewProjectDialog({ idea, projects, onClose }: { idea: IdeaX; projects: ProjectSummary[] | undefined; onClose: () => void }) {
  const toast = useToast();
  const inv = useInvalidate();
  const { openNewSession } = useApp();
  const fromProject = idea.projectPath ? projects?.find((p) => p.path === idea.projectPath) : undefined;
  const [name, setName] = useState(() => suggestName(idea.text));
  const [goal, setGoal] = useState(idea.text);
  const [ws, setWs] = useState<string>(fromProject?.workspace || '');
  const [gitInit, setGitInit] = useState(true);
  const [useAI, setUseAI] = useState(true);
  const [parentDir, setParentDir] = useState('');
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const seq = useRef(0);

  const workspaces = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const p of projects || []) {
      if (!p.workspace) continue;
      const w = m.get(p.workspace) || { name: p.workspaceName, n: 0 };
      w.n++;
      m.set(p.workspace, w);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [projects]);

  const body = (dryRun: boolean) => ({
    fromIdeaId: idea.id,
    name: name.trim(),
    goal: goal.trim() || undefined,
    workspace: ws || null,
    parentDir: parentDir.trim() || undefined,
    gitInit,
    useAI,
    launch: null,
    dryRun,
  });

  // Live dry run: shows the exact folder (and catches "already exists") before anything is written.
  useEffect(() => {
    if (created) return;
    if (!name.trim()) {
      setPreview({ state: 'idle' });
      return;
    }
    const n = ++seq.current;
    setPreview((p) => (p.state === 'ok' ? p : { state: 'loading' }));
    const t = setTimeout(async () => {
      try {
        const r = await postRaw<DryRun>('/api/projects/new', body(true));
        if (n !== seq.current) return;
        if (r.ok) setPreview({ state: 'ok', d: r.data });
        else setPreview({ state: 'error', msg: r.data.error || `Error ${r.status}`, suggestion: r.status === 409 ? r.data.suggestion : null });
      } catch (e) {
        if (n === seq.current) setPreview({ state: 'error', msg: errMsg(e) });
      }
    }, 380);
    return () => clearTimeout(t);
  }, [name, goal, ws, gitInit, parentDir, created]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (preview.state !== 'ok' || creating) return;
    setCreating(true);
    try {
      const r = await postRaw<CreatedProject>('/api/projects/new', body(false));
      if (!r.ok) {
        setPreview({ state: 'error', msg: r.data.error || `Error ${r.status}`, suggestion: r.status === 409 ? r.data.suggestion : null });
        return;
      }
      setCreated(r.data);
      inv('ideas', 'projects', 'overview', 'work', 'spinoffs');
      toast(`Created ${r.data.project.displayPath}`);
    } catch (e) {
      toast(`Couldn't create the project: ${errMsg(e)}`, true);
    } finally {
      setCreating(false);
    }
  };

  if (created) {
    const p = created.project;
    return (
      <Modal title="Project created" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <div className="modal-body">
          <div className="launch-state">
            <div className="launch-icon ok">
              <CheckCircle2 size={26} />
            </div>
            <div className="stack-sm">
              <div className="launch-title">{p.name}</div>
              <div className="mono small muted">{p.displayPath}</div>
            </div>
            <ul className="np-done-list small muted">
              <li>
                CLAUDE.md written {created.claudeMd.generatedBy === 'ai' ? 'by AI from your idea' : 'from a template'}
                {created.claudeMd.aiError ? ' (AI was not available)' : ''}
              </li>
              {created.git && <li>{created.git.ok ? 'Git repository created' : `Git init failed: ${created.git.error || 'unknown error'}`}</li>}
              {created.items.length > 0 && <li>{plural(created.items.length, 'starter task')} on its board</li>}
              <li>The idea is marked done and linked to the project</li>
            </ul>
            <div className="cluster np-done-actions">
              <Link className="btn" to={`/projects/${p.id}`} onClick={onClose}>
                <FolderPlus size={15} /> Open project
              </Link>
              <Button
                icon={<Play />}
                onClick={() => {
                  onClose();
                  openNewSession({ projectId: p.id, prompt: 'Read CLAUDE.md, summarize the plan, and wait for my go before big changes.', title: 'First session' });
                }}
              >
                Start first session
              </Button>
            </div>
            {!p.registered && <div className="hint">It shows up in Projects after its first session.</div>}
          </div>
        </div>
      </Modal>
    );
  }

  const nameErr = preview.state === 'error' ? preview : null;
  return (
    <Modal
      wide
      title="Start a project from this idea"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button variant="primary" icon={<FolderPlus />} loading={creating} disabled={preview.state !== 'ok'} onClick={create}>
            {creating ? 'Creating…' : 'Create project'}
          </Button>
        </>
      }
    >
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="np-grid">
          <Field label="Name" htmlFor="np-name" hint="Becomes the folder name.">
            <input id="np-name" className="input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="WhatsApp reminders" />
          </Field>
          <Field label="Workspace" htmlFor="np-ws" hint="Related projects there give Claude background.">
            <select id="np-ws" className="select" value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="">None (stands alone)</option>
              {workspaces.map(([k, w]) => (
                <option key={k} value={k}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Goal" htmlFor="np-goal" hint="What this project should achieve. Claude reads it first.">
          <textarea id="np-goal" className="textarea" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <div className="np-switches">
          <label className="np-switch">
            <span className="np-switch-text">
              <span className="medium row" style={{ gap: 7 }}>
                <GitBranch size={14} className="faint" aria-hidden="true" /> Create a git repository
              </span>
              <span className="hint">Starts version control in the new folder.</span>
            </span>
            <Switch on={gitInit} onChange={setGitInit} label="Create a git repository" />
          </label>
          <label className="np-switch">
            <span className="np-switch-text">
              <span className="medium row" style={{ gap: 7 }}>
                <Sparkles size={14} className="faint" aria-hidden="true" /> Write CLAUDE.md with AI
              </span>
              <span className="hint">A short summary of your idea. Off: a plain template, instantly.</span>
            </span>
            <Switch on={useAI} onChange={setUseAI} label="Write CLAUDE.md with AI" />
          </label>
        </div>
        <Disclosure summary="Folder location">
          <Field label="Create it inside" htmlFor="np-parent" hint="Leave empty for your home folder. Folders that don't exist yet are created.">
            <input id="np-parent" className="input mono" value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder="~" spellCheck={false} autoCapitalize="off" />
          </Field>
        </Disclosure>

        <div className={`np-preview${nameErr ? ' err' : ''}`} aria-live="polite">
          {preview.state === 'idle' ? (
            <span className="faint small">Type a name to see where it goes.</span>
          ) : preview.state === 'loading' ? (
            <span className="row small muted">
              <Spinner size={13} /> Checking the folder…
            </span>
          ) : preview.state === 'error' ? (
            <div className="stack-sm">
              <span className="row small tone-amber" style={{ alignItems: 'flex-start' }}>
                <TriangleAlert size={14} style={{ flex: 'none', marginTop: 2 }} aria-hidden="true" />
                <span>{preview.msg}</span>
              </span>
              {preview.suggestion && (
                <div>
                  <Button size="sm" onClick={() => setName(preview.suggestion!)}>
                    Use “{preview.suggestion}”
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="stack-sm">
              <div className="np-path">
                <FolderPlus size={15} className="faint" aria-hidden="true" />
                <span className="mono">{preview.d.displayPath}</span>
                <span className="tiny faint">{preview.d.newParent ? `new folders from ${preview.d.newParent}` : 'new folder'}</span>
              </div>
              {preview.d.insideRepo && <div className="small tone-amber">Inside the git repo {preview.d.insideRepo}; it gets its own repository.</div>}
              {preview.d.related.length > 0 && (
                <div className="small muted">
                  Background from {preview.d.related.slice(0, 4).join(', ')}
                  {preview.d.related.length > 4 ? ` and ${preview.d.related.length - 4} more` : ''}.
                </div>
              )}
              <div className="hint">Pilotage only creates this folder (with CLAUDE.md and starter tasks). It doesn't touch your other projects.</div>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
