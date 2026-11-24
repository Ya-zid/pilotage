// The Map's vocabulary and graph helpers (types: src/types-map.ts, contract: docs/API-GRAPH.md).
import type { Graph, GraphLink, GraphNode, GraphNodeType } from '../../types-map';

/** Filter-chip order, and the words for each type (SIMPLIFY.md vocabulary: threads are "workstreams"). */
export const TYPE_ORDER: GraphNodeType[] = ['workspace', 'project', 'thread', 'topic', 'session', 'chat', 'task', 'idea', 'file'];
export const TYPE_LABEL: Record<GraphNodeType, { one: string; many: string }> = {
  workspace: { one: 'Workspace', many: 'Workspaces' },
  project: { one: 'Project', many: 'Projects' },
  thread: { one: 'Workstream', many: 'Workstreams' },
  topic: { one: 'Topic', many: 'Topics' },
  session: { one: 'Session', many: 'Sessions' },
  chat: { one: 'claude.ai chat', many: 'claude.ai chats' },
  task: { one: 'Task', many: 'Tasks' },
  idea: { one: 'Idea', many: 'Ideas' },
  file: { one: 'File', many: 'Files' },
};

/** Period choices (GET /api/graph?days=). 0 = all time. */
export const PERIODS = [
  { value: '7', label: '7 d', title: 'Last 7 days' },
  { value: '30', label: '30 d', title: 'Last 30 days' },
  { value: '90', label: '90 d', title: 'Last 90 days' },
  { value: '365', label: '1 y', title: 'Last 12 months' },
  { value: '0', label: 'All', title: 'All time' },
] as const;
export type Period = (typeof PERIODS)[number]['value'];

export type Adjacency = Map<string, { node: GraphNode; kind: GraphLink['kind'] }[]>;

export function adjacency(g: Graph): Adjacency {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const adj: Adjacency = new Map(g.nodes.map((n) => [n.id, []]));
  for (const l of g.links) {
    const s = byId.get(l.source);
    const t = byId.get(l.target);
    if (!s || !t) continue;
    adj.get(s.id)!.push({ node: t, kind: l.kind });
    adj.get(t.id)!.push({ node: s, kind: l.kind });
  }
  return adj;
}

/** Nodes whose label (or sub line) contains every word of the query, best first: label starts, then label, then sub. */
export function searchNodes(nodes: GraphNode[], q: string): GraphNode[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { n: GraphNode; s: number }[] = [];
  for (const n of nodes) {
    const label = n.label.toLowerCase();
    const all = `${label} ${(n.sub || '').toLowerCase()}`;
    if (!words.every((w) => all.includes(w))) continue;
    const s = label.startsWith(words[0]) ? 0 : words.every((w) => label.includes(w)) ? 1 : 2;
    scored.push({ n, s });
  }
  return scored.sort((a, b) => a.s - b.s || (b.n.weight || 0) - (a.n.weight || 0)).map((x) => x.n);
}

/** "840 sessions, 12 files": what the server left out, in plain words. */
export function leftOut(left: Partial<Record<GraphNodeType, number>>) {
  return TYPE_ORDER.filter((t) => (left[t] || 0) > 0)
    .map((t) => `${left[t]} ${(left[t] === 1 ? TYPE_LABEL[t].one : TYPE_LABEL[t].many).toLowerCase()}`)
    .join(', ');
}

export const isExternal = (href: string) => /^https:\/\//.test(href);
