// claude.ai chats in Sessions (assistant "claude.ai") and in search: read-only rows that open the chat in claude.ai.
// Data: GET /api/chats (docs/API-CHATS.md).
import React from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, MessageCircle, SearchX } from 'lucide-react';
import { useChats } from '../../api-extra';
import type { ChatSummary } from '../../types-map';
import { Card, EmptyState, LoadingCard, Meta, Section } from '../ui';
import { ago, fmtDateTime, plural } from '../../util';
import { groupByBucket } from './shared';

export function ChatRow({ c }: { c: ChatSummary }) {
  return (
    <div className="lrow clickable chat-row">
      <a className="lrow-link" href={c.url} target="_blank" rel="noreferrer noopener" aria-label={`${c.name}: open in claude.ai`} />
      <div className="lrow-lead">
        <span className="icon-tile" aria-hidden="true">
          <MessageCircle size={14} />
        </span>
      </div>
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{c.name}</span>
        </div>
        <Meta items={[c.projects.length ? c.projects.map((p) => p.name).join(', ') : null, <span className="num">{plural(c.messages, 'message')}</span>, <span title={fmtDateTime(c.updatedAt)}>{ago(c.updatedAt)}</span>]} />
      </div>
      <div className="lrow-trail">
        <ExternalLink size={15} className="faint" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Sessions with the assistant filter on "claude.ai": the imported chats in date buckets (project filter applies). */
export function ChatsView({ q, project }: { q: string; project: string }) {
  const { data, isLoading, error } = useChats(q.length >= 2 ? q : '', 2000);
  if (isLoading) return <LoadingCard lines={5} />;
  if (error) return <Card><EmptyState title="Couldn’t load the claude.ai chats" body={(error as Error).message} /></Card>;
  const st = data?.status;
  if (!st?.imported)
    return (
      <Card>
        <EmptyState icon={<MessageCircle />} title="No claude.ai chats yet" body="Export your data on claude.ai (Settings → Privacy → Export data), then import the zip in Settings → Sources on the PC." action={<Link className="btn sm" to="/settings#sources">Open Settings</Link>} />
      </Card>
    );
  const list = (data?.chats || []).filter((c) => !project || c.projects.some((p) => p.id === project));
  const groups = groupByBucket(list, (c) => c.updatedAt);
  return (
    <div className="stack-xl ss-groups">
      <div className="hint ss-hint">
        Read-only, from your claude.ai export ({st.importedAt ? ago(st.importedAt) : 'imported'}): each one opens in claude.ai. <Link to="/settings#sources">Import a newer one</Link>
      </div>
      {!list.length ? (
        <Card>
          <EmptyState icon={<SearchX />} title="No chats match" body={q ? `Nothing found for “${q}”.` : 'Nothing with these filters.'} />
        </Card>
      ) : (
        groups.map((g) => (
          <Section key={g.key} title={g.label} count={g.items.length}>
            <Card flush>
              {g.items.map((c) => (
                <ChatRow key={c.uuid} c={c} />
              ))}
            </Card>
          </Section>
        ))
      )}
    </div>
  );
}
