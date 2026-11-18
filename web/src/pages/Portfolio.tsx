// Portfolio & CV: every project as a CV entry (EN/FR), AI-written from sessions and commits, editable, exportable.
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Briefcase, Download, Search, Sparkles } from 'lucide-react';
import { api, useBootstrap, useInvalidate, usePortfolio } from '../api';
import type { PortfolioOverride, PortfolioProject, ProjectDetail } from '../types';
import {
  Button,
  Callout,
  CopyButton,
  EmptyState,
  ErrorBox,
  LoadingCard,
  PageHeader,
  Progress,
  SegmentedControl,
  Skeleton,
  StatTile,
  Toolbar,
  ToolbarSpacer,
  compactNum,
  useToast,
} from '../components/ui';
import { EntryCard } from '../components/portfolio/EntryCard';
import { EditModal, ExportModal } from '../components/portfolio/Modals';
import { Item, L, Lang, PortfolioData, asLang, buildExport, emptyOverride, entryOf, errMsg, hasCustom, haystack, isIncluded, isReady } from '../components/portfolio/model';
import { fmtMonth, plural } from '../util';
import './Portfolio.css';

/** included / excluded / all = the segmented control; todo = included entries not yet written (from the rail). */
type View = 'included' | 'excluded' | 'todo' | 'all';
type Generated = NonNullable<ProjectDetail['cv']>;

