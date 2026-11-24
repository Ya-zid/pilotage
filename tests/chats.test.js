// claude.ai chats from the official data export (server/sources/claude-ai.js): a zip built here with node:zlib, a
// plain folder, format variants, redaction, project linking, re-import, malformed files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.PILOTAGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-chats-'));
const { ClaudeAiChats, ImportError, readExport, parseConversations, projectNames, zipEntries, zipRead } = await import('../server/sources/claude-ai.js');
const { buildGraph } = await import('../server/graph.js');
const { Views } = await import('../server/views.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-chats-fixture-'));
// A fake secret, assembled at runtime so no secret-shaped literal sits in the repo.
const SECRET = 'DB_PASSWORD=' + 'hunter2' + 'secret';

// ---- a tiny zip writer (local headers + central directory + end record)
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = store ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(store ? 0 : 8, 8);
    h.writeUInt32LE(crc32(raw), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    locals.push(h, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const EXPORT = [
  {
    uuid: '11111111-aaaa-4bbb-8ccc-000000000001',
    name: 'Pricing for the shopfront',
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: `How should I price coupons? My config has ${SECRET} in it`, created_at: '2026-10-01T09:00:00Z' },
      { uuid: 'm2', sender: 'assistant', text: 'Start with a flat discount.', created_at: '2026-10-01T09:01:00Z' },
      { uuid: 'm3', sender: 'human', text: 'And for bundles?', created_at: '2026-10-02T10:00:00Z' },
    ],
  },
  {
    // variants: id/title/messages, role + content parts, numeric times, no updated_at
    id: '22222222-aaaa-4bbb-8ccc-000000000002',
    title: 'Release notes wording',
    created_at: 1761900000,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Rewrite the changelog of Pilotage web for me' }, { type: 'image', source: 'x' }], created_at: 1761900000 },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is a version.' }, { type: 'tool_use', name: 'x' }], created_at: 1761900600 },
    ],
  },
  {
    uuid: '33333333-aaaa-4bbb-8ccc-000000000003',
    name: 'Holiday plans',
    created_at: '2026-09-01T09:00:00Z',
    updated_at: '2026-09-01T09:30:00Z',
    chat_messages: [
      { sender: 'human', text: 'Ideas for a trip? Not about shopfronts at all.' },
      { sender: 'assistant', text: 'Maybe the API of the travel site, or a test drive.' },
    ],
  },
  { name: 'No id, skipped', chat_messages: [] },
  {
    uuid: '44444444-aaaa-4bbb-8ccc-000000000004',
    name: '',
    created_at: '2026-08-01T09:00:00Z',
    chat_messages: [{ sender: 'assistant', text: 'Only the answer mentions SHOPFRONT.' }],
  },
];

function fakeWorld() {
  const projects = new Map(
    [
      { id: 'aaaaaaaaaa', path: '/w/acme/shopfront', name: 'shopfront', workspace: 'acme', sessionIds: [], lastAt: Date.now(), worktrees: new Map() },
      { id: 'bbbbbbbbbb', path: '/w/acme/pilotage-web', name: 'pilotage-web', workspace: 'acme', sessionIds: [], lastAt: Date.now(), worktrees: new Map() },
      { id: 'cccccccccc', path: '/w/acme/api', name: 'api', workspace: 'acme', sessionIds: [], lastAt: Date.now(), worktrees: new Map() },
      { id: 'dddddddddd', path: '/w/acme/hid', name: 'holiday', workspace: 'acme', sessionIds: [], lastAt: Date.now(), worktrees: new Map() },
    ].map((p) => [p.path, p]),
  );
  const store = { project: (p) => (p === '/w/acme/hid' ? { hidden: true } : {}), session: () => ({}), data: { ideas: [], workspaces: {} }, settings: {} };
  return { registry: { projects, gitOf: () => ({}), byId: (id) => [...projects.values()].find((p) => p.id === id) || null }, store };
}

const fresh = (w = fakeWorld()) => new ClaudeAiChats({ ...w, file: path.join(fs.mkdtempSync(path.join(TMP, 'data-')), 'claude-ai.json') });

