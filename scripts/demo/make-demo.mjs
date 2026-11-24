#!/usr/bin/env node
// Pilotage demo world
// ===================
//
// Builds a fake, self-contained world for Pilotage: a fictional developer ("Alex Rivera") with 8 projects in 4
// workspaces, ~6 weeks of Claude Code and Codex sessions, AI summaries, tasks, possible projects and a few sessions
// that are "running" right now. Use it for screenshots, UI work and trying Pilotage without your own data.
// Everything in it is made up (the content lives in world.mjs).
//
//   scripts/demo/run-demo.sh          build a fresh world and start Pilotage on it (port 4963, no AI calls)
//   scripts/demo/stop-demo.sh         stop that server and the fake running sessions
//   scripts/demo/shoot.mjs            screenshots + hero image into docs/images (needs Playwright)
//
//   node scripts/demo/make-demo.mjs [--dir DIR] [--no-live] [--live-only] [--stop-live]
//     --dir DIR     where to build (default: $PILOTAGE_DEMO_DIR or /tmp/pilotage-demo). DIR is wiped and rebuilt;
//                   it must be empty, missing, or an earlier demo (it holds a .pilotage-demo marker).
//     --no-live     don't start the fake running sessions
//     --live-only   only restart the fake running sessions of an existing world
//     --stop-live   only stop them
//
// Layout of DIR:
//   home/alex/                         fake $HOME
//     clients/ saas/ lab/ oss/         8 git repos (author Alex Rivera <alex@example.com>), commits over ~6 weeks,
//                                      a branch, a worktree and some uncommitted changes
//     .claude/projects/<key>/*.jsonl   Claude Code transcripts in the real format (prompts, replies, tool calls)
//     .claude/history.jsonl            every typed prompt, including older "archived" sessions with no transcript
//     .claude/sessions/<pid>.json      running sessions: each pid is a `sleep` process started by this script
//     .claude/jobs/<id>/state.json     a background (`claude --bg`) session and its live detail line
//     .claude/rate_limits.json         usage meters (5-hour / weekly)
//     .codex/sessions/YYYY/MM/DD/      two Codex CLI rollouts
//     .local/bin/claude                stub: answers `claude agents --json` with the fake background session and
//                                      refuses everything else, so the demo never starts a real Claude session
//   win/Users/alex/                    empty fake Windows profile (PILOTAGE_WIN_HOME), so the real one is never read
//   data/                              PILOTAGE_DATA: state.json, secrets.json, ai.json, work.json
//   live.pids                          the sleep processes (stop-demo.sh kills them)
//
// Why /tmp and not <repo>/.sandbox: Pilotage hides everything under .sandbox (config.js INTERNAL_PATHS), and a path
// under your own home would show your user name in the screenshots.
//
// Timestamps are relative to now: rebuild (run-demo.sh does it by default) before taking screenshots another day.
// Block keys and hashes come from the server's own parser (server/sources/sessions.js, server/ai/engine.js), so the
// AI summaries always match the transcripts. Suggested tasks are not written here: Pilotage's extractor makes them
// from the summaries when the server starts, exactly as it does with real data.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as W from './world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ------------------------------------------------------------------------------------------------ args + paths

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const DIR = path.resolve(opt('--dir') || process.env.PILOTAGE_DEMO_DIR || '/tmp/pilotage-demo');
const HOME = path.join(DIR, 'home', W.OWNER.user);
const WIN_HOME = path.join(DIR, 'win', 'Users', W.OWNER.user);
const DATA = path.join(DIR, 'data');
const CLAUDE = path.join(HOME, '.claude');
const PIDS = path.join(DIR, 'live.pids');
const MARKER = path.join(DIR, '.pilotage-demo');

const NOW = Date.now();
const MIN = 60e3;
const DAY = 86400e3;

// ------------------------------------------------------------------------------------------------ small helpers

