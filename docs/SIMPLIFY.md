# Pilotage v3: simpler, one model, fewer places

User feedback, 2026-11-15: "it's still kind of messy… I don't fully understand it." A fresh-eyes test (screenshots only) and a
research pass (Linear, Things, Sunsama, GitHub dashboard, Claude Code agent view, Cursor, NN/g) agree on the cause:
**the same four objects appear in 4–6 places under different names**, and Home tries to show everything.
This document is the contract for the v3 UI pass. DESIGN.md (visual language) still applies.

**v4, the calm pass (2026-11-18).** Next feedback: "hard to look at and it's all just text… make it more high level,
easier on the eye and more organized… the tasks, I never read them, they're long." Causes found: ~300 words on the first
Home screen (mostly grey), 12–17 buttons per screen, the user's own prompts quoted back in rows, dashed frames and
boxes in boxes, and tasks written as Claude's working instructions (0 of 306 AI suggestions ever kept). v4 keeps the
model below and changes how it looks: first glance = state (counts, status dots, project glyphs, short titles); one
title + one meta line per row; one visible action per row; short tasks in the user's words. DESIGN.md §2 has the rules;
the sections below are updated to v4.

## 1. The model (show it, name it the same everywhere)

| Object | One line (reuse as page subtitle / empty state) |
|---|---|
| **Project** | A repo or folder you work in. |
| **Session** | One conversation with Claude Code, Codex or Gemini. |
| **Workstream** | Sessions about one goal inside a project, grouped by AI. |
| **Task** | Something you've decided to do. AI suggests tasks from your sessions; you keep or dismiss them. |
| **Idea** | Something you might do, including possible new projects the AI spotted in your work. |

Rules:
- Every list is a **view of one state**. A task is in exactly one of: Suggested · To do · Doing · Done (+ Dropped).
  "Today" is a flag on To do / Doing tasks, not another list.
- **Machine input is kept apart from commitments.** AI suggestions live in *Suggested* (tasks) and *Possible projects*
  (ideas). They never fill Home.
- **Show the reason, not a score.** Every AI item can show where it came from (project + session + a quote/summary) and
  links to it; v4 shows it on tap (task sheet, expanded row), not in the list. No confidence percentages.
- **Home is for acting.** Stats, feeds and history go to History / Portfolio.

## 2. Vocabulary (old → new). Use the new words in UI text, aria labels, palette, empty states, toasts.

| Old | New |
|---|---|
| Today (page/nav) | **Home** (route stays `/`) |
| Live / Live now / Now / running | **Running** (state groups: **Needs you** · **Working** · **Open** (idle)) |
| Today's focus / Next up / Planned | **Today** (≤3 tasks you picked; AI proposes) |
| Tasks › Inbox / "new in the inbox" | **Suggested** |
| Needs attention / things slipping / things to watch / "Left in progress N days ago" | **Gone quiet** tag inside **Pick up** |
| Pick up where you left off | **Pick up** |
| Brief / Project brief | **Summary** |
| Threads | **Workstreams** |
| Work block / "N work blocks" | never shown; show a date range or a session count |
| Daily brief (Settings) | **Today's plan** |
| Timeline | **History** |
| Spin-off candidates / scout | **Possible projects** |
| Prompts only (session kind) | **Archived** (hint: transcript removed by Claude Code, prompts kept) |
| Automated / automation runs | **Automations** (one word everywhere) |
| This week (usage) / 5-hour window | **Weekly limit** / **5-hour limit** |
| Portfolio: In CV / Drafts | **Included** / **Not included** |
| Sidebar "Workspaces" list | **Recent projects** (v4) |
| Home "Working" + "N more sessions open (idle)" | **Running** (v4: working and open in one list) |

Status colours: Needs you = amber, Working = accent (animated dot), Open/idle = grey (not green), Done = muted green.

## 3. Navigation (v4)

Desktop sidebar, primary: **Home · Sessions · Projects · Tasks**. Then **Recent projects**: the 5 most recently active
projects (running first), each with its glyph + running dot; click opens the project, ▶ on hover = New session there;
an "All projects" link. Secondary (bottom of sidebar, small): **Ideas** (new possible projects count), History,
Portfolio & CV, Settings, How Pilotage works. Usage meters stay in the sidebar footer, labelled "5-hour limit" /
"Weekly limit".
Badges: Sessions = Needs-you count (amber) else Working count; Tasks = To do + Doing (never Suggested).