export default function Portfolio() {
  const { data, isLoading, error } = usePortfolio();
  const { data: boot } = useBootstrap();
  const qc = useQueryClient();
  const inv = useInvalidate();
  const toast = useToast();
  const [view, setView] = useState<View>('included');
  const [q, setQ] = useState('');
  const [running, setRunning] = useState<Record<string, number>>({});
  const [editId, setEditId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const lang = asLang(data?.settings.lang);
  const aiOn = boot ? boot.settings.ai.enabled : true;

  const patchCache = (fn: (d: PortfolioData) => PortfolioData) => qc.setQueryData<PortfolioData>(['portfolio'], (old) => (old ? fn(old) : old));
  const patchProjectCache = (id: string, fn: (p: PortfolioProject) => PortfolioProject) => patchCache((d) => ({ ...d, projects: d.projects.map((x) => (x.id === id ? fn(x) : x)) }));

  const setLang = (l: Lang) => {
    if (l === lang) return;
    patchCache((d) => ({ ...d, settings: { ...d.settings, lang: l } }));
    api('/api/portfolio', { method: 'PATCH', body: { lang: l } }).catch((e) => {
      toast(`Couldn't save the language: ${errMsg(e)}`, true);
      inv('portfolio');
    });
  };
  const saveHeader = (header: string) => {
    patchCache((d) => ({ ...d, settings: { ...d.settings, header } }));
    api('/api/portfolio', { method: 'PATCH', body: { header } }).catch((e) => {
      toast(`Couldn't save the intro: ${errMsg(e)}`, true);
      inv('portfolio');
    });
  };
  const saveOverride = async (p: PortfolioProject, next: PortfolioOverride): Promise<boolean> => {
    const prev = p.portfolio;
    patchProjectCache(p.id, (x) => ({ ...x, portfolio: next }));
    try {
      await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { portfolio: next } });
      inv('portfolio', 'project', 'projects');
      return true;
    } catch (e) {
      patchProjectCache(p.id, (x) => ({ ...x, portfolio: prev }));
      toast(`Couldn't save: ${errMsg(e)}`, true);
      return false;
    }
  };
  const toggleInclude = (p: PortfolioProject, on: boolean) => saveOverride(p, { ...emptyOverride(on), ...(p.portfolio || {}), include: on });
  const writeCv = async (p: PortfolioProject) => {
    if (running[p.id]) return;
    setRunning((r) => ({ ...r, [p.id]: Date.now() }));
    try {
      const r = await api<Generated>('/api/ai/cv', { method: 'POST', body: { projectId: p.id, lang } });
      patchProjectCache(p.id, (x) => ({ ...x, generated: r }));
      toast(hasCustom(p.portfolio) ? `New AI entry saved for ${p.name}. Your edits still win; reset them to use it.` : `Entry written for ${p.name}`);
      inv('portfolio');
    } catch (e) {
      toast(`Couldn't write the entry for ${p.name}: ${errMsg(e)}`, true);
    } finally {
      setRunning((r) => {
        const n = { ...r };
        delete n[p.id];
        return n;
      });
    }
  };

  const all = useMemo<Item[]>(() => (data?.projects || []).map((p) => ({ p, e: entryOf(p, lang), inc: isIncluded(p) })).sort((a, b) => b.p.periodEnd - a.p.periodEnd), [data, lang]);
  const included = useMemo(() => all.filter((x) => x.inc), [all]);
  const excluded = useMemo(() => all.filter((x) => !x.inc), [all]);
  const todo = useMemo(() => included.filter((x) => !isReady(x.e.source)), [included]);
  const written = included.length - todo.length;
  const needle = q.trim().toLowerCase();
  const base = view === 'included' ? included : view === 'excluded' ? excluded : view === 'todo' ? todo : all;
  const shown = base.filter((x) => !needle || haystack(x).includes(needle));
  const editing = editId ? all.find((x) => x.p.id === editId)?.p : undefined;

  const stats = useMemo(() => {
    let prompts = 0;
    let commits = 0;
    let since = Infinity;
    const tech = new Map<string, { name: string; n: number }>();
    for (const { p, e } of included) {
      prompts += p.humanPrompts;
      commits += p.commits;
      if (p.periodStart > 0) since = Math.min(since, p.periodStart);
      for (const s of e.stack) {
        const k = s.toLowerCase();
        const t = tech.get(k) || { name: s, n: 0 };
        t.n++;
        tech.set(k, t);
      }
    }
    const topTech = [...tech.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 16);
    return { prompts, commits, since: Number.isFinite(since) ? since : 0, topTech };
  }, [included]);

  const header = (
    <PageHeader
      className="cv-ph"
      title="Portfolio & CV"
      actions={
        data ? (
          <SegmentedControl
            label="CV language"
            value={lang}
            onChange={setLang}
            options={[
              { value: 'en', label: 'English', title: 'Entries and export in English' },
              { value: 'fr', label: 'Français', title: 'Entrées et export en français' },
            ]}
          />
        ) : undefined
      }
    />
  );

  if (isLoading)
    return (
      <>
        {header}
        <div className="grid-stats">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="stat">
              <Skeleton h={12} w="50%" />
              <Skeleton h={26} w="40%" />
            </div>
          ))}
        </div>
        <div className="cv-layout">
          <div className="stack">
            <LoadingCard lines={5} />
            <LoadingCard lines={5} />
          </div>
        </div>
      </>
    );
  if (error || !data)
    return (
      <>
        {header}
        <ErrorBox error={error || 'No data'} />
      </>
    );

  return (
    <>
      {header}

      {all.length === 0 ? (
        <div className="card">
          <EmptyState icon={<Briefcase />} title="No projects yet" body="Projects appear here as soon as Pilotage finds them in your coding history." />
        </div>
      ) : (
        <>
          <div className="grid-stats cv-stats-row">
            <StatTile label="Included" value={<span className="num">{included.length}</span>} hint={`of ${plural(all.length, 'project')}`} />
            <StatTile label="Building since" value={stats.since ? fmtMonth(stats.since, lang) : '—'} hint="earliest work in your CV" />
            <StatTile label="Prompts" value={<span className="num">{compactNum(stats.prompts)}</span>} hint="you wrote, across them" />
            <StatTile label="Commits" value={<span className="num">{compactNum(stats.commits)}</span>} hint="in their repositories" />
          </div>

          {!aiOn && (
            <Callout
              tone="warn"
              icon={<Sparkles />}
              title="AI is off, so entries can't be written for you"
              action={
                <Link className="btn sm" to="/settings#ai">
                  Turn it on
                </Link>
              }
            >
              You can still write and edit entries yourself.
            </Callout>
          )}

          <div className="cv-layout">
            <div className="cv-col">
              <Toolbar className="cv-toolbar">
                <div className="input-wrap">
                  <Search />
                  <input className="input" type="search" placeholder="Search titles, stack, bullets…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search entries" />
                </div>
                <ToolbarSpacer />
                <SegmentedControl
                  label="Show"
                  value={view === 'todo' ? 'included' : view}
                  onChange={setView}
                  options={[
                    {
                      value: 'included',
                      label: (
                        <>
                          Included <span className="num faint">{included.length}</span>
                        </>
                      ),
                    },
                    {
                      value: 'excluded',
                      label: (
                        <>
                          Not included <span className="num faint">{excluded.length}</span>
                        </>
                      ),
                    },
                    {
                      value: 'all',
                      label: (
                        <>
                          All <span className="num faint">{all.length}</span>
                        </>
                      ),
                    },
                  ]}
                />
              </Toolbar>

              {view === 'todo' && (
                <div className="cv-filter-note small muted" role="status">
                  <span>
                    Showing the {plural(todo.length, 'included entry', 'included entries')} not written yet.
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setView('included')}>
                    Show all included
                  </Button>
                </div>
              )}
              {shown.length === 0 ? (
                <div className="card">
                  {needle ? (
                    <EmptyState
                      icon={<Search />}
                      title={`Nothing matches “${q.trim()}”`}
                      action={
                        view !== 'all' ? (
                          <Button size="sm" onClick={() => setView('all')}>
                            Search all projects
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : view === 'todo' ? (
                    <EmptyState icon={<Sparkles />} title="Every entry is written" body="All included projects have an AI-written or edited entry." />
                  ) : view === 'excluded' ? (
                    <EmptyState icon={<Briefcase />} title="Every project is included" body="Switch a project off on its card to leave it out of the CV." />
                  ) : (
                    <EmptyState
                      icon={<Briefcase />}
                      title="Nothing in your CV yet"
                      body="Turn on the projects you want in it."
                      action={
                        <Button size="sm" onClick={() => setView('all')}>
                          Show all projects
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : (
                <div className="cv-list">
                  {shown.map(({ p, e, inc }) => (
                    <EntryCard
                      key={p.id}
                      p={p}
                      e={e}
                      included={inc}
                      lang={lang}
                      aiOn={aiOn}
                      runningSince={running[p.id]}
                      onToggle={(on) => toggleInclude(p, on)}
                      onEdit={() => setEditId(p.id)}
                      onWrite={() => writeCv(p)}
                    />
                  ))}
                </div>
              )}

              <ExportBar items={included} lang={lang} header={data.settings.header || ''} onOpen={() => setExporting(true)} />
            </div>

            <aside className="cv-rail" aria-label="Portfolio summary">
              <div className="card scard-like">
                <div className="cv-rail-head">Written entries</div>
                <Progress value={written} max={Math.max(1, included.length)} tone={todo.length ? 'accent' : 'green'} label="Included entries written by AI or by you" format={() => `${written} of ${included.length}`} />
                <p className="small muted">
                  {included.length === 0
                    ? 'Include a few projects first.'
                    : todo.length === 0
                      ? 'Every included entry is written by AI or by you. Export when you like.'
                      : `${written} of ${plural(included.length, 'included entry', 'included entries')} ${written === 1 ? 'is' : 'are'} written by AI or by you. The other ${todo.length} still show text taken from project summaries or session highlights.`}
                </p>
                {todo.length > 0 && view !== 'todo' && (
                  <Button size="sm" variant="ghost" onClick={() => setView('todo')}>
                    Show the {todo.length} not written yet
                  </Button>
                )}
              </div>
              {stats.topTech.length > 0 && (
                <div className="card scard-like">
                  <div className="cv-rail-head">Technologies</div>
                  <ul className="cv-tech">
                    {stats.topTech.map((t) => (
                      <li key={t.name}>
                        {t.name}
                        {t.n > 1 && <span className="faint num">{t.n}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      {editing && <EditModal p={editing} lang={lang} onClose={() => setEditId(null)} onSave={(o) => saveOverride(editing, o)} />}
      {exporting && <ExportModal items={included} lang={lang} header={data.settings.header || ''} onClose={() => setExporting(false)} onSaveHeader={saveHeader} />}
    </>
  );
}

/** Sticky at the bottom of the list: what will be exported, one-tap copy, and the full export dialog. */
function ExportBar({ items, lang, header, onOpen }: { items: Item[]; lang: Lang; header: string; onOpen: () => void }) {
  const md = useMemo(
    () =>
      buildExport(
        items.map((x) => x.e),
        lang,
        'md',
        header,
      ),
    [items, lang, header],
  );
  const ready = items.filter((x) => isReady(x.e.source)).length;
  return (
    <div className="cv-exportbar" role="region" aria-label="Export">
      <div className="cv-exportbar-text">
        <span className="medium">{plural(items.length, 'entry', 'entries')}</span>
        <span className="faint small">
          {ready} of {items.length} written by AI or you · {L[lang].name}
        </span>
      </div>
      <div className="cv-exportbar-actions">
        <span className="hide-mobile">
          <CopyButton text={md} label="Copy Markdown" />
        </span>
        <Button size="sm" icon={<Download />} onClick={onOpen} disabled={items.length === 0}>
          Export
        </Button>
      </div>
    </div>
  );
}