test('claude.ai import: a deflated zip with conversations.json one folder down, read tolerantly', async () => {
  const file = path.join(TMP, 'export.zip');
  fs.writeFileSync(file, zip({ 'data-2026-11-24/users.json': '[]', 'data-2026-11-24/conversations.json': JSON.stringify(EXPORT) }));
  const chats = fresh();
  const r = await chats.import(file);
  assert.equal(r.count, 4);
  assert.equal(r.skipped, 1, 'the conversation without an id');
  const one = chats.chats.find((c) => c.uuid.endsWith('01'));
  assert.equal(one.name, 'Pricing for the shopfront');
  assert.equal(one.messages, 3);
  assert.equal(one.humanMessages, 2);
  assert.match(one.firstPrompt, /How should I price coupons/);
  assert.equal(one.lastPrompt, 'And for bundles?');
  assert.equal(one.createdAt, Date.parse('2026-10-01T09:00:00Z'));
  assert.equal(one.updatedAt, Date.parse('2026-10-02T10:00:00Z'));
  const two = chats.chats.find((c) => c.uuid.endsWith('02'));
  assert.equal(two.name, 'Release notes wording', 'title instead of name');
  assert.equal(two.messages, 2, 'messages instead of chat_messages');
  assert.match(two.firstPrompt, /Rewrite the changelog/, 'role: user + content parts');
  assert.equal(two.createdAt, 1761900000 * 1000, 'seconds');
  assert.equal(two.updatedAt, 1761900600 * 1000, 'no updated_at: the last message');
  assert.deepEqual(chats.chats.map((c) => c.uuid.slice(-2)), ['01', '03', '04', '02'], 'newest first (02 is from 2025)');
  assert.equal(chats.view(chats.chats.find((c) => c.uuid.endsWith('04'))).name, 'Untitled chat');
  assert.equal(chats.view(one).url, 'https://claude.ai/chat/11111111-aaaa-4bbb-8ccc-000000000001');
  assert.equal(chats.status().source.kind, 'zip');
});

test('claude.ai import: every stored string is redacted, and the raw export is not copied', async () => {
  const file = path.join(TMP, 'secret.zip');
  fs.writeFileSync(file, zip({ 'conversations.json': JSON.stringify(EXPORT) }));
  const chats = fresh();
  await chats.import(file);
  const stored = fs.readFileSync(chats.file, 'utf8');
  assert.doesNotMatch(stored, /hunter2secret/);
  assert.match(stored, /DB_PASSWORD=\[hidden\]|DB_PASSWORD…\[hidden\]/);
  assert.doesNotMatch(stored, /Start with a flat discount/, "the assistant's answers are not kept");
  assert.equal((fs.statSync(chats.file).mode & 0o777).toString(8), '600');
});

test('claude.ai import: a stored (uncompressed) zip, a plain folder, and conversations.json itself', async () => {
  const stored = path.join(TMP, 'stored.zip');
  fs.writeFileSync(stored, zip({ 'conversations.json': JSON.stringify(EXPORT) }, { store: true }));
  assert.equal((await fresh().import(stored)).count, 4);
  const dir = fs.mkdtempSync(path.join(TMP, 'unzipped-'));
  fs.mkdirSync(path.join(dir, 'data-2026'));
  fs.writeFileSync(path.join(dir, 'data-2026', 'conversations.json'), JSON.stringify(EXPORT));
  const c = fresh();
  assert.equal((await c.import(dir)).count, 4, 'one folder down');
  assert.equal(c.status().source.kind, 'folder');
  assert.equal((await fresh().import(path.join(dir, 'data-2026'))).count, 4, 'the folder itself');
  assert.equal((await fresh().import(path.join(dir, 'data-2026', 'conversations.json'))).count, 4, 'the file');
  // { conversations: [...] } and a BOM are fine too
  const wrapped = path.join(dir, 'wrapped.json');
  fs.writeFileSync(wrapped, '﻿' + JSON.stringify({ conversations: EXPORT }));
  assert.equal((await fresh().import(wrapped)).count, 4);
});

