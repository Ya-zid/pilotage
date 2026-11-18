// Possible projects spotted by the AI scout (docs/SIMPLIFY.md §8, docs/API-SCOUT.md). Used by pages/Ideas.tsx (all
// projects) and the project Overview (compact, one project). A card is the title, a two-line pitch and where it came
// from; the reason (why, evidence, first steps) is one disclosure away, never a score. Actions: Make it a project
// (spin-off / new project dialog, prefilled, with scoutId so the server marks it accepted) and a ⋯ menu with Keep as
// idea · Not a project (with undo).
import React, { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Lightbulb, MoreHorizontal, Telescope, X } from 'lucide-react';
import { ApiError, useProject } from '../../api';
import { scoutSave, scoutSetStatus, useScout } from '../../api-extra';
import type { ScoutCandidate, ScoutKind, ScoutList, ScoutRun } from '../../types-v3';
import { Button, Card, Disclosure, EmptyState, Meta, Modal, ProjectGlyph, Section, Snippet, Spinner, useToast } from '../ui';
import { ago, fmtDateTime, plural } from '../../util';
import { SpinoffDialog } from '../project/SpinoffDialog';
import { NewProjectDialog } from '../project/NewProjectDialog';
import { Menu, TaskUndoToast } from '../tasks/TaskBits';
import { friendly, offerUndo, useMedia } from '../tasks/model';
import './ideas.css';

export interface ScoutCardsProps {
  /** Only this project's candidates (project Overview). Omit for all (Ideas page). */
  projectId?: string;
  /** Compact cards for the project Overview (no section header, max 2). */
  compact?: boolean;
  /** Max open candidates shown before "N more". Default 3 (2 when compact). */
  limit?: number;
  /** Ideas page: show the section with an empty state (and what the scout looked at) when there is nothing open. */
  showEmpty?: boolean;
}

export const SCOUT_KIND: Record<ScoutKind, { label: string; hint: string }> = {
  'spin-off': { label: 'Spin-off', hint: 'Already built (or half built) inside the project; it could live on its own' },
  idea: { label: 'New idea', hint: 'A project you talked about in your sessions but never started' },
  reusable: { label: 'Reusable', hint: 'A piece your other projects could reuse' },
};

const RANK = { high: 0, medium: 0, low: 1 } as const;

/** Open candidates, the "less sure" ones after the others (server order = newest first, kept within each group). */
export function openCandidates(list: ScoutList | undefined, projectId?: string) {
  return (list?.candidates || [])
    .filter((c) => c.status === 'new' && (!projectId || c.projectId === projectId))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => RANK[a.c.confidence] - RANK[b.c.confidence] || a.i - b.i)
    .map((x) => x.c);
}

/** Decisions on a candidate, with optimistic cache updates and an undo for "Not a project". */
function useScoutActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const setLocal = (id: string, status: ScoutCandidate['status']) =>
    qc.setQueriesData<ScoutList>({ queryKey: ['scout'] }, (old) => (old ? { ...old, candidates: old.candidates.map((c) => (c.id === id ? { ...c, status } : c)) } : old));
  const sync = () => ['scout', 'overview', 'ideas'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  return {
    save: async (c: ScoutCandidate) => {
      setLocal(c.id, 'saved');
      try {
        const r = await scoutSave(c.id);
        toast((r as { created?: boolean }).created === false ? 'Already in Your ideas' : 'Saved to Your ideas');
      } catch (e) {
        setLocal(c.id, c.status);
        toast(friendly(e), true);
      } finally {
        sync();
      }
    },
    dismiss: async (c: ScoutCandidate) => {
      setLocal(c.id, 'dismissed');
      try {
        await scoutSetStatus(c.id, 'dismissed');
        offerUndo(`“${c.title}” marked not a project`, async () => {
          setLocal(c.id, 'new');
          try {
            await scoutSetStatus(c.id, 'new');
            toast('Back in Possible projects');
          } catch (e) {
            setLocal(c.id, 'dismissed');
            toast(friendly(e), true);
          } finally {
            sync();
          }
        });
      } catch (e) {
        setLocal(c.id, c.status);
        toast(friendly(e), true);
      } finally {
        sync();
      }
    },
  };
}

