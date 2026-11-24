// Worktrees tab: table of the repo's worktrees (merged/open, changes, activity, servers) + copyable cleanup commands.
import React, { useMemo, useState } from 'react';
import { GitBranch, Info, Plus } from 'lucide-react';
import { useApp } from '../AppContext';
import { useBootstrap } from '../../api';
import type { ProjectDetail, Worktree } from '../../types';
import { Callout, Card, CopyButton, EmptyState, IconButton, Meta, PathLabel, SegmentedControl, StatusIcon, WorkStatus } from '../ui';
import { ago, fmtDateTime, plural } from '../../util';

type Filter = 'all' | 'open' | 'merged';

const shq = (p: string) => (/^[\w/.~@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const isClean = (w: Worktree) => !w.dirty && !w.untracked;
const dirOf = (p: string) => p.replace(/\/[^/]+\/?$/, '');

function State({ w }: { w: Worktree }) {
  if (w.missing) return <WorkStatus status="error" label="Folder missing" />;
  if (w.merged) return <WorkStatus status="done" label="Merged" />;
  return <WorkStatus status="in_progress" label="Open" />;
}

/**
 * A dev server's port: a link to it on the PC. On the phone, localhost is the phone itself (the link opened nothing
 * or the wrong thing), so the port is plain text.
 */
export function DevPort({ port, label }: { port: number; label: string }) {
  const { data: boot } = useBootstrap();
  if (boot?.device.viaLan) {
    return (
      <span className="mono small" title={`localhost:${port} on your PC (this phone can't open it)`}>
        {label}
      </span>
    );
  }
  return (
    <a className="link mono small" href={`http://localhost:${port}`} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function Servers({ w }: { w: Worktree }) {
  const ports = w.servers.flatMap((s) => s.ports);
  if (!ports.length) return <span className="fainter">—</span>;
  return (
    <span className="cluster">
      {ports.map((port) => (
        <DevPort key={port} port={port} label={`:${port}`} />
      ))}
    </span>
  );
}

export function WorktreesTab({ p }: { p: ProjectDetail }) {
  const { openNewSession } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const merged = p.worktrees.filter((w) => w.merged && isClean(w) && !w.missing);
  const missing = p.worktrees.filter((w) => w.missing);
  const counts = { all: p.worktrees.length, open: p.worktrees.filter((w) => !w.merged).length, merged: p.worktrees.filter((w) => w.merged).length };
  const list = useMemo(() => p.worktrees.filter((w) => filter === 'all' || (filter === 'merged' ? w.merged : !w.merged)), [p.worktrees, filter]);
  const main = p.gitExtras?.defaultBranch?.replace(/^origin\//, '') || 'main';
  const commands = [
    `# ${plural(merged.length, 'worktree')} merged into ${main} with no local changes. Review, then run:`,
    ...merged.map((w) => `git -C ${shq(p.path)} worktree remove ${shq(w.path)}`),
    ...(missing.length ? [`git -C ${shq(p.path)} worktree prune   # forget ${plural(missing.length, 'missing folder')}`] : []),
  ].join('\n');
  // Most worktrees share one parent folder; only show the folder for the ones that don't.
  const usualDir = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of p.worktrees) m.set(dirOf(w.path), (m.get(dirOf(w.path)) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }, [p.worktrees]);
  const newSession = (w: Worktree) => openNewSession({ projectId: p.id, worktree: w.path, name: w.name });

  if (!p.worktrees.length)
    return (
      <Card>
        <EmptyState icon={<GitBranch />} title="No extra worktrees" body="Worktrees let several sessions work on separate branches of this repo at once. They show up here when Claude or you create them." />
      </Card>
    );
  return (
    <div className="stack-lg">
      {(merged.length > 0 || missing.length > 0) && (
        <Callout tone="neutral" icon={<Info />} title={merged.length ? `${plural(merged.length, 'worktree')} can go` : `${plural(missing.length, 'worktree')} point at missing folders`}>
          <div className="stack">
            <span>{merged.length ? `Merged into ${main}, no local changes.` : 'Git still lists them.'} Pilotage never deletes anything: copy the commands, review them, and run them yourself.</span>
            <div>
              <CopyButton text={commands} label="Copy cleanup commands" />
            </div>
          </div>
        </Callout>
      )}
      <div>
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          label="Show"
          options={[
            { value: 'all', label: <>All <span className="num pj-seg-count">{counts.all}</span></> },
            { value: 'open', label: <>Open <span className="num pj-seg-count">{counts.open}</span></> },
            { value: 'merged', label: <>Merged <span className="num pj-seg-count">{counts.merged}</span></> },
          ]}
        />
      </div>
      {/* desktop: table (scrolls inside its card if the window is narrow) */}
      <div className="card pj-table-card hide-mobile">
        <div className="scroll-x">
          <table className="table pj-wt-table">
            <thead>
              <tr>
                <th>Worktree</th>
                <th>Branch</th>
                <th>State</th>
                <th className="num">Changes</th>
                <th>Last activity</th>
                <th className="num">Sessions</th>
                <th>Servers</th>
                <th>
                  <span className="pj-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.path} className={w.merged && isClean(w) ? 'pj-row-quiet' : ''}>
                  <td className="pj-wt-name">
                    {dirOf(w.path) === usualDir ? (
                      <span className="pj-wt-title" title={w.path}>
                        {w.name}
                      </span>
                    ) : (
                      <PathLabel path={w.path} />
                    )}
                    {w.lastCommitMsg && (
                      <div className="tiny faint clamp-1" title={w.lastCommitMsg}>
                        {w.lastCommitMsg}
                      </div>
                    )}
                  </td>
                  <td className="mono small pj-wt-branch">
                    <span className="truncate" title={w.branch || undefined}>
                      {w.branch || '—'}
                    </span>
                  </td>
                  <td>
                    <State w={w} />
                  </td>
                  <td className="num">
                    {w.dirty + w.untracked ? <span className="tone-amber">±{w.dirty + w.untracked}</span> : <span className="fainter">—</span>}
                    {w.ahead > 0 && <span className="tone-accent"> ↑{w.ahead}</span>}
                  </td>
                  <td className="small" title={fmtDateTime(w.lastAt)}>
                    {w.lastAt ? ago(w.lastAt) : '—'}
                  </td>
                  <td className="num small">{w.sessions || <span className="fainter">—</span>}</td>
                  <td>
                    <Servers w={w} />
                  </td>
                  <td className="pj-wt-act">{!w.missing && <IconButton icon={<Plus />} label={`New session in ${w.name}`} onClick={() => newSession(w)} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {/* phone: rows */}
      <Card flush className="hide-desktop">
        {list.map((w) => (
          <div key={w.path} className="lrow">
            <div className="lrow-lead">
              <StatusIcon status={w.missing ? 'error' : w.merged ? 'done' : 'in_progress'} title={w.missing ? 'Folder missing' : w.merged ? 'Merged' : 'Open'} />
            </div>
            <div className="lrow-body">
              <div className="lrow-title">
                <span className="t">{w.name}</span>
              </div>
              <div className="lrow-sub mono truncate">{w.branch || 'detached'}</div>
              <Meta
                items={[
                  w.missing ? 'Folder missing' : w.merged ? 'Merged' : 'Open',
                  w.dirty + w.untracked ? <span className="tone-amber">±{w.dirty + w.untracked}</span> : null,
                  w.lastAt ? ago(w.lastAt) : null,
                  w.sessions ? plural(w.sessions, 'session') : null,
                  w.servers.length ? <Servers w={w} /> : null,
                ]}
              />
            </div>
            <div className="lrow-trail">{!w.missing && <IconButton icon={<Plus />} label={`New session in ${w.name}`} onClick={() => newSession(w)} />}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}
