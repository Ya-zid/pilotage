# Pilotage design system: "Quiet instrument panel"

> v4 (2026-11-18), the "calm" pass: the owner found v3 "hard to look at… all just text". First glance is now state
> (counts, status dots, project glyphs, short titles), not prose. §2 lists the rules; docs/SIMPLIFY.md has the page
> contracts and the vocabulary, and wins where the two disagree.

This is the contract for every page in `web/src/pages/*`. Read it fully before you touch a page.
Primitives live in `src/components/ui.tsx`, domain cards in `src/components/cards.tsx`, all styles in
`src/styles.css`. Page CSS files (`Timeline.css`, …) may only use the tokens below, never raw colors.

## 1. Direction

Pilotage is a cockpit its user opens dozens of times a day, mostly in dark mode, on a 1440px PC and a
390px Android phone. It should feel like Linear, Vercel's dashboard, Raycast and Things 3: calm,
neutral, typographic, fast to scan.

- **Neutral canvas, about 95% grey.** Color is reserved for two things: **meaning** (status) and
  **identity** (workspace hue). If a color doesn't mean something, remove it.
- **Typography makes the hierarchy, not boxes.** One strong line per item, quiet metadata, big
  tabular numbers. Cards only group things; they never decorate.
- **Progressive disclosure.** Show the headline, keep at most two lines of secondary text, and put
  everything else behind a click (detail page, `Disclosure`, `ClampText`, "Show N more").
- **The exception, not the default.** Don't label what's normal (an "Active" badge on every active
  project). Show the live session, the blocked thread, the dirty repo.

Research behind this: Linear's 2024 redesign (neutral chrome, fewer variables, Inter / Inter Display,
reduced noise in sidebar and headers); Vercel Geist (a 10-step scale per color: backgrounds, borders,
high-contrast fills, text; "Background 2 sparingly"); Radix Colors (steps 1–2 app background, 3–5
component fills, 6–8 borders, 11–12 text); real-time dashboard UX guidance (about 5 primary
elements per view, big KPI numbers with a delta and a sparkline, color always paired with a glyph or a
word, 100–150 ms feedback and 200–400 ms transitions, respect reduced motion); Things 3 (whitespace
as structure, color only for meaning).

## 2. Principles (the rules reviewers will check)

1. **First glance = state, not prose.** Counts, status dots, project glyphs, short titles. Sentences only on tap
   (an expanded row, a detail page, a `Disclosure`).
2. **A row is one title line + at most one meta line.** Title 14px/550 `--text`; meta 12px `--text-3`, one line,
   ellipsis (`Meta` inside a `ListRow` body does this by itself). No `--text-2` paragraphs inside list rows, no quoted
   user prompts in rows. AI summaries go on detail pages (`ClampText`), never in lists.
3. **One visible action per row, at most.** Everything else goes in a ⋯ menu, or appears on hover on a PC
   (`.row-acts.hover`). Clicking the row opens it. On phones hover doesn't exist: the one action stays visible, the
   rest live in the ⋯ sheet.
4. **Sections carry the structure.** `Section` headings are 15px/650 `--text` with a count pill; consecutive
   sections sit `--section-gap` apart (40px PC, 32px phone).
5. **Identity color is the anchor.** A row about a project or session leads with its `ProjectGlyph` (24px), with the
   status as a corner badge (`status` prop), not a separate status icon.
6. **No dashed borders, no boxes inside boxes, no explanatory page subtitles.** Explanations go to /guide, an ⓘ, or a
   `Disclosure`.
7. **Drop default and repeated metadata**: "Terminal" when it's the default mode, the branch when it's main/master,
   the project name when it equals the title.
8. **Dark mode is the main use.** Cards must separate from the canvas (tokens do it: `--surface` above `--bg`, hairline,
   `--card-shadow`). Check every page dark and light.
