// The Map (GET /api/graph). Contract: docs/API-GRAPH.md.
export type GraphNodeType = 'workspace' | 'project' | 'thread' | 'topic' | 'session' | 'idea' | 'task' | 'chat' | 'file';
export type GraphLinkKind = 'workspace' | 'thread' | 'session' | 'topic' | 'idea' | 'spinoff' | 'task' | 'source' | 'edit' | 'file' | 'chat';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  sub?: string;
  weight: number;
  href: string;
  projectId?: string;
  at?: number;
  status?: string;
  live?: true;
  archived?: true;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: GraphLinkKind;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
  truncated?: { shown: number; total: number; left: Partial<Record<GraphNodeType, number>> };
  days: number;
  at: number;
}

// claude.ai chats (GET /api/chats). Contract: docs/API-CHATS.md.
export interface ChatSummary {
  uuid: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messages: number;
  humanMessages: number;
  firstPrompt: string;
  lastPrompt: string;
  projects: { id: string; name: string }[];
  url: string; // https://claude.ai/chat/<uuid>
}
export interface ChatsStatus {
  imported: boolean;
  count: number;
  importedAt?: number;
  source?: { kind: 'zip' | 'folder' | 'file'; from: string };
  skipped?: number;
  linked?: number;
}