let seed = 0x5eed2026;
function rnd() {
  // mulberry32: deterministic, so two builds differ only by the clock
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rnd() * 4)]}${hex(3)}-${hex(12)}`;
// Random ids for ids shown or stored: an alphabet without the letters that could spell a real name by chance.
const SAFE = 'abcdefgimnopqruwxzABCDEFGIMNOPQRUWXZ0123456789';
const safeId = (n) => Array.from({ length: n }, () => SAFE[Math.floor(rnd() * SAFE.length)]).join('');

function localTime(dayOffset, hhmm) {
  const d = new Date(NOW);
  d.setDate(d.getDate() + dayOffset);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, between(0, 50), between(0, 999));
  return d.getTime();
}
const iso = (t) => new Date(t).toISOString();
const isoDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const projectKeyFor = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const writeJSON = (file, data) => write(file, `${JSON.stringify(data, null, 2)}\n`);

// ------------------------------------------------------------------------------------------------ live processes

function procStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch {
    return null;
  }
}

/** Kill the sleep processes of an earlier run (only if they still are our sleeps). */
function stopLive() {
  let pids = [];
  try {
    pids = fs.readFileSync(PIDS, 'utf8').split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return 0;
  }
  let n = 0;
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!/^sleep\0/.test(cmd)) continue;
      process.kill(pid, 'SIGTERM');
      n++;
    } catch {}
  }
  fs.rmSync(PIDS, { force: true });
  return n;
}

/** Start one `sleep` per running session and write the files Pilotage reads for live state. */
function startLive(live) {
  stopLive();
  const sessDir = path.join(CLAUDE, 'sessions');
  fs.rmSync(sessDir, { recursive: true, force: true });
  fs.mkdirSync(sessDir, { recursive: true });
  const pids = [];
  const agents = [];
  for (const l of live) {
    const child = spawn('sleep', ['86400'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid;
    pids.push(pid);
    const procStart = procStartTicks(pid);
    const file = {
      pid,
      sessionId: l.sessionId,
      cwd: l.cwd,
      startedAt: l.startedAt,
      procStart,
      version: '2.1.325',
      peerProtocol: 1,
      kind: l.kind === 'background' ? 'bg' : 'interactive',
      entrypoint: 'cli',
      name: l.name,
      nameSource: 'user',
      status: l.status,
      updatedAt: l.lastAt,
      statusUpdatedAt: l.lastAt,
      ...(l.waitingFor ? { waitingFor: l.waitingFor } : {}),
      ...(l.jobId ? { jobId: l.jobId } : {}),
      bridgeSessionId: l.bridgeSessionId,
    };
    writeJSON(path.join(sessDir, `${pid}.json`), file);
    if (l.kind === 'background') {
      agents.push({ pid, id: l.jobId, cwd: l.cwd, kind: 'background', startedAt: l.startedAt, sessionId: l.sessionId, name: l.name, status: l.status, state: l.state });
      writeJSON(path.join(CLAUDE, 'jobs', l.jobId, 'state.json'), {
        state: l.state,
        detail: l.detail,
        tempo: 'active',
        name: l.name,
        nameSource: 'user',
        sessionId: l.sessionId,
        cwd: l.cwd,
        createdAt: iso(l.startedAt),
        updatedAt: iso(NOW - 20e3),
        bridgeSessionId: l.bridgeSessionId,
        output: null,
      });
    }
  }
  writeJSON(path.join(CLAUDE, 'demo-agents.json'), agents);
  const u = W.USAGE;
  writeJSON(path.join(CLAUDE, 'rate_limits.json'), {
    saved_at: Math.floor(NOW / 1000),
    five_hour: { used_percentage: u.fiveHourPct, resets_at: Math.floor((NOW + u.fiveHourResetsInMin * MIN) / 1000) },
    seven_day: { used_percentage: u.sevenDayPct, resets_at: Math.floor((NOW + u.sevenDayResetsInDays * DAY) / 1000) },
  });
  fs.writeFileSync(PIDS, `${pids.join('\n')}\n`);
  return pids;
}

// ------------------------------------------------------------------------------------------------ entry

if (flag('--stop-live')) {
  console.log(`stopped ${stopLive()} demo session process(es)`);
  process.exit(0);
}
if (flag('--live-only')) {
  const live = JSON.parse(fs.readFileSync(path.join(DIR, 'live.json'), 'utf8'));
  const pids = startLive(live);
  console.log(`restarted ${pids.length} running demo sessions`);
  process.exit(0);
}

// Never wipe a folder that isn't an earlier demo.
if (fs.existsSync(DIR)) {
  const empty = fs.readdirSync(DIR).length === 0;
  if (!empty && !fs.existsSync(MARKER)) {
    console.error(`${DIR} exists and is not a Pilotage demo folder (no .pilotage-demo marker). Pick another --dir.`);
    process.exit(1);
  }
  stopLive();
  fs.rmSync(DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(MARKER, 'Pilotage demo world (scripts/demo/make-demo.mjs). Safe to delete.\n');
fs.mkdirSync(WIN_HOME, { recursive: true });
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

const projPath = (p) => path.join(HOME, W.PROJECTS[p].dir);

// ------------------------------------------------------------------------------------------------ home basics

write(path.join(HOME, '.gitconfig'), `[user]\n\tname = ${W.OWNER.fullName}\n\temail = ${W.OWNER.email}\n[init]\n\tdefaultBranch = main\n`);
write(path.join(HOME, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n');
write(path.join(CLAUDE, 'settings.json'), '{\n  "permissions": { "defaultMode": "bypassPermissions" }\n}\n');
write(
  path.join(HOME, '.local', 'bin', 'claude'),
  '#!/bin/sh\n# Pilotage demo stub for `claude`: answers `claude agents --json` from the demo files and refuses the rest,\n# so nothing in the demo can start a real Claude session or use a real account.\nif [ "$1" = "agents" ]; then\n  cat "$(dirname "$0")/../../.claude/demo-agents.json" 2>/dev/null || echo "[]"\n  exit 0\nfi\necho "claude: this is the Pilotage demo stub (scripts/demo/make-demo.mjs)" >&2\nexit 1\n',
);
fs.chmodSync(path.join(HOME, '.local', 'bin', 'claude'), 0o755);

// ------------------------------------------------------------------------------------------------ session timelines

/** Turn a session spec into timed events: [{kind:'prompt'|'tool'|'result'|'reply'|'pre', t, ...}] */
function timeline(s) {
  const start = s.ago != null ? NOW - s.ago * MIN : localTime(s.day, s.at);
  const ex = s.x;
  const target = s.live ? { busy: NOW - 25e3, waiting: NOW - 7 * MIN, idle: null }[s.live.status] : null;
  const out = [];
  let t = start;
  ex.forEach(([prompt, tools, reply, gap], i) => {
    const last = i === ex.length - 1;
    let p = t;
    let step = () => between(15, 45) * 1000;
    if (last && target) {
      const span = tools.length * 45e3 + (reply ? 40e3 : 0);
      p = Math.max(t, target - span - 30e3);
      const n = tools.length * 2 + (reply ? 1 : 0) + 1;
      const each = Math.max(4e3, Math.floor((target - p) / n));
      step = () => each;
    }
    out.push({ kind: 'prompt', t: p, text: prompt, i });
    let c = p + between(3, 9) * 1000;
    if (tools.length) {
      out.push({ kind: 'pre', t: c, i });
      for (let k = 0; k < tools.length; k++) {
        c += step();
        out.push({ kind: 'tool', t: c, spec: tools[k], i, k, open: !reply && k === tools.length - 1 });
        if (!reply && k === tools.length - 1) break; // still running
        c += Math.min(step(), between(2, 12) * 1000);
        out.push({ kind: 'result', t: c, spec: tools[k], i, k });
      }
    }
    if (reply) {
      c += step();
      out.push({ kind: 'reply', t: c, text: reply, i });
    }
    t = c + (gap || between(4, 9)) * MIN;
  });
  return { start, events: out, end: out[out.length - 1].t };
}

const PRE = ["I'll start by reading the relevant code.", 'Let me look at how this works today.', 'Looking at the current setup first.', "Let me check what's there before changing anything."];

function parseTool(spec, cwd) {
  const sp = spec.indexOf(' ');
  const op = spec.slice(0, sp);
  const rest = spec.slice(sp + 1);
  const abs = (p) => (p.startsWith('/') ? p : path.join(cwd, p));
  switch (op) {
    case 'R':
      return { name: 'Read', input: { file_path: abs(rest) }, result: `     1\t${readStub(abs(rest))}` };
    case 'E':
      return { name: 'Edit', input: { file_path: abs(rest), old_string: '…', new_string: '…' }, result: `The file ${abs(rest)} has been updated.`, file: rest };
    case 'W':
      return { name: 'Write', input: { file_path: abs(rest), content: '…' }, result: `File created successfully at: ${abs(rest)}`, file: rest, created: true };
    case 'G':
      return { name: 'Grep', input: { pattern: rest, path: cwd, output_mode: 'files_with_matches' }, result: 'Found 2 files' };
    case 'F':
      return { name: 'WebFetch', input: { url: rest, prompt: 'Summarize the parts relevant to this task' }, result: 'Received 61.4KB (200 OK)' };
    case 'B':
    case 'shell': {
      const [cmd, ...o] = rest.split(' | ');
      return { name: op === 'B' ? 'Bash' : 'shell', input: { command: cmd, ...(op === 'B' ? { description: describe(cmd) } : {}) }, result: o.join(' | ') || '' };
    }
    default:
      throw new Error(`unknown tool spec ${spec}`);
  }
}
function describe(cmd) {
  if (/playwright test/.test(cmd)) return 'Run the Playwright tests';
  if (/vitest/.test(cmd)) return 'Run the unit tests';
  if (/^git /.test(cmd)) return 'Commit the changes';
  if (/migrate/.test(cmd)) return 'Apply the database migration';
  if (/build/.test(cmd)) return 'Build';
  return undefined;
}
function readStub(abs) {
  try {
    return fs.readFileSync(abs, 'utf8').split('\n')[0] || '';
  } catch {
    return '// …';
  }
}

// ------------------------------------------------------------------------------------------------ git repos

const GIT_ENV = { PATH: process.env.PATH, HOME, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', TZ: process.env.TZ || '' };
if (!GIT_ENV.TZ) delete GIT_ENV.TZ;
function git(cwd, args, at) {
  const env = { ...GIT_ENV };
  if (at) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = iso(at);
  return execFileSync('git', ['--no-optional-locks', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
const COMMENT = { '.ts': '//', '.tsx': '//', '.js': '//', '.prisma': '//', '.py': '#', '.sh': '#', '.sql': '--', '.svelte': null, '.astro': null, '.css': null, '.md': '', '.yml': '#' };
function touchFile(abs, msg) {
  const ext = path.extname(abs);
  if (!fs.existsSync(abs)) {
    const c = COMMENT[ext];
    write(abs, c === undefined || c === null ? `\n` : `${c ? `${c} ` : ''}${path.basename(abs)}\n`);
    return true;
  }
  const c = COMMENT[ext];
  if (c === undefined || c === null) return false;
  fs.appendFileSync(abs, `${c ? `${c} ` : ''}${msg}\n`);
  return true;
}

function buildRepos(sessionsByProject) {
  for (const [name, P] of Object.entries(W.PROJECTS)) {
    const root = projPath(name);
    fs.mkdirSync(root, { recursive: true });
    for (const [f, text] of Object.entries(P.files)) write(path.join(root, f), text);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'Initial commit'], localTime(P.born, '09:00'));
    let branch = 'main';
    let wt = null;
    const list = (sessionsByProject.get(name) || []).filter((s) => s.commits?.length).sort((a, b) => a.tl.start - b.tl.start);
    for (const s of list) {
      let dir = root;
      if (s.worktree && P.worktree) {
        if (!wt) {
          wt = path.join(root, '.claude', 'worktrees', P.worktree.name);
          git(root, ['worktree', 'add', '-q', '-b', P.worktree.branch, wt]);
        }
        dir = wt;
      } else if ((s.branch || 'main') !== branch) {
        branch = s.branch || 'main';
        git(root, ['checkout', '-q', '-B', branch]);
      }
      const files = [...new Set(s.x.flatMap(([, tools]) => tools.filter((x) => /^[EW] /.test(x)).map((x) => x.slice(2))))];
      s.commits.forEach((msg, i) => {
        const mine = files.filter((_, k) => k % s.commits.length === i);
        let changed = false;
        for (const f of mine) changed = touchFile(path.join(dir, f), msg) || changed;
        if (!changed) fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), `- ${msg}\n`);
        const at = s.tl.end - (s.commits.length - i) * between(2, 6) * MIN;
        git(dir, ['add', '-A']);
        git(dir, ['commit', '-q', '-m', msg], Math.max(at, s.tl.start + MIN));
      });
    }
    for (const [f, text] of Object.entries(P.dirty || {})) write(path.join(root, f), text);
  }
}

// ------------------------------------------------------------------------------------------------ transcripts

const VERSION = '2.1.325';
const MODEL = 'claude-opus-5-5';
const history = [];

function writeClaudeTranscript(s) {
  const cwd = s.cwd;
  const sid = s.sessionId;
  const entry = s.automation ? 'sdk-cli' : 'cli';
  const branch = s.branch || 'main';
  const common = () => ({ userType: 'external', entrypoint: entry, cwd, sessionId: sid, version: VERSION, gitBranch: branch });
  const L = [];
  let parent = null;
  let promptId = null;
  const line = (o) => {
    L.push(JSON.stringify(o));
    if (o.uuid) parent = o.uuid;
  };
  L.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: sid }));
  const toolIds = {};
  let lastPrompt = '';
  for (const ev of s.tl.events) {
    const ts = iso(ev.t);
    if (ev.kind === 'prompt') {
      promptId = uuid();
      lastPrompt = ev.text;
      line({ parentUuid: parent, isSidechain: false, promptId, type: 'user', message: { role: 'user', content: ev.text }, uuid: uuid(), timestamp: ts, ...common() });
      if (!s.automation) history.push({ display: ev.text, pastedContents: {}, timestamp: ev.t, project: cwd, sessionId: sid });
      if (ev.i === 1 || (s.x.length === 1 && ev.i === 0)) L.push(JSON.stringify({ type: 'ai-title', aiTitle: s.title, sessionId: sid }));
    } else if (ev.kind === 'pre' || ev.kind === 'reply' || ev.kind === 'tool') {
      let content;
      let stop = 'end_turn';
      if (ev.kind === 'pre') content = [{ type: 'text', text: s.pre?.[ev.i] || PRE[between(0, PRE.length - 1)] }];
      else if (ev.kind === 'reply') content = [{ type: 'text', text: ev.text }];
      else {
        const tool = parseTool(ev.spec, cwd);
        const id = `toolu_01${safeId(22)}`;
        toolIds[`${ev.i}:${ev.k}`] = id;
        content = [{ type: 'tool_use', id, name: tool.name, input: tool.input }];
        stop = 'tool_use';
      }
      const model = s.model || MODEL;
      line({
        parentUuid: parent,
        isSidechain: false,
        message: {
          model,
          id: `msg_01${safeId(22)}`,
          type: 'message',
          role: 'assistant',
          content,
          stop_reason: stop,
          stop_sequence: null,
          usage: { input_tokens: between(3, 12), cache_creation_input_tokens: between(200, 4000), cache_read_input_tokens: between(20000, 90000), output_tokens: between(60, 1400), service_tier: 'standard' },
        },
        requestId: `req_011C${safeId(20)}`,
        type: 'assistant',
        uuid: uuid(),
        timestamp: ts,
        ...common(),
      });
      if (ev.kind === 'reply' && !s.automation) {
        line({ parentUuid: parent, isSidechain: false, type: 'system', subtype: 'turn_duration', durationMs: between(20, 240) * 1000, messageCount: between(4, 18), timestamp: ts, uuid: uuid(), isMeta: false, ...common() });
      }
    } else if (ev.kind === 'result') {
      const tool = parseTool(ev.spec, cwd);
      const id = toolIds[`${ev.i}:${ev.k}`];
      line({
        parentUuid: parent,
        isSidechain: false,
        promptId,
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: tool.result || '(no output)', is_error: false }] },
        uuid: uuid(),
        timestamp: ts,
        toolUseResult: tool.result || '',
        ...common(),
      });
    }
  }
  if (s.recap) {
    const t = s.tl.end + 40 * MIN;
    if (t < NOW) line({ parentUuid: parent, isSidechain: false, type: 'system', subtype: 'away_summary', content: `${s.recap} (disable recaps in /config)`, timestamp: iso(t), uuid: uuid(), isMeta: false, ...common() });
  }
  L.push(JSON.stringify({ type: 'last-prompt', lastPrompt, leafUuid: parent, sessionId: sid }));
  const file = path.join(CLAUDE, 'projects', projectKeyFor(cwd), `${sid}.jsonl`);
  write(file, `${L.join('\n')}\n`);
  const mt = new Date(Math.min(NOW, s.tl.end + 1000));
  fs.utimesSync(file, mt, mt);
  return file;
}

function writeCodexRollout(s) {
  const cwd = s.cwd;
  const u = s.uuid;
  const start = s.tl.start;
  const d = new Date(start);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const file = path.join(HOME, '.codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), `rollout-${stamp}-${u}.jsonl`);
  const L = [];
  const rec = (t, type, payload) => L.push(JSON.stringify({ timestamp: iso(t), type, payload }));
  rec(start, 'session_meta', { id: u, timestamp: iso(start), cwd, originator: 'codex_cli_rs', cli_version: '0.58.0', instructions: null, source: 'cli', model_provider: 'openai', git: { commit_hash: hex(40), branch: 'main', repository_url: null } });
  rec(start, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <approval_policy>on-request</approval_policy>\n  <sandbox_mode>workspace-write</sandbox_mode>\n</environment_context>` }] });
  let out = 0;
  const calls = {};
  for (const ev of s.tl.events) {
    if (ev.kind === 'prompt') {
      rec(ev.t, 'turn_context', { cwd, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: s.model, effort: 'medium', summary: 'auto' });
      rec(ev.t, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: ev.text }] });
      rec(ev.t, 'event_msg', { type: 'user_message', message: ev.text, images: [], kind: 'plain' });
    } else if (ev.kind === 'tool') {
      const tool = parseTool(ev.spec, cwd);
      const id = `call_${safeId(24)}`;
      calls[`${ev.i}:${ev.k}`] = id;
      rec(ev.t, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', tool.input.command], workdir: cwd, timeout_ms: 120000 }), call_id: id });
    } else if (ev.kind === 'result') {
      const tool = parseTool(ev.spec, cwd);
      rec(ev.t, 'response_item', { type: 'function_call_output', call_id: calls[`${ev.i}:${ev.k}`], output: JSON.stringify({ output: tool.result, metadata: { exit_code: 0, duration_seconds: between(1, 30) / 2 } }) });
    } else if (ev.kind === 'reply') {
      rec(ev.t, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ev.text }] });
      out += between(300, 1500);
      rec(ev.t, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: between(20000, 60000), cached_input_tokens: between(10000, 40000), output_tokens: out, reasoning_output_tokens: between(100, 900), total_tokens: out + 50000 } } });
    }
  }
  write(file, `${L.join('\n')}\n`);
  const mt = new Date(s.tl.end + 1000);
  fs.utimesSync(file, mt, mt);
  return file;
}

