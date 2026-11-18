// Ideas (SIMPLIFY §8): things you might do. Two sections, top to bottom:
//   Possible projects  the AI scout's candidates (components/ideas/ScoutCards), "Look for project ideas" in the header
//   Your ideas         fast capture (phone-first), then turn an idea into a task, a project or a session
// No page subtitle; the daily plan's loose ideas are no longer listed here (they were never kept).
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Lightbulb, ListChecks, MoreHorizontal, Play, Plus, Sparkles, Telescope } from 'lucide-react';
import { api, ApiError, useIdeas, useInvalidate, useProjects } from '../api';
import { scoutRun, useScout } from '../api-extra';
import type { Idea, ProjectSummary } from '../types';
import { Button, EmptyState, ErrorBox, IconButton, Kbd, LoadingCard, Meta, PageHeader, ProjectGlyph, Section, SegmentedControl, StatusIcon, Toolbar, ToolbarSpacer, useToast } from '../components/ui';
import { useApp } from '../components/AppContext';
import { IdeaActions, IdeaSheet } from '../components/ideas/IdeaSheet';
import { NewProjectDialog } from '../components/ideas/NewProjectDialog';
import { ScoutCards } from '../components/ideas/ScoutCards';
import { IdeaX, ProjectSelect, baseName, errMsg, ideaTitle, isMac, looksLikePhone } from '../components/ideas/shared';
import { TaskUndoToast } from '../components/tasks/TaskBits';
import { friendly } from '../components/tasks/model';
import { ago, fmtDateTime, plural } from '../util';
import './Ideas.css';
import '../components/ideas/ideas.css';

type Filter = 'open' | 'done' | 'all';
const NO_PROJECT = '__none__';
const DRAFT_KEY = 'pilotage.ideaDraft';

