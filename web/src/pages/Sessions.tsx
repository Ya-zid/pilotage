// Sessions: what's running now (Needs you · Working · Open), then every session in Today · Yesterday · This week · Earlier.
// Absorbs the old Live page (docs/SIMPLIFY.md §5). Filters live in the URL so Back restores them; the running groups
// follow the project and assistant filters only.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Archive, Bot, CalendarDays, Info, MessagesSquare, Search, SearchX, SlidersHorizontal, TriangleAlert, X } from 'lucide-react';
import { api, useLive, useProjects, useSearch } from '../api';
import { useHarnesses } from '../api-extra';
import { Button, Card, Disclosure, Dot, EmptyState, IconButton, LoadingCard, Modal, PageHeader, SegmentedControl, Section, Spinner, StatusIcon, Toolbar, ToolbarSpacer } from '../components/ui';
import { plural } from '../util';
import type { SessionSummary } from '../types';
import { LaunchesSection, RunningGroups } from '../components/session/LiveRows';
import { SessionListRow } from '../components/session/SessionListRow';
import { ARCHIVED_HINT, BUCKET_TITLE, HARNESS_LABEL, KINDS, groupByBucket, harnessOf, useMedia, useTick, type HarnessId, type SessionKind } from '../components/session/shared';
import './Sessions.css';

type HarnessFilter = 'all' | HarnessId;
const STEP = 100;

/** The row glyphs, in the order a list shows them: running states first, then the AI summary's status of past work. */
const LEGEND: { icon: React.ReactNode; label: string; text: string }[] = [
  { icon: <StatusIcon status="needs-you" />, label: 'Needs you', text: 'Running and waiting for your answer.' },
  { icon: <StatusIcon status="working" />, label: 'Working', text: 'Claude is working on it right now.' },
  { icon: <StatusIcon status="idle_live" />, label: 'Open', text: 'Still running, but idle.' },
  { icon: <StatusIcon status="in_progress" />, label: 'In progress', text: 'Not running. Its summary said the work wasn’t finished.' },
  { icon: <StatusIcon status="blocked" />, label: 'Blocked', text: 'Its summary said it was stuck on something.' },
  { icon: <StatusIcon status="done" />, label: 'Done', text: 'Its summary said the work was finished.' },
  { icon: <StatusIcon status="abandoned" />, label: 'Dropped', text: 'Its summary said the work was given up.' },
  { icon: <Bot size={14} className="faint" />, label: 'Automation', text: 'A run Claude started by itself (no summary).' },
  { icon: <Archive size={14} className="faint" />, label: 'Archived', text: 'Transcript removed by Claude Code, prompts kept.' },
  { icon: <Dot />, label: 'No summary yet', text: 'The AI hasn’t summarised it.' },
];