// ------------------------------------------------------------------------------------------------ build

const sessions = W.SESSIONS.map((s) => ({ ...s, harness: 'claude' }));
const codex = W.CODEX_SESSIONS.map((s) => ({ ...s, harness: 'codex' }));
const all = [...sessions, ...codex];
for (const s of all) {
  if (s.harness === 'codex') s.uuid = uuid();
  else s.sessionId = uuid();
  s.tl = timeline(s);
  if (s.tl.end > NOW) throw new Error(`${s.key} ends in the future; check its day/at`);
}
const byProject = new Map();
for (const s of all) byProject.set(s.p, [...(byProject.get(s.p) || []), s]);

buildRepos(byProject);

// cwd (after the repos exist, so the worktree path is real)
for (const s of all) {
  const P = W.PROJECTS[s.p];
  s.cwd = s.worktree && P.worktree ? path.join(projPath(s.p), '.claude', 'worktrees', P.worktree.name) : projPath(s.p);
}

// Automation runs (rss-digest, every morning)
const A = W.AUTOMATION;
const autos = [];
for (let d = -(A.days - 1); d <= 0; d++) {
  const t = localTime(d, A.at);
  if (t > NOW - 20 * MIN) continue;
  const result = A.results[(d + 100) % A.results.length];
  const s = {
    key: `auto${d}`,
    p: A.p,
    automation: true,
    model: A.model,
    title: 'Morning digest run',
    x: [[A.prompt, ['R out/items.json', 'W out/digest.md'], result]],
  };
  s.sessionId = uuid();
  s.cwd = projPath(A.p);
  s.tl = timeline({ ...s, day: d, at: A.at });
  autos.push(s);
}

