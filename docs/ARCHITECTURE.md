# Architecture

A short map of how Pilotage works, for contributors. The code is the reference. Security rules:
[SECURITY.md](../SECURITY.md); UI contract: [DESIGN.md](DESIGN.md) and [SIMPLIFY.md](SIMPLIFY.md); API contracts:
`docs/API-*.md`.

```
~/.claude  ~/.codex  ~/.gemini  git repos  project folders                       (read-only)
  │  server/sources/: sessions.js + harness/, projects.js, git.js, live.js, processes.js
  ▼
data/index/ (sessions, turns) + ProjectRegistry ──► server/ai/engine.js (queue + guard) ──► data/ai.json
  │                                                                                         │
  ▼                                                                                         │
server/views.js (read model) ◄──────────────────────────────────────────────────────────────┘
  │
  ▼
server/index.js + server/routes/*.js ── JSON + SSE (/api/events) ──► web/ (React, built into web/dist)
```

## One process, two listeners

`server/index.js` is a plain Node HTTP server (no framework). It opens two listeners, both on 127.0.0.1 by default:

| Listener | Port (default) | Who uses it |
|---|---|---|
| PC listener | `PILOTAGE_PORT` (4747) | the PC browser and the `pilotage` CLI |
| Phone listener | `PILOTAGE_LAN_INTERNAL_PORT` (4746) | phones, through the Windows forwarder (WSL) |

The phone listener is a raw TCP server that reads the first byte of each connection: `0x16` (a TLS handshake) goes
to an HTTPS server, anything else to an HTTP server. Both call the same `handle()`, with `req.viaLan` set. On Linux
and macOS, `PILOTAGE_LAN_BIND` makes it bind `PILOTAGE_LAN_PORT` (4748) directly, and each connection is checked
against `PILOTAGE_LAN_ALLOW` first (`lanConnectionAllowed()` in `server/net.js`).

## Request flow

`handle()` in `server/index.js`, in order:

1. Check the `Host` header (`hostAllowed()` in `server/auth.js`): loopback names on the PC listener; IP addresses
   and VPN host names on the phone listener. Anything else gets `421`.
2. Public endpoints: `/healthz`, `/pilotage-ca.crt` (a certificate, never a key), `/auth/pair` and `/auth/login`
   (one-time codes, rate-limited on failure).
3. `/api/*` needs either the CLI's desktop key (`X-Pilotage-Key`, PC listener only) or a paired device (the
   `pl_dev` cookie, checked against hashed tokens in `data/secrets.json`). Otherwise `401`.
4. Mutating methods need `X-Pilotage: 1` and `Content-Type: application/json` (CSRF guard).
5. PC-only routes (`LOCAL_ONLY`, and routes registered with `{ localOnly: true }`) are refused on the phone listener.
6. The first route whose method and regex match runs as `handler(req, res, { m, url, body, dev, viaLan })`.
7. Anything else is the static app from `web/dist`: icons and hashed assets are public, the app shell needs a
   paired device. Every response carries the security headers (`SEC_HEADERS`).

## Feature modules

Core routes live in `server/index.js`. Larger features are modules in `server/routes/` (`plan.js`, `providers.js`,
`scout.js`, `work.js`). At startup every `server/routes/*.js` is imported in alphabetical order and its default
export is called:

```js
export default function ({ route, ctx }) {
  route('GET', '/api/example/([a-f0-9]{12})', async (req, res, { m }) => ctx.json(res, { id: m[1] }));
}
```

`route(method, pattern, handler, { localOnly })` adds to the core's route table. `ctx` carries the shared objects
(`index`, `registry`, `store`, `live`, `ai`, `views`, `secrets`) and helpers: `json`, `fail`, `send`, `broadcast`,
`cached`, `projectsList`, `every(ms, fn)` for background loops, `extendOverview(fn)` to add fields to
`/api/overview`, and `log`. A module that fails to load is logged and skipped; the server still starts.

## Live updates (SSE)

`GET /api/events` is a server-sent events stream. Code that changes data calls `broadcast(kind)` (`sessions`,
`projects`, `live`, `ai-data`, `work`, `scout`, ...). Kinds are batched for about 700 ms and sent as `event: change`
with `{ kinds, gen }`; `broadcast` also clears the server's memo cache. `web/src/api.ts` maps each kind to React
Query keys (`KIND_TO_KEYS`) and invalidates them, so pages refetch by themselves. A new kind needs an entry there.

