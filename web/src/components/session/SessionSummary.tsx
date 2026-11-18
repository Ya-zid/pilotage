// Summary of a session, one folded card: the AI summaries (latest part of the session first), then Claude's own recap
// as a disclosure inside the same card. Each open part's ⋯ adds its next step as a task (or says it already is one).
import React, { useMemo, useState } from 'react';
import { Check, ChevronRight, CornerDownRight, ListPlus, MoreHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, useInvalidate } from '../../api';
import { ClampText, Disclosure, IconButton, Meta, StatusIcon, useToast } from '../ui';
import { Menu, type MenuEntry } from '../project/Menu';
import { ago, fmtDate, fmtDateTime, plural } from '../../util';
import type { BlockView, SessionDetail } from '../../types';
import type { WorkItem, WorkList } from '../../types-extra';
import { clipWords } from './shared';

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const WORK_LABEL: Record<string, string> = { inbox: 'Suggested', todo: 'To do', doing: 'Doing', done: 'Done', dropped: 'Dropped' };

function blockRange(b: BlockView) {
  const a = fmtDate(b.startAt);
  const z = fmtDate(b.endAt);
  return a === z ? a : `${a} → ${z}`;
}

/** The block's ⋯: add its next step as a task, or say which task it already is. */
function useBlockTask(s: SessionDetail, b: BlockView, existing: WorkItem | undefined): MenuEntry[] {
  const d = b.digest!;
  const toast = useToast();
  const inv = useInvalidate();
  const [added, setAdded] = useState<WorkItem | null>(null);
  const item = added || existing;
  if (!s.projectId || !d.nextStep) return [];
  if (item)
    return [
      {
        label: item.status === 'done' || item.status === 'dropped' ? `Task ${WORK_LABEL[item.status].toLowerCase()}` : `In Tasks · ${WORK_LABEL[item.status] || item.status}`,
        icon: <Check />,
        hint: item.title,
        disabled: true,
        onSelect: () => {},
      },
    ];
  const add = () => {
    const title = clipWords(d.nextStep, 190);
    api<WorkItem>('/api/work', {
      method: 'POST',
      body: { projectId: s.projectId, title, detail: `${title !== d.nextStep ? `${d.nextStep}\n\n` : ''}From “${d.title || b.fallbackTitle}” in the session “${s.title}”.`, sessionId: s.id },
    })
      .then((w) => {
        setAdded(w);
        toast(`Added to ${s.projectName || 'project'} tasks`);
        inv('work', 'overview', 'project');
      })
      .catch((e) => toast(e.message, true));
  };
  return [{ label: 'Add the next step as a task', icon: <ListPlus />, onSelect: add }];
}

function BlockDigest({ s, b, existing, live }: { s: SessionDetail; b: BlockView; existing: WorkItem | undefined; live: boolean }) {
  const d = b.digest!;
  const open = d.status !== 'done' && d.status !== 'abandoned';
  const menu = useBlockTask(s, b, existing);
  return (
    <div className="sx-block">
      <div className="sx-block-lead">
        <StatusIcon status={live ? 'idle_live' : d.status} title={live ? 'Session is running' : undefined} />
      </div>
      <div className="sx-block-body">
        <div className="sx-block-head">
          <div className="sx-block-title">{d.title || b.fallbackTitle}</div>
          {open && menu.length > 0 && (
            <Menu label="Part actions" sheetTitle={d.title || b.fallbackTitle} items={menu} trigger={(t) => <IconButton {...t} icon={<MoreHorizontal />} label="More actions" className="sx-block-menu" />} />
          )}
        </div>
        <Meta items={[<span title={`${fmtDateTime(b.startAt)} → ${fmtDateTime(b.endAt)}`}>{blockRange(b)}</span>, b.prompts > 0 ? plural(b.prompts, 'prompt') : null]} />
        {(d.outcome || d.summary) && (
          <ClampText lines={2} className="sx-block-text">
            {d.outcome || d.summary}
          </ClampText>
        )}
        {d.nextStep && open && (
          <div className="next-step sx-nextline">
            <CornerDownRight size={13} />
            <span className="clamp-2 break">{d.nextStep}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionSummary({ s, collapsible }: { s: SessionDetail; collapsible: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  const [all, setAll] = useState(false);
  const pid = s.projectId;
  const { data: work } = useQuery({ queryKey: ['work', `project=${pid}&status=all`], queryFn: () => api<WorkList>(`/api/work?project=${pid}&status=all`), enabled: !!pid, staleTime: 30_000 });
  const digests = useMemo(() => [...s.blocksDetail].reverse().filter((b) => b.digest), [s.blocksDetail]);
  const undigested = s.blocksDetail.length - digests.length;

  // A task already made from a block (by the AI extractor or by hand) is shown instead of the button.
  const findTask = (b: BlockView) => {
    const items = (work?.items || []).filter((w) => w.source?.sessionId === s.id || w.source?.blockKey === b.key);
    const want = norm(clipWords(b.digest?.nextStep || '', 190));
    return items.find((w) => w.source?.blockKey === b.key) || items.find((w) => norm(w.title) === want || norm(w.detail || '').startsWith(want));
  };

  const shown = all ? digests : digests.slice(0, 4);

  const recap = s.recap ? (
    <Disclosure
      className="sx-recap-d"
      defaultOpen={!digests.length}
      summary={
        <span title={fmtDateTime(s.recapAt)}>
          Claude’s own recap <span className="faint">· {ago(s.recapAt)}</span>
        </span>
      }
    >
      <ClampText lines={6} className="sx-recap-text">
        {s.recap}
      </ClampText>
    </Disclosure>
  ) : null;

  const body = (
    <div className="sx-summary-body">
      {digests.length > 0 ? (
        <div className="sx-blocks">
          {shown.map((b) => (
            <BlockDigest key={b.key} s={s} b={b} existing={findTask(b)} live={!!s.live && b.key === s.blocksDetail[s.blocksDetail.length - 1]?.key} />
          ))}
        </div>
      ) : (
        <div className="small faint sx-nosum">{s.blocksDetail.length ? 'The AI hasn’t summarized this session yet. It does this in the background.' : 'Nothing to summarize yet.'}</div>
      )}
      {(digests.length > 4 || (undigested > 0 && digests.length > 0)) && (
        <div className="sx-summary-foot">
          {digests.length > 4 && (
            <button type="button" className="more-link" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show ${plural(digests.length - 4, 'earlier part')}`}
            </button>
          )}
          {undigested > 0 && digests.length > 0 && <span className="tiny faint">The latest work isn’t summarized yet</span>}
        </div>
      )}
      {recap}
    </div>
  );

  if (collapsible)
    return (
      <div className="card sx-summary">
        <button type="button" className="sx-summary-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={16} className="sx-chev" />
          <span className="sx-summary-h">Summary</span>
          <span className="tiny faint truncate">{digests[0] ? digests[0].digest!.title || digests[0].fallbackTitle : s.recap ? 'Claude’s own recap' : ''}</span>
        </button>
        {open && body}
      </div>
    );

  return (
    <div className="card sx-summary">
      <div className="card-head">
        <h2>Summary</h2>
      </div>
      {body}
    </div>
  );
}