for (const s of sessions) s.file = writeClaudeTranscript(s);
for (const s of autos) s.file = writeClaudeTranscript(s);
for (const s of codex) s.file = writeCodexRollout(s);

// Archived sessions: prompts in history.jsonl only (Claude Code removed their transcripts after ~30 days)
const archived = [];
for (const [name, P] of Object.entries(W.PROJECTS)) {
  for (const a of P.archived || []) {
    const sid = uuid();
    let t = localTime(a.day, a.at);
    const prompts = [];
    for (const p of a.prompts) {
      history.push({ display: p, pastedContents: {}, timestamp: t, project: projPath(name), sessionId: sid });
      prompts.push({ t, p });
      t += between(6, 25) * MIN;
    }
    archived.push({ key: `arch-${sid}`, p: name, id: sid, prompts, d: a.d, tl: { start: prompts[0].t, end: prompts[prompts.length - 1].t } });
  }
}
history.sort((a, b) => a.timestamp - b.timestamp);
write(path.join(CLAUDE, 'history.jsonl'), `${history.map((h) => JSON.stringify(h)).join('\n')}\n`);

// Claude memory files of a project (shown under Notes & docs)
for (const [name, P] of Object.entries(W.PROJECTS)) {
  for (const [f, text] of Object.entries(P.memory || {})) write(path.join(CLAUDE, 'projects', projectKeyFor(projPath(name)), 'memory', f), text);
}