Phone tab bar: **Home · Sessions · ＋ · Projects · More**. ＋ is a capture sheet (New session · Add task · Capture idea),
using the current project when on a project/session page. More = Tasks, Ideas, History, Portfolio & CV, Settings,
How Pilotage works, usage; the More tab shows a count pip when tasks are planned for today or in Doing.

Routes: `/live` → redirect `/sessions`; `/timeline` → redirect `/history`. `/guide` = How Pilotage works.

## 4. Home (v4; top to bottom, every section hides when empty)

1. Header: date + greeting only. No AI headline, no "Updated · Refresh" (Today's plan refreshes by itself).
2. **Pulse tiles** (links): Working N (accent) · Needs you N (amber only when > 0) · Today done/planned · To do N.
   Phone: four compact tiles in one row.
3. Phone-setup banner (PC, until a phone is paired) and the catching-up pill, as before.
4. **Needs you**: sessions waiting for an answer. Row: glyph + amber badge, title, Claude's question (one line),
   project · waiting N min; one visible button "Open in Claude app" ("Open" on phone).
5. **Running**: working then open (idle) sessions, one line each (glyph + badge, title, project · time). No quoted
   prompt, no live detail. One icon action (Open in Claude app) on hover on PC, a small icon on phone. More than six:
   the rest behind "+N open" → Sessions.
6. **Today**: only tasks the user picked. Otherwise one line "Claude suggests 3 for today ›" that unfolds in place; a
   suggestion row = glyph + short title, **＋ Today** and ⋯ (Start a session, Not today); the "why" shows only when the
   row is tapped. Nothing at all: "Nothing planned. Pick from Tasks".
7. **Pick up** (≤5): title + project · age (or "Gone quiet 12 d"); badge only for blocked / done / dropped. Resume + ⋯
   (Not now) on hover on PC; ⋯ on phone; tapping the row opens the session. No next-step line.

Removed from Home (v4): the AI headline, the footer of counts ("14 suggested tasks · …"; those live on Tasks, Ideas and
Sessions), dashed proposal frames, the per-row Start / Not today buttons.

## 5. Sessions (absorbs Live)

Header: "Sessions" + ⓘ (what the icons mean) + "History" link. No subtitle (v4).
Top groups (only when not empty, not affected by filters except project/assistant): **Needs you** (amber) ·
**Working** · **Open** (idle). v4 rows: glyph + status badge, title, project · time; no quoted last prompt; the digest
line only when short and useful; "Background" only when not the default mode; branch only when not main/master; the
project left out when it equals the title. One icon button (Smartphone = Open in Claude app) instead of "Open in
Claude app" + "View": on hover on PC, a borderless 40px icon on phone. Not running: Resume in ⋯ / on hover.
Below: the list in buckets **Today · Yesterday · This week · Earlier** ("Earlier" folded), one line per row; the AI
summary line shows only for search matches. Filters: search, project, assistant, kind **With you · Automations ·
Archived · All**.
Session detail (v4): header meta = project · branch (if not main/master) · last active; one primary button (Open in
Claude app when running, else Resume); Summary folded by default; "Files edited most" + "Tools" in one "Details" fold;
Spin off and per-block task chips in ⋯. Phone: a compact floating pill button above the tab bar.

## 6. Tasks

**Text at the source (v4).** A task is something the user does, in his words: 3–7 words, verb first, no file names,
commands, env vars, dates, reasons or conditions, never "the user"/"Claude"/a name. The digest keeps `nextStep`
(Claude-facing, for prompts) and adds `todo` (that short line) and `who` (`you` · `claude` · `waiting`; `waiting`
items are not tasks). Briefs add `todos`; the daily plan and handoffs follow the same length rules. Extraction takes
titles from `todo`, keeps the Claude-facing step as the detail, looks only at sessions active in the last 10 days, keeps
at most 3 open suggestions per project and expires them after 7 days, and dedupes across parent/child folders. A
one-time cleanup shortened the existing suggestions (one batched Haiku call through the engine queue + guard).

Tabs at top: **To do** (List by default, Board as an option: To do · Doing · Done) and **Suggested (N)**. No subtitle.
- Search + filters sit behind one compact "Filter" row (one 44px row on phone). Titles clamp to two lines in CSS.
- **Suggested** rows: title + project · age only (detail and source open in the task sheet on tap), grouped by
  project with "+N more". Actions: **Keep** (→ To do) · **Today** · **Dismiss** (reason chips: Not a task · Already
  done · Duplicate · Not now = snooze 7 d). Keys: 1 Keep, 2 Today, 3 Dismiss, H snooze, J/K move.
- **Done** hides tasks Claude closed by itself behind one "Show N closed automatically" toggle. A small You / Claude
  marker on each task.
- Sidebar badge = To do + Doing. Project › Tasks = the same UI filtered to the project.

## 7. Projects

Projects page: filter labels Current / Quiet / Done / Hidden. Each card/row has a direct ▶ "New session" icon button.
Phone rows: name, running pill, age. Card footers: at most one quiet tag ("Gone quiet 30 d"), no warning prose. One
folded line "Claude spotted N possible projects ›" links to Ideas (when N > 0).
Project page tabs: **Overview · Tasks · Sessions · Notes & docs**. Header: max one primary button (New session).
- Overview (v4): **Where it stands** = the summary clamped to 3 lines (tap to expand; never repeats the header
  description) → **What's next** = only the user's own To do / Doing tasks (no AI suggestions with Keep/Dismiss here;
  hidden when empty) → **Workstreams** (compact) → **Possible projects** (if any) → **Automations** (one folded line).
  The Details card (folder, started, last activity, branch, open-in buttons) is folded, below the main column.
- Running session(s): a compact strip under the header, not a card.
- Sessions tab: running group on top + list; worktrees in a "Worktrees (N)" disclosure at the bottom.
- Notes & docs: notes/links first, docs list below.

**New session dialog (v4).** Visible: the project (or the resumed session card), the message box (empty, placeholder
only) and the "Trust this folder in Claude Code" checkbox. Name, Agent, Where, Model and the permissions hint sit
behind an **Options** disclosure whose summary shows the current choices ("Terminal · Default model · Skip all
prompts"). Project picker: most recently active first.

## 8. Ideas

No subtitle. Sections: **Possible projects** (AI scout; max 3 open shown + "N more"; card = proposed name, a 2-line
pitch, source project glyph + name; evidence, why and first steps behind one disclosure, PC too; actions **Make it a
project** (spin-off dialog prefilled, or New project for kind idea; pass scoutId) + ⋯ (Keep as idea · Not a project))
→ **Your ideas** (saved). The "From today's plan" section is gone (v4). Header button "Look for project ideas"
(POST /api/scout/run) with last-run time.

## 9. How Pilotage works (`/guide`)

One page: the five objects (table above, with icons), then "Where things come from" (Pilotage reads your Claude
Code / Codex / Gemini sessions on this PC → groups them into projects → AI writes summaries, suggests tasks and spots
possible projects; nothing is sent anywhere else), "Phone" (Running → Open in Claude app; pairing), "What AI costs"
(runs on your Claude plan; pauses itself above the limits in Settings). Linked from sidebar, More, and empty states.

## 10. Server contract for v3 (being added by the lead; build against these)

- `GET /api/overview` adds:
  - `pickup: [{key, kind: 'session', sessionId, title, projectId, projectName, workspace, summary, nextStep, lastAt,
    quietDays (0 if active < 3 d), resumable: bool}]` (≤6, newest first, hidden ones excluded).
  - `plan: {day: 'YYYY-MM-DD', today: [WorkItemView…] (open tasks with plannedFor ≤ today), proposals: [{index,
    projectId, projectName, title, why, action, matchId|null}] (focus items not accepted/dismissed today)}`.
  - `counts.interactive`, `counts.automated` (session counts) alongside existing counts.
  - `scout: {newCount, top}` (scout module).
- `POST /api/pickup/hide {key}` → hides a Pick up row (Not now). `POST /api/pickup/unhide {key}`.
- Work items gain `plannedFor: 'YYYY-MM-DD'|null`, `snoozeUntil: ms|null`, `dismissReason: string|null`,
  `closedBy` may be `'expired'`.
  - `POST /api/work/:id/today {on: boolean}`.
  - `POST /api/work/:id/dismiss {reason: 'not-a-task'|'done'|'duplicate'|'snooze'}` (snooze = 7 d, stays Suggested
    but hidden until then; others → dropped with dismissReason).
  - `POST /api/work/dismiss-old {days: 14}` → drops untouched suggestions older than N days, returns `{ids}`;
    `POST /api/work/restore {ids}` undoes it.
  - `POST /api/plan/focus/:index {action: 'accept'|'dismiss'}` → accept returns the task (existing match or new
    To do task flagged today); dismiss hides the proposal for today.
- Scout: see docs/API-SCOUT.md (`GET /api/scout`, `POST /api/scout/run`, `PATCH /api/scout/:id`,
  `POST /api/scout/:id/save`, `scoutId` on `POST /api/spinoff` and `POST /api/projects/new`, SSE kind `scout`).
- SSE kinds: `work` (tasks incl. plan flags), `scout`, `overview` as before.
