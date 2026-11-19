# Changelog

All notable changes to Pilotage are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pilotage is at 0.x: things can still change between
minor versions.

## [Unreleased]

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

[Unreleased]: https://github.com/Ya-zid/pilotage/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Ya-zid/pilotage/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ya-zid/pilotage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Ya-zid/pilotage/releases/tag/v0.1.0
