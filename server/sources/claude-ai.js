// claude.ai chats ("online sessions") from the official data export (claude.ai → Settings → Privacy → Export data).
// The export is a zip whose conversations.json is an array of { uuid, name, created_at, updated_at, chat_messages:
// [{ uuid, sender: 'human' | 'assistant', text, content: [{ type: 'text', text }], created_at }] } (field names per
// community tools; read tolerantly: role vs sender, text vs content parts, missing fields).
//
// Read-only: the export is only read (a .zip, an unzipped folder, or conversations.json itself). One entry is
// inflated with node:zlib through a minimal zip directory reader (no dependency). What is kept is a compact index in
// data/claude-ai.json: title, dates, message counts, first and last prompts, a capped search text, and the projects a
// chat mentions. Every stored string goes through redact(). A newer import replaces the old one. The export's
// content never goes to the log (counts only). Contract: docs/API-CHATS.md.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, HOME } from '../config.js';
import { clip, oneLine, redact, readJSONSync, writeJSONSync, isInside } from '../util.js';

export const FILE = () => path.join(DATA, 'claude-ai.json');
/** Biggest conversations.json read (uncompressed). The whole file is parsed in memory. */
export const MAX_JSON_BYTES = 400 * 1024 * 1024;
const SEARCH_CHARS = 3000;
/** Heap of the child process an import runs in: a 400 MB export needs about 1-1.2 GB. Past it, the import is refused
 * and the server carries on (the child dies, not the server). */
export const IMPORT_HEAP_MB = 1536;
const UUID = /^[A-Za-z0-9-]{8,64}$/;

export class ImportError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const tilde = (p) => (isInside(p, HOME) ? `~${p.slice(HOME.length)}` : p);
const keep = (s, n) => clip(redact(oneLine(s)), n);

// ------------------------------------------------------------------ minimal zip reader (one entry)

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** Central directory entries of a zip: { name, method, flags, csize, usize, offset }. ZIP64 aware. */
export function zipEntries(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportError('This file is not a zip archive');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const locAt = size - tailLen + eocd - 20;
    const loc = locAt >= 0 ? readAt(fd, locAt, 20) : null;
    if (!loc || loc.readUInt32LE(0) !== 0x07064b50) throw new ImportError('This zip archive is damaged (no ZIP64 directory)');
    const recAt = Number(loc.readBigUInt64LE(8));
    const rec = readAt(fd, recAt, 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new ImportError('This zip archive is damaged (bad ZIP64 directory)');
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOff = Number(rec.readBigUInt64LE(48));
  }
  if (cdOff + cdSize > size || cdSize > 64 * 1024 * 1024) throw new ImportError('This zip archive is damaged (directory out of range)');
  const cd = readAt(fd, cdOff, cdSize);
  const out = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new ImportError('This zip archive is damaged (bad directory entry)');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ImportError('This zip archive is damaged (a directory entry runs past the directory)');
    const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    // ZIP64 extra field: the 0xffffffff values, in order
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff && q + 8 <= e + 4 + len) (usize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (csize === 0xffffffff && q + 8 <= e + 4 + len) (csize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (offset === 0xffffffff && q + 8 <= e + 4 + len) offset = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    out.push({ name, method, flags, csize, usize, offset });
    p = eEnd + commentLen;
  }
  return out;
}

/** The bytes of one zip entry (stored or deflated), at most `max` once inflated. */
export function zipRead(fd, size, entry, max = MAX_JSON_BYTES) {
  if (entry.flags & 1) throw new ImportError('This zip archive is encrypted');
  const tooBig = () => new ImportError(`conversations.json is over ${Math.round(max / 1048576)} MB, too big to read`);
  if (entry.usize > max) throw tooBig();
  // The claimed size can lie: cap the bytes really read too (deflate never needs much more room than its output).
  if (entry.csize > (entry.method === 0 ? max : max + Math.ceil(max / 1000) + 1024)) throw tooBig();
  const head = readAt(fd, entry.offset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) throw new ImportError('This zip archive is damaged (bad entry header)');
  const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (start + entry.csize > size) throw new ImportError('This zip archive is damaged (entry out of range)');
  const data = readAt(fd, start, entry.csize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ImportError(`This zip uses a compression method Pilotage can't read (${entry.method})`);
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: max });
  } catch (e) {
    throw e.code === 'ERR_BUFFER_TOO_LARGE' ? tooBig() : new ImportError('This zip archive is damaged (could not inflate conversations.json)');
  }
}

// ------------------------------------------------------------------ reading the export

