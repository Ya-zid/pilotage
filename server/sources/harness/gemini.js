// Gemini CLI sessions: ~/.gemini/tmp/<sha256(projectDir)>/chats/session-<start>-<id8>.json
// One JSON document per chat (rewritten as it grows):
//   {sessionId, projectHash, startTime, lastUpdated, messages:[
//     {id, timestamp, type:'user', content},
//     {id, timestamp, type:'gemini', content, toolCalls:[{id,name,args,result,status}], tokens:{output}, model},
//     {type:'info'|'error'|'warning', ...}]}
// The project folder is not stored, only its sha256, so we hash known folders to find it.
// A second chat file with the same sessionId whose time range sits inside the first one's is a
// sub-agent run (e.g. codebase_investigator) and is skipped, like Claude sidechains.
// Turn `off` is the message index in `messages` (not a byte offset); turnDetail re-reads the file.
// Antigravity (~/.gemini/antigravity/conversations/*.pb) is encrypted/compressed: not supported.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, WIN_HOME, SCAN_SKIP, HOME_SKIP } from '../../config.js';
import { yieldNow, holdsProjects } from '../../util.js';
import { clip, baseMeta, TurnBuilder, tsOf, cleanCwd, pruneFiles, addPrLinks } from './common.js';

export const GEMINI_DIR = path.join(HOME, '.gemini');
const FILE_TOOLS = new Set(['write_file', 'replace', 'edit', 'smart_edit', 'write_todos_file']);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const geminiIdFor = (file) => `gemini-${path.basename(file, '.json').replace(/^session-/, '')}`;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  return '';
}

/** "/model", "/stats" ... (one word, starts with "/") are UI commands, not prompts. */
const isUiCommand = (t) => /^\/[\w-]+$/.test(t.trim());

function toolSummary(tc) {
  const a = tc.args || {};
  const pick = a.command || a.file_path || a.absolute_path || a.path || a.pattern || a.query || a.url || a.description || Object.values(a).find((v) => typeof v === 'string') || '';
  return clip(String(pick).replace(/\s+/g, ' '), 220);
}

function toolResult(tc) {
  const r = Array.isArray(tc.result) ? tc.result : [];
  const out = r.map((x) => x?.functionResponse?.response?.output ?? x?.functionResponse?.response?.error ?? '').filter((x) => typeof x === 'string');
  return out.join('\n') || (typeof tc.resultDisplay === 'string' ? tc.resultDisplay : '');
}

/** Parse one chat document. Returns {meta, turns}. */
export function parseGeminiChat(doc, { id, file, cwd } = {}) {
  const meta = baseMeta(id || 'gemini-unknown', 'gemini', file || null);
  const turns = [];
  const tb = new TurnBuilder(meta, turns);
  meta.cwd = cleanCwd(cwd);
  meta.entrypoint = 'cli';
  meta.geminiSessionId = doc?.sessionId || null;
  meta.projectHash = doc?.projectHash || null;
  tb.touch(tsOf(doc?.startTime));
  const msgs = Array.isArray(doc?.messages) ? doc.messages : [];
  msgs.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const ts = tsOf(m.timestamp);
    if (m.type === 'user') {
      const text = textOf(m.content).trim();
      if (!text || isUiCommand(text)) return tb.touch(ts);
      tb.prompt('h', text, ts, i);
    } else if (m.type === 'gemini') {
      if (m.model) meta.models[m.model] = (meta.models[m.model] || 0) + 1;
      if (typeof m.tokens?.output === 'number') meta.outTokens += m.tokens.output;
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        tb.tool(tc.name, ts);
        if (tc.result != null) meta.counts.toolResult++;
        const fp = tc.args?.file_path || tc.args?.absolute_path;
        if (FILE_TOOLS.has(tc.name) && typeof fp === 'string') tb.file(fp, meta.cwd);
        addPrLinks(meta, toolResult(tc));
      }
      const text = textOf(m.content).trim();
      if (text) {
        meta.counts.assistantText++;
        tb.reply(text, ts, i);
      } else tb.touch(ts);
    } else tb.touch(ts);
  });
  tb.touch(tsOf(doc?.lastUpdated));
  meta.turnCount = turns.length;
  if (meta.cwd) meta.projectKey = meta.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  pruneFiles(meta);
  return { meta, turns };
}

/** sha256(dir) → dir for candidate project folders. */
class HashResolver {
  constructor() {
    this.map = new Map();
    this.walkedAt = 0;
  }
  add(dir) {
    if (dir && !this.map.has(sha(dir))) this.map.set(sha(dir), dir);
  }
  async walk() {
    this.walkedAt = Date.now();
    const roots = [{ dir: HOME, depth: 4 }];
    if (WIN_HOME) roots.push({ dir: path.join(WIN_HOME, 'Documents', 'Projects'), depth: 2 });
    let n = 0;
    const visit = async (dir, depth, max) => {
      this.add(dir);
      if (depth >= max) return;
      let ents;
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const subdirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SCAN_SKIP.has(e.name) && !(dir === HOME && HOME_SKIP.has(e.name))).map((e) => e.name);
      // A huge folder is skipped (generated), unless it holds projects (~/code with 400+ repos): see holdsProjects.
      if (ents.length > 400 && depth >= 1 && !(await holdsProjects(dir, subdirs, ['.git', 'GEMINI.md', 'CLAUDE.md']))) return;
      for (const name of subdirs) {
        if (++n % 200 === 0) await yieldNow();
        await visit(path.join(dir, name), depth + 1, max);
      }
    };
    for (const r of roots) if (fs.existsSync(r.dir)) await visit(r.dir, 0, r.depth);
  }
  async resolve(hash) {
    if (this.map.has(hash)) return this.map.get(hash);
    if (Date.now() - this.walkedAt > 10 * 60e3) await this.walk();
    return this.map.get(hash) || null;
  }
}

