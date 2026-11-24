# The Map: API contract

One graph of the user's work: workspaces, projects, workstreams, topics, sessions, ideas, open tasks, files several
sessions share, and claude.ai chats. It is built only from what Pilotage already holds (the session index, the project
registry, the AI summaries in `data/ai.json`, ideas in `data/state.json`, tasks and spin-offs in `data/work.json`, the
scout's candidates, the claude.ai import): no AI call, no transcript read.

Server: `server/routes/graph.js` (logic in `server/graph.js`). Auth is the same as every `/api/*` route (paired-device
cookie or the CLI's desktop key). Errors are `{ error: string }` with a 4xx status.

## `GET /api/graph?days=90&project=<id>`

| Param | Values | Default |
|---|---|---|
| `days` | `7`, `30`, `90`, `365`, `0` (all time) | `90` |
| `project` | a project id (10 hex) | none: every project |

`400` for another `days` value or a malformed id, `404` for an unknown project.

```ts
type GraphNodeType = 'workspace' | 'project' | 'thread' | 'topic' | 'session' | 'idea' | 'task' | 'chat' | 'file';
interface GraphNode {
  id: string;          // 'ws:<key>' 'p:<projectId>' 't:<hash>' 'topic:<hash>' 's:<sessionId>' 'i:<ideaId>'
                       // 'sc:<candidateId>' (a possible project) 'k:<taskId>' 'c:<chatUuid>' 'f:<hash>'
  type: GraphNodeType;
  label: string;       // display name / title (plain text)
  sub?: string;        // one short line: the project, "3 sessions · 2 projects", "To do", "claude.ai · 12 messages"
  weight: number;      // ≥ 1; sessions in the window (project), prompts (session), sessions (topic, file), blocks (thread)
  href: string;        // where it opens: an app route ('/projects/…', '/sessions/…', '/tasks?open=…', '/ideas'),
                       // or https://claude.ai/chat/<uuid> for a chat
  projectId?: string;  // the project it belongs to (project, thread, session, task, idea)
  at?: number;         // last activity, ms
  status?: string;     // session: its digest status; thread: the workstream status; task: 'todo' | 'doing'
  live?: true;         // session: running now
  archived?: true;     // session: transcript removed by Claude Code (prompts kept), so it can't be resumed
}
interface GraphLink { source: string; target: string; kind: GraphLinkKind }
type GraphLinkKind =
  | 'workspace'  // workspace → project
  | 'thread'     // project → workstream
  | 'session'    // workstream → session (its blocks); project → session when no shown workstream holds it
  | 'topic'      // session → topic; project → topic (2+ of its sessions share it)
  | 'idea'       // idea → project (a saved idea's project; a possible project's source)
  | 'spinoff'    // the project a spin-off came from → the new project
  | 'task'       // task → project
  | 'source'     // task → the session it came from
  | 'edit'       // session → file it edited
  | 'file'       // file → each project whose sessions edited it
  | 'chat';      // claude.ai chat → a project it mentions
interface Graph {
  nodes: GraphNode[];  // ordered: workspaces and projects first, then the most connected and newest
  links: GraphLink[];  // both ends always in `nodes`
  truncated?: { shown: number; total: number; left: Partial<Record<GraphNodeType, number>> };  // only when capped
  days: number;
  at: number;          // when it was built
}
```

What gets on the map:

- **Projects** active in the window, plus quiet ones that hold an open task, an open idea or possible project, or a
  chat from the window. Hidden projects never.
- **Sessions**: interactive ones (no automations, no hidden ones) active in the window, newest first, at most 160.
- **Workstreams**: the project summary's threads with work in the window, at most 8 per project.
- **Topics**: the block digests' `topic`, folded (case, spacing, punctuation, accents), when 2+ sessions share one.
- **Tasks**: To do and Doing only (not Suggested, not done). **Ideas**: saved ideas not done, and possible projects
  the scout found that are still open.
- **Files**: edited by 2+ shown sessions or by sessions of 2+ projects; files in `~/.claude`, `~/.codex`, `~/.gemini`
  (plans, memory) are left out. At most 40.
- **Chats**: claude.ai conversations from the import (see [API-CHATS.md](API-CHATS.md)) updated in the window, linked
  ones first, at most 80.
- With `project`: that project's own nodes and everything they touch (its workspace, a spin-off partner, shared topics
  and files, chats about it).

At most **400 nodes**. When something is left out, `truncated.left` counts it per type (per-type caps included).

Cached in the server's memo; any change broadcast (`sessions`, `projects`, `ai-data`, `work`, `ideas`, `scout`,
`chats`, ...) clears it. The web app maps those kinds to the `graph` query key in `KIND_TO_KEYS`.
