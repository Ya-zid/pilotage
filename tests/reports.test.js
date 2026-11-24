// Developer reports and their CLI commands (standup, sessions, resume, export, usage): a real server on a fake home
// with a few Claude Code transcripts, plus AI summaries and tasks seeded in its data folder (no AI, no forwarder,
// no terminal), and bin/pilotage run against it. All names, projects and texts are fictional.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { standupRange, previousWorkday, startOfDay, addDays, parseDay, renderStandup } from '../server/standup.js';
import { isoDay } from '../server/util.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(ROOT, 'bin', 'pilotage');
const SKIP = process.platform === 'win32' && 'bash script';
const PORT = 5161 + 2 * Math.floor(Math.random() * 40); // LAN listener uses PORT - 1
const base = `http://127.0.0.1:${PORT}`;
const BASE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pilotage-reports-'));
const HOME = path.join(BASE, 'home');
const DATA = path.join(BASE, 'data');
const line = (o) => JSON.stringify(o) + '\n';

const NOW = Date.now();
const TODAY = startOfDay(NOW);
// Five days back is outside "since the previous working day" (at most three days back) and inside the last 7 days.
const AT = { old: addDays(TODAY, -5) + 15 * 3600e3, yesterday: addDays(TODAY, -1) + 10 * 3600e3, today: NOW - 120e3 };
const SHOP = path.join(HOME, 'acme', 'shop');
const BLOG = path.join(HOME, 'acme', 'blog');
const ID = {
  shopY: '11111111-bbbb-4bbb-8ccc-000000000001',
  shopT: '11111111-aaaa-4bbb-8ccc-000000000002',
  blogT: '22222222-aaaa-4bbb-8ccc-000000000003',
  blogOld: '22222222-aaaa-4bbb-8ccc-000000000004',
};

// API usage on assistant lines: 6 120 tokens per tool call, 6 060 per final reply. The reply's message is written as
// two lines (thinking, then text) carrying the same usage, as Claude Code does: it counts once.
const U_TOOL = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 };
const U_END = { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 };