/** The text of conversations.json from a zip, a folder (or one level below it) or the file itself. */
export function readExport(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ImportError('Give the path of the export: the .zip, its folder or conversations.json');
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(HOME, p.slice(1));
  if (!path.isAbsolute(p)) throw new ImportError('Use a full path (starting with / or ~)');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new ImportError(`Nothing at ${tilde(p)}`);
  }
  if (st.isDirectory()) {
    const direct = path.join(p, 'conversations.json');
    let file = fs.existsSync(direct) ? direct : null;
    if (!file) {
      for (const d of fs.readdirSync(p, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const f = path.join(p, d.name, 'conversations.json');
        if (fs.existsSync(f)) {
          file = f;
          break;
        }
      }
    }
    if (!file) throw new ImportError(`No conversations.json in ${tilde(p)}`);
    return { text: readJsonFile(file), kind: 'folder', from: tilde(p) };
  }
  if (!st.isFile()) throw new ImportError(`${tilde(p)} is not a file or a folder`);
  if (/\.json$/i.test(p)) return { text: readJsonFile(p), kind: 'file', from: tilde(p) };
  const { fd, size } = openRegular(p);
  try {
    let entries;
    let bytes;
    try {
      entries = zipEntries(fd, size).filter((e) => path.posix.basename(e.name) === 'conversations.json' && !e.name.startsWith('__MACOSX/'));
      if (!entries.length) throw new ImportError('No conversations.json in this zip: is it the claude.ai export?');
      entries.sort((a, b) => a.name.length - b.name.length);
      bytes = zipRead(fd, size, entries[0]);
    } catch (e) {
      if (e instanceof ImportError) throw e;
      throw new ImportError('This zip archive is damaged (its directory points outside the file)'); // offsets past the end
    }
    return { text: bytes.toString('utf8'), kind: 'zip', from: tilde(p) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Open for reading only if it is a regular file: a FIFO would block the open (non-blocking here), a device such as
 * /dev/zero would never end. Checked on the open descriptor, so a swap after the check can't sneak one in. */
function openRegular(f) {
  let fd;
  try {
    fd = fs.openSync(f, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch {
    throw new ImportError(`Can't open ${tilde(f)}`);
  }
  const st = fs.fstatSync(fd);
  if (!st.isFile()) {
    fs.closeSync(fd);
    throw new ImportError(`${tilde(f)} is not a regular file`);
  }
  return { fd, size: st.size };
}

function readJsonFile(f) {
  const { fd, size } = openRegular(f);
  try {
    if (size > MAX_JSON_BYTES) throw new ImportError(`conversations.json is over ${Math.round(MAX_JSON_BYTES / 1048576)} MB, too big to read`);
    return readAt(fd, 0, size).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const ts = (v) => {
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v || '');
  return Number.isFinite(t) && t > 0 ? t : 0;
};

/** A message's text: `text`, else its text content parts (other parts, tool calls and files, are skipped). */
export function messageText(m) {
  if (!m || typeof m !== 'object') return '';
  const parts = Array.isArray(m.content) ? m.content.filter((c) => c && (c.type === 'text' || c.type == null) && typeof c.text === 'string').map((c) => c.text) : [];
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  if (parts.length) return parts.join('\n');
  if (typeof m.content === 'string') return m.content;
  return '';
}

const isHuman = (m) => {
  const who = String(m?.sender ?? m?.role ?? m?.author ?? '').toLowerCase();
  return who === 'human' || who === 'user';
};

/** conversations.json text → raw conversations (each with its full text, for linking) + how many were skipped. */
export function parseConversations(text) {
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    // V8's message quotes the text around the error: keep only where it is, never the export's content
    const at = /position (\d+)/.exec(String(e?.message || ''))?.[1];
    throw new ImportError(`conversations.json is not valid JSON${at ? ` (at character ${at})` : ''}: the export may be cut short or damaged`);
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : null;
  if (!list) throw new ImportError('conversations.json should hold a list of conversations: is it the claude.ai export?');
  const out = [];
  let skipped = 0;
  for (const c of list) {
    const uuid = c && typeof c === 'object' ? String(c.uuid ?? c.id ?? '') : '';
    if (!UUID.test(uuid)) {
      skipped++;
      continue;
    }
    const msgs = Array.isArray(c.chat_messages) ? c.chat_messages : Array.isArray(c.messages) ? c.messages : [];
    const texts = [];
    const human = [];
    let first = 0;
    let last = 0;
    for (const m of msgs) {
      const t = messageText(m);
      const at = ts(m?.created_at ?? m?.createdAt ?? m?.timestamp);
      if (at) {
        first = first ? Math.min(first, at) : at;
        last = Math.max(last, at);
      }
      if (!t.trim()) continue;
      texts.push(t);
      if (isHuman(m)) human.push(t);
    }
    const createdAt = ts(c.created_at ?? c.createdAt) || first;
    out.push({
      uuid,
      name: typeof (c.name ?? c.title) === 'string' ? c.name ?? c.title : '',
      createdAt,
      updatedAt: Math.max(ts(c.updated_at ?? c.updatedAt), last, createdAt),
      messages: msgs.length,
      human,
      text: [c.name ?? c.title ?? '', ...texts].join('\n'),
    });
  }
  return { conversations: out, skipped, total: list.length };
}

// ------------------------------------------------------------------ linking chats to projects

/** Names that are folders everyone has, or too short to mean one project. */
const GENERIC_NAMES = new Set(
  'app apps api web site www test tests demo docs doc home project projects code src lib main server client backend frontend website scripts tools utils notes data config temp tmp sandbox playground misc work dev new old blog chat bot readme claude untitled desktop documents downloads repos repo git github'.split(' '),
);

const fold = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
const tokens = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The word sequences that name a project: its display name and its folder name, unless short or generic. */
export function projectNames(p, displayName) {
  const out = [];
  for (const n of new Set([displayName, path.basename(p.path)].filter(Boolean))) {
    const t = tokens(n);
    const joined = t.join('');
    if (!t.length || joined.length < 4 || /^\d+$/.test(joined) || GENERIC_NAMES.has(t.join(' ')) || GENERIC_NAMES.has(fold(n))) continue;
    if (!out.some((x) => x.join(' ') === t.join(' '))) out.push(t);
  }
  return out;
}

/** Whole-word, case-insensitive: a name's words appear next to each other ("pilotage-web" = "Pilotage web"). */
export function makeMatcher(projects) {
  const names = projects.map((x) => ({ path: x.path, names: x.names })).filter((x) => x.names.length);
  return (text) => {
    const words = tokens(text);
    const uni = new Set(words);
    const bi = new Set();
    for (let i = 0; i + 1 < words.length; i++) bi.add(`${words[i]} ${words[i + 1]}`);
    const hits = [];
    for (const x of names) {
      const ok = x.names.some((t) => (t.length === 1 ? uni.has(t[0]) : t.every((w, i) => i === 0 || bi.has(`${t[i - 1]} ${w}`)) || uni.has(t.join(''))));
      if (ok) hits.push(x.path);
    }
    return hits;
  };
}

// ------------------------------------------------------------------ the index

/** The heavy part of an import, in one synchronous call (it runs in the import's child process): read the export, parse it,
 * link each chat to the projects it names and keep only redacted, clipped text. `linkable` = ClaudeAiChats.linkable(). */
export function buildChats(input, linkable) {
  const src = readExport(input);
  const { conversations, skipped, total } = parseConversations(src.text);
  src.text = null;
  if (total && !conversations.length) throw new ImportError('No conversation in this export has an id: is it the claude.ai export?');
  const match = makeMatcher(linkable);
  const chats = [];
  for (let i = 0; i < conversations.length; i++) {
    const c = conversations[i];
    chats.push({
      uuid: c.uuid,
      name: keep(c.name, 200),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: c.messages,
      humanMessages: c.human.length,
      firstPrompt: keep(c.human[0] || '', 400),
      lastPrompt: c.human.length > 1 ? keep(c.human[c.human.length - 1], 400) : '',
      search: clip(redact(c.human.map(oneLine).join(' · ')), SEARCH_CHARS),
      projectPaths: match(c.text),
    });
    conversations[i] = null;
  }
  return { chats, skipped, total, source: { kind: src.kind, from: src.from } };
}

/** buildChats() in a separate Node process with a capped heap. A worker thread is not enough: V8 can abort the whole
 * process when a thread runs out of memory inside JSON.parse. Here the server keeps answering while a big export is
 * read, and an export too big for memory refuses this import instead of ending the server (phone access included). */
function inChild(input, linkable, maxHeapMb) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./claude-ai-worker.js', import.meta.url)), [], {
      execArgv: [`--max-old-space-size=${maxHeapMb}`],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], // nothing the child prints reaches the server's output or log
      serialization: 'advanced',
    });
    let err = '';
    child.stderr.on('data', (d) => {
      if (err.length < 8192) err += d;
    });
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };
    child.once('message', (m) => {
      if (m?.ok) done(resolve, m.result);
      else done(reject, m?.importError ? new ImportError(m.message, m.status || 400) : new Error(m?.message || 'import failed'));
    });
    child.once('error', (e) => done(reject, e));
    child.once('close', (code, signal) => {
      const oom = /heap out of memory|allocation failed/i.test(err);
      done(reject, oom ? new ImportError(`This export needs more memory than Pilotage gives an import (${maxHeapMb} MB), so it was not imported`, 413) : new Error(`the import process stopped (${signal || `exit ${code}`})`));
    });
    child.send({ input, linkable });
  });
}