// ---------------------------------------------------------------- "Make it a project"

/** Spin-off / reusable → the spin-off dialog of the source project; idea (or a source Pilotage no longer knows) →
 *  the New project dialog. Both prefilled per API-SCOUT.md and sending scoutId. Nothing is created before "Create". */
export function MakeProjectDialog({ c, onClose }: { c: ScoutCandidate; onClose: () => void }) {
  const spin = (c.kind === 'spin-off' || c.kind === 'reusable') && c.registered;
  const { data: p, error, isLoading } = useProject(spin ? c.projectId : undefined);
  const prefill = { name: c.title, goal: c.pitch, thread: c.threadName || undefined, scoutId: c.id };
  if (spin && p) return <SpinoffDialog p={p} prefill={prefill} onClose={onClose} />;
  if (spin && isLoading)
    return (
      <Modal title="Spin off a new project" onClose={onClose}>
        <div className="modal-body scout-loading">
          <Spinner size={18} /> <span className="muted small">Loading {c.projectName}…</span>
        </div>
      </Modal>
    );
  // idea, unknown source, or the source failed to load: a plain new project still works
  return <NewProjectDialog onClose={onClose} defaultWorkspace={c.workspace || ''} prefill={prefill} note={spin && error ? `${c.projectName} couldn’t be loaded, so this starts a fresh project instead of a spin-off.` : undefined} />;
}

// ---------------------------------------------------------------- card

function Evidence({ items }: { items: string[] }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 2);
  return (
    <div className="scout-block">
      <div className="scout-label">Evidence</div>
      <ul className="scout-evidence">
        {shown.map((e, i) => (
          <li key={i}>
            <Snippet text={e} lines={2} />
          </li>
        ))}
      </ul>
      {items.length > 2 && (
        <button type="button" className="scout-more-link" onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : `Show ${items.length - 2} more`}
        </button>
      )}
    </div>
  );
}