## Data flow

- **Sources** (`server/sources/`, read-only). `sessions.js` indexes Claude Code transcripts (and, on WSL, the
  Windows-side ones, plus `history.jsonl`) incrementally: it keeps each file's byte offset and parses only new
  bytes. `harness/codex.js` and `harness/gemini.js` are adapters with the same output shape. Secrets are redacted
  (`redact()` in `server/util.js`) before anything is stored.
- **Index** (`data/index/`): session meta and turns (prompt, final reply, tool count, byte offset). Turn detail is
  read from the transcript at the stored offset when a page asks for it.
- **Registry** (`sources/projects.js`): walks your home folder (3 levels by default) and extra folders from
  Settings for git repos, `CLAUDE.md` folders and code folders, and builds workspace → project → worktrees and
  sessions. Git runs through `sources/git.js` with `--no-optional-locks`, hooks, fsmonitor and signature checks off,
  never uses the network (`GIT_ALLOW_PROTOCOL=''`), and skips `git status` in repos whose own config names a program
  (filters, git-lfs extensions or transfer agents): a downloaded repo is untrusted.
- **Live** (`sources/live.js`): running Claude sessions from `claude agents --json` and Claude's state files.
  `sources/processes.js` finds dev servers and maps them to projects.
- **State**: `server/store.js` keeps settings, renames, ideas and decisions in `data/state.json` (atomic writes,
  daily backups). Tasks and spin-offs are in `data/work.json` (`server/work/store.js`).
- **Read model** (`server/views.js`): turns all of the above into what the pages show (overview, project detail,
  session lists, history, search).

Background loops in `start()`: session scan every 8 s, live state every 5 s while a page is open, dev servers every
30 s, git every 60 s, an AI tick every 45 s, the phone certificate check every minute.

## AI engine

`server/ai/engine.js` (`AIEngine`) owns every AI call.

- A **work block** is a run of turns without a 4-hour gap (`computeBlocks`). Each block gets a digest, each project
  a summary with workstreams, each day a plan; portfolio entries on request. The scout (`ai/scout.js`) runs last.
- One **queue**, highest priority first (block digests, summaries, today's plan, then the scout), 1 to 4 jobs at
  once (Settings, default 2).
- The **guard** (`guard()`) holds automatic jobs back when AI is off or paused, for a while after a provider error,
  when Pilotage's own call caps are used up (per 5 hours, per day, and a daily cap for non-Claude providers), or
  when Claude's 5-hour or weekly usage is above its limit (`ai/usage.js` reads `~/.claude/rate_limits.json`).
  Jobs you start by hand ("Summarize now") skip the guard; the non-Claude daily cap still applies in `callAI()`.
- Results are cached in `data/ai.json` with a hash of their input, and redone only when the input changes.
- **Providers** (`ai/providers.js`, `callAI()`): `claude -p` (`ai/runner.js`: no tools, no MCP, no slash commands,
  no session persistence, run in a private temp folder with no CLAUDE.md above it: `config.aiWorkDir()`), `codex exec`
  (read-only sandbox, same folder), or an OpenAI-compatible API.
- Task suggestions (`server/work/extract.js`) make no AI calls: they come from the digests and summaries.

## Phone path

On WSL2 + Windows:

```
phone ──Wi-Fi / VPN──► Windows: pilotage-forwarder.exe on 0.0.0.0:4748
                         (windows/forwarder.js run by a copy of node.exe; VPN ranges always,
                          Wi-Fi neighbours only on a trusted network)
                     ──► 127.0.0.1:4746 ──WSL localhost relay──► phone listener ──► handle() (viaLan)
```

`server/net.js` writes the forwarder's config, starts it, and manages its Windows Firewall rule (one admin prompt).
`server/tls.js` creates a local, name-constrained certificate authority in `data/tls/` and a server certificate for
the PC's current addresses, so phones can use HTTPS on the same port. After sleep or a network change, Windows can
lose the relayed ports: a watchdog asks Windows once a minute (`curl.exe`) and re-opens both listeners after two
misses. Details: [PHONE.md](PHONE.md).

## CLI

`bin/pilotage` (bash) starts and stops the server (pid in `data/pilotage.pid`, log in `data/logs/server.log`),
builds the web app and installs the Windows shortcuts. Commands that talk to the running server go through
`server/cli.js`, which sends the desktop key from `data/secrets.json`.