export class ClaudeAiChats {
  constructor({ registry, store, file = FILE() }) {
    this.registry = registry;
    this.store = store;
    this.file = file;
    this.data = readJSONSync(file, null);
    if (!this.data || !Array.isArray(this.data.chats)) this.data = null;
    this.linkCache = { sig: '', map: new Map() };
    this.hay = new WeakMap(); // chat → folded search text
  }

  /** The projects names can point at (hidden ones and the home folder left out). */
  linkable() {
    const out = [];
    for (const p of this.registry.projects.values()) {
      const over = this.store.project(p.path);
      if (over.hidden || p.path === HOME || p.isWorkspaceRoot) continue;
      out.push({ path: p.path, names: projectNames(p, over.name || p.name) });
    }
    return out;
  }

  /** Replace the import. The reading, parsing and linking run in a child process with its own heap cap
   * (IMPORT_HEAP_MB): a big export can't freeze the server, and one too big for memory fails alone. */
  async import(input, now = Date.now(), { maxHeapMb = IMPORT_HEAP_MB } = {}) {
    const { chats, skipped, total, source } = await inChild(input, this.linkable(), maxHeapMb);
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    this.data = { version: 1, importedAt: now, source, total, skipped, chats };
    writeJSONSync(this.file, this.data, 0o600);
    this.linkCache = { sig: '', map: new Map() };
    return { count: chats.length, skipped, linked: chats.filter((c) => c.projectPaths.length).length, importedAt: now };
  }