function readDraft() {
  try {
    return localStorage.getItem(DRAFT_KEY) || '';
  } catch {
    return '';
  }
}
function writeDraft(v: string) {
  try {
    if (v) localStorage.setItem(DRAFT_KEY, v);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** All the things an idea can become, with cache updates + toasts. */
function useIdeaActions(onNewProject: (i: IdeaX) => void): IdeaActions {
  const qc = useQueryClient();
  const inv = useInvalidate();
  const toast = useToast();
  const { openNewSession } = useApp();
  const patchCache = (id: string, fn: (i: Idea) => Idea | null) => qc.setQueryData<Idea[]>(['ideas'], (old) => old?.flatMap((x) => (x.id === id ? (fn(x) ? [fn(x)!] : []) : [x])));
  return {
    start: (idea, project) => openNewSession({ projectId: project?.id, prompt: idea.text, ideaId: idea.id, title: 'Start from an idea' }),
    makeTask: async (idea, projectId) => {
      try {
        await api('/api/work', { method: 'POST', body: { projectId, title: ideaTitle(idea.text), fromIdeaId: idea.id } });
        patchCache(idea.id, (x) => ({ ...x, doneAt: Date.now() }));
        inv('ideas', 'work', 'overview', 'project');
        toast('Added to the project board');
        return true;
      } catch (e) {
        toast(`Couldn't make a task: ${errMsg(e)}`, true);
        return false;
      }
    },
    newProject: onNewProject,
    toggleDone: async (idea) => {
      const done = !idea.doneAt;
      patchCache(idea.id, (x) => ({ ...x, doneAt: done ? Date.now() : null }));
      try {
        await api(`/api/ideas/${idea.id}`, { method: 'PATCH', body: { done } });
        inv('ideas', 'overview');
        toast(done ? 'Marked done' : 'Reopened');
        return true;
      } catch (e) {
        patchCache(idea.id, () => idea);
        toast(`Couldn't update the idea: ${errMsg(e)}`, true);
        return false;
      }
    },
    save: async (idea, body, msg) => {
      try {
        const updated = await api<Idea>(`/api/ideas/${idea.id}`, { method: 'PATCH', body });
        patchCache(idea.id, (x) => ({ ...x, ...updated }));
        inv('ideas', 'overview');
        toast(msg);
        return true;
      } catch (e) {
        toast(`Couldn't update the idea: ${errMsg(e)}`, true);
        return false;
      }
    },
    remove: async (idea) => {
      if (!window.confirm('Delete this idea? This can’t be undone.')) return false;
      try {
        await api(`/api/ideas/${idea.id}`, { method: 'DELETE' });
        patchCache(idea.id, () => null);
        inv('ideas', 'overview');
        toast('Idea deleted');
        return true;
      } catch (e) {
        toast(`Couldn't delete the idea: ${errMsg(e)}`, true);
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------- page
export default function Ideas() {
  const ideasQ = useIdeas();
  const { data: projects } = useProjects();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('open');
  const [projFilter, setProjFilter] = useState('');
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [npIdea, setNpIdea] = useState<IdeaX | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const actions = useIdeaActions(setNpIdea);

  // /ideas?new=1 (palette, Today, phone shortcut) → focus the capture box, then drop the flag from the URL.
  const newParam = params.get('new');
  useEffect(() => {
    if (newParam !== '1') return;
    const t = setTimeout(() => {
      composerRef.current?.focus();
      composerRef.current?.scrollIntoView({ block: 'center' });
      const next = new URLSearchParams(window.location.search);
      next.delete('new');
      setParams(next, { replace: true });
    }, 60);
    return () => clearTimeout(t);
  }, [newParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const byPath = useMemo(() => new Map((projects || []).map((p) => [p.path, p])), [projects]);
  const ideas = (ideasQ.data || []) as IdeaX[];
  const counts = useMemo(() => {
    const done = ideas.filter((i) => i.doneAt).length;
    return { open: ideas.length - done, done, all: ideas.length };
  }, [ideas]);

  const filterProjects = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of ideas) if (i.projectPath && !m.has(i.projectPath)) m.set(i.projectPath, byPath.get(i.projectPath)?.name || baseName(i.projectPath));
    return [...m.entries()].map(([path, name]) => ({ path, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [ideas, byPath]);
  const hasUnassigned = ideas.some((i) => !i.projectPath);
  const pf = projFilter === NO_PROJECT ? (hasUnassigned ? NO_PROJECT : '') : projFilter && !filterProjects.some((p) => p.path === projFilter) ? '' : projFilter;

  const shown = useMemo(() => {
    let list = ideas.filter((i) => (filter === 'open' ? !i.doneAt : filter === 'done' ? !!i.doneAt : true));
    if (pf === NO_PROJECT) list = list.filter((i) => !i.projectPath);
    else if (pf) list = list.filter((i) => i.projectPath === pf);
    if (filter === 'done') return list.slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    if (filter === 'all') return list.slice().sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || b.createdAt - a.createdAt);
    return list.slice().sort((a, b) => b.createdAt - a.createdAt);
  }, [ideas, filter, pf]);

  const sheetIdea = sheetId ? ideas.find((i) => i.id === sheetId) : undefined;

  let empty: { title: string; body: React.ReactNode; action?: React.ReactNode };
  if (ideas.length === 0) empty = { title: 'No ideas yet', body: 'Write one above.' };
  else if (pf)
    empty = {
      title: 'Nothing here',
      body: 'No ideas match this project and filter.',
      action: (
        <Button size="sm" variant="ghost" onClick={() => setProjFilter('')}>
          Show all projects
        </Button>
      ),
    };
  else if (filter === 'open') empty = { title: 'All caught up', body: 'Every idea is done or turned into something. Capture a new one above.' };
  else empty = { title: 'Nothing done yet', body: 'Ideas you finish, or turn into a task or a project, land here.' };

  return (
    <>
      <PageHeader title="Ideas" actions={<LookForProjects />} />

      <ScoutCards showEmpty />

      <Section title="Your ideas" count={counts.open || undefined}>
        <Composer projects={projects} inputRef={composerRef} />

        {ideas.length > 0 && (
        <div className="stack">
          <Toolbar className="idea-toolbar">
            <SegmentedControl
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                {
                  value: 'open',
                  label: (
                    <>
                      Open <span className="num faint">{counts.open}</span>
                    </>
                  ),
                },
                {
                  value: 'done',
                  label: (
                    <>
                      Done <span className="num faint">{counts.done}</span>
                    </>
                  ),
                },
                {
                  value: 'all',
                  label: (
                    <>
                      All <span className="num faint">{counts.all}</span>
                    </>
                  ),
                },
              ]}
            />
            <ToolbarSpacer />
            {(filterProjects.length > 0 || pf) && (
              <select className="select idea-filter" value={pf} onChange={(e) => setProjFilter(e.target.value)} aria-label="Filter by project">
                <option value="">All projects</option>
                {hasUnassigned && <option value={NO_PROJECT}>No project</option>}
                {filterProjects.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Toolbar>

          {ideasQ.error ? (
            <ErrorBox error={ideasQ.error} />
          ) : ideasQ.isLoading ? (
            <LoadingCard lines={4} />
          ) : shown.length === 0 ? (
            <div className="card">
              <EmptyState icon={<Lightbulb />} title={empty.title} body={empty.body} action={empty.action} />
            </div>
          ) : (
            <div className="card idea-list">
              {shown.map((i) => (
                <IdeaRow key={i.id} idea={i} project={i.projectPath ? byPath.get(i.projectPath) : undefined} actions={actions} onOpen={() => setSheetId(i.id)} />
              ))}
            </div>
          )}
        </div>
        )}
        {ideas.length === 0 && ideasQ.error ? <ErrorBox error={ideasQ.error} /> : null}
      </Section>

      <TaskUndoToast />

      {sheetIdea && (
        <IdeaSheet idea={sheetIdea} project={sheetIdea.projectPath ? byPath.get(sheetIdea.projectPath) : undefined} projects={projects} actions={actions} onClose={() => setSheetId(null)} />
      )}
      {npIdea && <NewProjectDialog idea={npIdea} projects={projects} onClose={() => setNpIdea(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- composer
function Composer({ projects, inputRef }: { projects: ProjectSummary[] | undefined; inputRef: React.RefObject<HTMLTextAreaElement> }) {
  const [text, setText] = useState(readDraft);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const inv = useInvalidate();
  const qc = useQueryClient();

  useEffect(() => writeDraft(text), [text]);
  useEffect(() => {
    if (projectId && projects && !projects.some((p) => p.id === projectId)) setProjectId('');
  }, [projects, projectId]);
  // auto-grow
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 260)}px`;
  }, [text, inputRef]);

  const save = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const idea = await api<Idea>('/api/ideas', { method: 'POST', body: { text: t, projectId: projectId || undefined } });
      qc.setQueryData<Idea[]>(['ideas'], (old) => (old ? [idea, ...old.filter((x) => x.id !== idea.id)] : old));
      inv('ideas', 'overview');
      setText('');
      toast('Idea saved');
      inputRef.current?.focus();
    } catch (e) {
      toast(`Couldn't save the idea: ${errMsg(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card idea-composer"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        ref={inputRef}
        className="idea-input"
        rows={2}
        value={text}
        placeholder="What's the idea? A feature, a fix, a whole new project…"
        aria-label="New idea"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="idea-composer-bar">
        <ProjectSelect
          id="idea-new-project"
          className="idea-composer-proj"
          projects={projects}
          value={projectId}
          onChange={setProjectId}
          label="Project for this idea (optional)"
          noneLabel="No project"
        />
        <span className="grow" />
        <span className="hint hide-mobile">
          <Kbd>{isMac ? '⌘' : 'Ctrl'} ↵</Kbd>
        </span>
        <Button type="submit" variant="primary" size="sm" icon={<Plus />} loading={busy} disabled={!text.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- row
function IdeaRow({ idea, project, actions, onOpen }: { idea: IdeaX; project: ProjectSummary | undefined; actions: IdeaActions; onOpen: () => void }) {
  const done = !!idea.doneAt;
  const ai = idea.source === 'ai';
  const [tasking, setTasking] = useState(false);
  return (
    <div className={`lrow clickable idea-row${ai ? ' ai' : ''}${done ? ' done' : ''}`}>
      <button type="button" className="lrow-link idea-hit" onClick={onOpen} aria-label={`Open idea: ${ideaTitle(idea.text, 80)}`} />
      <div className="lrow-lead">
        <button type="button" className="idea-check" onClick={() => actions.toggleDone(idea)} aria-label={done ? 'Reopen idea' : 'Mark idea done'} title={done ? 'Reopen' : 'Mark done'}>
          <StatusIcon status={done ? 'done' : 'todo'} size={16} />
        </button>
      </div>
      <div className="lrow-body">
        <div className="idea-text clamp-2" title={idea.text.length > 160 ? idea.text : undefined}>
          {idea.text}
        </div>
        <Meta
          items={[
            ai ? (
              <span className="idea-ai">
                <Sparkles aria-hidden="true" />
                {idea.scoutId ? 'Possible project' : 'AI suggestion'}
              </span>
            ) : null,
            project ? (
              <>
                <ProjectGlyph name={project.name} ws={project.workspace} color={project.color} size={14} />
                {project.name}
              </>
            ) : idea.projectPath ? (
              <span title={idea.projectPath}>{baseName(idea.projectPath)}</span>
            ) : null,
            <span title={fmtDateTime(idea.createdAt)}>{ago(idea.createdAt)}</span>,
            !ai && looksLikePhone(idea.source) ? 'from your phone' : null,
            idea.workItemId ? 'became a task' : idea.launchedAt ? <span title={fmtDateTime(idea.launchedAt)}>session started</span> : null,
          ]}
        />
      </div>
      <div className="lrow-trail idea-actions">
        <div className="row on-hover hide-mobile" style={{ gap: 2 }}>
          {!done && project && (
            <Button
              size="sm"
              variant="ghost"
              icon={<ListChecks />}
              loading={tasking}
              onClick={async () => {
                setTasking(true);
                await actions.makeTask(idea, project.id);
                setTasking(false);
              }}
              title={`Add to ${project.name}'s board`}
            >
              Task
            </Button>
          )}
          {!done && (
            <Button size="sm" variant="ghost" icon={<Play />} onClick={() => actions.start(idea, project)}>
              Start
            </Button>
          )}
          {!done && <IconButton icon={<Check />} label="Mark done" onClick={() => actions.toggleDone(idea)} />}
        </div>
        <IconButton icon={<MoreHorizontal />} label="All actions" onClick={onOpen} className="hide-mobile" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- header: "Look for project ideas"
/** Runs the scout over every eligible project (POST /api/scout/run). Shows when it last looked, or that it's looking. */
function LookForProjects() {
  const { data, error } = useScout();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (error instanceof ApiError && error.status === 404) return null;
  const pending = Array.isArray(data?.pending) ? data!.pending : [];
  const active = pending.filter((p) => p.state === 'running' || p.state === 'queued');
  const aiOff = data?.settings && !data.settings.enabled;
  const meta = !data
    ? null
    : aiOff
      ? 'AI is off in Settings'
      : active.length
        ? `Looking at ${plural(active.length, 'project')}…`
        : data.lastRunAt
          ? `Last looked ${ago(data.lastRunAt)}`
          : 'Not looked yet';
  const run = async () => {
    setBusy(true);
    try {
      const r = await scoutRun();
      if (r.queued) toast(`Looking at ${plural(r.queued, 'project')}. Possible projects show up here in a few minutes.`);
      else toast((r as { note?: string }).note || 'Nothing new to look at: every project was checked recently.');
    } catch (e) {
      toast(friendly(e), true);
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['scout'] });
    }
  };
  return (
    <div className="idea-scout-head">
      {meta && (
        <span className="faint small" title={data?.lastRunAt ? fmtDateTime(data.lastRunAt) : undefined}>
          {meta}
        </span>
      )}
      <Button icon={<Telescope />} loading={busy} disabled={!!aiOff} onClick={run} title={aiOff ? 'Turn AI on in Settings first' : 'Look through your projects for work that could become its own project'}>
        Look for project ideas
      </Button>
    </div>
  );
}
