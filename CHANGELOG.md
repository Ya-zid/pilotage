# Changelog

All notable changes to Pilotage are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pilotage is at 0.x: things can still change between
minor versions.

## [Unreleased]

### Added

- CLI: `pilotage version` prints the installed version and short commit, and the version reported by a running
  server (with a hint to restart when the two differ).

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

[Unreleased]: https://github.com/Ya-zid/pilotage/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Ya-zid/pilotage/releases/tag/v0.1.0