function ScoutCard({ c, compact, showSource, onMake }: { c: ScoutCandidate; compact: boolean; showSource: boolean; onMake: () => void }) {
  const { save, dismiss } = useScoutActions();
  const phone = useMedia();
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const kind = SCOUT_KIND[c.kind] || SCOUT_KIND.idea;
  const source = c.registered ? (
    <Link to={`/projects/${c.projectId}`} className="scout-src" title={`Open ${c.projectName}`}>
      <ProjectGlyph name={c.projectName} ws={c.workspace} size={14} />
      <span className="truncate">{c.projectName}</span>
    </Link>
  ) : (
    <span className="scout-src" title={c.displayPath}>
      <ProjectGlyph name={c.projectName} ws={c.workspace} size={14} />
      <span className="truncate">{c.projectName}</span>
    </span>
  );
  const hasMore = !!c.why || c.evidence.length > 0 || c.firstSteps.length > 0;
  return (
    <article className={`scout-card${compact ? ' compact' : ''}`} aria-label={`Possible project: ${c.title}`}>
      <h3 className="scout-title">{c.title}</h3>
      <Snippet text={c.pitch} lines={2} className="scout-pitch" />
      <Meta
        className="scout-meta"
        items={[
          <span className={`scout-kind k-${c.kind}`} title={kind.hint}>
            {kind.label}
          </span>,
          showSource ? source : null,
          c.confidence === 'low' ? <span className="scout-unsure" title="The scout found less evidence for this one">less sure</span> : null,
          <span title={`Spotted ${fmtDateTime(c.at)}`}>{ago(c.at)}</span>,
        ]}
      />
      {hasMore && (
        <Disclosure summary="Why, evidence and first steps" className="scout-fold">
          {c.why && <p className="scout-why">{c.why}</p>}
          <Evidence items={c.evidence} />
          {c.firstSteps.length > 0 && (
            <div className="scout-block">
              <div className="scout-label">First steps</div>
              <ol className="scout-steps">
                {c.firstSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </Disclosure>
      )}
      <div className="scout-actions">
        <Button size="sm" icon={<FolderPlus />} onClick={onMake} title={c.kind === 'idea' ? 'Start a new project from it (you check everything first)' : `Spin it off from ${c.projectName} (you check everything first)`}>
          Make it a project
        </Button>
        <button ref={moreRef} type="button" className="btn sm ghost icon scout-menu-btn" aria-label="More: keep as idea, not a project" aria-haspopup="menu" aria-expanded={menu} title="Keep as idea, Not a project" onClick={() => setMenu(true)}>
          <MoreHorizontal />
        </button>
        {menu && (
          <Menu
            anchor={moreRef.current}
            title={c.title}
            onClose={() => setMenu(false)}
            items={[
              { key: 'save', label: 'Keep as idea', icon: <Lightbulb />, sub: phone ? undefined : 'Saved to Your ideas for later', onSelect: () => save(c) },
              { key: 'dismiss', label: 'Not a project', icon: <X />, sub: phone ? undefined : 'It won’t be suggested again', onSelect: () => dismiss(c) },
            ]}
          />
        )}
      </div>
    </article>
  );
}

/** Projects the scout looked at that gave nothing, with the model's one-line note ("Looked at X; left out because …"). */
function EmptyRuns({ runs }: { runs: ScoutRun[] }) {
  if (!runs.length) return null;
  return (
    <Disclosure summary={<>Nothing to take out of {plural(runs.length, 'other project')}</>} className="scout-runs">
      <ul className="scout-run-list">
        {runs.map((r) => (
          <li key={r.projectId}>
            <span className="medium">{r.projectName}</span> <span className="faint small">· looked {ago(r.at)}</span>
            {r.note && <div className="small muted">{r.note}</div>}
            {r.lastError && <div className="small tone-amber">The last try failed: {r.lastError}</div>}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

export function ScoutCards({ projectId, compact = false, limit, showEmpty = false }: ScoutCardsProps) {
  const { data, error } = useScout(projectId);
  const [expanded, setExpanded] = useState(false);
  const [making, setMaking] = useState<ScoutCandidate | null>(null);
  const open = useMemo(() => openCandidates(data, projectId), [data, projectId]);
  const max = limit ?? (compact ? 2 : 3);
  const shown = expanded ? open : open.slice(0, max);
  const unavailable = error instanceof ApiError && error.status === 404;
  const emptyRuns = (data?.scouted || []).filter((r) => r.candidates === 0 && (!projectId || r.projectId === projectId));

  const dialog = making && <MakeProjectDialog c={making} onClose={() => setMaking(null)} />;
  if (unavailable || (!data && !showEmpty)) return null;

  if (!open.length) {
    if (compact) {
      // one quiet line: what the scout weighed for this project and why it left it out
      const r = emptyRuns[0];
      return r?.note ? (
        <div className="scout-empty-line small muted">
          <Telescope size={14} className="faint" aria-hidden="true" />
          <span>
            No possible projects in {r.projectName}: {r.note}
          </span>
        </div>
      ) : null;
    }
    if (!showEmpty) return null;
    return (
      <Section title="Possible projects">
        <Card>
          <EmptyState
            compact
            icon={<Telescope />}
            title="Nothing stands out yet"
            body="Pilotage looks through your sessions for work that could become its own project, like a bridge you keep rebuilding inside another app. It looks again when there’s new work (every few days at most)."
          />
        </Card>
        <EmptyRuns runs={emptyRuns} />
        {dialog}
      </Section>
    );
  }

  const cards = (
    <>
      <div className={`scout-grid${compact ? ' compact' : ''}`}>
        {shown.map((c) => (
          <ScoutCard key={c.id} c={c} compact={compact} showSource={!projectId} onMake={() => setMaking(c)} />
        ))}
      </div>
      {open.length > max && (
        <button type="button" className="scout-more" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Show fewer' : `Show ${open.length - max} more`}
        </button>
      )}
      {dialog}
      <TaskUndoToast />
    </>
  );
  if (compact) return <div className="scout-cards compact">{cards}</div>;
  return (
    <Section title="Possible projects" count={open.length}>
      <div className="scout-cards">
        {cards}
        {!projectId && <EmptyRuns runs={emptyRuns} />}
      </div>
    </Section>
  );
}
