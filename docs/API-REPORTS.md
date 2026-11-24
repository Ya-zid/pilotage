# Developer reports: API contract

Server: `server/routes/reports.js` (period and text rendering in `server/standup.js`, session markdown in
`server/export.js`, data from `server/views.js`, token counts from `server/sources/sessions.js`). CLI:
`pilotage standup | sessions | resume | export | usage` (`server/cli.js`). The report routes are read-only: built from what
Pilotage already has (the session index in `data/index/`, AI summaries in `data/ai.json`, tasks in `data/work.json`,
running sessions). No AI call, no write.
Auth is the same as every `/api/*` route: a paired device's cookie or the CLI's desktop key (`X-Pilotage-Key`, PC
listener only). Errors are `{ error: string }` with a 4xx status.

## `GET /api/standup?range=&since=&until=&project=`

What was worked on in a period, per project, for a standup or a status update.

| Query | |
| --- | --- |
| `range` | `recent` (default): the previous working day and today so far · `yesterday`: the previous working day only · `today` · `week`: the last 7 days, today included. The previous working day is Friday on a Monday or a weekend (so a Monday `yesterday` covers Friday to Sunday). |
| `since` | `YYYY-MM-DD`: from that local day to now. Overrides `range`. |
| `until` | `YYYY-MM-DD`, with `since`: up to the end of that day. |
| `project` | A project id (10 hex): only that project's work, tasks and sessions. 404 if unknown. |

Days are the PC's local days. A bad date or range is a 400.

```ts
interface Standup {
  from: number; to: number;          // ms, [from, to)
  label: string;                     // "Since Fri 20 Nov", "Yesterday (Tue 24 Nov)", "Last 7 days (since Wed 18 Nov)"
  project: { id: string; name: string } | null;
  projects: {                        // most recently active first; hidden projects and sessions left out
    id: string | null;               // null: sessions outside any known project ("Other folders")
    name: string;
    lastAt: number;
    items: {                         // one per piece of work, oldest first
      title: string;                 // the AI summary's title, else the session title
      status: 'done' | 'in_progress' | 'blocked' | 'abandoned' | 'ongoing' | null;  // null: not summarized yet
      detail: string;                // the summary's outcome (else its summary), plain text, ≤ 240 chars
      next: string;                  // short next step when not done, else ''
      summarized: boolean;
      sessionId: string; sessionTitle: string;
      startAt: number; endAt: number;
      live: boolean;                 // the latest work of a running session
    }[];
  }[];
  doing: Task[]; doingMore: number;  // open tasks, Tasks-page order, at most 8 each (+ how many more)
  todo: Task[]; todoMore: number;
  needsYou: { id: string; title: string; projectId: string | null; projectName: string | null; detail: string; bridgeUrl: string | null }[];
  markdown: string;                  // the same report as markdown, ready to paste (what `pilotage standup --md` prints)
}
interface Task { id: string; title: string; status: 'doing' | 'todo'; priority: number; projectId: string; projectName: string; dueAt: number | null; who: 'you' | 'claude' | 'waiting' | null }
```