/** One Claude Code transcript: per exchange, a prompt → tool calls → final reply, a few seconds apart. */
function transcript(id, cwd, at, { title, turns }) {
  const ts = (s) => new Date(at + s * 1000).toISOString();
  const b = { isSidechain: false, cwd, sessionId: id, entrypoint: 'cli', version: '2.1.325', gitBranch: 'main' };
  let s = '';
  turns.forEach(({ prompt, reply, tools = [] }, k) => {
    const t0 = k * 120;
    s += line({ ...b, type: 'user', turnOrigin: 'human', message: { role: 'user', content: prompt }, timestamp: ts(t0) });
    tools.forEach(([name, error], i) => {
      const tid = `t${k}_${i}`;
      s += line({ ...b, type: 'assistant', message: { id: `msg_${id.slice(-4)}_${k}_${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input: { file_path: path.join(cwd, 'a.js'), command: 'npm test' } }], usage: U_TOOL }, timestamp: ts(t0 + 2 + i) });
      s += line({ ...b, type: 'user', message: { role: 'user', content: [{ tool_use_id: tid, type: 'tool_result', is_error: !!error, content: error ? 'failed' : 'ok' }] }, timestamp: ts(t0 + 3 + i) });
    });
    const end = { id: `msg_${id.slice(-4)}_${k}_end`, model: 'claude-opus-5-5', role: 'assistant', usage: U_END };
    s += line({ ...b, type: 'assistant', message: { ...end, content: [{ type: 'thinking', thinking: 'Let me see.' }] }, timestamp: ts(t0 + 29) });
    s += line({ ...b, type: 'assistant', message: { ...end, content: [{ type: 'text', text: reply }] }, timestamp: ts(t0 + 30) });
  });
  if (title) s += line({ type: 'ai-title', aiTitle: title, sessionId: id });
  const dir = path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), s);
}
// A fake GitHub token, built so the leak scan doesn't flag this file.
const TOKEN = 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789';

const digest = (d) => ({ summary: '', outcome: '', nextStep: '', todo: '', who: 'claude', topic: 'Work', kind: 'build', cvWorthy: false, highlights: [], ...d });

function seed() {
  for (const p of [SHOP, BLOG]) {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'CLAUDE.md'), '# Notes\n');
  }
  transcript(ID.shopY, SHOP, AT.yesterday, {
    title: 'Checkout totals',
    turns: [
      { prompt: 'Fix the checkout totals', reply: 'Fixed: totals now round per line.', tools: [['Edit'], ['Edit']] },
      { prompt: `Deploy it, the token is ${TOKEN}`, reply: `The deploy failed with ${TOKEN}: permission denied.`, tools: [['Bash', true]] },
      { prompt: '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>12</command-args>', reply: 'Review: looks good.' },
    ],
  });
  transcript(ID.shopT, SHOP, AT.today, { title: 'Stripe webhooks', turns: [{ prompt: 'Add the Stripe webhooks', reply: 'Webhook handler stubbed.', tools: [['Edit']] }] });
  transcript(ID.blogT, BLOG, AT.today - 60e3, { title: 'Launch post draft', turns: [{ prompt: 'Draft the launch post', reply: 'Here is a first draft.' }] });
  transcript(ID.blogOld, BLOG, AT.old, { title: 'Blog theme', turns: [{ prompt: 'Set up the blog theme', reply: 'Theme installed.' }] });
  // AI summaries already in data/ai.json (keys are `<session>:<first turn>`); the blog draft has none yet.
  fs.mkdirSync(DATA, { recursive: true });
  const blocks = {
    [`${ID.shopY}:0`]: { projectPath: SHOP, hash: 'seed', digest: digest({ title: 'Fix checkout rounding', summary: 'Cart totals were off by a cent.', outcome: 'Totals now round per line; the cart tests pass.', status: 'done' }) },
    [`${ID.shopT}:0`]: { projectPath: SHOP, hash: 'seed', digest: digest({ title: 'Add Stripe webhooks', outcome: 'Webhook handler stubbed.', status: 'in_progress', nextStep: 'Retest checkout with the webhook live on a phone.', todo: 'Retest checkout on a real phone' }) },
    [`${ID.blogOld}:0`]: { projectPath: BLOG, hash: 'seed', digest: digest({ title: 'Set up the blog theme', outcome: 'Theme installed.', status: 'done' }) },
  };
  fs.writeFileSync(path.join(DATA, 'ai.json'), JSON.stringify({ blocks }));
  const task = (id, projectPath, title, status) => ({ id, projectPath, title, status, source: { kind: 'user' }, createdAt: NOW - 3600e3, updatedAt: NOW - 3600e3 });
  fs.writeFileSync(path.join(DATA, 'work.json'), JSON.stringify({ version: 1, items: [task('u_doing01', SHOP, 'Fix the double reminder emails', 'doing'), task('u_todo001', BLOG, 'Ask the printer for a new quote', 'todo'), task('u_done001', SHOP, 'Rename the cart module', 'done')] }));
  // The blog draft is open in a terminal and waiting for the user (Claude Code's own session file; this test's pid is alive).
  fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: ID.blogT, pid: process.pid, cwd: BLOG, kind: 'interactive', status: 'waiting', waitingFor: 'input needed', startedAt: NOW - 600e3 }));
  // A stand-in `claude`: `agents` lists nothing, `--bg` records its arguments and says it backgrounded, `-p` (an AI call) is recorded.
  fs.mkdirSync(path.join(HOME, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, '.local', 'bin', 'claude'),
    `#!/bin/sh
case " $* " in
  *" --bg "*) echo "$*" >> "$HOME/launches.log"; mkdir -p "$HOME/.claude/jobs/0a1b2c3d"; echo '{"bridgeSessionId":"session_0a1b2c3d"}' > "$HOME/.claude/jobs/0a1b2c3d/state.json"; echo "backgrounded · 0a1b2c3d"; exit 0 ;;
  *" -p "*) touch "$HOME/ai-called" ;;
esac
echo '[]'
`,
    { mode: 0o755 },
  );
}

const ENV = {
  ...process.env,
  HOME,
  PILOTAGE_DATA: DATA,
  PILOTAGE_PORT: String(PORT),
  PILOTAGE_LAN_INTERNAL_PORT: String(PORT - 1),
  PILOTAGE_WSL: '0',
  PILOTAGE_TERMINAL: 'none',
  PILOTAGE_NO_AI: '1',
  PILOTAGE_NO_FORWARDER: '1',
  PILOTAGE_NODE: process.execPath,
  PILOTAGE_WEB_DIST: path.join(BASE, 'dist'),
};
let proc;
let key = '';
const api = async (p) => {
  const r = await fetch(base + p, { headers: { 'X-Pilotage-Key': key } });
  return { status: r.status, body: await r.json() };
};
/** bin/pilotage against the test server; returns {status, stdout, stderr}. */
const pilotage = (...args) => spawnSync('bash', [CLI, ...args], { env: ENV, encoding: 'utf8', timeout: 60000 });

before(async () => {
  seed();
  fs.mkdirSync(ENV.PILOTAGE_WEB_DIST, { recursive: true });
  fs.writeFileSync(path.join(ENV.PILOTAGE_WEB_DIST, 'index.html'), '<!doctype html><title>app</title>');
  proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: ENV, stdio: 'ignore' });
  for (let i = 0; i < 80 && !key; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const up = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
    if (up) key = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')).desktopKey;
  }
  assert.ok(key, 'server did not start');
  // Indexed, grouped into projects, and the waiting session seen as live.
  for (let i = 0; i < 80; i++) {
    const { body } = await api('/api/sessions?limit=50');
    if (body.sessions?.length === 4 && body.sessions.every((s) => s.projectId) && body.sessions.some((s) => s.live)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail('sessions were not indexed');
});
after(async () => {
  // It saves its state on SIGTERM: wait for that before removing the folder.
  if (proc && proc.exitCode == null) await new Promise((r) => (proc.once('exit', r), proc.kill()));
  fs.rmSync(BASE, { recursive: true, force: true });
});

test('standup periods: the previous working day, today, the last week, or a given day', () => {
  const at = (s) => new Date(s).getTime();
  // Monday → Friday; Sunday → Friday; Wednesday → Tuesday.
  assert.equal(previousWorkday(at('2026-11-23T09:00:00')), at('2026-11-20T00:00:00'));
  assert.equal(previousWorkday(at('2026-11-22T09:00:00')), at('2026-11-20T00:00:00'));
  assert.equal(previousWorkday(at('2026-11-25T09:00:00')), at('2026-11-24T00:00:00'));
  const mon = at('2026-11-23T09:30:00');
  assert.deepEqual(standupRange({}, mon), { from: at('2026-11-20T00:00:00'), to: mon, label: 'Since Fri 20 Nov' });
  assert.deepEqual(standupRange({ range: 'yesterday' }, mon), { from: at('2026-11-20T00:00:00'), to: at('2026-11-23T00:00:00'), label: 'Fri 20 Nov to Sun 22 Nov' });
  assert.equal(standupRange({ range: 'yesterday' }, at('2026-11-25T09:00:00')).label, 'Yesterday (Tue 24 Nov)');
  assert.equal(standupRange({ range: 'week' }, mon).from, at('2026-11-17T00:00:00'));
  assert.deepEqual(standupRange({ since: '2026-11-19', until: '2026-11-19' }, mon), { from: at('2026-11-19T00:00:00'), to: at('2026-11-20T00:00:00'), label: 'Thu 19 Nov' });
  assert.match(standupRange({ since: '2026-02-31' }, mon).error, /date/);
  assert.match(standupRange({ since: '2026-12-01' }, mon).error, /before/);
  assert.match(standupRange({ range: 'month' }, mon).error, /range/);
  assert.equal(parseDay('2026-11-20'), at('2026-11-20T00:00:00'));
});

test('GET /api/standup: work per project from the AI summaries (session title when there is none), open tasks, sessions waiting for you', async () => {
  const { status, body } = await api('/api/standup');
  assert.equal(status, 200);
  assert.match(body.label, /^Since /);
  const names = body.projects.map((p) => p.name);
  assert.deepEqual(names.sort(), ['blog', 'shop']);
  const shop = body.projects.find((p) => p.name === 'shop');
  assert.deepEqual(
    shop.items.map((i) => [i.title, i.status, i.detail, i.next]),
    [
      ['Fix checkout rounding', 'done', 'Totals now round per line; the cart tests pass.', ''],
      ['Add Stripe webhooks', 'in_progress', 'Webhook handler stubbed.', 'Retest checkout on a real phone'],
    ],
  );
  const blog = body.projects.find((p) => p.name === 'blog');
  assert.deepEqual(blog.items.map((i) => [i.title, i.summarized]), [['Launch post draft', false]], 'no summary yet: the session title; older work is left out');
  assert.deepEqual(body.doing.map((t) => [t.title, t.projectName]), [['Fix the double reminder emails', 'shop']]);
  assert.deepEqual(body.todo.map((t) => t.title), ['Ask the printer for a new quote']);
  assert.deepEqual(body.needsYou.map((s) => [s.id, s.detail]), [[ID.blogT, 'Waiting for your input']]);
  assert.match(body.markdown, /^\*\*Standup: Since .+\*\*$/m);
  assert.match(body.markdown, /^- Add Stripe webhooks \(in progress\): Webhook handler stubbed\. Next: Retest checkout on a real phone$/m);
  assert.match(body.markdown, /^\*\*Needs you\*\*\n- Launch post draft \(blog\): Waiting for your input$/m);

  // The week includes the older blog work; one project narrows everything (tasks and waiting sessions too).
  const week = (await api('/api/standup?range=week')).body;
  assert.ok(week.projects.find((p) => p.name === 'blog').items.some((i) => i.title === 'Set up the blog theme'));
  const pid = shop.id;
  const one = (await api(`/api/standup?range=week&project=${pid}`)).body;
  assert.deepEqual(one.projects.map((p) => p.name), ['shop']);
  assert.deepEqual(one.todo, []);
  assert.deepEqual(one.needsYou, []);
  assert.equal((await api('/api/standup?since=2026-02-31')).status, 400);
  assert.equal((await api('/api/standup?project=0000000000')).status, 404);
  assert.equal((await fetch(`${base}/api/standup`)).status, 401, 'needs a paired device or the CLI key');
  assert.equal(fs.existsSync(path.join(HOME, 'ai-called')), false, 'no AI call');
});

test('pilotage standup prints the report; --md is paste-ready markdown; --project narrows it', { skip: SKIP }, () => {
  const r = pilotage('standup');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Standup: Since /);
  assert.match(r.stdout, /^shop\n {2}• Fix checkout rounding: Totals now round per line; the cart tests pass\.$/m);
  assert.match(r.stdout, /^Doing\n {2}• Fix the double reminder emails \(shop\)$/m);
  assert.doesNotMatch(r.stdout, /\*\*|\x1b\[/, 'plain text: no markdown, no colour codes');
  const md = pilotage('standup', '--md', '--week', '--project', 'shop');
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^\*\*Standup: Last 7 days .* · shop\*\*$/m);
  assert.match(md.stdout, /^- Fix checkout rounding: /m);
  assert.doesNotMatch(md.stdout, /blog/);
  const bad = pilotage('standup', '--weak');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown option --weak/);
  assert.equal(pilotage('standup', '--since', '2026-11-30-x').status, 1);
});

test('renderStandup: an empty period still lists tasks', () => {
  const out = renderStandup({ label: 'Today', projects: [], doing: [], todo: [{ title: 'Ship it', projectName: 'shop' }], todoMore: 2, needsYou: [] });
  assert.equal(out, 'Standup: Today\n\nNothing recorded in this period.\n\nTo do\n  • Ship it (shop)\n  • and 2 more');
});

test('pilotage sessions: latest sessions with a short id, when, project and running state', { skip: SKIP }, async () => {
  const r = pilotage('sessions');
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trimEnd().split('\n');
  assert.match(rows[0], /^ {2}ID\s+LAST\s+PROJECT\s+STATE\s+TITLE$/);
  assert.equal(rows.length, 5, r.stdout);
  assert.match(rows[1], /^● 22222222 {2}\S+ ago\s+blog\s+needs you {2}Launch post draft$/, 'running sessions first, in the web words');
  assert.ok(rows.some((x) => /^ {2}11111111 .* shop {2}.* {2}Stripe webhooks$/.test(x)));
  const shop = pilotage('sessions', 'shop');
  assert.equal(shop.stdout.trimEnd().split('\n').length, 3, shop.stdout);
  assert.equal(pilotage('sessions', '--limit', '1').stdout.trimEnd().split('\n').length, 2);
  // The id filter behind `resume <id>` / `export <id>`: a prefix.
  const { body } = await api('/api/sessions?id=22222222&hidden=1');
  assert.deepEqual(body.sessions.map((s) => s.id).sort(), [ID.blogT, ID.blogOld]);
});

test('pilotage resume: a running session is not started twice; it says how to open it', { skip: SKIP }, () => {
  const r = pilotage('resume', 'blog', 'More please');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^"Launch post draft" \(blog\) is already running \(needs you: Waiting for your input\)\. Open it instead:$/m);
  assert.match(r.stdout, new RegExp(`In Pilotage: +http://pilotage\\.localhost:${PORT}/sessions/${ID.blogT}$`, 'm'));
  assert.equal(fs.existsSync(path.join(HOME, 'launches.log')), false, 'nothing launched');
});

test('pilotage resume <project>: the latest session, through /api/launch with the usual permission mode; or a session by id', { skip: SKIP }, () => {
  const log = path.join(HOME, 'launches.log');
  const r = pilotage('resume', 'shop', '--bg', 'Carry on');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Resuming "Stripe webhooks" \(shop, last active \S+ ago\) in the background/);
  assert.match(r.stdout, /Phone \/ web: https:\/\/claude\.ai\/code\/session_0a1b2c3d/);
  const last = () => fs.readFileSync(log, 'utf8').trim().split('\n').pop();
  assert.equal(last(), `--bg -n Stripe webhooks --permission-mode default --resume ${ID.shopT} -- Carry on`);
  // By id (or an unambiguous prefix); an ambiguous prefix lists the matches.
  const byId = pilotage('resume', '11111111-b', '--bg');
  assert.equal(byId.status, 0, byId.stdout + byId.stderr);
  assert.equal(last(), `--bg -n Checkout totals --permission-mode default --resume ${ID.shopY}`);
  const many = pilotage('resume', '11111111');
  assert.equal(many.status, 1);
  assert.match(many.stderr, /"11111111" matches several sessions/);
  assert.doesNotMatch(many.stderr, /\x1b\[/, 'no colour codes when stderr is not a terminal');
  assert.match(pilotage('resume', 'nothing-like-this').stderr, /No project matches "nothing-like-this"/);
  assert.match(pilotage('resume', 'shop', '--fork').stderr, /Unknown option --fork/);
});

test('pilotage export: the conversation as markdown (prompts, final replies, tool counts), secrets hidden', { skip: SKIP }, () => {
  const r = pilotage('export', '11111111-b');
  assert.equal(r.status, 0, r.stderr);
  const md = r.stdout;
  assert.match(md, /^# Checkout totals\n\n- Project: shop \(~\/acme\/shop, branch main\)\n- Session: `11111111-bbbb-4bbb-8ccc-000000000001` · Claude Code 2\.1\.325 · claude-opus-5-5\n/);
  assert.match(md, /^- Resume: `claude --resume 11111111-bbbb-4bbb-8ccc-000000000001` \(in that folder\)$/m);
  assert.equal(md.match(/^## You · \d{4}-\d\d-\d\d \d\d:\d\d$/gm).length, 3);
  assert.match(md, /^Fix the checkout totals\n\n\*\*Claude\*\* · 2 tool calls \(Edit ×2\)\n\nFixed: totals now round per line\.$/m);
  assert.match(md, /^\*\*Claude\*\* · 1 tool call \(Bash\), 1 failed$/m);
  assert.match(md, /^\/review 12$/m, 'slash commands as typed, not as transcript markup');
  assert.ok(!md.includes(TOKEN), 'the token is hidden');
  assert.match(md, /ghp_ab…\[hidden\]/);
  // Only the last turns; to a file.
  const out = path.join(BASE, 'handoff.md');
  const r2 = pilotage('export', ID.shopY.slice(0, 10), '--last', '1', '--out', out);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /^Wrote .*handoff\.md: "Checkout totals", 1 turn \(the last of 3\)\./);
  const f = fs.readFileSync(out, 'utf8');
  assert.match(f, /^- Showing the last 1 of 3 turns$/m);
  assert.equal(f.match(/^## You/gm).length, 1);
  assert.match(f, /^\/review 12$/m);
  // A relative --out lands in the folder the command was run from, never in Pilotage's own folder (review R3).
  const here = fs.mkdtempSync(path.join(BASE, 'cwd-'));
  const rel = spawnSync('bash', [CLI, 'export', ID.shopY.slice(0, 10), '--last', '1', '--out', 'rel-handoff.md'], { env: ENV, cwd: here, encoding: 'utf8', timeout: 60000 });
  assert.equal(rel.status, 0, rel.stderr);
  assert.ok(fs.existsSync(path.join(here, 'rel-handoff.md')), 'written where the command ran');
  assert.equal(fs.existsSync(path.join(ROOT, 'rel-handoff.md')), false, 'not in the install folder');
  assert.match(rel.stdout, new RegExp(`^Wrote ${path.join(here, 'rel-handoff.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
  assert.match(pilotage('export', 'ab').stderr, /at least 4 characters/);
  assert.match(pilotage('export', '99999999').stderr, /No session id starts with "99999999"/);
});

test('GET /api/sessions/:id/export: 404 for an unknown session; needs sign-in', async () => {
  assert.equal((await api('/api/sessions/99999999-0000-4000-8000-000000000000/export')).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/${ID.shopY}/export`)).status, 401);
  const { body } = await api(`/api/sessions/${ID.shopT}/export`);
  assert.deepEqual([body.id, body.title, body.turns, body.total], [ID.shopT, 'Stripe webhooks', 1, 1]);
});

test('token usage: per session and project, and GET /api/usage per day, per project, top sessions', async () => {
  // Checkout totals: 3 tool calls + 3 replies. Stripe webhooks: 1 + 1. Each blog session: 1 reply.
  const s = (await api(`/api/sessions/${ID.shopY}`)).body;
  assert.deepEqual(s.tokens, { input: 330, output: 210, cacheWrite: 3000, cacheRead: 33000, total: 36540 });
  assert.equal(s.outTokens, 210, 'a message written over two lines counts once');
  const { projects } = (await api('/api/projects')).body;
  assert.deepEqual(projects.map((p) => [p.name, p.tokens.total]).sort(), [['blog', 12120], ['shop', 48720]]);
  const { status, body: u } = await api('/api/usage?days=7');
  assert.equal(status, 200);
  assert.deepEqual(u.totals, { input: 460, output: 380, cacheWrite: 4000, cacheRead: 56000, total: 60840 });
  assert.deepEqual(u.projects.map((p) => [p.name, p.total, p.sessions]), [['shop', 48720, 2], ['blog', 12120, 2]]);
  assert.equal(u.days.length, 7);
  assert.equal(u.days[6].day, isoDay(NOW));
  const day = (t) => u.days.find((d) => d.day === isoDay(t))?.total;
  assert.equal(day(AT.yesterday), 36540);
  assert.equal(day(AT.old), 6060);
  assert.equal(u.sessions[0].id, ID.shopY);
  assert.equal(u.sessions[0].title, 'Checkout totals');
  assert.equal(u.pending, 0);
  // Narrower: one project, one day; bad input.
  const blog = projects.find((p) => p.name === 'blog');
  assert.equal((await api(`/api/usage?days=7&project=${blog.id}`)).body.totals.total, 12120);
  const one = (await api(`/api/usage?since=${isoDay(AT.yesterday)}&until=${isoDay(AT.yesterday)}`)).body;
  assert.deepEqual([one.days.length, one.totals.total], [1, 36540]);
  assert.equal((await api('/api/usage?days=0')).status, 400);
  assert.equal((await api('/api/usage?since=2026-13-01')).status, 400);
  assert.equal((await api('/api/usage?project=0000000000')).status, 404);
  assert.equal((await fetch(`${base}/api/usage`)).status, 401);
});

test('pilotage usage: totals, per project, per day with bars, top sessions; export shows the tokens too', { skip: SKIP }, () => {
  const r = pilotage('usage', '--week');
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /^Tokens: \w{3} \d+ \w{3} to \w{3} \d+ \w{3}$/m);
  assert.match(out, /^Total 60\.8k {2}\(output 380 · input 460 · cache write 4k · cache read 56k\)$/m);
  assert.match(out, /^ {2}shop {20} +48\.7k +280 +440 +4k +44k +2$/m);
  const bars = out.split('By day\n')[1].split('\n\n')[0].split('\n');
  assert.equal(bars.length, 7);
  assert.ok(bars.some((x) => /36\.5k {2}█{30}$/.test(x)), 'the busiest day has the full bar');
  assert.match(out, /^Top sessions\n {2}11111111 +36\.5k {2}shop +Checkout totals$/m);
  assert.doesNotMatch(out, /\x1b\[/);
  const blog = pilotage('usage', '--project', 'blog');
  assert.match(blog.stdout, /^Tokens: .* · blog$/m);
  assert.match(blog.stdout, /^Total 12\.1k /m);
  assert.doesNotMatch(blog.stdout, /By project/);
  assert.equal(pilotage('usage', '--days', 'x').status, 1);
  assert.match(pilotage('export', '11111111-b').stdout, /^- Usage: 36\.5k tokens \(output 210, input 330, cache write 3k, cache read 33k\)$/m);
});
