// The Tasks page row (To do tab): status glyph · title (two lines at most) · one meta line. One visible action at most
// (Done, on hover on PC); everything else is in the status menu or the task sheet (tap the row).
// Home and Project keep TaskRow (TaskBits.tsx); this is the calmer variant for long lists.
import React from 'react';
import { Check } from 'lucide-react';
import { Meta, ProjectGlyph, StatusIcon } from '../ui';
import type { WorkItem } from '../../types-extra';
import { ago, fmtDateTime } from '../../util';
import { PriorityIcon, StatusButton, TodayChip, WhoTag } from './TaskBits';
import { aiHint, dueInfo, isAutoClosed, useMedia, useTaskActions } from './model';

type ProjLite = { id: string; name: string; workspace: string; color?: string | null };

/** When it happened, in the fewest words: "done 2 d" for closed items, else the age of the evidence. */
function when(it: WorkItem) {
  if ((it.status === 'done' || it.status === 'dropped') && (it.doneAt || it.updatedAt)) {
    const t = it.doneAt || it.updatedAt;
    return { text: ago(t), title: `${it.status === 'done' ? 'Done' : 'Dropped'} ${fmtDateTime(t)}` };
  }
  return { text: ago(it.sourceAt || it.createdAt), title: `Seen ${fmtDateTime(it.sourceAt || it.createdAt)}` };
}

export function TaskLine({ it, project, showProject = true, onOpen }: { it: WorkItem; project?: ProjLite; showProject?: boolean; onOpen: () => void }) {
  const { setStatus } = useTaskActions();
  const phone = useMedia();
  const closed = it.status === 'done' || it.status === 'dropped';
  const due = dueInfo(it.dueAt);
  const hint = aiHint(it);
  const w = when(it);
  return (
    <div className={`lrow task-line clickable${closed ? ' closed' : ''}`}>
      <button type="button" className="lrow-link task-open" aria-label={`Open task: ${it.title}`} onClick={onOpen} />
      <div className="lrow-lead">
        <StatusButton it={it} />
      </div>
      <div className="lrow-body">
        <div className="task-line-title">
          <span className="t">{it.title}</span>
          <PriorityIcon p={it.priority} />
          <TodayChip it={it} />
        </div>
        <Meta
          items={[
            showProject ? (
              <span className="task-proj">
                <ProjectGlyph name={it.projectName} ws={it.workspace ?? project?.workspace} color={project?.color} size={14} />
                <span className="truncate">{it.projectName}</span>
              </span>
            ) : null,
            it.who ? <WhoTag who={it.who} /> : null,
            hint ? (
              <span className={`task-hint ${hint.kind}`} title={hint.kind === 'done' ? 'Your latest session says this is done' : 'The AI no longer lists this'}>
                {hint.label}
              </span>
            ) : null,
            due ? (
              <span className={due.warn ? 'tone-amber' : ''} title={due.title}>
                {due.label}
              </span>
            ) : null,
            isAutoClosed(it) ? <span>{it.closedBy === 'expired' ? 'expired' : 'closed automatically'}</span> : null,
            <span title={w.title}>{w.text}</span>,
          ]}
        />
      </div>
      {!closed && !phone && (
        <div className="task-line-act above hover-only" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn sm ghost" onClick={() => setStatus(it.id, 'done')} title="Mark done" aria-label="Mark done">
            {hint?.kind === 'done' ? <Check /> : <StatusIcon status="done" size={14} title="Done" />}
            Done
          </button>
        </div>
      )}
    </div>
  );
}
