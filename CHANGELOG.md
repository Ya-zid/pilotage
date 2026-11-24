# Changelog

All notable changes to Pilotage are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pilotage is at 0.x: things can still change between
minor versions.

## [Unreleased]

## [0.5.0] - 2026-11-24

Features for people who run many sessions at once, a Map of all your work, your claude.ai chats next to your
Claude Code sessions, new terminal commands, and the remaining fixes from the overnight audit.

### Added

- **Map** (sidebar; More on the phone; `/map`): a mind map of your work: workspaces, projects, workstreams, topics
  your sessions share, recent sessions, ideas, open tasks, files several sessions edited and your claude.ai chats.
  Drag, wheel or pinch to move and zoom; click anything for its links and the fitting action (open, New session,
  Resume, Open in claude.ai); search to highlight and centre; "Focus on this"; type chips; period and project
  filters; keyboard access. "See on the map" in a project's ⋯ menu. Built from what Pilotage already knows, with no
  AI call. `GET /api/graph` (docs/API-GRAPH.md).
- **claude.ai chats**: import claude.ai's official data export (Settings → Sources, on the PC: the zip, its folder or
  `conversations.json`). Chats show on the Map linked to the projects they mention, in Sessions (read-only, "Open in
  claude.ai") and in search. Only a compact, redacted index is kept; the import runs in its own process with a
  memory cap (docs/API-CHATS.md).
- **Many sessions at once**: the tab title counts sessions waiting for you, with an optional desktop notification
  when one starts waiting (Settings → General); Home warns when running sessions in the same checkout edit the same
  files; **Continue fresh** starts a new session from a recap of a long, often-compacted one.
- **New commands**: `pilotage standup` (what you did, per project, ready to paste), `pilotage sessions`,
  `pilotage resume <project | id>`, `pilotage export <id>` (a session as markdown) and `pilotage usage` (tokens per
  project and day). Sessions and projects show a Tokens line (docs/API-REPORTS.md).
- Settings → AI → "Summarize automatically: the last N days" (was only in `state.json`).
- New project, Spin off and task Start offer an unticked "Trust this folder".

### Changed

- Sessions seeded by AI-written text (a suggested task's Start, Home's focus, a new project's kickoff and first
  session, Continue fresh) ask before acting whatever Settings says ("Plan first" is kept); a new project's
  CLAUDE.md marks its background as unverified context.
- Output token counts are the real ones (a reply written as several transcript lines was counted several times);
  forked sessions count only their own prompts, blocks and tokens.
- Automatic project briefs follow the same 30-day window as summaries.
- One server per data folder: a second one refuses to start and says where the first runs.
- `pilotage new` uses the Settings model unless `--model` is given; an unknown model is refused.
- The package says it runs on Linux and macOS (Windows: use WSL); npm refuses it on Windows itself.
- `POST /api/open` no longer opens URLs on the PC (nothing used it; phones could reach it).
- Old expired or dismissed suggestions are forgotten after 150 days.
- Phone access: the firewall rule follows the network the PC is on (Windows' LocalSubnet plus VPN ranges); a VPN
  address counts as VPN only when it arrives on a VPN adapter (NetBird, Tailscale, WireGuard `wg<N>`, ZeroTier).
- An upgrade restarts the phone forwarder once, when its code changed (the old one serves until the new one can
  start).
- CLI errors are plain text when not on a terminal.

### Fixed

- Uninstall stops the `pilotage run` supervisor first; the WSL autostart and shortcut quote the install path; the
  Desktop shortcut goes on the Desktop Windows shows (OneDrive); WSL without autostart says to keep the window open.
- Projects Pilotage creates are registered wherever they are, and their starter task can start; task Start honours
  "Trust folders automatically".
- A shortened task title follows when its block's next step changes.
- Indexing: `\\wsl.localhost\<distro>` session folders map to their Linux path; a read error mid-append doesn't
  double-count on retry; Codex rollouts and `history.jsonl` are read from where the last scan stopped, and a line
  written during a read is picked up next time.
- Git 2.8-2.25: repo status works again (filters are still checked safely); older git says it's too old.
- `pilotage doctor` names a port held by another program; `pilotage export --out` writes relative paths where you
  ran it; a stale server lock whose pid another program took over no longer blocks the start.
- Web: dialogs manage focus (in, Tab kept inside, back on close); Markdown images show as their alt text; dev-server
  ports are plain text on the phone; About shows the data folder; "Make it a project" keeps its success screen;
  "Start a project" shows its path before Create.

### Security

- Codex as the AI provider: SECURITY.md and Settings say plainly that Codex's read-only sandbox can still read files
  (Codex has no switch that removes its shell); keep Claude Code as the provider if that matters.
- Leak scan: file names, more token formats, and the packed package itself.

## [0.4.2] - 2026-11-24

### Fixed

- A screenshot of about 4.5 MB or more in a prompt no longer makes its whole session disappear from the index (0.4.1
  blanked image data with a regex that overflowed on very long base64; it's a linear scan now).
- "Summarize now" writes the project summary after the work it just summarized, and a manual job never waits behind
  a held automatic one. CV entries go through the AI queue (one at a time per project, counted in the limits).
- AI calls run in a private temporary folder with no CLAUDE.md above it (fewer tokens, no stray instructions).
- Summaries keep a gateway setup (`ANTHROPIC_BASE_URL` with its token) as it is.
- Indexing: each real Claude folder is read once (a symlinked `~/.claude` was parsed twice), a transcript whose file
  can't be read for a moment isn't treated as deleted, sessions of a removed worktree stay in their repo, Git for
  Windows worktrees are recognised on WSL, worktrees of a bare repo (`proj/.bare`) group under one project, and a
  folder with 400+ repos (`~/code`) is scanned.
- macOS: the home scan stays out of `~/Library` and the media folders (no privacy prompts).
- Suggested tasks no longer merge into a "Home folder" project from every other project.
- Project folder names keep combining marks (Devanagari, vowelled Arabic, Hebrew, Tamil).
- Other open devices refresh when coding tools are turned on or off; an open tool-call list on a working session
  updates; Home no longer polls the network status.
- The phone forwarder's restart backoff also covers a forwarder that dies right after starting.
- macOS: Pilotage's own AI calls stay out of the sessions list whatever temp folder they ran in.

## [0.4.1] - 2026-11-24

Fixes from a second round of independent review of 0.4.0, and two indexing fixes.

### Security

- Pilotage's git calls only search absolute PATH entries, so a program shipped inside an untrusted repo can't be
  picked up under an allowed name (git-lfs, git-crypt) through ".", "" or "node_modules/.bin" in PATH.
- Redaction: JWTs right after a URL escape (`id_token%3DeyJ...`) and `curl -u` anywhere on a long curl line are
  masked; separators around secret keys are bounded (no slow lines).

### Fixed

- Sessions Pilotage starts keep Node.js at the end of PATH again, for MCP servers run with npx, node hooks and
  wrapper shims (0.4.0 removed it while running an npm-installed claude with Pilotage's node).
- A prompt with several screenshots (a transcript line over 6 MB) is indexed, and each reply stays on its own prompt.
- A transcript folder that can't be read for a moment (WSL right after Windows sleeps) keeps its sessions instead of
  dropping them and re-reading everything.
- Linux autostart records the data folder, port and other `PILOTAGE_*` settings, starts right away, and `status` /
  `doctor` check that it is enabled.
- `pilotage doctor` no longer creates a missing data folder.

## [0.4.0] - 2026-11-24

A security and first-run release: an overnight audit of the whole codebase, with every fix tested and reviewed.

### Security

- A repository found on disk (an unpacked archive, a clone) can no longer make Pilotage's background `git` calls run
  a program: no repo-local filters, git-lfs extensions or transfer agents, signature checks, lazy fetches or network
  transports. Such repos simply show no git status.
- Secrets are masked in everything sent to the AI provider (CLAUDE.md files, Claude memory, READMEs, notes), not only
  in transcripts, and more formats are recognised (Groq, Hugging Face, xAI, Replicate, Google OAuth, Stripe
  webhooks, Slack/Discord webhooks, Basic auth, `curl -u`, quoted values). Redaction is linear: a huge paste no
  longer blocks the server.
- AI provider settings (where an API key is sent) and coding-tool sources can only be changed from the PC.
- Junk login or pairing codes can't lock out a valid one.
- An unknown or mistyped permission mode asks first instead of skipping permission prompts; `/api/launch` refuses it.
- WSL: a folder path containing `"` is refused before Windows Terminal (it could inject a command).
- Encoded `..%2f` paths no longer reach the app shell without a paired device; non-object JSON bodies get a 400.
- SECURITY.md now says plainly that a paired device can start sessions on the PC, and what to do after losing one.

### Added

- `pilotage doctor`: checks Node, Claude Code (found, recent enough), ports, the data folder, PATH, Windows Terminal,
  Node.js on Windows, autostart and the launch mode, and says how to fix what's missing.
- Linux: `pilotage install` starts Pilotage at login with a systemd user service (#2).
- `pilotage phone --trust-wifi`.
- Phone access over IPv6 in direct-bind mode (Linux/macOS, `PILOTAGE_LAN_BIND=::`): IPv6 CIDRs in
  `PILOTAGE_LAN_ALLOW`, IPv6 subnets in `lan` and Tailscale's IPv6 range in `vpn`; IPv4-mapped peers are always
  checked as IPv4 (#7).
- Home welcomes a new user who has no sessions yet (New session, the Guide) instead of a page of zeros.

### Changed

- New installs start sessions in Claude Code's ask mode ("Ask every time"). "Skip all prompts" is one click away in
  Settings → New sessions; installs from before 0.4.0 keep their mode. When it skips prompts, New session and task
  Start say so, and "Trust this folder" is never pre-ticked, on the phone either.
- "Enable phone access" no longer trusts the current Wi-Fi by itself: trust your home network with the Trust button
  (or `--trust-wifi`).
- Automatic summaries cover the last 30 days (`ai.backfillDays`); older work and repos without sessions are
  summarized on "Summarize now" only.
- Pilotage's own `claude -p` calls run on your Claude login, not an `ANTHROPIC_API_KEY` left in the shell
  (`PILOTAGE_USE_ANTHROPIC_API_KEY=1` to use the key).
- Home and Settings name a broken AI provider (logged out, missing CLI, bad key) instead of blaming usage.
- AI "Pause" survives a restart. `PILOTAGE_NO_AI=1` stops every AI call, Settings' Test included.
- The README is rewritten around a 5-minute quick start and a troubleshooting table.

### Fixed

- A `state.json` that doesn't parse is kept aside and the newest backup is loaded, instead of everything silently
  resetting to defaults (settings, notes, ideas, renames).
- `pilotage open` always shows the one-time sign-in link, also when no browser could be opened (WSL).
- WSL without Windows Terminal (Windows 10): Claude sessions start in the background instead of failing.
- Claude Code installed with npm under nvm is found by launch tabs and by the autostarted server, and runs with
  Pilotage's Node.js whatever node comes first on PATH.
- Phone access works on Windows in any display language (addresses, Wi-Fi name, firewall scope).
- `pilotage stop` / `restart` / `uninstall` only ever stop Pilotage's own server, however it was started.
- The phone forwarder comes back by itself after Windows sleep, and backs off when it can't.
- The launch screens stop spinning when no phone link appears, and link to the session as soon as it exists.
- The usage guard keeps a 5-hour reading until its window resets; the session index's memory stays bounded; day
  detail is right on DST days; project names in any script (Arabic, Cyrillic, CJK) make a folder name.
- The public export leaves out the audit notes.

## [0.3.0] - 2026-11-19

Install in one command, and macOS and Linux start sessions in a terminal like WSL does.

### Added

- npm package: `npx pilotage-cli` starts Pilotage and opens it; `npm install -g pilotage-cli` keeps it (the command
  is still `pilotage`). An npm install keeps its data in `~/.pilotage`; a git clone keeps using its `data/` folder.
- macOS: sessions started from the browser or the phone open in a Terminal window (`PILOTAGE_TERMINAL=iTerm` for
  iTerm), with Remote Control, like the Windows Terminal tabs on WSL. Codex and Gemini sessions can be started too.
- Linux: the same in your terminal emulator (`x-terminal-emulator`, GNOME Terminal, Konsole, kitty, Alacritty,
  WezTerm, Ghostty, foot, xterm…, or `PILOTAGE_TERMINAL`) when there's a desktop session. Over SSH or headless,
  sessions still start in the background.
- macOS: `pilotage install` adds a login item (a LaunchAgent) that starts Pilotage at login; `pilotage uninstall`
  removes it.
- A demo GIF at the top of the README.

### Changed

- `pilotage` with no command starts Pilotage if needed and opens it in the browser (it used to print the status:
  `pilotage status`).
- CI also runs on macOS, and installs the packed npm package on Linux and macOS to check that it starts.

### Fixed

- Trust folders: a folder reached through a symlink (on macOS, anything under `/var` or `/tmp`) is found under either
  spelling in `~/.claude.json`, so a folder Claude Code already trusts isn't offered again.

## [0.2.0] - 2026-11-18

A calmer UI: state at a glance instead of paragraphs, and short tasks.

### Changed

- Home: four counts at the top (working, needs you, today, to do), then Needs you, Running (one line per session),
  Today (Claude's suggestions folded into one line) and Pick up. No AI headline paragraph.
- Every list: one title line and one quiet meta line per row, one visible action (the rest under ⋯ or on hover),
  project glyphs with a status badge, stronger section headings, no dashed frames; a clearer dark theme.
- Navigation: Home, Sessions, Projects, Tasks, plus your five most recent projects in the sidebar. Phone tab bar:
  Home, Sessions, +, Projects, More.
- Session rows no longer quote your last prompt; the session page has one main button, with summary and details
  folded. Projects get a New session button on every card.
- Tasks: the AI now writes a 3–7 word to-do in your words (marked You, Claude or Waiting) next to the step it keeps
  for Claude. Fewer, fresher suggestions: only from the last 10 days, at most 3 open per project, duplicates merged
  across a folder and its subfolders, expiring after 7 days. A one-time pass (one AI call, within your usage limits)
  shortens the titles you already have. Tasks opens as a list, with filters behind one button.
- New session dialog: the project and your message; name, agent, mode and model under Options.
- Resume opens with an empty message box (it used to pre-fill "Let's continue. Next step: …").

### Added

- Settings → Trust folders (off by default), and a "Trust this folder" checkbox when starting a session: Pilotage
  answers Claude Code's "Do you trust the files in this folder?" for you, so sessions started from the phone don't
  wait for someone at the PC. It sets that one flag in `~/.claude.json`, under Claude Code's own lock, with a backup.
- New project / spin-off: the folder to create it in may not exist yet; it is created along with the project.
- CLI: `pilotage version` (also `-v`, `--version`) prints the installed version and short commit, and the version
  reported by a running server (with a hint to restart when the two differ).

### Fixed

- WSL: Pilotage repairs itself when Windows loses its connection to it (after sleep or a network change). A
  watchdog checks once a minute, and `pilotage open` checks before it opens the browser.
- Phone: the "not paired" screen re-checks by itself instead of needing a manual reload.

## [0.1.0] - 2026-11-16

First public release.

### Added

- A local web app for Claude Code, Codex CLI and Gemini CLI sessions: Home, Sessions, Tasks, Projects and Ideas,
  plus History, Portfolio & CV and Spin off.
- Read-only indexing of the agents' transcripts, your git repositories and project folders, grouped by workspace.
- AI summaries of work blocks, projects (with workstreams) and the day, through `claude -p`, Codex CLI or an
  OpenAI-compatible API, with Pilotage's own call caps and a guard on your Claude usage limits.
- Suggested tasks from your sessions' next steps, and a project scout that spots possible new projects.
- Start, resume and fork sessions from the browser: Windows Terminal tabs on WSL, `claude --bg` elsewhere.
- Phone access: pairing with a QR code, a Windows forwarder limited to trusted Wi-Fi and VPN ranges, HTTPS from a
  local name-constrained certificate authority, and an installable app. Linux and macOS can bind the phone
  listener directly (`PILOTAGE_LAN_BIND`).
- The `pilotage` command, and on WSL an install step for autostart and a Desktop shortcut.
- Security: a 127.0.0.1-only server, paired devices, one-time codes, a CSRF header, a Host allow-list and redaction
  of common secret formats.

[Unreleased]: https://github.com/Ya-zid/pilotage/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/Ya-zid/pilotage/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Ya-zid/pilotage/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Ya-zid/pilotage/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ya-zid/pilotage/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ya-zid/pilotage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Ya-zid/pilotage/releases/tag/v0.1.0
