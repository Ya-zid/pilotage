# Work items, spin-offs, new projects: API contract

Server: `server/routes/work.js` (logic in `server/work/{store,extract,spinoff}.js`, data in `data/work.json`).
Auth/CSRF is the same as every `/api/*` route: paired-device cookie; mutating calls need `X-Pilotage: 1` and
`Content-Type: application/json` (use `api()` from `src/api.ts`, which already does this).
Errors are always `{ error: string, ...extra }` with a 4xx/5xx status.

## Live updates (SSE)

No new SSE event name. The server sends the usual `event: change` with `data: { kinds: string[], gen }`.
Work changes use the kind **`work`**. Spin-off / new-project calls also send `projects` (and `ideas` when an idea
was used). Add this to `KIND_TO_KEYS` in `src/api.ts`:

```ts
work: ['work', 'spinoffs', 'overview', 'project'],
```

The extractor runs by itself (a few seconds after any AI digest/brief lands, at startup, and every 10 minutes), so
`work` events arrive without any user action. Nothing needs polling.

## Types

```ts
type WorkStatus = 'inbox' | 'todo' | 'doing' | 'done' | 'dropped';
type WorkSourceKind = 'ai' | 'brief' | 'user' | 'idea' | 'spinoff';
/** What the AI currently thinks, even for items it is not allowed to move (user-edited ones). */
type AiStatus = 'open' | 'done' | 'abandoned' | 'superseded' | 'removed' | 'stale' | null;

interface WorkItem {
  id: string;                 // 'ai_…' (from sessions/briefs), 'u_…' user, 'i_…' from an idea, 'k_…' spin-off kickoff
  projectId: string;          // same 10-hex id as /api/projects (works even if the folder is not registered)
  projectPath: string;
  projectName: string;
  workspace: string | null;
  title: string;              // short imperative, ≤ 200 chars. AI titles: the AI's 3-7 word to-do (≤ 60 chars), or
                              //   a shortened next step for summaries written before that field existed (≤ ~96)
  detail: string;             // plain text; AI items: the Claude-facing next step (older items may still end with
                              //   "\n\nFrom: “<block title>” — <outcome>" until their source is summarized again)
  who: 'you' | 'claude' | 'waiting' | null; // who does it, as the AI sees it (null = unknown / not from the AI)
  titleBy: 'short' | null;    // 'short': retitled by the one-time cleanup (server/work/retitle.js); never lengthened again
  status: WorkStatus;
  priority: 0 | 1 | 2 | 3;    // 0 low, 1 normal, 2 high, 3 urgent (AI never sets 3)
  source: {
    kind: WorkSourceKind;
    sessionId?: string;       // ai: the session whose latest block raised it (link to /sessions/:id)
    blockKey?: string;        // ai: `${sessionId}:${turnIndex}`
    sessionTitle: string | null;
    step?: number;            // brief: index in brief.nextSteps
    ideaId?: string;          // idea
    spinoffId?: string;       // spinoff
  };
  ai: boolean;                // created by Pilotage (kinds ai | brief | spinoff), not typed by the user
  autoManaged: boolean;       // the extractor may still move it (ai && !userEdited)
  userEdited: boolean;        // set by edits and by Restore (not by moves between open columns); then the AI never changes status/title/detail
  aiStatus: AiStatus;
  closedBy: 'ai' | 'user' | 'expired' | null; // 'ai' and 'expired' = closed automatically (restorable)
  createdAt: number;          // ms epoch, all timestamps
  updatedAt: number;
  sourceAt: number;           // when the evidence was observed (block end / brief time) — use for "3 days ago"
  doneAt: number | null;
  dueAt: number | null;
  startedAt: number | null;
  launches: { launchId: string; at: number; mode: 'terminal' | 'background'; sessionId: string | null }[];
}

interface WorkCounts { inbox: number; todo: number; doing: number; done: number; dropped: number }

interface Spinoff {
  id: string;
  kind: 'spinoff' | 'new';    // 'new' = POST /api/projects/new (no source project)
  from: string | null;        // source project path
  to: string;                 // new folder path
  name: string;
  goal: string;
  sessionId: string | null;   // source session, if one was picked
  threadName: string | null;  // source thread, if one was picked
  ideaId?: string | null;
  createdAt: number;
  fromProjectId: string | null;
  fromName: string | null;
  toProjectId: string;
  toName: string;
  toDisplayPath: string;      // '~/whatsapp-module'
  fromRegistered: boolean;
  toRegistered: boolean;
}

interface LaunchRecord {      // same object /api/launch returns (server/launch.js)
  id: string; mode: 'terminal' | 'background'; cwd: string; name: string;
  state: 'starting' | 'launched' | 'running' | 'ready' | 'error';
  sessionId: string | null; bgId: string | null; bridgeUrl: string | null; error: string | null;
}

interface CreatedProject {
  ok: true;
  project: { id: string; path: string; displayPath: string; name: string; workspace: string | null; registered: boolean };
  claudeMd: { path: string; generatedBy: 'ai' | 'template'; aiError: string | null };
  git: { ok: boolean; error?: string } | null;   // null when gitInit was false
  launch: LaunchRecord | null;                   // null when launch was null; state 'error' does NOT fail the call
  items: WorkItem[];                             // starter tasks created in the new project (status 'todo')
  spinoff: Spinoff;
}
```

