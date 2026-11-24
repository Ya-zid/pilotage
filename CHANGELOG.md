# Changelog

All notable changes to Pilotage are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pilotage is at 0.x: things can still change between
minor versions.

## [Unreleased]

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

[Unreleased]: https://github.com/Ya-zid/pilotage/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/Ya-zid/pilotage/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Ya-zid/pilotage/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ya-zid/pilotage/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ya-zid/pilotage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Ya-zid/pilotage/releases/tag/v0.1.0