test('claude.ai linking: whole words, case-insensitive, title or any message, no short or generic names, no hidden projects', async () => {
  const file = path.join(TMP, 'link.zip');
  fs.writeFileSync(file, zip({ 'conversations.json': JSON.stringify(EXPORT) }));
  const chats = fresh();
  const r = await chats.import(file);
  const links = (end) => chats.linksOf(chats.chats.find((c) => c.uuid.endsWith(end))).sort();
  assert.deepEqual(links('01'), ['/w/acme/shopfront'], 'the title names it');
  assert.deepEqual(links('02'), ['/w/acme/pilotage-web'], '"Pilotage web" names pilotage-web');
  assert.deepEqual(links('03'), [], '"shopfronts" is another word, "API" is too generic, the hidden project is never linked');
  assert.deepEqual(links('04'), ['/w/acme/shopfront'], 'an answer in capitals counts');
  assert.equal(r.linked, 3);
  assert.deepEqual(projectNames({ path: '/w/x/api' }, 'API'), [], 'generic');
  assert.deepEqual(projectNames({ path: '/w/x/abc' }, 'abc'), [], 'too short');
  assert.deepEqual(projectNames({ path: '/w/x/2024' }, '2024'), [], 'a number');
  assert.deepEqual(chats.list({ projectId: 'aaaaaaaaaa' }).map((c) => c.uuid.slice(-2)), ['01', '04']);
  assert.deepEqual(chats.view(chats.chats[0]).projects, [{ id: 'aaaaaaaaaa', name: 'shopfront' }]);
});

test('claude.ai linking: a project found after the import is linked from the kept text', async () => {
  const w = fakeWorld();
  const chats = fresh(w);
  const file = path.join(TMP, 'later.zip');
  fs.writeFileSync(file, zip({ 'conversations.json': JSON.stringify(EXPORT) }));
  await chats.import(file);
  assert.deepEqual(chats.linksOf(chats.chats.find((c) => c.uuid.endsWith('01'))), ['/w/acme/shopfront']);
  w.registry.projects.set('/w/acme/coupons', { id: 'eeeeeeeeee', path: '/w/acme/coupons', name: 'coupons', workspace: 'acme', sessionIds: [], worktrees: new Map() });
  assert.deepEqual(chats.linksOf(chats.chats.find((c) => c.uuid.endsWith('01'))).sort(), ['/w/acme/coupons', '/w/acme/shopfront']);
});

test('claude.ai search and the Map: chats are found by title and prompts, and drawn linked to their project', async () => {
  const w = fakeWorld();
  const chats = fresh(w);
  const file = path.join(TMP, 'graph.zip');
  fs.writeFileSync(file, zip({ 'conversations.json': JSON.stringify(EXPORT) }));
  await chats.import(file);
  assert.deepEqual(chats.search('bundles').map((c) => c.name), ['Pricing for the shopfront'], 'a later prompt');
  assert.deepEqual(chats.search('RELEASE notes').map((c) => c.name), ['Release notes wording']);
  assert.deepEqual(chats.search('flat discount'), [], 'answers are not searchable (not kept)');
  assert.deepEqual(chats.search('x'), [], 'one letter finds nothing');
  const index = { list: () => [], get: () => null, loadTurns: () => [] };
  const ai = { state: { blocks: {}, projects: {}, cv: {} }, blocksOf: () => [], digestOf: () => null };
  const views = new Views({ index, registry: w.registry, store: w.store, live: { get: () => null }, ai, processes: () => [] });
  const g = buildGraph({ index, registry: w.registry, store: w.store, ai, views, chats: chats.forGraph() }, { days: 0 });
  const node = g.nodes.find((n) => n.id === 'c:11111111-aaaa-4bbb-8ccc-000000000001');
  assert.ok(node && node.type === 'chat');
  assert.ok(g.links.some((l) => l.source === node.id && l.target === 'p:aaaaaaaaaa' && l.kind === 'chat'));
  assert.ok(g.nodes.some((n) => n.id === 'c:33333333-aaaa-4bbb-8ccc-000000000003'), 'an unlinked chat is still on the map');
});