function Legend({ onClose }: { onClose: () => void }) {
  return (
    <Card className="ss-legend" pad>
      <div className="ss-legend-head">
        <h2 className="ss-legend-title">What the icons mean</h2>
        <button type="button" className="btn ghost icon sm" onClick={onClose} aria-label="Close the icon legend">
          <X size={16} />
        </button>
      </div>
      <dl className="ss-legend-list">
        {LEGEND.map((l) => (
          <div key={l.label} className="ss-legend-item">
            <dt>
              <span className="ss-legend-ico" aria-hidden="true">
                {l.icon}
              </span>
              {l.label}
            </dt>
            <dd>{l.text}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

export default function Sessions() {
  useTick(30_000);
  const [params, setParams] = useSearchParams();
  const phone = useMedia();
  const kind = (KINDS.some((k) => k.value === params.get('kind')) ? params.get('kind') : 'interactive') as SessionKind;
  const project = params.get('project') || '';
  const harness = (['claude', 'codex', 'gemini'].includes(params.get('harness') || '') ? params.get('harness') : 'all') as HarnessFilter;
  const [q, setQ] = useState(params.get('q') || '');
  const qd = useDebounced(q.trim(), 250);
  const [limit, setLimit] = useState(STEP);
  const [sheet, setSheet] = useState(false); // phone: the Filters sheet
  const [legend, setLegend] = useState(false);

  const set = (k: string, v: string, def = '') =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (!v || v === def) n.delete(k);
        else n.set(k, v);
        return n;
      },
      { replace: true },
    );
  useEffect(() => set('q', qd), [qd]);
  useEffect(() => setLimit(STEP), [kind, project, qd]);

  const { data: projects } = useProjects();
  const { data: harnesses } = useHarnesses();
  const live = useLive();
  const others = (harnesses?.harnesses || []).filter((h) => h.id !== 'claude' && h.sessions > 0);
  const showHarness = others.length > 0 || harness !== 'all';

  const qs = new URLSearchParams({ limit: String(limit) });
  if (kind !== 'all') qs.set('kind', kind);
  if (project) qs.set('project', project);
  if (qd.length >= 2) qs.set('q', qd);
  const { data, error, isLoading, isFetching, refetch, isPlaceholderData } = useQuery({
    queryKey: ['sessions', `page:${qs.toString()}`],
    queryFn: () => api<{ sessions: SessionSummary[] }>(`/api/sessions?${qs.toString()}`).then((r) => r.sessions),
    placeholderData: keepPreviousData,
  });

  // Running sessions: only the project and assistant filters apply (SIMPLIFY.md §5).
  const running = useMemo(() => (live.data?.live || []).filter((s) => (!project || s.projectId === project) && (harness === 'all' || harnessOf(s) === harness)), [live.data, project, harness]);
  const launches = useMemo(() => (project ? [] : live.data?.launches || []), [live.data, project]);
  const runningIds = useMemo(() => new Set(running.map((s) => s.id)), [running]);

  // Prompts deep inside a conversation are only found by the full search.
  const deep = useSearch(qd);
  const keep = (s: SessionSummary) => (harness === 'all' || harnessOf(s) === harness) && (kind === 'all' || s.kind === kind) && (!project || s.projectId === project) && !s.hidden;

  // Running sessions are already in the groups above, so the list leaves them out.
  const list = useMemo(() => (data || []).filter((s) => keep(s) && !runningIds.has(s.id)), [data, harness, kind, project, runningIds]);
  const groups = useMemo(() => groupByBucket(list, (s) => s.lastAt), [list]);
  const extra = useMemo(() => {
    if (qd.length < 2) return [];
    const have = new Set(list.map((s) => s.id));
    return (deep.data?.sessions || []).filter((s) => !have.has(s.id) && !runningIds.has(s.id) && keep(s));
  }, [deep.data, list, qd, runningIds]);

  const canMore = !!data && data.length >= limit;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && !isFetching && setLimit((l) => l + STEP), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [canMore, isFetching, data]);

  const filtered = kind !== 'interactive' || !!project || harness !== 'all' || qd.length > 0;
  const clear = () => {
    setQ('');
    setParams(new URLSearchParams(), { replace: true });
  };
  const projectOptions = (projects || []).filter((p) => p.sessionCount > 0).sort((a, b) => a.name.localeCompare(b.name));

  const search = (
    <div className="input-wrap ss-search">
      <Search />
      <input className="input" type="search" placeholder="Search sessions…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sessions" />
      {isFetching && qd.length >= 2 && (
        <span className="ss-search-spin">
          <Spinner size={14} />
        </span>
      )}
    </div>
  );
  const kindSeg = <SegmentedControl value={kind} onChange={(v) => set('kind', v, 'interactive')} options={KINDS.map((k) => ({ value: k.value, label: k.label, title: k.title }))} label="Session type" block={phone} />;
  // the filters behind the phone "Filters" button (search stays outside it)
  const nFilters = [kind !== 'interactive', !!project, harness !== 'all'].filter(Boolean).length;
  const clearSheet = () =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete('kind');
        n.delete('project');
        n.delete('harness');
        return n;
      },
      { replace: true },
    );
  const projectSel = (
    <select className="select ss-select" value={project} onChange={(e) => set('project', e.target.value)} aria-label="Project">
      <option value="">All projects</option>
      {projectOptions.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  const harnessSel = showHarness ? (
    <select className="select ss-select" value={harness} onChange={(e) => set('harness', e.target.value, 'all')} aria-label="Assistant">
      <option value="all">All assistants</option>
      {(['claude', 'codex', 'gemini'] as const)
        .filter((h) => h === 'claude' || others.some((o) => o.id === h) || harness === h)
        .map((h) => (
          <option key={h} value={h}>
            {HARNESS_LABEL[h]}
          </option>
        ))}
    </select>
  ) : null;

  const nothingAtAll = !isLoading && !error && !list.length && !extra.length;
  // "Earlier" folds unless it's all there is or a search is narrowing the list; "Load more" then lives inside it
  // (a folded body is hidden, so the infinite-scroll sentinel doesn't fire behind the fold).
  const earlierFolded = !qd && groups.length > 1 && groups.some((g) => g.key === 'earlier');
  const more = canMore ? (
    <div className="ss-more" ref={sentinel}>
      <Button loading={isFetching} onClick={() => setLimit((l) => l + STEP)}>
        Load more
      </Button>
    </div>
  ) : null;
  const history = (
    <Link className={`btn ghost${phone ? ' sm' : ''} ss-history`} to="/history">
      <CalendarDays /> History
    </Link>
  );
  return (
    <>
      <PageHeader
        title="Sessions"
        status={
          <IconButton icon={<Info />} label="What the icons mean" onClick={() => setLegend((v) => !v)} aria-expanded={legend} className={`ss-info${legend ? ' on' : ''}`} />
        }
        actions={phone ? undefined : history}
      >
        {legend && <Legend onClose={() => setLegend(false)} />}
      </PageHeader>

      {running.length > 0 && <RunningGroups live={running} />}
      <LaunchesSection launches={launches} />

      {phone ? (
        <div className="ss-filters">
          {search}
          <Button variant={nFilters ? 'subtle' : 'secondary'} icon={<SlidersHorizontal />} onClick={() => setSheet(true)} aria-haspopup="dialog" className="ss-filter-btn">
            {nFilters ? `Filters · ${nFilters}` : 'Filters'}
          </Button>
          {sheet && (
            <Modal
              title="Filters"
              onClose={() => setSheet(false)}
              className="ss-sheet"
              footer={
                <>
                  {nFilters > 0 && (
                    <Button variant="ghost" icon={<X />} onClick={clearSheet}>
                      Clear filters
                    </Button>
                  )}
                  <Button variant="primary" onClick={() => setSheet(false)}>
                    Done
                  </Button>
                </>
              }
            >
              <div className="modal-body">
                <div className="ss-sheet-field">
                  <span className="ss-sheet-label">Kind</span>
                  <div className="ss-scroll">{kindSeg}</div>
                </div>
                <label className="ss-sheet-field">
                  <span className="ss-sheet-label">Project</span>
                  {projectSel}
                </label>
                {harnessSel && (
                  <label className="ss-sheet-field">
                    <span className="ss-sheet-label">Assistant</span>
                    {harnessSel}
                  </label>
                )}
              </div>
            </Modal>
          )}
        </div>
      ) : (
        <Toolbar className="ss-toolbar">
          {search}
          {projectSel}
          {harnessSel}
          <ToolbarSpacer />
          {kindSeg}
        </Toolbar>
      )}

      {kind === 'archived' && <div className="hint ss-hint">{ARCHIVED_HINT}</div>}

      {isLoading ? (
        <div className="stack-lg">
          <LoadingCard lines={5} />
          <LoadingCard lines={4} />
        </div>
      ) : error ? (
        <Card>
          <EmptyState icon={<TriangleAlert />} title="Couldn’t load sessions" body={(error as Error).message} action={<Button size="sm" onClick={() => refetch()}>Try again</Button>} />
        </Card>
      ) : nothingAtAll ? (
        <Card>
          {filtered ? (
            <EmptyState icon={<SearchX />} title="No sessions match" body={qd ? `Nothing found for “${qd}” with these filters.` : 'Nothing with these filters.'} action={<Button size="sm" onClick={clear}>Clear filters</Button>} />
          ) : running.length ? (
            <EmptyState compact title="Nothing else yet" body="Only the running sessions above so far." />
          ) : (
            <EmptyState icon={<MessagesSquare />} title="No sessions yet" body="Start one with New session. Sessions you run in a terminal appear here too." />
          )}
        </Card>
      ) : (
        <div className={`stack-xl ss-groups${isPlaceholderData && isFetching ? ' ss-stale' : ''}`}>
          {groups.map((g) => {
            const rows = (
              <Card flush>
                {g.items.map((s) => (
                  <SessionListRow key={s.id} s={s} showProject={!project} when={g.key === 'today' || g.key === 'yesterday' ? 'time' : g.key === 'week' ? 'ago' : 'date'} />
                ))}
              </Card>
            );
            if (g.key === 'earlier' && earlierFolded)
              return (
                <Disclosure
                  key={g.key}
                  className="ss-earlier"
                  summary={
                    <span className="ss-earlier-sum">
                      Earlier <span className="count">{canMore ? `${g.items.length}+` : g.items.length}</span>
                    </span>
                  }
                >
                  {rows}
                  {more}
                </Disclosure>
              );
            return (
              <Section key={g.key} title={<span title={BUCKET_TITLE[g.key] || undefined}>{g.label}</span>} count={g.items.length}>
                {rows}
              </Section>
            );
          })}
          {extra.length > 0 && (
            <Section title="Found inside conversations" count={extra.length}>
              <Card flush>
                {extra.map((s) => (
                  <SessionListRow key={s.id} s={s} showProject={!project} when="date" />
                ))}
              </Card>
            </Section>
          )}
          {!earlierFolded && more}
          {!canMore && list.length > 20 && (
            <div className="ss-end tiny faint">
              {running.length ? `${plural(list.length, 'session')} here, plus ${running.length} running above. That’s all of them.` : `${plural(list.length, 'session')}, that’s all of them`}
            </div>
          )}
        </div>
      )}
    </>
  );
}