9. **Hide, don't delete.** Every feature stays reachable (⋯ menu, fold, secondary nav).
10. **One primary button per view** (white-on-dark `.btn.primary`; the shell's "New session" is usually it). Plain,
    short English; no gendered words, no hardcoded names (`settings.profile.name`).

Also still true: metadata is text, not chips (at most one pill per row, and only for "live"); status = glyph from
the shared vocabulary (§6); phone is a first-class layout (lists, bottom sheets, controls ≥ 40px tall); `Snippet` strips
Markdown, only detail views render `Markdown`.

## 3. Tokens

All tokens are CSS variables on `:root`, defined once with `light-dark()`. The theme follows the OS
unless `<html data-theme="light|dark">` forces one (set from Settings → Appearance by `Layout`).
**Never hard-code a hex value in a page; never use `@media (prefers-color-scheme)` in a page.**

### Color

| Token | Role |
|---|---|
| `--bg` | Page canvas |
| `--bg-chrome` | Sidebar, bottom tab bar |
| `--surface` | Cards, panels, list containers |
| `--surface-2` | Insets, segmented-control track, chips, hover fills on cards |
| `--surface-3` | Pressed, meter tracks, skeletons |
| `--surface-raised` | Modals, popovers, palette |
| `--field` | Text inputs |
| `--hover`, `--pressed` | Translucent overlays for interactive rows/nav (work on any surface) |
| `--border` | Default hairline (translucent) |
| `--border-strong` | Inputs, buttons, hovered cards |
| `--text` | Primary text, titles |
| `--text-2` | Secondary text (descriptions, sub-lines) |
| `--text-3` | Metadata, labels, placeholders (≥ 4.5:1 on bg/surface/surface-2 in both themes) |
| `--text-4` | Decoration only (separators, disabled). Never for text someone needs to read. |
| `--accent` / `--accent-text` / `--accent-soft` | Brand periwinkle: focus rings, links, selection, "in motion" status |
| `--green` | Live / ready |
| `--amber` | Needs attention: needs you, blocked, dirty, warnings |
| `--red` | Errors, destructive |
| `--blue`, `--violet`, `--teal` | Reserved for charts and ideas; not for status |
| `--card-shadow` | Cards, tiles, board cards: soft drop in light mode, top highlight + drop in dark mode |
| `--glyph-tint`, `--glyph-ink` | How strongly a `ProjectGlyph` takes its workspace hue (fill / letter); per theme |

Dark mode (v4): canvas `#0b0c0f`, cards `#16171c`, hairlines 8.5% white, so a card always reads as a card. Light
mode: canvas `#f8f8fa`, white cards.

Compatibility aliases kept for old pages: `--ok`, `--live` (= green), `--busy` (= accent, i.e. "working"),
`--warn` (= amber), `--danger` (= red), `--ok-soft`, `--warn-soft`, `--danger-soft`, `--teal`.

Soft tints are always computed: `color-mix(in srgb, var(--amber) 13%, transparent)`.

### Type

Inter Variable (self-hosted, optical sizes, so large sizes get the Display cut automatically) and
Geist Mono Variable for code, paths and commands. Feature `cv05` (l with a tail) is on globally so
`l`/`I` are distinguishable in project names. `.num` turns on tabular figures. Use it for every number
that can change or sits in a column.

| Token | px (desktop / phone) | Use |
|---|---|---|
| `--fs-3xl` | 32 / 28 | `StatTile` value |
| `--fs-2xl` | 26 / 24 | Page title (`h1`), weight 650, tracking −0.022em |
| `--fs-xl` | 20 | Rare: hero numbers inside a card |
| `--fs-lg` | 17 | Modal titles |
| `--fs-md` | 15 | Card titles of big cards (`.pcard .title`), lead paragraph (`.lead`) |
| `--fs-base` | 14 / 15 | Body, row titles |
| `--fs-sm` | 13 / 13.5 | Secondary text, section headings, buttons |
| `--fs-xs` | 12 / 12.5 | Metadata, labels, counts |
| `--fs-2xs` | 11 | Glyph initials, tab-bar labels only |

Section headings (v4) are **15px/650 `--text` with a count pill**: they carry the page structure. Card headings stay
14px/600. Don't use uppercase labels.

### Space, radius, elevation, motion

- Space: 4px grid, `--s-1`…`--s-12` = 4, 8, 12, 16, 20, 24, 32, 40, 48. `--flow-gap` (28px PC, 24px phone) between
  the blocks of a page (`.content`); `--section-gap` (40px PC, 32px phone) between two `Section`s (`.section +
  .section` adds the difference). Inside cards: 20px padding desktop, 16px phone. Row padding 13–14px × 20px.
- Radius: `--r-xs` 4 (kbd), `--r-sm` 6 (small buttons, badges), `--r-md` 8 (buttons, inputs),
  `--r-lg` 12 (cards, `--radius`), `--r-xl` 16 (modals). Pills are `999px`.
- Elevation: flat. Cards = `--surface` + `--border` + `--card-shadow`. No dashed frames, no card inside a card. Shadows
  (`--shadow-md`, `--shadow-lg`) only for floating layers: modals, palette, toasts, tooltips.
- Motion: `--ease` (cubic-bezier .2,.8,.2,1), `--dur-1` 120ms (hover/press), `--dur-2` 180ms
  (open/close, toggles), `--dur-3` 260ms (sheets, page fade). Only `working` and `needs-you` pulse.
  Everything respects `prefers-reduced-motion`.

### Iconography

lucide-react, stroke 1.75 (set globally in CSS). Sizes: 16 in nav and buttons (15 in `.btn`, 14 in
`.btn.sm`, 17 in `.btn.row-icon`), 16 in section titles, 13–14 in metadata, 17–18 in empty-state tiles and callouts.
`StatusIcon` is 16 by default, 9–12 as a glyph corner badge, 11–13 inside pills. Icons
are `--text-3` by default and only take a meaning color when they carry meaning (amber warning
triangle). Don't put an icon on every heading. One per section at most, and none on rows that already
have a status glyph.

## 4. Shell and layout

- Desktop (> 860px): 248px sidebar (`--bg-chrome`) + content column. Sticky 52px top bar with the
  search/palette trigger (Ctrl K) and the only primary button, **New session**. Content max width
  1200px, padding 32px 40px.
- Sidebar (v4): main **Home · Sessions · Projects · Tasks**; then **Recent projects** (the 5 most recently active,
  running first: glyph + presence dot, click opens the project, ▶ on hover = New session there, "All projects"
  link); then, smaller and at the bottom, **Ideas · Map · History · Portfolio & CV · Settings · How Pilotage works** and
  the two usage meters.
- Phone (≤ 860px): compact header (brand, search icon), bottom tab bar **Home · Sessions · ＋ · Projects · More**
  (＋ = create sheet; Tasks and Ideas live in More, whose tab shows a pip with today's + doing task count), with
  safe-area insets. Content padding 20px 16px and bottom padding for the tab bar. Modals become bottom sheets with a
  grab handle; the palette drops from the top.
- Grids: `.grid-main` (content + 320px rail, stacks under 1100px), `.grid-cards` (auto-fill
  ≥ 320px), `.grid-stats` (auto-fit ≥ 180px, **2 columns on phone**), `.grid-2`, `.grid-3`.
- Stacks: `.stack-sm` 4, `.stack` 8, `.stack-lg` 20, `.stack-xl` 32. Inline: `.row`, `.cluster`,
  `.spread`, `.grow`.
- Don't use `window.scrollY` tricks or a page-level scroll container. The document scrolls.

## 5. Formats and copy

- Dates: `fmtDate(t)` gives "11 Nov" (adds the year only when it's not this year). `fmtDateTime` gives
  "11 Nov, 14:05" and `fmtTime` gives "14:05": 24-hour clock, en-GB order. Day group headers use
  `fmtDay(t)` ("Today", "Yesterday", "11 Nov"). **Never weekday names in lists** ("Tuesday" next to
  "4 days ago" is confusing). The only weekday allowed is the Today page date line.
- Relative time: `ago(t)` ("3 h ago", "yesterday") in rows and metadata. Put the absolute date in
  `title=` for hover.
- Plurals: always `plural(n, 'worktree')`. Never `${n} worktrees`.
- Numbers: `.num` / tabular; `compactNum(12400)` gives "12.4k" in tiles.
- Paths: `PathLabel` (file name + "…/parent/folder" tail, full path in the tooltip). Never truncate a
  long absolute path from the right (they all start the same).
- AI text: `Snippet` for one-liners (strips Markdown), `ClampText` for paragraphs, `Markdown` only on
  detail pages.
- Copy: sentence case, plain words, no emoji, no ALL CAPS. Buttons are verbs ("Start session",
  "Continue"). Pages have no explanatory subtitle (v4); a detail page's header may carry one `Meta` line.

## 6. Status language (one vocabulary, two families)

There are two different questions, so they get two different looks. Each meaning keeps one color
everywhere.

**A. Process state of a live session ("is Claude running right now?")**: `LiveStatus`: solid dot +
word in a tinted pill. Get the state with `liveState(s)` / `liveLabel(s)` from `cards.tsx`.

| state | label | look |
|---|---|---|
| `working` | Working | accent, pulsing dot |
| `idle_live` | Open | grey dot (v3: idle is not green) |
| `needs-you` | Needs you | amber, pulsing dot |

**B. Work status (AI digest of a block, thread or project lifecycle)**: `WorkStatus`: outlined circle
glyph + plain text, no fill. In rows, use the glyph alone (`StatusIcon`) as the leading element.

| status | glyph | tone |
|---|---|---|
| `in_progress`, `ongoing`, `active` | half-filled circle | accent |
| `blocked` | filled circle with "!" | amber |
| `done` | filled check circle | muted (finished work recedes) |
| `abandoned` (Dropped), `archived` | circle with slash | faint |
| `idle`, `todo` | empty ring | muted |
| `dormant`, `queued` | dashed ring | faint |
| `paused` | ring with pause bars | muted |
| `error` | filled circle with × | red |

Rules (v3): accent = in motion, amber = needs you, grey = open/idle, muted green = done, red = broken
or asleep. Don't invent new status colors. Don't show "Active" on active projects.

**C. Status as a corner badge (v4).** In rows, the project glyph leads and the state sits on its corner:
`<ProjectGlyph … size={24} status={liveState} />` (working pulses accent, needs-you amber, open grey) or a work status
(blocked, done, abandoned). Badge only the exception: a Pick up row that is simply "in progress" gets no badge.

**Workspace identity:** `wsColor(key)` returns a hue from a 16-color palette, assigned so every known
workspace gets a distinct color (deterministic for a given set). `registerWorkspaces()` is already
called when projects, timeline or portfolio data load. If a project has `p.color`, pass it as `color`.
Identity colors are never used for status.

## 7. Component catalogue

All of these are exported from `src/components/ui.tsx` unless noted.

### Page structure

```tsx
<PageHeader
  crumbs={[{ label: 'Projects', to: '/projects' }, { label: <><WorkspaceAvatar ws={p.workspace} name={p.workspaceName} size={16} />{p.workspaceName}</>, to: `/projects?ws=${p.workspace}` }]}
  glyph={<ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={40} />}
  title={p.name}
  status={p.liveCount ? <LiveStatus state="idle_live" label={`${p.liveCount} live`} /> : <WorkStatus status={p.status} />}
  subtitle={<Meta items={[branch, ago(p.lastAt)]} />}            // detail pages only: one Meta line, never an explanation
  actions={<><Button icon={<Play />}>New session</Button><IconButton icon={<MoreHorizontal />} label="More" variant="secondary" size="md" /></>}
>
  <Tabs value={tab} onChange={setTab} items={[{ value: 'overview', label: 'Overview' }, { value: 'board', label: 'Board', count: 7 }]} />
</PageHeader>

<Section title="Needs you" count={2} countTone="amber" actions={<Link className="small" to="/sessions">Sessions</Link>}>
  …                                         // heading 15/650 + count pill; next Section sits --section-gap below
</Section>
<CountPill n={3} tone="accent" />          // the same pill anywhere else (menus, More)

<Card title="Brief" icon={<Sparkles />} actions={<span className="tiny faint">updated {ago(t)}</span>}>…</Card>
<Card title="Sessions" count={13} flush>{sessions.map((s) => <SessionRow key={s.id} s={s} />)}</Card>   // flush = list inside
<Card>plain padded content</Card>          // `Panel` is an alias
<Toolbar><div className="input-wrap"><Search /><input className="input" placeholder="Filter…" /></div><ToolbarSpacer /><SegmentedControl … /></Toolbar>
```

### Rows

```tsx
// The v4 row: project glyph (24, status badge) · one title line · one meta line · at most one visible action.
// `to` makes the whole row a link; buttons inside stay clickable. The Meta inside a ListRow body never wraps.
<ListRow
  to={`/sessions/${s.id}`}
  lead={<ProjectGlyph name={s.projectName} ws={s.workspace} size={24} status={liveState(s) === 'idle_live' ? 'open' : liveState(s)} />}
  title={s.title}
  meta={<Meta items={[s.projectName !== s.title && s.projectName, ago(s.lastAt)]} />}
  actions={<Button size="sm" variant="ghost" icon={<Play />}>Resume</Button>}   // hover-only on PC, hidden on phone
/>
<ListRow dense lead={<Settings2 size={16} className="faint" />} title="Settings" to="/settings" />   // menus (phone More page)
```

Hand-built rows (`.lrow` + `.lrow-link` + `.lrow-lead` / `.lrow-body`) put their actions in **`.row-acts`**:
`<div className="row-acts hover">` appears on hover on a PC with a mouse and stays visible on touch;
`<div className="row-acts">` with one child `.hover` hides only that child (e.g. "＋ Today" visible, ⋯ on hover).
The icon action of a row is **`.btn.row-icon`** (borderless, 32px PC / 40px phone: Smartphone = open in Claude app,
MoreHorizontal = ⋯ menu; the menu itself is `Menu` from `tasks/TaskBits`). `.lrow-sub` is `--text-3`: use it for
one short line (Claude's question on a Needs-you row), never a paragraph.

Domain rows/cards from `cards.tsx` (use these, don't rebuild them):

| Component | Use |
|---|---|
| `<ProjectCard p showWorkspace? showStack? />` | Grid card: glyph, name, path, 2-line summary, meta (age · sessions · branch ±dirty), first attention signal |
| `<SessionRow s showProject? />` | Session list row; live sessions show the state word on the right |
| `<BlockRow b showProject? showSession? />` | A unit of work: digest glyph, title, outcome (2 lines), "next step" line, meta, **Continue** (hidden when live or done) |
| `<LiveCard s />` | Live session card: state pill, title, project, last prompt, Open in Claude app / View / Attach / Stop |
| `<AttentionRow a />` | Attention signal row (amber triangle or info icon, project name, 2 lines) |
| `liveState(s)`, `liveLabel(s)`, `liveDot(s)` | Process state helpers |
| `<ProjectStatusBadge status />` | = `WorkStatus` (compat) |

### Status and identity

```tsx
<LiveStatus state={liveState(s)!} label={liveLabel(s)} />       // process: pill with dot
<WorkStatus status={d.status} />                                // work: glyph + text, no fill
<StatusIcon status="blocked" />                                 // glyph only (16px), has a title tooltip
<ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={32} />   // 14 (meta), 18 (sidebar), 24 (row lead), 26–32 (cards), 40 (headers)
<ProjectGlyph name={p.name} ws={p.workspace} size={24} status="working" statusTitle="Working" />   // state as a corner badge
// the badge ring uses --badge-bg (default --surface): set it on a tinted container (e.g. the amber Needs-you card)
<WorkspaceAvatar ws={key} name={w.name} size={18} />
<AvatarStack items={workspaces.map((w) => ({ key: w.key, name: w.name, ws: w.key }))} max={4} />
```

### Numbers and charts

```tsx
<div className="grid-stats">
  <StatTile label="Prompts this week" icon={<MessagesSquare />} value={161} delta={-27} deltaLabel="27%" spark={last14} />
  <StatTile label="Live now" icon={<Radio />} value={6} hint="3 working · 1 needs you" to="/live" />
  <StatTile label="Tokens out" value={compactNum(812000)} unit="tokens" size="sm" bare />   // bare = no card (inside another card)
</div>
<Sparkline data={[3, 5, 2, 8]} width={96} height={28} color="var(--green)" />   // no axes, ever
<MiniBars data={perDay} titles={perDay.map((n, i) => `${days[i]}: ${n}`)} height={48} />
<Progress value={3} max={8} />            // meter + "3/8"
<Progress value={72} tone="warn" />       // "72%"
<Meter pct={u.five.pct} size="sm" />      // auto amber ≥ 60, red ≥ 85
```

`delta` colors itself (up = green, down = red); pass `invertDelta` when lower is better.

### Text

```tsx
<Snippet text={b.digest?.outcome} lines={2} className="lrow-sub" />     // plain text, Markdown stripped
<Snippet text={s.lastPrompt} quote />                                    // “quoted prompt”
<ClampText lines={3}>{brief.description}</ClampText>                     // "Show more" only if it overflows
<ClampText lines={8} fade><Markdown text={reply} /></ClampText>          // rich content: height clamp with fade
<Markdown text={md} />                                                    // safe: no raw HTML, links open in a new tab
<Disclosure summary={`${n} tool calls`}>{…}</Disclosure>                  // native <details>
<PathLabel path={doc.path} />  <PathLabel path={wt.path} inline mono />
<Meta items={[a, b, c]} />     <Kbd>Ctrl K</Kbd>     <Tooltip label="Open in VS Code"><IconButton … /></Tooltip>
```

Utility classes: `.muted` (text-2), `.faint` (text-3), `.small`, `.tiny`, `.bold`, `.medium`, `.lead`,
`.overline`, `.truncate`, `.clamp-1…4`, `.readable` (72ch), `.num`, `.mono`, `.tone-green|amber|red|accent`.

### Controls

```tsx
<Button variant="primary" icon={<Plus />}>New session</Button>     // primary | secondary (default) | ghost | subtle | accent | danger
<Button size="sm" variant="ghost" loading={busy}>Rewrite</Button>
<IconButton icon={<Pencil />} label="Edit" />                       // label = aria-label + title
<CopyButton text={cmd} label="Copy command" />
<SegmentedControl value={v} onChange={setV} options={[{ value: 'current', label: <>Current <span className="num faint">11</span></> }]} size="sm" />
<Tabs value={tab} onChange={setTab} items={[…]} />                  // underline tabs for page sections
<Switch on={x} onChange={setX} label="Daily brief" />
<Field label="Name" hint="Shown in the Claude app"><input className="input" /></Field>
<div className="input-wrap"><Search /><input className="input" placeholder="Filter…" /></div>
```

Plain classes still work for links: `<Link className="btn sm" to=…>`. Buttons: `.btn` + `.primary`
`.ghost` `.subtle` `.accent` `.danger` + `.sm` `.lg` `.icon` `.block` `.round`.

### Feedback

```tsx
<EmptyState icon={<Lightbulb />} title="No ideas yet" body="Write down anything you'd like to try." action={<Button size="sm" icon={<Plus />}>Add idea</Button>} />
<Callout tone="warn" icon={<TriangleAlert />} title="2 dev servers still running" action={<Button size="sm">Review</Button>}>From deleted folders.</Callout>
<LoadingCard lines={4} />   <Skeleton h={14} w="60%" />   <Spinner />   useToast()('Saved')
<Modal title="Edit project" onClose={close} footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary">Save</Button></>}><div className="modal-body">…</div></Modal>
```

Callout tones: info (accent), `warn`, `danger`, `ok`, `neutral`. Use a callout only for something
the user should act on; never for explanations (put those in a `Disclosure` or `.hint`).

### Board (Tasks tab)

```tsx
<Board>
  <BoardColumn title="To do" status="todo" count={todo.length}>
    {todo.map((t) => (
      <div key={t.id} className="board-card clickable" onClick={…}>
        <span className="t clamp-2">{t.title}</span>
        <Meta items={[t.source, ago(t.at)]} />
      </div>
    ))}
  </BoardColumn>
  <BoardColumn title="In progress" status="in_progress" count={…} />
  <BoardColumn title="Blocked" status="blocked" count={…} />
  <BoardColumn title="Done" status="done" count={…} />
</Board>
```

Columns scroll horizontally and snap (84% width on phones). An empty column says "Nothing here".

## 8. Page blueprints

Every page: `PageHeader` (title, no explanatory subtitle) → content in `Section`s. Max about five primary blocks above
the fold. Desktop numbers below assume 1440px wide (about 1120px content). Page contracts and what each section
holds: docs/SIMPLIFY.md; the visual recipe per page is below.

### Home `/`
- **Header**: date eyebrow + "Good evening, Sam" (name from Settings). Nothing else: no AI headline, no
  "Updated · Refresh" (Today's plan refreshes by itself).
- **Pulse tiles** right under it (`.pulse`, 4 small linked tiles, one row on phone too): Working (accent when > 0),
  Needs you (amber when > 0), Today `done/planned` with a progress ring, To do. Number 24px (20 on phone), label 12px.
- Then, each only when not empty: the catching-up pill, the phone-setup `Callout` (PC, until a phone is paired),
  **Needs you** (amber card; glyph + badge, title, Claude's question as one line, project · waiting; one visible
  "Open in Claude app"), **Running** (working then open, one line each on PC: glyph + badge, title, project · time on
  the right, Smartphone icon on hover; > 6: "+N open"), **Today** (your picked tasks; else one line "✦ Claude suggests
  3 for today ›" that unfolds rows: glyph, title, "＋ Today", ⋯ Start / Not today; tapping a row shows the why),
  **Pick up** (5 rows: glyph + exception badge, title, project · age or "Gone quiet 6 d"; Resume + ⋯ on hover on PC,
  ⋯ on phone).
- No footer of counts, no stat tiles, no quick-idea box.

### Sessions `/sessions`
- Header: "Sessions" + ⓘ (icon legend) + "History" link. No subtitle.
- **Running** on top (Needs you · Working · Open), then the list in date buckets with "Earlier" folded. Rows: one
  line by default (glyph + badge, title, project · time); the AI summary line only for search matches; never the last
  prompt. One icon action (Smartphone) on hover on PC / borderless 40px on phone; Resume in ⋯ / on hover.
- Meta drops defaults: "Background" only when it isn't the default mode, branch only when not main/master, project
  only when it differs from the title.

### Session `/sessions/:id`
- Header meta: project · branch (if not main/master) · last active. **One** primary button: Open in Claude app when
  running, else Resume. Spin off and per-block task chips live in ⋯.
- Summary folded by default (PC too); "Files edited most" and "Tools" share one "Details" fold.
- Phone: a compact floating pill button (bottom right, above the tab bar) instead of a full-width sticky bar.

### Projects `/projects`
- Header: "Projects" + New project. Toolbar: search, Current / Quiet / Done / All, grid/list toggle.
- Groups by workspace (avatar + name + count pill). Cards/rows get a direct ▶ "New session" icon button. Phone rows:
  name, running pill, age. One folded line "Claude spotted N possible projects ›" → /ideas when N > 0.

### Project detail `/projects/:id`
- Header: crumbs, glyph 40px, title, `LiveStatus` if running; max one primary button (New session); open-in buttons
  and edit/status/pin in ⋯.
- Overview: "Where it stands" = the summary clamped to 3 lines (tap to expand; never repeats the header line);
  "What's next" = only your own To do / Doing tasks (hidden when empty, no AI Keep/Dismiss here); Workstreams;
  Details card folded, below the main column.

### Tasks `/tasks` and Ideas `/ideas`
- Tasks: no subtitle; List view by default (Board stays an option); search + filters behind one compact "Filter" row
  (one 44px row on phone). Titles clamp to two lines in CSS. Suggested rows: title + project · age only (detail and
  source in the task sheet), grouped by project with "+N more". Done hides tasks Claude closed by itself behind one
  "Show N closed automatically" toggle. A small You / Claude marker per task.
- Ideas: no subtitle; cards = title + 2-line pitch + source; evidence and first steps behind one disclosure;
  actions "Make it a project" + ⋯.

### Map `/map`
- **Header**: "Map"; actions: the period `SegmentedControl` (7 d · 30 d · 90 d · 1 y · All; in the toolbar on phone).
  Toolbar: "Find on the map…" (typing highlights the hits and centres the best one; Enter walks through them and opens
  each), project `select`. Below, one row of type chips (they are the legend: mark + word + count; tap hides a type).
- **Stage**: one card, the SVG map (drag to pan, wheel or pinch to zoom, + / − / fit buttons bottom left; arrow keys,
  + / −, 0 and Enter when the map has focus). Types use the chart hues, each with its own shape (idea = diamond, task =
  rounded square, file = small square, workspace = ring, the rest circles); a running session gets a green ring. Labels
  only on large, hovered, selected (and its neighbours) and searched nodes, 12px at any zoom.
- **Panel** (right, 340px; a bottom sheet above the tab bar on phone): type word, title (status glyph for sessions,
  workstreams and tasks), one `Meta` line, the fitting action (Open project / session / task…, New session, Resume, Open
  in claude.ai), Focus on this / Only this project, then its links grouped by type (6 + "Show N more"); a link row
  selects that node. Esc closes it.
- What the server left out (`truncated`) is one `.hint` line under the map. Empty: one `EmptyState` (Show all time, or
  New session + the Guide).

### History `/history` (the old Timeline)
- **Header** + stat row: Active days, Prompts, Commits, Current streak, Longest streak (`StatTile`,
  `size="sm"`).
- **Heatmap card** full width (accent scale `.heat`/page CSS, cells 12px, legend Less→More).
  Selecting a cell sets the day.
- **Day panel** (`grid-main` left): header `fmtDay` + `Meta` (prompts · commits · sessions), workspace
  split bar (ws colors, labels below), then `BlockRow`s ordered by time with `fmtTime` in a left
  gutter. Prev/next day as `IconButton`s.
- **Rail**: "Last 8 weeks" (`StatTile` with delta + `MiniBars`), "Last 30 days by project" (bars in
  workspace color with `ProjectGlyph` labels).
- **Phone**: stat tiles 2 columns (5th spans), heatmap shows the latest 16 weeks with horizontal
  scroll and 14px cells (tap target), day panel below, rail after.

### Portfolio & CV `/portfolio`
- **Header**: "Portfolio & CV"; actions: Export (secondary).
- **Toolbar**: search, `SegmentedControl` (Included / All), language `SegmentedControl` (EN / FR).
- **Cards** (one column, `readable` width): `ProjectGlyph` 32 + title + period (right, `.num`
  `.faint`), tagline (`.lead` small), role, bullets (max 3 visible, `ClampText`), stack as plain
  dotted text, footer: include `Switch`, "Rewrite with AI" (ghost), edit (`IconButton`). Excluded
  cards at 60% opacity.
- **Rail** (desktop): export preview (Markdown, mono) with `CopyButton`. **Phone**: export opens a
  bottom sheet.

### Settings `/settings`
- Desktop: left sticky section nav (vertical `nav-item`-style list) + right column of `Card`s, one
  per section. Inside, **setting rows**: label (14/550) + hint (`.hint`) on the left, control on the
  right (`Switch`, `SegmentedControl`, `select`, button). Rows separated by hairlines.
- Destructive actions (revoke device, purge) in their own card, `.btn.danger`, always confirm.
- Phone: section nav becomes a horizontally scrollable `SegmentedControl`-like chip row; rows stack
  (control under the label when it doesn't fit).

### More `/more` (phone only)
- `Card flush` menu of `ListRow dense` (icon tile, one line each): Tasks (state line "2 for today · 5 to do" + accent
  count pill), Ideas (possible projects / saved ideas), Map, History, Portfolio & CV, Settings, How Pilotage works; then
  the usage card (5-hour limit, Weekly limit, reset times).

## 9. Legacy classes (still styled, migrate when you rewrite a page)

`.page-head` (+ `.sub`, `.actions`), `.crumbs`, `.card-head`/`.card-body`, `.section`/`.section-title`,
`.list`/`.list-item`, `.pcard`, `.focus-card`, `.signal`, `.chip`, `.badge` (+ tones), `.dot`
(+ `live`/`busy`/`warn`), `.ws-swatch`, `.ws-head`, `.callout`, `.empty`, `.kv`, `table.table`,
`.heat`, `.bars`, `.seg`, `.tabs`, `.turn`, `.bubble-user`, `.bubble-sys`, `.tool-line`, `.block-sep`,
`.prose`, `.modal-body`, `.modal-foot`, `.hide-mobile`, `.hide-desktop`, `.wrap-mobile`.
Prefer the components: `PageHeader` over `.page-head`, `ListRow` over `.list-item`, `StatusIcon`/
`WorkStatus` over `Badge`/`DigestStatus`, `ProjectGlyph` over `WsSwatch`, `Meta` over `.cluster` of
chips, `EmptyState` over `Empty`.

## 10. Checklist before you hand a page back

- [ ] Screenshot at 1440×900 and 390×844, dark and light. No horizontal scroll on the phone.
- [ ] One `h1` (via `PageHeader`). Section headings via `Section`. No uppercase labels.
- [ ] Each row: one title line + one meta line (`Meta`), project glyph lead with a status badge, at most one visible
      action (the rest in ⋯ / on hover). No quoted prompts, no `--text-2` paragraphs in rows.
- [ ] No dashed borders, no card inside a card, no explanatory page subtitle. Sections use `Section` (count pill).
- [ ] No more than one pill per row/card; no stack chips in lists; no "Active" labels.
- [ ] No raw hex colors, no new font sizes outside the scale, no inline `style` for colors.
- [ ] Dates via `fmtDate`/`fmtDay`/`ago`, plurals via `plural`, numbers `.num`.
- [ ] AI text clamped (`Snippet` / `ClampText`); Markdown only in detail views.
- [ ] Every control ≥ 40px tall on phone; nothing important is hover-only.
- [ ] Empty and loading states use `EmptyState` / `LoadingCard`.
- [ ] Keyboard: focus rings visible, Esc closes modals, Ctrl K still opens the palette. A dialog (`Modal`) takes focus
  when it opens, keeps Tab inside, gives focus back to what opened it, and is named by its title.