test('claude.ai re-import replaces the old one; remove forgets it', async () => {
  const chats = fresh();
  const a = path.join(TMP, 're-a.zip');
  const b = path.join(TMP, 're-b.zip');
  fs.writeFileSync(a, zip({ 'conversations.json': JSON.stringify(EXPORT) }));
  fs.writeFileSync(b, zip({ 'conversations.json': JSON.stringify([{ ...EXPORT[2], name: 'Holiday plans, again' }]) }));
  await chats.import(a);
  assert.equal(chats.chats.length, 4);
  await chats.import(b);
  assert.deepEqual(chats.chats.map((c) => c.name), ['Holiday plans, again']);
  const reread = new ClaudeAiChats({ ...fakeWorld(), file: chats.file });
  assert.equal(reread.chats.length, 1, 'kept across restarts');
  chats.remove();
  assert.equal(fs.existsSync(chats.file), false);
  assert.deepEqual(chats.status(), { imported: false, count: 0 });
});

test('claude.ai import: malformed files are refused with a clear error, and nothing is replaced', async () => {
  const chats = fresh();
  const good = path.join(TMP, 'keep.zip');
  fs.writeFileSync(good, zip({ 'conversations.json': JSON.stringify(EXPORT) }));
  await chats.import(good);
  const cases = [
    ['not-a-zip.zip', Buffer.from('this is not a zip at all, just text'), /not a zip archive/],
    ['other.zip', zip({ 'readme.txt': 'hello' }), /No conversations\.json in this zip/],
    ['broken.zip', zip({ 'conversations.json': '[{"uuid": "1234567890", "name": ' }), /not valid JSON/],
    ['object.zip', zip({ 'conversations.json': '{"hello": "world"}' }), /should hold a list of conversations/],
    ['noids.json', Buffer.from(JSON.stringify([{ name: 'x' }, { name: 'y' }])), /No conversation in this export has an id/],
  ];
  for (const [name, bytes, rx] of cases) {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, bytes);
    await assert.rejects(chats.import(f), (e) => e instanceof ImportError && rx.test(e.message), name);
  }
  // a damaged entry (bytes cut short)
  const z = zip({ 'conversations.json': JSON.stringify(EXPORT) });
  const cut = path.join(TMP, 'cut.zip');
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  fs.writeFileSync(cut, Buffer.concat([z.subarray(0, 40), Buffer.alloc(cd - 40, 0x41), z.subarray(cd)]));
  await assert.rejects(chats.import(cut), (e) => e instanceof ImportError && /damaged|not valid JSON/.test(e.message));
  await assert.rejects(chats.import(path.join(TMP, 'missing.zip')), /Nothing at/);
  await assert.rejects(chats.import('relative/path.zip'), /full path/);
  await assert.rejects(chats.import(''), /Give the path/);
  assert.equal(chats.chats.length, 4, 'the earlier import is still there');
  assert.equal(parseConversations('[]').conversations.length, 0, 'an empty export is valid');
  assert.throws(() => readExport(TMP), /No conversations\.json in/);
});