Work comes from work blocks (runs of turns without a 4-hour gap) that overlap the period, the same blocks History's
day view shows (`views.blocksBetween`). Automation runs are left out. Blocks of one session without a summary merge
into one line; summaries with the same title in a project merge too (the later one's status and outcome win).
"Needs you" is the web's definition: a terminal session waiting for input or a permission, or a blocked background one.

## Sessions by id prefix: `GET /api/sessions?id=<prefix>`

The usual session list (`views.listSessions`) narrowed to ids that start with `<prefix>`; it combines with the other
filters (`project`, `kind`, `hidden=1`, `limit`). `pilotage resume` and `pilotage export` use it to accept the short
ids `pilotage sessions` prints (8 characters, after a `codex-` / `gemini-` prefix).

## `pilotage resume <project | session id> [--bg] [--model m] ["prompt"]`

No route of its own. The CLI picks the most recent interactive session of the project (matched like `pilotage new`:
exact name, folder or path, else a unique partial match), or the session whose id starts with the argument, then:

- running already (`live` set): prints how to open it (Remote Control link, `claude attach <id>` for a background
  session, its Pilotage page) and exits with status 2, so a prompt given on the command line is never sent to a
  second copy;
- otherwise `POST /api/launch { resumeId, mode, prompt, model? }`: the same validation (known project folder,
  `sanitizeName`, prompt through a file), permission mode and default model as a resume from the web app.
  Gemini sessions are skipped (Gemini CLI can't resume a given session), and `--bg` only picks Claude sessions.

## `GET /api/sessions/:id/export?last=`

The conversation as markdown, for a handoff or a bug report.

```ts
{ id: string; title: string; turns: number; total: number; markdown: string }   // turns exported, of `total` listed
```

- The turns are the ones the session page lists (`views.turns`, system-only turns left out); `last=N` keeps the last N.
- Each turn's prompt and final reply come from the transcript at the turn's stored byte offset (`index.turnDetail`, the
  code behind `GET /api/sessions/:id/turns/:i`), so they are complete up to that code's limits (20 000 characters for
  a prompt, 30 000 for a reply); a turn with no detail on disk uses the indexed text. Slash commands show as typed.
- Tool calls are counted per turn, by tool name, with how many failed; their inputs and outputs are not included.
  Intermediate replies between tool calls are left out; a compaction shows as one line.
- A header gives the project, folder (with `~` for the home folder), branch, session id, tool version, model, period
  and the resume command. The whole text goes through `redact()` again; it is still the user's own code and words,
  so `pilotage export` says to read it before sharing.
- Unknown session: 404. Hidden sessions export too (they are asked for by id).

`pilotage export <id or prefix> [--out FILE] [--last N]` prints it, or writes it to FILE (the CLI writes the file, in
the folder it runs in; the server writes nothing).

## Token usage

### Where it comes from (`server/sources/sessions.js`)

Claude Code writes the API usage of each reply on its assistant lines (`message.usage`: `input_tokens`,
`output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). The indexer adds them up while it parses
(`addUsage`), main conversation only (sidechain lines are skipped, as everywhere else). One reply is written as one
line per content block (thinking, text, each tool call), each repeating the message's usage, so lines with the same
`message.id` count once: each field adds only what it grew by since that message's previous line. Each index entry
(`data/index/sessions.json`, still format 4) gains:

```ts
usage: { in: number; out: number; cw: number; cr: number };   // totals
usageDays: Record<'YYYY-MM-DD', [number, number, number, number]>; // per local day: in, out, cw, cr
usageMsg: { id: string; u: number[] } | null;                   // the last message counted (appends continue it)
```

`outTokens` (shown before as "Output tokens") now equals `usage.out`; it used to count each line of a message again.
Entries written by older versions have no `usage`: each scan, `backfillUsage()` counts up to 128 MB of their
transcripts (newest sessions first) without touching their turns (AI summaries are keyed by turn), and an old entry
that grows first gets its indexed part counted before the new lines. Codex and Gemini sessions have no counts.

### On sessions and projects

`SessionSummary.tokens` (lists, `GET /api/sessions/:id`) and `ProjectSummary.tokens` (`GET /api/projects`, the project
page; all time, the project's sessions with a count):

```ts
type TokenCounts = { input: number; output: number; cacheWrite: number; cacheRead: number; total: number } | null;
// null: another harness, no transcript (history only), or not counted yet
```

The web app shows them as a "Tokens" line on the session page (Details) and the project page (Details).

### `GET /api/usage?days=&since=&until=&project=&top=`

| Query | |
| --- | --- |
| `days` | The last N local days, today included (1 to 800, default 30). |
| `since`, `until` | `YYYY-MM-DD` days instead (inclusive; `until` defaults to today). |
| `project` | A project id: that project only (404 if unknown). |
| `top` | How many top sessions (1 to 50, default 10). |

```ts
{
  label: string;                    // "Wed 18 Nov to Tue 24 Nov"
  fromDay: string; toDay: string;   // YYYY-MM-DD
  totals: TokenCounts;
  days: ({ day: string } & TokenCounts)[];                          // every day of the period, zeros included
  projects: ({ id: string | null; name: string; sessions: number } & TokenCounts)[];  // biggest first
  sessions: ({ id: string; title: string; projectId: string | null; projectName: string | null; lastAt: number; kind: string } & TokenCounts)[];
  pending: number;                  // Claude sessions not counted yet (the backfill after an update)
}
```

Every session counts, automations and hidden ones included (they used the tokens); Pilotage's own AI calls are not
sessions and are left out. `pilotage usage [--week | --days N | --since D [--until D]] [--project NAME] [--top N]`
prints it: totals, a table per project, one bar per day, the top sessions.