  remove() {
    this.data = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {}
  }

  get chats() {
    return this.data?.chats || [];
  }

  /** chat uuid → linked project paths: the import-time links (full text) still valid, plus links from the kept text
   *  to projects named since. Recomputed only when the set of project names changes. */
  links() {
    const ps = this.linkable();
    const sig = ps.map((x) => `${x.path}=${x.names.map((n) => n.join(' ')).join('|')}`).join('\n');
    if (sig !== this.linkCache.sig) {
      const match = makeMatcher(ps);
      const map = new Map();
      const known = new Set(ps.map((x) => x.path));
      for (const ch of this.chats) map.set(ch.uuid, [...new Set([...(ch.projectPaths || []).filter((p) => known.has(p)), ...match(`${ch.name}\n${ch.search}`)])]);
      this.linkCache = { sig, map };
    }
    return this.linkCache.map;
  }

  linksOf(c, map = this.links()) {
    return map.get(c.uuid) || [];
  }

  status() {
    if (!this.data) return { imported: false, count: 0 };
    const m = this.links();
    return { imported: true, count: this.chats.length, importedAt: this.data.importedAt, source: this.data.source, skipped: this.data.skipped || 0, linked: this.chats.filter((c) => this.linksOf(c, m).length).length };
  }

  view(c, m = this.links()) {
    const projects = this.linksOf(c, m)
      .map((pp) => this.registry.projects.get(pp))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: this.store.project(p.path).name || p.name }));
    return { uuid: c.uuid, name: c.name || 'Untitled chat', createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.messages, humanMessages: c.humanMessages, firstPrompt: c.firstPrompt, lastPrompt: c.lastPrompt, projects, url: `https://claude.ai/chat/${encodeURIComponent(c.uuid)}` };
  }

  list({ q = '', projectId = null, limit = 200 } = {}) {
    const m = this.links();
    let arr = this.chats;
    if (projectId) arr = arr.filter((c) => this.linksOf(c, m).some((pp) => this.registry.projects.get(pp)?.id === projectId));
    if (q && q.trim()) arr = this.matching(q, arr);
    return arr.slice(0, limit).map((c) => this.view(c, m));
  }

  matching(q, arr = this.chats) {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return arr.filter((c) => {
      let hay = this.hay.get(c);
      if (hay === undefined) this.hay.set(c, (hay = fold(`${c.name} ${c.firstPrompt} ${c.lastPrompt} ${c.search}`)));
      return words.every((w) => hay.includes(w));
    });
  }

  /** For /api/search: newest matches first. */
  search(q, limit = 12) {
    if (String(q || '').trim().length < 2) return [];
    const m = this.links();
    return this.matching(q).slice(0, limit).map((c) => this.view(c, m));
  }

  /** For the Map (server/graph.js). */
  forGraph() {
    const m = this.links();
    return this.chats.map((c) => ({ uuid: c.uuid, name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.messages, projectPaths: this.linksOf(c, m) }));
  }
}
