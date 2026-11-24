// Right rail of the Session page (below the conversation on phones): workstreams and PRs when there are any, then one
// folded "Details" card (facts, files edited most, tools, the resume command, more details).
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, GitPullRequest } from 'lucide-react';
import { Card, CopyButton, Disclosure, Meta, PathLabel, compactNum } from '../ui';
import { bytes, fmtDateTime, plural, shortModel, tokenBreakdown } from '../../util';
import type { SessionDetail } from '../../types';
import { HARNESS_LABEL, harnessOf } from './shared';

const FILES_SHOWN = 8;

function prLabel(url: string) {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1], n: `#${m[2]}` } : { repo: url.replace(/^https?:\/\//, ''), n: '' };
}

function Files({ files }: { files: SessionDetail['files'] }) {
  const [all, setAll] = useState(false);
  if (!files.length) return null;
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return (
    <div className="sx-dsec">
      <div className="sx-dsec-h">
        Files edited most <span className="count">{files.length}</span>
      </div>
      <div className="sx-files">
        {shown.map((f) => (
          <div key={f.path} className="sx-file">
            <PathLabel path={f.path} />
            <span className="num faint tiny" title={`${plural(f.n, 'edit')}`}>
              {f.n}
            </span>
          </div>
        ))}
      </div>
      {files.length > FILES_SHOWN && (
        <button type="button" className="more-link sx-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${files.length}`}
        </button>
      )}
    </div>
  );
}

function Facts({ s }: { s: SessionDetail }) {
  const harness = harnessOf(s);
  const models = Object.entries(s.models || {}).sort((a, b) => b[1] - a[1]);
  const toolCalls = s.counts?.toolUse || 0;
  const row = (k: string, v: React.ReactNode) =>
    v === null || v === undefined || v === '' ? null : (
      <React.Fragment key={k}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </React.Fragment>
    );
  return (
    <dl className="kv sx-kv">
      {row('Started', <span className="num">{fmtDateTime(s.startedAt)}</span>)}
      {row('Last activity', <span className="num">{fmtDateTime(s.lastAt)}</span>)}
      {row('Your prompts', s.humanPrompts ? <span className="num">{s.humanPrompts.toLocaleString()}</span> : null)}
      {row('Tool calls', toolCalls ? <span className="num">{toolCalls.toLocaleString()}</span> : null)}
      {s.tokens?.total
        ? row(
            'Tokens',
            <span title={tokenBreakdown(s.tokens)}>
              <span className="num">{compactNum(s.tokens.total)}</span> <span className="tiny faint num">{compactNum(s.tokens.output)} out</span>
            </span>,
          )
        : row('Output tokens', s.outTokens > 0 ? <span className="num" title={s.outTokens.toLocaleString()}>{compactNum(s.outTokens)}</span> : null)}
      {row(models.length > 1 ? 'Models' : 'Model', models.length ? models.map(([m]) => shortModel(m)).join(', ') : null)}
      {row(harness === 'claude' ? 'Claude Code' : HARNESS_LABEL[harness], s.version || null)}
    </dl>
  );
}

function MoreFacts({ s }: { s: SessionDetail }) {
  const row = (k: string, v: React.ReactNode) =>
    v === null || v === undefined || v === '' ? null : (
      <React.Fragment key={k}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </React.Fragment>
    );
  return (
    <dl className="kv sx-kv">
      {row('Folder', <PathLabel path={s.cwd} mono />)}
      {row('Branch', s.branch ? <span className="mono">{s.branch}</span> : null)}
      {row('Compactions', s.compactions > 0 ? <span className="num">{s.compactions}</span> : null)}
      {row('Started from', s.entrypoint || null)}
      {row('Source', s.source)}
      {row('Account', s.account ? <span className="mono">{s.account}</span> : null)}
      {row('Transcript', s.sizeBytes > 0 ? <span className="num">{bytes(s.sizeBytes)}</span> : s.archived ? 'Removed by Claude Code' : null)}
      {row('Session id', <span className="mono tiny break">{s.id}</span>)}
    </dl>
  );
}

export function SessionDetails({ s }: { s: SessionDetail }) {
  const [open, setOpen] = useState(false);
  // An entry equal to the session folder is a tool pointed at the folder itself, not a file.
  const files = s.files.filter((f) => f.path && f.path.replace(/\/+$/, '') !== s.cwd.replace(/\/+$/, ''));
  const tools = s.tools.filter((t) => t.n > 0);
  const toolCalls = s.counts?.toolUse || tools.reduce((n, t) => n + t.n, 0);
  return (
    <div className="sx-rail">
      {s.threads.length > 0 && s.projectId && (
        <Card title="Workstreams" count={s.threads.length} flush>
          {s.threads.map((t) => (
            <Link key={t} to={`/projects/${s.projectId}?workstream=${encodeURIComponent(t)}`} className="sx-link-row" title="Sessions about one goal inside the project, grouped by AI">
              <span className="truncate">{t}</span>
            </Link>
          ))}
        </Card>
      )}

      {s.prs.length > 0 && (
        <Card title="Pull requests" count={s.prs.length} flush>
          {s.prs
            .slice()
            .reverse()
            .map((u) => {
              const pr = prLabel(u);
              return (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="sx-link-row">
                  <GitPullRequest size={14} className="faint" />
                  <span className="truncate">{pr.repo}</span>
                  <span className="num faint">{pr.n}</span>
                </a>
              );
            })}
        </Card>
      )}

      <div className="card sx-fold">
        <button type="button" className="sx-summary-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={16} className="sx-chev" />
          <span className="sx-summary-h">Details</span>
          <span className="tiny faint truncate">{[files.length ? plural(files.length, 'file') : '', toolCalls ? plural(toolCalls, 'tool call') : ''].filter(Boolean).join(' · ')}</span>
        </button>
        {open && (
          <div className="sx-fold-body">
            <Facts s={s} />
            <Files files={files} />
            {tools.length > 0 && (
              <div className="sx-dsec">
                <div className="sx-dsec-h">Tools</div>
                <Meta
                  className="sx-tools"
                  items={tools.map((t) => (
                    <>
                      <span>{t.name}</span>
                      <span className="num">{t.n.toLocaleString()}</span>
                    </>
                  ))}
                />
              </div>
            )}
            <div className="sx-resume">
              <div className="sx-resume-label">Resume in a terminal</div>
              <code className="sx-cmd" title={s.resumeCommand}>
                {s.resumeCommand}
              </code>
              <div className="cluster">
                <CopyButton text={s.resumeCommand} label="Copy command" />
              </div>
            </div>
            <Disclosure summary="More details">
              <MoreFacts s={s} />
            </Disclosure>
          </div>
        )}
      </div>
    </div>
  );
}