// ------------------------------------------------------------------------------------------------ AI layer (ai.json)

// The server's own parser and block maths, so keys and hashes match what Pilotage computes.
process.env.HOME = HOME;
process.env.PILOTAGE_DATA = DATA;
process.env.PILOTAGE_WIN_HOME = WIN_HOME;
process.env.CODEX_HOME = path.join(HOME, '.codex');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { parseTranscriptFile } = await imp('server/sources/sessions.js');
const { parseCodexFile } = await imp('server/sources/harness/codex.js');
const { computeBlocks } = await imp('server/ai/engine.js');
const { hash, clip, redact } = await imp('server/util.js');
const { normText } = await imp('server/work/extract.js');

const PRIMARY = new Set(['h', 's', 'p']);
function blockHash(b, turns) {
  const parts = [];
  for (let i = b.i0; i <= b.i1; i++) if (PRIMARY.has(turns[i].o)) parts.push(turns[i].p.slice(0, 120));
  parts.push((turns[b.i1]?.a || '').slice(0, 300));
  return hash(parts.join('\n'), 20);
}

const blocks = {};
const blockOf = {}; // session key -> block key
for (const s of all) {
  const r = s.harness === 'codex' ? await parseCodexFile(s.file, `codex-${s.uuid}`) : await parseTranscriptFile(s.file);
  const id = s.harness === 'codex' ? `codex-${s.uuid}` : s.sessionId;
  const bl = computeBlocks({ ...r.meta, id }, r.turns);
  if (bl.length !== 1) console.warn(`warning: ${s.key} has ${bl.length} work blocks`);
  for (const b of bl) {
    blocks[b.key] = {
      hash: blockHash(b, r.turns),
      failures: 0,
      at: Math.min(NOW - 2 * MIN, b.endAt + between(12, 50) * MIN),
      model: 'claude-haiku-5-5',
      sessionId: id,
      projectPath: projPath(s.p),
      startAt: b.startAt,
      endAt: b.endAt,
      digest: s.d,
    };
    blockOf[s.key] = b.key;
  }
  s.id = id;
}