async function listChats(dir) {
  const out = [];
  let projects = [];
  try {
    projects = await fsp.readdir(path.join(dir, 'tmp'), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory() || !/^[0-9a-f]{64}$/.test(p.name)) continue;
    const chats = path.join(dir, 'tmp', p.name, 'chats');
    let ents = [];
    try {
      ents = await fsp.readdir(chats);
    } catch {
      continue;
    }
    for (const n of ents) {
      if (!/^session-.+\.json$/.test(n)) continue;
      const file = path.join(chats, n);
      try {
        const st = await fsp.stat(file);
        out.push({ id: geminiIdFor(file), file, projectHash: p.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

async function turnDetail(meta, turns, index) {
  const turn = turns[index];
  if (!turn) return { items: [] };
  let doc = null;
  try {
    doc = JSON.parse(await fsp.readFile(meta.file, 'utf8'));
  } catch {}
  const msgs = Array.isArray(doc?.messages) ? doc.messages : null;
  if (!msgs || turn.off < 0) return { items: [{ kind: 'prompt', text: turn.p, t: turn.t }, ...(turn.a ? [{ kind: 'text', text: turn.a, t: turn.at }] : [])] };
  const next = turns.slice(index + 1).find((x) => x.off > turn.off);
  const end = next ? next.off : msgs.length;
  const items = [];
  for (let i = turn.off; i < end && items.length < 1500; i++) {
    const m = msgs[i];
    if (!m) continue;
    const t = tsOf(m.timestamp);
    if (m.type === 'user') {
      const text = textOf(m.content).trim();
      if (text && !isUiCommand(text)) items.push({ kind: 'prompt', origin: 'h', text: clip(text, 20000), t });
    } else if (m.type === 'gemini') {
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        items.push({ kind: 'tool', id: String(tc.id || `g${i}-${items.length}`), name: tc.displayName || tc.name || '?', summary: toolSummary(tc), t: tsOf(tc.timestamp) || t, error: tc.status ? tc.status !== 'success' : false, result: clip(toolResult(tc), 1200) });
      }
      const text = textOf(m.content).trim();
      if (text) items.push({ kind: 'text', text: clip(text, 30000), t });
    }
  }
  return { items };
}

export const geminiAdapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  dir: GEMINI_DIR,
  resolver: new HashResolver(),
  async scan({ known, knownCwds = () => [] }) {
    const files = await listChats(this.dir);
    if (!files.length) return { metas: [], turns: new Map() };
    for (const m of known.values()) if (m.cwd) this.resolver.add(m.cwd);
    for (const c of knownCwds()) this.resolver.add(c);
    // Read headers (sessionId + time range) to spot sub-agent chats.
    const docs = new Map();
    const metas = [];
    const turns = new Map();
    const pending = [];
    for (const f of files) {
      const prev = known.get(f.id);
      if (prev && prev.file === f.file && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
        metas.push(prev);
        continue;
      }
      let doc;
      try {
        doc = JSON.parse(await fsp.readFile(f.file, 'utf8'));
      } catch {
        // Gemini rewrites the chat in place: a torn read keeps the last good meta (its old size/mtime
        // make the next scan retry) instead of reporting the session as gone for one scan.
        if (prev) metas.push(prev);
        continue;
      }
      docs.set(f.id, doc);
      pending.push(f);
    }
    // Sub-agent detection needs every chat's sessionId/time range, cached ones included.
    const ranges = [];
    for (const m of metas) ranges.push({ id: m.id, sid: m.geminiSessionId, a: m.startedAt, b: m.lastAt });
    for (const f of pending) {
      const d = docs.get(f.id);
      ranges.push({ id: f.id, sid: d.sessionId, a: tsOf(d.startTime), b: tsOf(d.lastUpdated) });
    }
    const isSub = (id, sid, a, b) => ranges.some((r) => r.id !== id && r.sid && r.sid === sid && r.a < a && r.b >= b);
    for (const f of pending) {
      const d = docs.get(f.id);
      if (isSub(f.id, d.sessionId, tsOf(d.startTime), tsOf(d.lastUpdated))) continue;
      const cwd = await this.resolver.resolve(f.projectHash);
      const r = parseGeminiChat(d, { id: f.id, file: f.file, cwd });
      if (!r.turns.length) continue;
      r.meta.size = f.size;
      r.meta.mtimeMs = f.mtimeMs;
      r.meta.offset = f.size;
      metas.push(r.meta);
      turns.set(f.id, r.turns);
    }
    return { metas: metas.filter((m) => !isSub(m.id, m.geminiSessionId, m.startedAt, m.lastAt)), turns };
  },
  turnDetail,
};