## Endpoints

### `GET /api/work?project=&status=&q=&hidden=1&limit=`
- `project`: project id. Omitted = all projects (items of hidden projects excluded unless `hidden=1`).
- `status`: comma list of statuses, or `open` (= inbox,todo,doing), or `all`. **Omitted = open items + items closed
  in the last 14 days.**
- `q`: substring search in title/detail. `limit` default 500, max 2000.
- Sorted: doing → todo → inbox → done → dropped, then priority desc, dueAt asc, newest evidence first.

```ts
→ { items: WorkItem[]; counts: WorkCounts /* for this project filter, ignoring status/q */; lastExtractAt: number }
```

### `POST /api/work`
```ts
body: { projectId: string; title: string; detail?: string; status?: WorkStatus /* default 'todo' */;
        priority?: 0|1|2|3 /* default 1 */; dueAt?: number | string /* ISO date ok */ | null;
        sessionId?: string; fromIdeaId?: string }
→ WorkItem
```
`fromIdeaId` turns an idea into a task: `projectId` may be omitted if the idea has a project, `title` defaults to the
idea text, the idea is marked done (`idea.doneAt`, `idea.workItemId`). Errors: 400 empty title / bad priority /
bad status / bad dueAt, 404 project or idea not found.

### `PATCH /api/work/:id`
```ts
body: Partial<{ title: string; detail: string; status: WorkStatus; priority: 0|1|2|3; dueAt: number | string | null; projectId: string }>
→ WorkItem   // userEdited becomes true, except for a status-only move between open columns
```
Status → `done` sets `doneAt`; → `done`/`dropped` sets `closedBy: 'user'`; back to an open status clears both.

### `DELETE /api/work/:id` → `{ ok: true }`
AI items leave a tombstone so the extractor never recreates them (or a near-identical restatement). Prefer offering
"Drop" (PATCH status `dropped`, restorable) and keep Delete for mistakes.

### `POST /api/work/:id/start`
```ts
body: { mode?: 'terminal' | 'background' /* default: settings pcMode / phoneMode by device */;
        resume?: boolean /* resume the source session instead of a new one */; model?: string }
→ { item: WorkItem; launch: LaunchRecord }
```
Starts a Claude session in the item's project with a prompt built from title + detail, sets status `doing` and
records the launch. It does **not** set `userEdited`: when that launched session's digest later says done, the item
closes itself. Errors: 404, 400 (project gone / source transcript gone with `resume`), 409 (source session already
live with `resume`), 500 (launch failed). Poll `GET /api/launch/:launchId` for the phone link like the New-session dialog.

### `GET /api/spinoffs?project=`
`project` matches either side (`from` or `to`). → `{ spinoffs: Spinoff[] }` newest first.
Use it on the Project page for "Spun off from X" / "Spun off: Y, Z".

### `POST /api/spinoff`
```ts
body: { fromProjectId: string; fromSessionId?: string; threadName?: string /* exact thread name from the project page */;
        name: string; goal?: string /* strongly suggested; a default is derived */; parentDir?: string /* abs or '~/…' */;
        workspace?: string | null /* default: the source's workspace; null/'' = its own */;
        gitInit?: boolean; launch?: 'terminal' | 'background' | null; model?: string;
        useAI?: boolean /* default true; false = deterministic CLAUDE.md, instant */; dryRun?: boolean }
→ CreatedProject
→ (dryRun) { ok: true; dryRun: true; path; displayPath; slug; parent; insideRepo: string | null; workspace; goal;
             source: { projectId; name; session: {id,title} | null; thread: {name,summary} | null; blocks: number; files: number } }
```
- Folder = `parentDir || <folder holding the source's top-level workspace folder>` + `/` + slug(name)
  (e.g. `~/acme/outreach` → `~/whatsapp-module`). Slug is `a-z0-9-`, max 60.
- CLAUDE.md sections: Goal, Background, Relevant files in the source project, Open questions, First steps
  (+ a short working agreement). One Haiku call through the AI queue; if AI is off/busy/fails it falls back to a
  template from the same data (`claudeMd.generatedBy` tells which; `aiError` says why). **The call can take 10–60 s
  with AI** — show progress, and do a `dryRun` first to show the target path.