// Archived sessions: the server builds their turns from history.jsonl (sessions.js loadTurns)
for (const a of archived) {
  if (!a.d) continue;
  const turns = a.prompts.map((x) => ({ t: x.t, o: 'h', p: clip(redact(x.p), 1200), off: -1, a: '', at: 0, n: 0, e: x.t }));
  for (const b of computeBlocks({ id: a.id, startedAt: a.tl.start }, turns)) {
    blocks[b.key] = { hash: blockHash(b, turns), failures: 0, at: b.endAt + between(20, 90) * MIN, model: 'claude-haiku-5-5', sessionId: a.id, projectPath: projPath(a.p), startAt: b.startAt, endAt: b.endAt, digest: a.d };
    blockOf[a.key] = b.key;
  }
}

const projects = {};
for (const [name, B] of Object.entries(W.BRIEFS)) {
  const mine = [...all, ...archived.filter((a) => a.d)].filter((s) => s.p === name);
  const threads = B.threads.map(([tname, summary, status, topics]) => ({
    name: tname,
    summary,
    status,
    blockKeys: mine.filter((s) => topics.includes(s.d.topic)).map((s) => blockOf[s.key]),
  }));
  for (const s of mine) if (!threads.some((t) => t.blockKeys.includes(blockOf[s.key]))) console.warn(`warning: ${s.key} (${s.d.topic}) is in no workstream`);
  projects[projPath(name)] = {
    hash: hash(`demo:${name}`, 20),
    at: NOW - between(2, 9) * 60 * MIN,
    model: 'claude-haiku-5-5',
    brief: { oneLiner: B.oneLiner, description: B.description, currentState: B.currentState, nextSteps: B.nextSteps, attention: B.attention, cv: B.cv, threads },
  };
}

