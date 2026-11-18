# Pilotage — notes for Claude sessions working on this repo

Pilotage is a local web cockpit for Claude Code / Codex / Gemini CLI sessions (see README.md for the user view,
SECURITY.md for the security model, CONTRIBUTING.md for the rules).

## Run / test
- Node 22+. If `node -v` is older, put an nvm install first on PATH (`~/.nvm/versions/node/v22.*/bin`).
- `npm test` → node:test suites in tests/ (they start a server on a spare port with a temp data dir, no AI, no forwarder).
- `cd web && npx tsc --noEmit -p .` type-checks the web app.
- `bin/pilotage restart` after server changes; `bin/pilotage build` after web/ changes (tsc + vite → web/dist). Both act
  on the user's running instance: ask before doing it.
- Never `pkill -f` with a pattern that also matches your own shell command line; stop via `pilotage stop` or data/pilotage.pid.
- For experiments use `PILOTAGE_DATA=<tmp> PILOTAGE_PORT=4799 PILOTAGE_LAN_INTERNAL_PORT=4798 PILOTAGE_NO_AI=1 PILOTAGE_NO_FORWARDER=1 node server/index.js`.
- `npm run leak-scan` before publishing anything: no real names, clients, paths, addresses or keys in code, fixtures or docs.

## Hard rules
- Read-only toward the user's projects and ~/.claude, ~/.codex, ~/.gemini (never write the agents' files; session renames live in data/state.json).
  Only exception: server/claude-trust.js sets Claude Code's folder-trust flag in ~/.claude.json, opt-in (setting or launch checkbox), under Claude's lock.
- Every git call uses `--no-optional-locks`.
- Every /api route needs a paired device (cookie) or the CLI desktop key header; mutating routes need `X-Pilotage: 1` + JSON.
  Keep the Host allow-list (DNS-rebinding guard) and the 127.0.0.1 bind.
- Launch inputs: cwd must be a known project/worktree; names go through sanitizeName; prompts are passed via a file + `--`.
- AI work goes through ai/engine.js queue + guard (usage thresholds). `claude -p` runs with no tools/MCP/persistence in data/ai-sandbox.
- The user's name in prompts and UI comes from settings.profile.name (server/profile.js); never hardcode a name or a gender.
- Windows-only paths (Windows Terminal, explorer.exe, the forwarder, firewall) are gated on config.IS_WSL; plain Linux/macOS must keep working.

## Data model (server/views.js is the read model)
- Session meta + turns (prompt, final reply, tool count, byte offset) cached in data/index/. Turn detail is read from
  the transcript at the stored offset.
- Work block = run of turns without a 4 h gap (computeBlocks). Digest per block (Haiku) → project brief groups blocks
  into threads. Hashes decide when to redo.
- Project = git repo root (worktrees attach to the main repo) or non-git folder; workspace = top folder under ~
  (display names and `mergeInto` folds in state.json `workspaces`; generic defaults in server/workspaces.js).
- Design system: docs/DESIGN.md; vocabulary and page contracts: docs/SIMPLIFY.md; API contracts: docs/API-*.md.
