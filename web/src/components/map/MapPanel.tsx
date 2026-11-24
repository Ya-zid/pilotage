// The Map's side panel (a bottom sheet on the phone): what the selected node is, its links, and the fitting action.
// Esc closes it; Tab goes through its buttons; a link row selects that node, so the map can be walked by keyboard.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Filter, Focus, Play, RotateCcw, X } from 'lucide-react';
import type { GraphLink, GraphNode, GraphNodeType } from '../../types-map';
import { useApp } from '../AppContext';
import { Button, IconButton, Meta, StatusIcon } from '../ui';
import { ago, fmtDateTime } from '../../util';
import { TYPE_LABEL, TYPE_ORDER, isExternal } from './model';

const SHOW = 6;
const TASK_GLYPH: Record<string, string> = { todo: 'todo', doing: 'in_progress' };

/** The type's mark (same shape and colour as on the map), for chips, link rows and the panel title. */
export function TypeMark({ type }: { type: GraphNodeType }) {
  return <span className={`mp-mark t-${type}`} aria-hidden="true" />;
}

function statusOf(n: GraphNode) {
  if (n.type === 'task') return TASK_GLYPH[n.status || ''] || null;
  if (n.type === 'session' || n.type === 'thread') return n.status || null;
  return null;
}

/** The one action that fits the node, plus a second one where it helps (New session in a project, Resume). */
function Actions({ n }: { n: GraphNode }) {
  const { openNewSession } = useApp();
  if (isExternal(n.href))
    return (
      <a className="btn sm" href={n.href} target="_blank" rel="noreferrer noopener">
        <ExternalLink /> Open in claude.ai
      </a>
    );
  const open: Record<GraphNodeType, string> = {
    workspace: 'Open projects',
    project: 'Open project',
    thread: 'Open workstream',
    topic: 'Find sessions',
    session: 'Open session',
    idea: 'Open ideas',
    task: 'Open task',
    chat: 'Open',
    file: 'Open project',
  };
  const sessionId = n.type === 'session' ? n.id.slice(2) : null;
  return (
    <>
      <Link className="btn sm" to={n.href}>
        {open[n.type]}
      </Link>
      {(n.type === 'project' || n.type === 'thread') && n.projectId && (
        <Button size="sm" variant="ghost" icon={<Play />} onClick={() => openNewSession({ projectId: n.projectId })}>
          New session
        </Button>
      )}
      {sessionId && !n.live && !n.archived && (
        <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => openNewSession({ resumeId: sessionId, projectId: n.projectId })}>
          Resume
        </Button>
      )}
    </>
  );
}

export function MapPanel({
  node,
  links,
  focused,
  onFocus,
  onSelect,
  onClose,
  onProject,
  grabFocus,
}: {
  node: GraphNode;
  links: { node: GraphNode; kind: GraphLink['kind'] }[];
  focused: boolean;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onProject?: (id: string) => void;
  grabFocus: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    setOpen(new Set());
    if (grabFocus) titleRef.current?.focus({ preventScroll: true });
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes the panel, unless a dialog (New session, the palette) is open on top of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.overlay')) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select') && !t.closest('.mp-panel')) return; // the search box clears itself
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const by = new Map<GraphNodeType, GraphNode[]>();
    const seen = new Set<string>();
    for (const l of links) {
      if (seen.has(l.node.id)) continue;
      seen.add(l.node.id);
      if (!by.has(l.node.type)) by.set(l.node.type, []);
      by.get(l.node.type)!.push(l.node);
    }
    for (const list of by.values()) list.sort((a, b) => (b.at || 0) - (a.at || 0) || a.label.localeCompare(b.label));
    return TYPE_ORDER.filter((t) => by.has(t)).map((t) => ({ type: t, nodes: by.get(t)! }));
  }, [links]);

  const st = statusOf(node);
  return (
    <aside className="mp-panel" aria-label={`${TYPE_LABEL[node.type].one}: ${node.label}`}>
      <div className="sheet-grab mp-grab" aria-hidden="true" />
      <div className="mp-panel-head">
        <span className="mp-kind">
          <TypeMark type={node.type} />
          {TYPE_LABEL[node.type].one}
        </span>
        <IconButton icon={<X />} label="Close" onClick={onClose} />
      </div>
      <h2 className="mp-title" ref={titleRef} tabIndex={-1}>
        {st && <StatusIcon status={st} size={15} />}
        <span>{node.label}</span>
      </h2>
      <Meta
        className="mp-meta"
        items={[
          node.sub && node.sub !== node.label ? node.sub : null,
          node.live ? <span className="tone-green">Running</span> : null,
          node.at ? <span title={fmtDateTime(node.at)}>{ago(node.at)}</span> : null,
        ]}
      />
      <div className="mp-actions">
        <Actions n={node} />
      </div>
      <div className="mp-tools">
        <Button size="sm" variant={focused ? 'subtle' : 'ghost'} icon={<Focus />} onClick={onFocus} aria-pressed={focused}>
          {focused ? 'Show everything' : 'Focus on this'}
        </Button>
        {node.type === 'project' && onProject && node.projectId && (
          <Button size="sm" variant="ghost" icon={<Filter />} onClick={() => onProject(node.projectId!)}>
            Only this project
          </Button>
        )}
      </div>
      {groups.length ? (
        <div className="mp-links">
          {groups.map((g) => {
            const all = open.has(g.type);
            const rows = all ? g.nodes : g.nodes.slice(0, SHOW);
            return (
              <section key={g.type} className="mp-group" aria-label={TYPE_LABEL[g.type].many}>
                <h3 className="mp-group-title">
                  {TYPE_LABEL[g.type].many} <span className="count num">{g.nodes.length}</span>
                </h3>
                <ul>
                  {rows.map((n) => (
                    <li key={n.id}>
                      <button type="button" className="mp-link" onClick={() => onSelect(n.id)}>
                        <TypeMark type={n.type} />
                        <span className="mp-link-t truncate">{n.label}</span>
                        {n.at ? <span className="mp-link-at num">{ago(n.at)}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
                {g.nodes.length > SHOW && (
                  <button type="button" className="mp-more" onClick={() => setOpen((s) => new Set(s).add(g.type))} hidden={all}>
                    Show {g.nodes.length - SHOW} more
                  </button>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <p className="mp-none">Nothing linked to it in this view.</p>
      )}
    </aside>
  );
}