const startOfDay = new Date(NOW).setHours(0, 5, 0, 0);
const dailyAt = Math.max(startOfDay, NOW - 3 * 60 * MIN);
const withPath = (x) => ({ ...x, project: x.project, projectPath: projPath(x.project) });
const daily = {
  v: 2,
  day: isoDay(dailyAt),
  at: dailyAt,
  refreshes: 0,
  brief: { headline: W.DAILY.headline, focus: W.DAILY.focus.map(withPath), forgotten: W.DAILY.forgotten.map(withPath), ideas: W.DAILY.ideas },
};

const keyOf = Object.fromEntries(all.map((s) => [s.key, s]));
const scout = {};
for (const [name, S] of Object.entries(W.SCOUT)) {
  const p = projPath(name);
  const at = NOW - S.ago * MIN;
  scout[p] = {
    at,
    hash: hash(`demo-scout:${name}`, 20),
    model: 'claude-opus-5-5',
    auto: true,
    note: S.note || '',
    candidates: S.candidates.map((c, i) => ({
      id: hash(`${p}\n${normText(c.title)}`, 12),
      kind: c.kind,
      title: c.title,
      pitch: c.pitch,
      why: c.why,
      evidence: c.evidence.map(([k, text]) => (k ? `${text} (${isoDay(keyOf[k].tl.start)})` : text)),
      threadName: c.threadName,
      firstSteps: c.firstSteps,
      confidence: c.confidence,
      firstAt: at - DAY * 2,
      at: at - i * 1000,
    })),
  };
}

writeJSON(path.join(DATA, 'ai.json'), {
  blocks,
  projects,
  daily,
  cv: {},
  stats: { calls: 268, cost: 0, errors: 1, lastError: null, lastRunAt: dailyAt, byKind: { digest: 214, brief: 41, daily: 9, scout: 4 } },
  callLog: [],
  dailyFail: null,
  scout,
  scoutAutoLog: [],
});

// ------------------------------------------------------------------------------------------------ state.json, secrets.json, work.json

const state = {
  version: 1,
  profile: { name: W.OWNER.name },
  projects: {},
  workspaces: W.WORKSPACES,
  sessions: {},
  ideas: W.IDEAS.map((x) => ({ id: safeId(12), text: x.text, projectPath: x.p ? projPath(x.p) : null, createdAt: localTime(x.day, '19:30'), doneAt: null, source: x.source })),
  pickupHidden: {},
  planAccepted: {},
  planDismissed: {},
  scout: {},
  settings: { ai: { enabled: true }, ui: { theme: 'system' } },
  portfolio: { lang: 'en', header: '' },
};
for (const [name, P] of Object.entries(W.PROJECTS)) {
  const o = {};
  if (P.notes) o.notes = P.notes;
  if (P.pinned) o.pinned = true;
  if (Object.keys(o).length) state.projects[projPath(name)] = o;
}
writeJSON(path.join(DATA, 'state.json'), state);