- Starter tasks go into the new project (`items`). With AI: the first steps; template: one "Plan the first version" task.
- With `launch`, a session starts in the new folder with a kickoff prompt (read CLAUDE.md, summarize the plan, wait for
  the user's go before big changes).
- Errors (all before anything is written): 400 bad name / not inside `$HOME` / `..` / relative path / missing parent /
  forbidden place (`~/.claude`, `~/.ssh`, `~/.config`, Pilotage itself…) / parent inside another git repo without
  `gitInit` / thread not found / session from another project / bad `launch`; 404 project or session; **409 folder
  exists** (case-insensitive) with `{ error, suggestion: 'whatsapp-module-2', existing: '/abs/path' }` — offer the
  suggestion as a one-tap fix.

### `POST /api/projects/new`
```ts
body: { name: string; goal?: string /* required unless fromIdeaId */; workspace?: string /* key, e.g. 'acme' */;
        parentDir?: string /* default ~ */; fromIdeaId?: string; gitInit?: boolean;
        launch?: 'terminal' | 'background' | null; model?: string; useAI?: boolean; dryRun?: boolean }
→ CreatedProject      (dryRun → { ok, dryRun, path, displayPath, slug, parent, insideRepo, workspace, goal, related: string[] })
```
Same safety rules, no source project. With `workspace`, the other projects of that workspace (their briefs) are used
as background, and the new project is grouped under it. With `fromIdeaId`, the idea is marked done and linked
(`idea.projectPath`).

### Overview (`GET /api/overview`) gains
```ts
work: { openCount: number; doingCount: number; todoCount: number; inboxCount: number; lastExtractAt: number;
        topNext: Pick<WorkItem, 'id'|'title'|'status'|'priority'|'projectId'|'projectName'|'ai'|'aiStatus'|'dueAt'|'sourceAt'>[] /* 5 */ }
```

## How items appear and move (UX notes)

- **Zero clicks:** items appear on their own from AI summaries. Per session, only the latest summarized block counts;
  if it is in progress / blocked / ongoing with a next step, that is one item. Each project brief adds its top 2 next
  steps (git-hygiene steps are skipped since Pilotage already shows them as signals). Near-duplicates in a project and
  its parent/child folders (same title, or the same step text) are merged into one item.
- Titles are the AI's short to-do (`digest.todo`, `brief.todos[i]`: 3-7 words, verb first, for the user); the detail is
  the step written for Claude (used as the Start prompt). Steps the AI marks `waiting` (blocked on someone else) never
  make a new item.
- New AI items land in **Inbox** (Suggested). Only sessions active in the last 10 days make new items; at most 3
  untouched suggestions per project stay open (a newer one expires the oldest, `closedBy: 'expired'`), and untouched
  suggestions expire after 7 days. Snoozed, restored and edited ones don't count.
- **One-time cleanup** (`server/work/retitle.js`, state in `work.json` `meta.cleanup`): suggestions from before these
  rules whose source is older than 10 days are dropped (`closedBy: 'ai'`, restorable); the rest get a short title from
  one batched AI call through the engine queue (usage guard, call caps, Settings › AI and `PILOTAGE_NO_AI` apply).
  Rules, doubts and duplicates found by that call are dropped or merged (restorable). It runs once.
- **AI vs user:** `ai: true` → show a small "AI" / sparkle badge and `source.sessionTitle` as a link to the session.
  `source.kind === 'brief'` → "from the project brief". `user`/`idea` items are the user's and are never touched.
- **Auto-moves** (only `autoManaged` items): session reports done → Done (`closedBy: 'ai'`); a newer block in the
  same session moved on (`superseded`), the brief no longer lists it (`removed`), abandoned, or the project was idle
  45 days / marked done/archived (`stale`) → Dropped. A `doing` item only auto-closes on done. If newer work brings
  an AI-closed item back, it reopens. Show `closedBy: 'ai'` items with an "auto" hint and a one-tap Restore (PATCH
  status `todo`).
- **Any edit = ownership.** A PATCH of title, detail, priority, due date or project sets `userEdited`, and so does moving a
  closed item (done/dropped) back to an open column (Restore). Moving between open columns does not. The AI then only updates
  `aiStatus`. Use that as a hint: e.g. a user-edited `todo` item with `aiStatus === 'done'` → "Looks done, mark
  done?" one tap. `superseded`/`removed` → "AI moved on". This keeps clicks low without the AI overriding the user.
- Triage in one tap: Inbox → To do / Drop. Start (▶) = `POST /start`, then show the live session link.
- Spin-off entry points: a session page ("Spin off this work"), a thread on the project page ("Spin off this
  thread"), and an idea ("Make it a project" → `/api/projects/new` with `fromIdeaId`). Prefill `name` from the thread
  or idea, run `dryRun` as the user types to show the target path and 409 suggestions, default `gitInit: true` and
  `launch: 'terminal'` on PC / `'background'` on phone.
- `project.registered: false` means the folder is deeper than the scan depth or in a dot-folder; it still exists and
  appears once a session runs there.
