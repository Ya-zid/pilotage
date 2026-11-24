# Contributing

Thanks for looking. Pilotage is a small project with one maintainer, so short, focused pull requests work best.
For anything bigger than a fix, open an issue first so we can agree on the shape:
https://github.com/Ya-zid/pilotage/issues

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

- [Ways to contribute](#ways-to-contribute)
- [Your first contribution](#your-first-contribution)
- [Setup](#setup)
- [Try the demo world](#try-the-demo-world)
- [Where things live](#where-things-live)
- [Checks before a pull request](#checks-before-a-pull-request)
- [Ground rules](#ground-rules)
- [Style](#style)
- [Commit messages](#commit-messages)
- [Pull requests and review](#pull-requests-and-review)
- [No personal data](#no-personal-data)

## Ways to contribute

- **Report a bug.** Use the bug form (https://github.com/Ya-zid/pilotage/issues/new/choose). Say which platform and
  versions you use, and paste the relevant lines of `data/logs/server.log` after removing names, paths and tokens.
- **Test on Linux or macOS.** Pilotage is used every day on WSL2; the other platforms get far less testing. Follow
  the README's [Quick start](README.md#quick-start) and report what worked and what didn't, even if everything
  worked. The [Platforms](README.md#platforms) table is what the project claims today.
- **Improve the docs.** Unclear steps in the README or [docs/PHONE.md](docs/PHONE.md) (for example the certificate
  menus on your phone brand), missing explanations, typos.
- **Fix bugs and build features.** Pick an open issue (see below). For a new feature, open an issue or a discussion
  first.
- **Ask questions and share ideas** in [Discussions](https://github.com/Ya-zid/pilotage/discussions).
- **Security problems** go to private vulnerability reporting, never to a public issue: see [SECURITY.md](SECURITY.md).

## Your first contribution

1. Find an issue labelled
   [good first issue](https://github.com/Ya-zid/pilotage/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
   or [help wanted](https://github.com/Ya-zid/pilotage/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
2. Say in the issue that you'd like to take it, so two people don't work on the same thing. For anything bigger than
   a small fix, describe your plan in the issue and wait for an OK before writing a lot of code. A plan agreed early
   saves you a rewrite.
3. Fork the repository, create a branch, make the change and run the [checks](#checks-before-a-pull-request).
4. Open a pull request. The template asks what changed, why, and how you tested it.

Stuck? Ask in the issue or in Discussions. No question is too small.

## Setup

You need Node.js 22+, git, bash, curl and openssl (the TLS tests call it). Claude Code is not needed for the tests.

```bash
git clone https://github.com/<you>/pilotage.git && cd pilotage
npm install && npm --prefix web install
npm test                           # server tests (node:test): temp data dir, no AI, no forwarder
cd web && npx tsc --noEmit -p .    # type-check the web app
```

Run a throwaway server next to your real one (it never touches your real `data/`):

```bash
npm run build                      # the server serves web/dist (same as bin/pilotage build)
PILOTAGE_DATA=/tmp/pilotage-dev PILOTAGE_PORT=4799 PILOTAGE_LAN_INTERNAL_PORT=4798 \
  PILOTAGE_NO_AI=1 PILOTAGE_NO_FORWARDER=1 node server/index.js
```

It reads your sessions and projects (read-only, as Pilotage always does) and writes only to `/tmp/pilotage-dev`. To
sign in, get a one-time login link from a second terminal and open it in your browser:

```bash
PILOTAGE_DATA=/tmp/pilotage-dev PILOTAGE_PORT=4799 node server/cli.js login-url
```

For UI work with hot reload, run Vite against that server:

```bash
PILOTAGE_API=http://127.0.0.1:4799 npm --prefix web run dev    # http://localhost:5199
```

Then open the login link with `pilotage.localhost:4799` replaced by `localhost:5199`: Vite forwards `/api` and
`/auth` to the server. Without `PILOTAGE_API`, Vite talks to port 4747, your real Pilotage. `VITE_PORT` changes
Vite's own port.

`bin/pilotage build` rebuilds the web app (`web/dist`) and `bin/pilotage restart` restarts the server; both act on
the Pilotage you run from this clone.

## Try the demo world

`scripts/demo/` builds a fictional world (a developer called Alex, 8 projects, about six weeks of Claude Code and
Codex sessions, summaries, tasks and a few "running" sessions) and starts Pilotage on it. Use it for UI work,
screenshots and bug reproductions without your own data.

```bash
npm run build                      # once: the demo serves web/dist
scripts/demo/run-demo.sh           # builds the world in /tmp/pilotage-demo, serves it on port 4963, prints a login link
scripts/demo/run-demo.sh --login   # a new login link
scripts/demo/stop-demo.sh          # stop it
```

The demo server runs with an empty environment and a fake home folder: nothing from your shell, `~/.claude`,
`~/.codex` or git config reaches it, it makes no AI calls, and your own Pilotage is not touched.
`scripts/demo/shoot.mjs` takes the screenshots in `docs/images` and `scripts/demo/record.mjs` records the README GIF
(both need Playwright; the GIF also needs Pillow).

## Where things live

How the pieces fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
server/                 Node server (ES modules, no framework)
  index.js              listeners, auth, core routes, SSE (/api/events), background loops
  routes/               feature modules loaded at startup: plan.js (today's plan, triage), providers.js (AI
                        providers, harnesses), reports.js (standup, session export, token usage), scout.js
                        (project scout), work.js (tasks, spin-offs, new projects)
  sources/              read-only inputs: sessions.js (transcript indexer), harness/ (Codex and Gemini adapters),
                        projects.js (project registry), git.js, live.js (running sessions), processes.js (dev servers)
  ai/                   engine.js (queue, guard, summaries, today's plan, CV), scout.js, providers.js,
                        runner.js (headless claude -p), usage.js (5-hour and weekly usage)
  work/                 extract.js (suggested tasks), store.js (data/work.json), spinoff.js (spin-offs)
  views.js              read model: everything the web app renders
  auth.js               pairing, device cookies, Host allow-list, rate limits
  store.js              settings and state (data/state.json), atomic writes, daily backups
  launch.js             starting and resuming sessions (a terminal tab or window, or claude --bg)
  terminal.js           which terminal to open: Windows Terminal (WSL), Terminal.app (macOS), a Linux emulator
  net.js  tls.js        phone access (forwarder, firewall rule, direct bind); phone HTTPS (local CA)
  config.js             paths, ports, platform detection (IS_WSL)
  profile.js            the user's name (settings.profile.name)
  util.js               shared helpers, including redact()
web/                    React + TypeScript app (Vite)
  src/main.tsx          routes
  src/pages/            one file per page: Today (Home), Sessions, Session, Projects, Project, Tasks, Ideas,
                        Timeline (History), Portfolio, Settings, Guide, More
  src/components/       ui.tsx (primitives), cards.tsx, Layout.tsx, and a folder per feature: project/,
                        session/, tasks/, ideas/, settings/, timeline/, today/, portfolio/
  src/api.ts            api() fetch helper (adds X-Pilotage), React Query hooks, SSE → cache invalidation
  src/styles.css        design tokens; page CSS uses tokens only (docs/DESIGN.md)
  public/               icons, manifest, service worker
tests/                  node:test suites (npm test)
scripts/                leak-scan.sh (+ leak-allowlist.txt), demo/ (the demo world), export-public.sh
windows/                forwarder.js (the phone forwarder; runs on Windows), pilotage.ico
bin/pilotage            the CLI (bash)
docs/                   ARCHITECTURE.md, PHONE.md, DESIGN.md, SIMPLIFY.md, API-*.md, images/
```

## Checks before a pull request

```bash
npm test                           # server tests
cd web && npx tsc --noEmit -p .    # type-check the web app (if you changed web/)
npm run leak-scan                  # no personal data or secrets
npm run build                      # the web app still builds (if you changed web/)
```

CI runs the same on every pull request ([.github/workflows/ci.yml](.github/workflows/ci.yml)): `npm ci` for the
server and the web app, `npm test`, the type-check, the leak scan and a Vite build, on Ubuntu with Node 22.

Also try your change by hand, on the throwaway server or the demo world. For UI changes, check a desktop width and a
phone width (about 390 px): the phone is a first-class layout ([docs/DESIGN.md](docs/DESIGN.md)).

## Ground rules

- **Read-only toward the user's projects and agent folders** (`~/.claude`, `~/.codex`, `~/.gemini`). Pilotage never
  writes there. The single, opt-in exception is `server/claude-trust.js` (Claude Code's folder-trust flag in
  `~/.claude.json`); don't add others. Every git call uses `--no-optional-locks`.
- **Security stays tight**: every `/api` route needs a paired device or the CLI key; mutating routes need
  `X-Pilotage: 1` + JSON; keep the Host allow-list and the 127.0.0.1 bind. See [SECURITY.md](SECURITY.md).
- **Launch inputs are checked**: the folder must be a known project or worktree, names go through `sanitizeName()`,
  and prompts reach the agent through a file and after `--`, never through a shell command line.
- **AI work goes through the engine queue** (`server/ai/engine.js`) and its usage guard. AI providers get no tools.
- **The user's name comes from Settings** (`settings.profile.name`, `server/profile.js`). Never hardcode a name or a
  gender in prompts or UI text.
- **Windows-only code is gated on `config.IS_WSL`** (Windows Terminal, `explorer.exe`, the forwarder, the firewall).
  Plain Linux and macOS must keep working.
- **No new dependencies** without a good reason. The server has one (`qrcode`).
- **Tests** for server logic go in `tests/` and must not need a network, an AI provider, a real `$HOME` or Windows.

## Style

- Plain modern JavaScript (ES modules) on the server, TypeScript + React in `web/`. Match the code around you.
- UI: follow [docs/DESIGN.md](docs/DESIGN.md) (tokens, components) and the words in [docs/SIMPLIFY.md](docs/SIMPLIFY.md)
  (Project, Session, Workstream, Task, Idea).
- Comments explain why, not what. User-facing text is short, plain English, no jargon.
- Using an AI coding agent? [CLAUDE.md](CLAUDE.md) has these rules in short form for agents working on this
  repository. You are still responsible for what you submit: read the whole diff before you open a pull request.

## Commit messages

One line that says what changed, in plain words. An area prefix helps (`WSL:`, `Phone:`, `Tests:`, `README:`). Put
the reason or details in parentheses or in the body. No `feat:` / `fix:` prefixes needed. Examples from the
project's history (some shortened):

```
WSL: self-heal when Windows loses Pilotage's ports in the localhost relay
Tests: assemble fake secrets at runtime (GitHub push protection flags secret-shaped literals)
README: don't overclaim secret redaction
Device cookie SameSite=Lax (opening from a home-screen icon showed 'not paired' until a reload)
```

## Pull requests and review

- One change per pull request. Split unrelated fixes into separate ones.
- Fill in the template: what and why, the linked issue (`Fixes #123`), how you tested it, and before/after
  screenshots with fictional data for UI changes.
- Update the docs when behavior changes, and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) when
  users will notice.
- Review is done by one maintainer, on a best-effort basis: it is a side project. Expect a first reply within a
  couple of weeks; if two weeks pass with no answer, a short ping on the pull request is welcome.
- Review looks at the ground rules above (read-only, security, no personal data), whether the change still works on
  WSL2 and on plain Linux and macOS, tests for server logic, and the design and vocabulary rules for UI. Being asked
  for changes is normal.
- By contributing, you agree that your contribution is released under the [MIT License](LICENSE), like the rest of
  the project.

## No personal data

Fixtures, docs, screenshots and examples must not contain real names, clients, e-mail addresses, IP addresses, home
folder paths (`/home/<you>`), or anything copied from your own transcripts. Use fictional ones (`/home/alex/acme`,
"Sam"). Run the scan before you open a pull request:

```bash
npm run leak-scan
```

It flags credentials that look real, e-mail addresses and home-folder paths, in file contents and in file names.
Maintainers can add a private pattern list (`scripts/leak-patterns.txt`, never committed to the public repository)
for names that must never appear. `scripts/smoke-npm.sh` (CI) also scans the packed npm package, built web app
included (`leak-scan.sh --package DIR`).