test('claude.ai: a big export (3,000 chats) imports in seconds, and the Map and search reuse the links', async () => {
  const w = fakeWorld();
  for (let i = 0; i < 60; i++) w.registry.projects.set(`/w/many/project-${i}-name`, { id: `f${String(i).padStart(9, '0')}`, path: `/w/many/project-${i}-name`, name: `project-${i}-name`, workspace: 'many', sessionIds: [], worktrees: new Map() });
  const big = Array.from({ length: 3000 }, (_, i) => ({
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Chat ${i} about project ${i % 60} name`,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString(),
    chat_messages: Array.from({ length: 6 }, (_, k) => ({ sender: k % 2 ? 'assistant' : 'human', text: `message ${k} `.repeat(60) })),
  }));
  const file = path.join(TMP, 'big.zip');
  fs.writeFileSync(file, zip({ 'conversations.json': JSON.stringify(big) }));
  const chats = fresh(w);
  let t0 = performance.now();
  const r = await chats.import(file);
  const importMs = performance.now() - t0;
  assert.equal(r.count, 3000);
  assert.equal(r.linked, 3000, '"project 7 name" names project-7-name');
  assert.ok(importMs < 8000, `imported in ${Math.round(importMs)} ms`);
  chats.forGraph();
  t0 = performance.now();
  for (let i = 0; i < 5; i++) chats.forGraph();
  chats.search('chat 2999');
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 250, `the Map's chat list in ${ms.toFixed(1)} ms`); // cached: a few ms; uncached it is seconds
});

test('claude.ai import: an entry is capped by its real size, not the size the zip claims (review R2)', () => {
  // A stored entry that says it holds 10 bytes but carries 5,000.
  const z = zip({ 'conversations.json': 'x'.repeat(5000) }, { store: true });
  const cdAt = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE(10, cdAt + 24); // uncompressed size in the central directory
  const f = path.join(TMP, 'liar.zip');
  fs.writeFileSync(f, z);
  const fd = fs.openSync(f, 'r');
  try {
    const [entry] = zipEntries(fd, z.length);
    assert.equal(entry.usize, 10);
    assert.throws(() => zipRead(fd, z.length, entry, 1000), (e) => e instanceof ImportError && /too big/.test(e.message));
    // a deflated entry whose compressed bytes alone are over the cap is refused before they are read
    assert.throws(() => zipRead(fd, z.length, { ...entry, method: 8, csize: 4000, usize: 10 }, 1000), /too big/);
  } finally {
    fs.closeSync(fd);
  }
});

test('claude.ai import: a conversations.json that is not a regular file (a FIFO) is refused, never waited on (review R6)', { skip: process.platform === 'win32' && 'no mkfifo' }, async () => {
  const { spawnSync, execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(TMP, 'fifo-'));
  execFileSync('mkfifo', [path.join(dir, 'conversations.json')]);
  // In a child with a time limit: before the fix, opening the FIFO blocked forever.
  const mod = new URL('../server/sources/claude-ai.js', import.meta.url).href;
  const script = `const { readExport } = await import(${JSON.stringify(mod)}); try { readExport(${JSON.stringify(dir)}); console.log('READ'); } catch (e) { console.log('ERR ' + e.message); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000, env: { ...process.env } });
  assert.equal(r.signal, null, 'readExport hung on a FIFO');
  assert.match(r.stdout, /^ERR .*not a regular file/m, r.stdout + r.stderr);
});

test('claude.ai import: a zip with a damaged directory says so (review R7)', async () => {
  const chats = fresh();
  const z = zip({ 'conversations.json': JSON.stringify(EXPORT) });
  const cdAt = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  for (const [at, what] of [[28, 'file name'], [30, 'extra field'], [32, 'comment']]) {
    const bad = Buffer.from(z);
    bad.writeUInt16LE(0xffff, cdAt + at); // a length that runs past the end of the directory
    const f = path.join(TMP, `baddir-${at}.zip`);
    fs.writeFileSync(f, bad);
    await assert.rejects(chats.import(f), (e) => e instanceof ImportError && /damaged/.test(e.message), what);
  }
  // a ZIP64 end record pointing nowhere
  const z64 = Buffer.from(z);
  z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
  const f64 = path.join(TMP, 'baddir-64.zip');
  fs.writeFileSync(f64, Buffer.concat([z64.subarray(0, z64.length - 22), Buffer.from([0x50, 0x4b, 0x06, 0x07]), Buffer.alloc(4), Buffer.from([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0]), Buffer.alloc(4), z64.subarray(z64.length - 22)]));
  await assert.rejects(chats.import(f64), (e) => e instanceof ImportError && /damaged/.test(e.message), 'zip64 locator');
});

test('claude.ai import: runs in its own process; an export too big for its memory is refused, the server lives on (review R5)', async () => {
  const chats = fresh();
  const big = [];
  for (let i = 0; i < 4000; i++) big.push({ uuid: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Chat ${i}`, chat_messages: [{ sender: 'human', text: 'y'.repeat(4000) }] });
  const f = path.join(TMP, 'heavy.json');
  fs.writeFileSync(f, JSON.stringify(big)); // ~16 MB
  // The import's own process has a capped heap (1.5 GB by default); here 16 MB, so this export can't fit.
  await assert.rejects(chats.import(f, Date.now(), { maxHeapMb: 16 }), (e) => e instanceof ImportError && /more memory/.test(e.message));
  // …and the same export imports with the normal limit.
  assert.equal((await chats.import(f)).count, 4000);
});