const secrets = {
  desktopKey: safeId(43),
  devices: W.DEVICES.map((d) => ({
    id: hash(safeId(20), 12),
    name: d.name,
    tokenHash: hash(safeId(43), 64),
    createdAt: localTime(d.createdDay, '20:00'),
    lastSeenAt: NOW - d.seenAgo * MIN,
    ua: d.ua,
    via: d.via,
  })),
  pairCodes: [],
};
writeJSON(path.join(DATA, 'secrets.json'), secrets);
fs.chmodSync(path.join(DATA, 'secrets.json'), 0o600);

const items = W.TASKS.map((x) => {
  const created = localTime(x.createdDay, '10:00');
  const doneAt = x.doneAgo != null ? NOW - x.doneAgo * MIN : x.doneDay != null ? localTime(x.doneDay, '18:30') : null;
  const kept = x.kept ? keyOf[x.kept] : null;
  return {
    id: kept ? `ai_${hash(`blk:${blockOf[x.kept]}`, 10)}` : `u_${safeId(8)}`,
    projectPath: projPath(x.p),
    title: x.title,
    detail: kept ? `${kept.d.nextStep}\n\nFrom: “${kept.d.title}” — ${kept.d.outcome}` : '',
    status: x.status,
    priority: x.priority ?? 1,
    source: kept ? { kind: 'ai', sessionId: kept.id, blockKey: blockOf[x.kept] } : { kind: 'user' },
    createdAt: created,
    updatedAt: doneAt || (x.startedDay != null ? localTime(x.startedDay, '11:00') : created),
    doneAt,
    dueAt: null,
    userEdited: !!kept,
    aiStatus: kept ? 'open' : null,
    closedBy: x.status === 'done' ? 'user' : null,
    closedEvidenceAt: 0,
    keys: kept ? [`blk:${blockOf[x.kept]}`] : [],
    sourceAt: kept ? kept.tl.end : created,
    aiBucket: kept ? 'inbox' : null,
    launches: [],
    startedAt: x.startedDay != null ? localTime(x.startedDay, '11:00') : null,
    plannedFor: x.today ? isoDay(NOW) : null,
    snoozeUntil: null,
    restoredAt: null,
    dismissReason: null,
  };
});
writeJSON(path.join(DATA, 'work.json'), { version: 1, items, spinoffs: [], tombstones: [], meta: { lastExtractAt: 0, lastExtract: null, v3Suggested: NOW } });

// claude.ai chats, as an import of the official export would leave them (server/sources/claude-ai.js)
writeJSON(path.join(DATA, 'claude-ai.json'), {
  version: 1,
  importedAt: NOW - DAY,
  source: { kind: 'zip', from: '~/Downloads/data-2026-11-20.zip' },
  total: W.CHATS.length,
  skipped: 0,
  chats: W.CHATS.map((c) => ({
    uuid: c.uuid,
    name: c.name,
    createdAt: NOW + c.day * DAY - 3600e3,
    updatedAt: NOW + c.day * DAY,
    messages: c.messages,
    humanMessages: Math.ceil(c.messages / 2),
    firstPrompt: c.first,
    lastPrompt: c.last,
    search: [c.first, c.last].filter(Boolean).join(' · '),
    projectPaths: c.project ? [path.join(HOME, c.project)] : [],
  })),
});

// ------------------------------------------------------------------------------------------------ running sessions

const live = sessions
  .filter((s) => s.live)
  .map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    startedAt: s.tl.start,
    lastAt: s.tl.end,
    kind: s.live.kind,
    status: s.live.status,
    state: s.live.state || null,
    waitingFor: s.live.waitingFor || null,
    name: s.live.name,
    jobId: s.live.jobId || null,
    detail: s.live.detail || '',
    bridgeSessionId: `session_01${safeId(22)}`,
  }));
writeJSON(path.join(DIR, 'live.json'), live);
const pids = flag('--no-live') ? [] : startLive(live);

const n = { claude: sessions.length, automations: autos.length, codex: codex.length, archived: Object.values(W.PROJECTS).reduce((a, P) => a + (P.archived || []).length, 0) };
console.log(`demo world: ${DIR}`);
console.log(`  ${Object.keys(W.PROJECTS).length} projects, ${n.claude} Claude sessions, ${n.automations} automation runs, ${n.codex} Codex sessions, ${n.archived} archived`);
console.log(`  ${Object.keys(blocks).length} summaries, ${items.length} tasks (+ Suggested from the extractor), ${pids.length} running sessions`);
