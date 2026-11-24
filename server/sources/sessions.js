// Incremental indexer for Claude Code transcripts (~/.claude/projects/*/*.jsonl),
// for both the WSL and the Windows-side Claude installs, plus history.jsonl.
//
// Transcripts are append-only JSONL, some several hundred MB. We read each file
// once, remember the byte offset, and on later scans only parse the new bytes.
// Huge lines (tool results, request blobs) are classified from their first bytes
// and skipped without JSON.parse.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CLAUDE_DIR, WIN_CLAUDE_DIR, WSL_DISTRO, paths, isInternalPath, HOME } from '../config.js';
import { readJSONSync, writeJSON, writeJSONSync, clip as rawClip, yieldNow, log, isInside, redact, hash, isoDay } from '../util.js';
import { getStore } from '../store.js';
import { codexAdapter } from './harness/codex.js';
import { geminiAdapter } from './harness/gemini.js';

// Everything stored or shown from transcripts goes through redact().
// Redact the whole text, then clip: clipping first could cut a secret in two and show its first part. Every redaction
// pattern is bounded, so this stays linear (a 1 MB blob takes milliseconds).
const clip = (s, n) => rawClip(redact(s), n);

const CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 96 * 1024 * 1024;
const MAX_PARSE = 6 * 1024 * 1024;
/**
 * The line as text, with base64 payloads (pasted screenshots) of 1 KB or more blanked, so a prompt carrying several
 * images still parses under MAX_PARSE; null if it is still too big. A plain indexOf scan: a regex over one multi-MB
 * base64 run overflows V8's stack (RangeError), which used to drop the whole session.
 */
function parsable(buf) {
  if (buf.length <= MAX_PARSE) return buf.toString('utf8');
  const s = buf.toString('utf8');
  const KEY = '"data":"';
  let out = '';
  let from = 0;
  for (let i = s.indexOf(KEY); i !== -1; i = s.indexOf(KEY, from)) {
    const start = i + KEY.length;
    const end = s.indexOf('"', start);
    if (end === -1) break;
    out += s.slice(from, start);
    // Keep short values (they aren't images); blank long ones.
    if (end - start < 1024) out += s.slice(start, end);
    from = end;
  }
  out += s.slice(from);
  return out.length <= MAX_PARSE ? out : null;
}
const META_TYPES = new Set(['ai-title', 'custom-title', 'last-prompt', 'summary', 'agent-name', 'pr-link', 'session-owner']);
// Appends to a running session wait this long before its turns file and the index are rewritten (see flush()).
const FLUSH_MS = 45000;
const PR_RX = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const TRIVIAL_COMMANDS = new Set(
  (
    '/model /clear /compact /config /resume /rc /remote-control /login /logout /status /usage /cost /help /exit /quit ' +
    '/effort /fast /mcp /doctor /theme /permissions /agents /ide /memory /vim /terminal-setup /statusline /hooks /plugin ' +
    '/plugins /context /export /add-dir /upgrade /release-notes /privacy-settings /output-style /bashes /todos /rewind ' +
    '/stats /tasks /feedback /bug /copy /rename /btw /sandbox /keybindings /voice /tui /focus /extra-usage /artifacts /desktop /mobile /fleet'
  ).split(' '),
);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Older index entries (no `usage` yet) get their token counts in the background, this many transcript bytes per scan.
const USAGE_BACKFILL_BYTES = 128 * 1024 * 1024;

export const ORIGIN = {
  human: 'h',
  sdk: 's',
  peer: 'p',
  task_notification: 'n',
  scheduled: 'c',
  system: 'y',
  compact: 'x',
};

/**
 * Convert a Windows path to its WSL path: C:\Users\X\.. → /mnt/c/Users/X/..; a folder of this distro opened from
 * Windows (\\wsl.localhost\<distro>\home\.. or \\wsl$\<distro>\..) → /home/... Other paths are returned unchanged.
 */
export function winToWsl(p) {
  const u = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(p || '');
  if (u) {
    if (u[1].toLowerCase() !== WSL_DISTRO.toLowerCase()) return p; // another distro: not this file system
    return `/${(u[2] || '').replace(/\\/g, '/')}`.replace(/(.)\/+$/, '$1');
  }
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p || '');
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/+$/, '');
}

/** Directory name Claude Code uses for a project path. */
export function projectKeyFor(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Attribute /tmp scratchpad sessions back to the project they belong to. */
export function normalizeCwd(cwd) {
  if (!cwd) return cwd;
  const m = /^\/tmp\/claude-\d+\/(-[^/]+)/.exec(cwd);
  if (m) {
    // -home-alex-acme-0823b372-...-scratchpad → /home/alex/acme (best effort)
    const enc = m[1].replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*$/, '');
    const guess = enc.replace(/-/g, '/');
    if (guess.startsWith(HOME) && fs.existsSync(guess)) return guess;
    return cwd;
  }
  return cwd.replace(/\/+$/, '') || '/';
}

/** Classify a raw transcript line from its first bytes: 'user' | 'assistant' | 'system' | null. */
export function headType(head) {
  const tm = /"type":"(user|assistant|system|attachment|progress|summary|file-history-snapshot)"/.exec(head);
  const t = tm ? tm[1] : null;
  if (t === 'user' || t === 'assistant' || t === 'system') return t;
  if (t && t !== 'summary') return null;
  if (head.includes('"role":"assistant"')) return 'assistant';
  if (head.includes('"role":"user"')) return 'user';
  return null;
}

function stripReminders(s) {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** A folder's real path (through symlinks), else the path as given (missing, unreadable for a moment). */
function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function tsOf(o) {
  if (!o || !o.timestamp) return 0;
  const t = Date.parse(o.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function newMeta(id, source, file, projectKey) {
  return {
    id,
    source,
    file,
    projectKey,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    startedAt: 0,
    lastAt: 0,
    lastHumanAt: 0,
    aiTitle: null,
    customTitle: null,
    agentName: null,
    lastPrompt: null,
    summaryTitle: null,
    awaySummary: null,
    awayAt: 0,
    compactions: 0,
    bridgeIds: [],
    counts: { h: 0, s: 0, p: 0, n: 0, c: 0, y: 0, x: 0, assistantText: 0, toolUse: 0, toolResult: 0 },
    tools: {},
    files: {},
    prs: [],
    models: {},
    outTokens: 0,
    // Tokens from the API usage on assistant lines (main conversation): totals, per local day as [in, out, cw, cr]
    // (input, output, cache write, cache read), and the last message counted (its lines repeat the usage; see addUsage).
    // Missing in index entries written by earlier versions: backfillUsage() fills them in.
    usage: { in: 0, out: 0, cw: 0, cr: 0 },
    usageDays: {},
    usageMsg: null,
    firstPrompt: null,
    turnCount: 0,
    archived: false,
    roots: [], // uuids of the first turn and of compact summaries: where a fork of this session can start (markForks)
  };
}

/** Human prompts of a session, without those a fork copied from its parent (they count in the parent). */
export function ownPrompts(meta) {
  return Math.max(0, (meta?.counts?.h || 0) - (meta?.inherited?.h || 0));
}

/**
 * A session's token usage without the lines a fork copied from its parent (their API usage is the parent's, counted
 * there): {usage, usageDays} like the meta's, or null when its usage isn't recorded.
 */
export function ownUsage(meta) {
  if (!meta?.usage) return null;
  const inh = meta.inherited?.usage;
  if (!inh) return { usage: meta.usage, usageDays: meta.usageDays || {} };
  const usage = {};
  for (const k of ['in', 'out', 'cw', 'cr']) usage[k] = Math.max(0, (meta.usage[k] || 0) - (inh[k] || 0));
  const usageDays = {};
  for (const [day, u] of Object.entries(meta.usageDays || {})) {
    const minus = meta.inherited.usageDays?.[day] || [0, 0, 0, 0];
    const own = u.map((v, i) => Math.max(0, v - (minus[i] || 0)));
    if (own.some(Boolean)) usageDays[day] = own;
  }
  return { usage, usageDays };
}

/** Classify a user-message string. Returns {origin, text} or null to skip. */
function classifyUserText(o, raw) {
  let text = typeof raw === 'string' ? raw : '';
  if (o.isCompactSummary) return { origin: ORIGIN.compact, text: clip(text, 5000) };
  const to = typeof o.turnOrigin === 'string' ? o.turnOrigin : null;
  if (o.isMeta) {
    if (to === 'peer') return { origin: ORIGIN.peer, text: clip(stripReminders(text), 600) };
    if (to === 'scheduled') return { origin: ORIGIN.scheduled, text: clip(stripReminders(text), 300) };
    return null;
  }
  const t = text.trimStart();
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
    const name = (/<command-name>([^<]*)<\/command-name>/.exec(t) || [])[1]?.trim() || '';
    const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(t) || [])[1]?.trim() || '';
    const n = name.startsWith('/') ? name : `/${name}`;
    if (!name || TRIVIAL_COMMANDS.has(n)) return null;
    return { origin: ORIGIN.human, text: clip(`${n} ${args}`.trim(), 1500) };
  }
  if (t.startsWith('<local-command') || t.startsWith('<bash-') || t.startsWith('<user-memory-input')) return null;
  if (t.startsWith('<task-notification>') || to === 'task_notification') {
    return { origin: ORIGIN.task_notification, text: clip(stripReminders(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 300) };
  }
  text = stripReminders(text);
  if (!text) return null;
  let origin = ORIGIN.human;
  if (to && ORIGIN[to]) origin = ORIGIN[to];
  else if (o.promptSource === 'sdk' || o.entrypoint === 'sdk-cli') origin = ORIGIN.sdk;
  if (origin === ORIGIN.human && o.entrypoint === 'sdk-cli' && to !== 'human') origin = ORIGIN.sdk;
  const lim = origin === ORIGIN.human || origin === ORIGIN.sdk ? 1500 : 400;
  return { origin, text: clip(text, lim) };
}

function addPrLinks(meta, s) {
  if (!s || s.indexOf('/pull/') === -1) return;
  const m = s.match(PR_RX);
  if (!m) return;
  for (const u of m) {
    if (!meta.prs.includes(u)) {
      meta.prs.push(u);
      if (meta.prs.length > 60) meta.prs.shift();
    }
  }
}

function pruneFiles(meta) {
  const entries = Object.entries(meta.files);
  if (entries.length <= 300) return;
  entries.sort((a, b) => b[1] - a[1]);
  meta.files = Object.fromEntries(entries.slice(0, 200));
}

const tok = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * Count one assistant line's API usage into meta.usage / usageDays (and outTokens). Claude Code writes one line per
 * content block (thinking, text, tool call) and repeats the message's usage on each, so lines of the same message id
 * count once: each field adds only what it grew by since that message's previous line (they can grow while it streams).
 */
export function addUsage(m, msg, ts) {
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return;
  const cur = [tok(u.input_tokens), tok(u.output_tokens), tok(u.cache_creation_input_tokens), tok(u.cache_read_input_tokens)];
  const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
  const prev = id && m.usageMsg?.id === id ? m.usageMsg.u : [0, 0, 0, 0];
  const add = cur.map((v, i) => Math.max(0, v - prev[i]));
  m.usageMsg = id ? { id, u: cur.map((v, i) => Math.max(v, prev[i])) } : null;
  if (!add.some(Boolean)) return;
  if (!m.usage) m.usage = { in: 0, out: 0, cw: 0, cr: 0 };
  if (!m.usageDays) m.usageDays = {};
  m.usage.in += add[0];
  m.usage.out += add[1];
  m.usage.cw += add[2];
  m.usage.cr += add[3];
  m.outTokens = (m.outTokens || 0) + add[1];
  const day = isoDay(ts || m.lastAt || Date.now());
  const d = (m.usageDays[day] ||= [0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) d[i] += add[i];
}

/** Usage only, for backfilling older index entries: assistant lines of the main conversation, nothing else. */
class UsageParser {
  constructor(meta) {
    this.meta = meta;
  }
  line(buf) {
    if (buf.length < 10) return;
    const head = buf.toString('latin1', 0, Math.min(buf.length, 700));
    // The same lines TranscriptParser reads usage from (it skips {"type":"…"} lines that aren't titles).
    if (head.startsWith('{"type":"') || headType(head) !== 'assistant' || head.includes('"isSidechain":true') || !buf.includes('"usage"')) return;
    const text = parsable(buf);
    if (text == null) return;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    if (!o.isSidechain) addUsage(this.meta, o.message, tsOf(o));
  }
}

/** Parser for one transcript; mutates meta + turns. */
class TranscriptParser {
  constructor(meta, turns, mapCwd) {
    this.meta = meta;
    this.turns = turns;
    this.mapCwd = mapCwd;
  }
  cur() {
    return this.turns[this.turns.length - 1];
  }
  /** New turn; its line's uuid is kept so a fork's copies of it can be recognised (markForks). */
  push(turn, o, origin) {
    const m = this.meta;
    if (typeof o.uuid === 'string' && o.uuid.length <= 64) {
      turn.u = o.uuid;
      if (!this.turns.length || origin === ORIGIN.compact) {
        m.roots = (m.roots || []).concat(o.uuid);
        if (m.roots.length > 50) m.roots.splice(1, 1); // keep the first turn's
      }
      // A copied line that still names the session it was written in.
      if (!this.turns.length && typeof o.sessionId === 'string' && o.sessionId !== m.id) m.forkOf = o.sessionId;
    }
    this.turns.push(turn);
    return turn;
  }
  touch(ts) {
    if (!ts) return;
    const m = this.meta;
    if (!m.startedAt || ts < m.startedAt) m.startedAt = ts;
    if (ts > m.lastAt) m.lastAt = ts;
    const c = this.cur();
    if (c && ts > (c.e || 0)) c.e = ts;
  }
  line(buf, off) {
    if (buf.length < 10) return;
    const head = buf.toString('latin1', 0, Math.min(buf.length, 700));
    const m = this.meta;
    if (head.startsWith('{"type":"')) {
      const t = head.slice(9, head.indexOf('"', 9));
      if (!META_TYPES.has(t) || buf.length > 400_000) return;
      let o;
      try {
        o = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (t === 'ai-title' && o.aiTitle) m.aiTitle = clip(o.aiTitle, 160);
      else if (t === 'custom-title' && o.customTitle) m.customTitle = clip(o.customTitle, 160);
      else if (t === 'agent-name' && o.agentName) m.agentName = clip(o.agentName, 120);
      else if (t === 'last-prompt' && o.lastPrompt) m.lastPrompt = clip(o.lastPrompt, 600);
      else if (t === 'summary' && o.summary) m.summaryTitle = clip(o.summary, 200);
      else if (t === 'session-owner' && !m.accountUuid && typeof o.accountUuid === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(o.accountUuid)) m.accountUuid = o.accountUuid;
      return;
    }
    // Key order varies between Claude Code versions (assistant lines often start with the nested
    // "message":{"type":"message","role":"assistant"...}), so classify on several markers.
    const type = headType(head);
    if (!type) return;
    if (head.includes('"isSidechain":true')) return;
    if (type === 'user' && (head.includes('"tool_use_id"') || head.includes('"type":"tool_result"'))) {
      m.counts.toolResult++;
      if (buf.length < 1_500_000 && buf.includes('/pull/')) addPrLinks(m, buf.toString('utf8'));
      return;
    }
    // Over MAX_PARSE: usually a prompt with screenshots. Skipping it dropped the prompt and moved its reply onto the
    // previous one, so parse it with the image data blanked.
    const text = parsable(buf);
    if (text == null) return;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    if (o.isSidechain) return;
    const ts = tsOf(o);
    if (o.cwd && !m.cwd) m.cwd = normalizeCwd(this.mapCwd(o.cwd));
    if (o.gitBranch && o.gitBranch !== 'HEAD') m.gitBranch = o.gitBranch;
    if (o.version) m.version = o.version;
    if (o.entrypoint && !m.entrypoint) m.entrypoint = o.entrypoint;

    if (type === 'system') {
      if (o.subtype === 'away_summary' && o.content) {
        m.awaySummary = clip(String(o.content).replace(/\s*\(disable recaps in \/config\)\s*$/, ''), 1500);
        m.awayAt = ts;
      } else if (o.subtype === 'bridge_status' && o.url) {
        const id = String(o.url).split('/').pop();
        if (id && !m.bridgeIds.includes(id)) m.bridgeIds.push(id);
        if (m.bridgeIds.length > 20) m.bridgeIds.shift();
      }
      // (compactions are counted once, from the compact-summary user line)
      this.touch(ts);
      return;
    }

    if (type === 'user') {
      const c = o.message?.content;
      let cls = null;
      if (typeof c === 'string') cls = classifyUserText(o, c);
      else if (Array.isArray(c)) {
        const texts = c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text);
        const hasImage = c.some((x) => x && x.type === 'image');
        const joined = texts.join('\n');
        cls = classifyUserText(o, joined || (hasImage ? '[image]' : ''));
        if (cls && hasImage && joined) cls.text = clip(`[image] ${cls.text}`, 1500);
      }
      if (!cls) {
        this.touch(ts);
        return;
      }
      m.counts[cls.origin] = (m.counts[cls.origin] || 0) + 1;
      if (cls.origin === ORIGIN.compact) m.compactions++;
      if ((cls.origin === ORIGIN.human || cls.origin === ORIGIN.sdk) && !m.firstPrompt) m.firstPrompt = clip(cls.text, 600);
      if (cls.origin === ORIGIN.human) m.lastHumanAt = Math.max(m.lastHumanAt, ts);
      this.push({ t: ts, o: cls.origin, p: cls.text, off, a: '', at: 0, n: 0, e: ts }, o, cls.origin);
      this.touch(ts);
      return;
    }

    // assistant
    const msg = o.message || {};
    if (msg.model && msg.model !== '<synthetic>') m.models[msg.model] = (m.models[msg.model] || 0) + 1;
    addUsage(m, msg, ts);
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        m.counts.assistantText++;
        let cur = this.cur();
        if (!cur) cur = this.push({ t: ts, o: ORIGIN.system, p: '', off, a: '', at: 0, n: 0, e: ts }, o, ORIGIN.system);
        cur.a = clip(b.text.trim(), 1600);
        cur.at = ts;
        addPrLinks(m, b.text);
      } else if (b.type === 'tool_use') {
        m.counts.toolUse++;
        const name = String(b.name || '?');
        m.tools[name] = (m.tools[name] || 0) + 1;
        const cur = this.cur();
        if (cur) cur.n++;
        const fp = b.input && (b.input.file_path || b.input.notebook_path);
        if (FILE_TOOLS.has(name) && typeof fp === 'string') {
          const p = normalizeCwd(this.mapCwd(fp));
          m.files[p] = (m.files[p] || 0) + 1;
        }
      }
    }
    this.touch(ts);
  }
}

/**
 * Feed every complete line of `file` from `fromOffset` to `size` to parser.line(buf, offset), in 8 MB chunks; lines over
 * MAX_LINE are skipped. Returns the offset after the last complete line (the rest is re-read next time).
 */
async function readLines(file, parser, fromOffset, size) {
  const fh = await fsp.open(file, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = fromOffset;
  let carry = null; // partial line
  let carryOff = fromOffset;
  let skipping = false;
  let lastGood = fromOffset;
  let chunks = 0;
  try {
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) break;
      let start = 0;
      while (start < bytesRead) {
        const nl = buf.indexOf(10, start);
        if (nl === -1 || nl >= bytesRead) {
          // partial line until next chunk
          if (!skipping) {
            const part = Buffer.from(buf.subarray(start, bytesRead));
            if (!carry) {
              carry = part;
              carryOff = pos + start;
            } else carry = Buffer.concat([carry, part]);
            if (carry.length > MAX_LINE) {
              carry = null;
              skipping = true;
            }
          }
          break;
        }
        const lineEnd = pos + nl + 1;
        if (skipping) {
          skipping = false;
          carry = null;
        } else if (carry) {
          const full = Buffer.concat([carry, buf.subarray(start, nl)]);
          parser.line(full, carryOff);
          carry = null;
        } else {
          parser.line(buf.subarray(start, nl), pos + start);
        }
        lastGood = lineEnd;
        start = nl + 1;
      }
      pos += bytesRead;
      if (++chunks % 4 === 0) await yieldNow();
    }
  } finally {
    await fh.close();
  }
  return lastGood;
}

async function parseFile(meta, turns, mapCwd, fromOffset, size) {
  // Only advance to the last complete line; the rest is re-read next time.
  meta.offset = await readLines(meta.file, new TranscriptParser(meta, turns, mapCwd), fromOffset, size);
  pruneFiles(meta);
  meta.turnCount = turns.length;
}

/** Token usage of the part of a transcript already indexed (0 to meta.offset), into a fresh set of usage fields. */
async function fillUsage(meta, end = meta.offset || 0) {
  const m = { ...meta, usage: { in: 0, out: 0, cw: 0, cr: 0 }, usageDays: {}, usageMsg: null, outTokens: 0 };
  await readLines(meta.file, new UsageParser(m), 0, end);
  return { usage: m.usage, usageDays: m.usageDays, usageMsg: m.usageMsg, outTokens: m.outTokens };
}

export class SessionIndex extends EventEmitter {
  constructor() {
    super();
    this.meta = new Map(); // id -> meta
    this.turnCache = new Map(); // id -> turns, the 40 most recently used (cacheTurns)
    this.history = new Map(); // id -> {cwd, prompts:[{t,p}], source}
    this.historyMtime = {};
    this.historyLoaded = new Set();
    this.historyRead = {}; // src -> {size, offset, head} of the last history read (see readHistoryBytes)
    this.scanning = false;
    this.progress = { total: 0, done: 0, bytes: 0, running: false, firstDone: false };
    const saved = readJSONSync(paths.index, null);
    if (saved && saved.version === 4 && Array.isArray(saved.sessions)) {
      for (const s of saved.sessions) this.meta.set(s.id, s.harness ? s : { ...s, harness: 'claude' });
      this.historyMtime = saved.historyMtime || {};
      this.progress.firstDone = true;
    }
    this.sources = [{ id: 'wsl', dir: CLAUDE_DIR, mapCwd: (p) => p }];
    if (WIN_CLAUDE_DIR) this.sources.push({ id: 'win', dir: WIN_CLAUDE_DIR, mapCwd: winToWsl });
    // Turns of sessions that only grew, not yet written: a long live session would otherwise rewrite its whole
    // turns file and the whole index on every 8 s scan. Written together with the index by flush().
    this.pendingTurns = new Map();
    this._flushTimer = null;
    this.flushing = null;
    this.lastScan = { structural: true }; // false when the last scan only grew known sessions (same folders)
    // Other harnesses (Codex, Gemini, ...): see sources/harness/common.js for the adapter contract.
    this.adapters = [];
    this.registerAdapter(codexAdapter);
    this.registerAdapter(geminiAdapter);
  }

  registerAdapter(adapter) {
    if (!adapter?.id || typeof adapter.scan !== 'function') throw new Error('adapter needs id + scan()');
    this.adapters = this.adapters.filter((a) => a.id !== adapter.id).concat(adapter);
  }

  sourceSettings() {
    try {
      return getStore().settings.sources || {};
    } catch {
      return {};
    }
  }

  /**
   * Claude config dirs to index: WSL, Windows, plus settings.sources.extraClaudeDirs (other accounts). One source per
   * real folder: a ~/.claude symlinked to the Windows profile's (or an extra dir aliasing another) would list every
   * transcript twice, and each scan would re-parse it in full under both paths.
   */
  allSources() {
    const out = [];
    const byReal = new Map(); // real path -> index in out
    const add = (s) => {
      const real = realOr(s.dir);
      if (!byReal.has(real)) {
        byReal.set(real, out.length);
        out.push(s);
      } else if (s.mapCwd === winToWsl) {
        // Windows' Claude Code writes there too: map its C:\ folders (POSIX paths pass through winToWsl unchanged).
        const i = byReal.get(real);
        out[i] = { ...out[i], mapCwd: winToWsl };
      }
    };
    for (const s of this.sources) add(s);
    for (const dir of this.sourceSettings().extraClaudeDirs || []) {
      if (typeof dir === 'string' && path.isAbsolute(dir)) add({ id: `x-${hash(dir, 6)}`, dir, mapCwd: winToWsl, extra: true });
    }
    return out;
  }

  /**
   * Run every adapter; adapter metas live in this.meta next to Claude ones (harness !== 'claude'). Ids of sessions
   * that only grew (same file and folder, no turn lost) also go into `grew`: like Claude appends, their writes wait
   * for flush() instead of rewriting the turns file and the whole index on every scan.
   */
  async scanAdapters(grew = new Set()) {
    const changed = [];
    const enabled = this.sourceSettings().harnesses || {};
    const cwds = () => [...new Set([...this.meta.values()].map((m) => m.cwd).filter(Boolean))];
    for (const a of this.adapters) {
      const known = new Map();
      for (const [id, m] of this.meta) if (m.harness === a.id) known.set(id, m);
      let res = { metas: [], turns: new Map() };
      if (enabled[a.id] !== false) {
        try {
          res = await a.scan({ known, knownCwds: cwds, loadTurns: (id) => this.loadTurns(id) });
        } catch (e) {
          log.warn(`adapter ${a.id} scan failed`, e.message);
          continue;
        }
      }
      const turnsOf = res.turns instanceof Map ? res.turns : new Map(Object.entries(res.turns || {}));
      const present = new Set();
      for (const m0 of res.metas || []) {
        if (!m0?.id || (this.meta.has(m0.id) && !known.has(m0.id))) continue; // never shadow another harness' id
        const m = m0.harness === a.id ? m0 : { ...m0, harness: a.id };
        present.add(m.id);
        const t = turnsOf.get(m.id);
        const prev = known.get(m.id);
        const grown = !!prev && prev.file === m.file && m.size >= prev.size && prev.cwd === m.cwd && (!t || t.length >= (prev.turnCount || 0));
        if (t) {
          m.turnCount = t.length;
          this.cacheTurns(m.id, t);
          if (grown) this.pendingTurns.set(m.id, t);
          else {
            this.pendingTurns.delete(m.id);
            await writeJSON(this.turnsFile(m.id), t);
          }
        }
        if (!prev || t || prev.size !== m.size || prev.mtimeMs !== m.mtimeMs) {
          changed.push(m.id);
          if (grown) grew.add(m.id);
        }
        this.meta.set(m.id, m);
      }
      for (const id of known.keys()) {
        if (present.has(id)) continue;
        this.meta.delete(id);
        this.turnCache.delete(id);
        this.pendingTurns.delete(id);
        changed.push(id);
      }
    }
    return changed;
  }

  /** Claude sessions whose token usage isn't counted yet (index entries from before usage was recorded). */
  usagePending() {
    let n = 0;
    for (const m of this.meta.values()) if (m.usage === undefined && (m.harness || 'claude') === 'claude' && m.file) n++;
    return n;
  }

  /**
   * Token usage for older index entries, newest first, at most USAGE_BACKFILL_BYTES of transcript per scan so a big
   * history doesn't hold up indexing. Reads the part already indexed; turns are left as they are (so AI summaries,
   * keyed by turn, stay valid). An entry whose file changed in the meantime is left for the next scan.
   */
  async backfillUsage() {
    const changed = [];
    this.usageFailed ||= new Set(); // unreadable this run: not retried (nor logged) every scan
    const todo = [...this.meta.values()].filter((m) => m.usage === undefined && (m.harness || 'claude') === 'claude' && m.file && !this.usageFailed.has(m.id)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    let budget = USAGE_BACKFILL_BYTES;
    for (const m of todo) {
      if (budget <= 0) break;
      budget -= m.offset || 0;
      let u;
      try {
        u = await fillUsage(m);
      } catch (e) {
        this.usageFailed.add(m.id);
        if (e?.code !== 'ENOENT') log.warn('usage backfill', m.file, e.message);
        continue;
      }
      const now = this.meta.get(m.id);
      if (now !== m) continue; // re-indexed meanwhile (it then has its own count)
      this.meta.set(m.id, { ...m, ...u });
      changed.push(m.id);
    }
    return changed;
  }

  /**
   * Forks (claude --resume X --fork-session, Pilotage's Fork) begin with copies of the parent's lines: same uuids, same
   * timestamps. Counted in both, the parent's prompts showed twice in the timeline, project totals, AI digests and
   * Pick up. A fork's copied leading turns get meta.inherited = {from, n, h, s, usage, usageDays} (the first n turns;
   * h/s prompts among them; the tokens of the copied lines), which computeBlocks, activity, ownPrompts() and ownUsage()
   * leave out. Looks only at sessions sharing a first or compact turn with one that changed; returns the ids whose
   * marking changed.
   */
  async markForks(changed) {
    if (!changed.length) return [];
    const byRoot = new Map(); // uuid -> ids of Claude sessions with that first or compact turn
    for (const m of this.meta.values()) {
      if ((m.harness || 'claude') !== 'claude') continue;
      for (const u of m.roots || []) {
        const ids = byRoot.get(u);
        if (ids) ids.push(m.id);
        else byRoot.set(u, [m.id]);
      }
    }
    const gone = new Set(changed.filter((id) => !this.meta.has(id)));
    const todo = new Set();
    for (const id of changed) for (const u of this.meta.get(id)?.roots || []) for (const o of byRoot.get(u) || []) todo.add(o);
    for (const m of this.meta.values()) if (m.inherited && (gone.has(m.inherited.from) || !this.meta.has(m.inherited.from))) todo.add(m.id);
    const uuidsOf = new Map();
    const uuids = (id) => {
      if (!uuidsOf.has(id)) uuidsOf.set(id, this.loadTurns(id).map((t) => t.u));
      return uuidsOf.get(id);
    };
    // First turn of `a` that `b` doesn't have: when a's own work began (-Infinity when it has none).
    const ownStart = (a, bSet) => {
      const t = this.loadTurns(a).find((x) => x.u && !bSet.has(x.u));
      return t ? t.t || 0 : -Infinity;
    };
    const out = [];
    for (const id of todo) {
      const m = this.meta.get(id);
      if (!m) continue;
      const first = m.roots?.[0];
      let inherited = null;
      const others = first ? (byRoot.get(first) || []).filter((o) => o !== id) : [];
      if (others.length) {
        const mine = uuids(id);
        let best = null;
        for (const o of others) {
          const om = this.meta.get(o);
          const theirs = uuids(o);
          const set = new Set(theirs);
          // Does `o` come first? It says so (a copied line names it), or it had turns before the shared one (a fork
          // made after a compaction), or its own work began earlier (it stopped, or was forked after a rewind).
          let before;
          if (m.forkOf === o) before = true;
          else if (om.forkOf === id) before = false;
          else if (theirs.indexOf(first) > 0) before = true;
          else if (mine.indexOf(om.roots?.[0]) > 0) before = false;
          else {
            const a = ownStart(o, new Set(mine));
            const b = ownStart(id, set);
            before = a < b || (a === b && o < id);
          }
          if (!before) continue;
          let n = 0;
          while (n < mine.length && mine[n] && set.has(mine[n])) n++;
          if (n && (!best || n > best.n)) best = { from: o, n };
        }
        if (best) {
          const turns = this.loadTurns(id).slice(0, best.n);
          inherited = { ...best, h: turns.filter((t) => t.o === ORIGIN.human).length, s: turns.filter((t) => t.o === ORIGIN.sdk).length };
        }
      }
      const was = m.inherited ? { from: m.inherited.from, n: m.inherited.n, h: m.inherited.h, s: m.inherited.s } : null;
      if (JSON.stringify(was) === JSON.stringify(inherited)) continue;
      if (inherited && m.file && m.usage) {
        // The copied lines' tokens: everything before the fork's first own turn (or all it has indexed so far).
        const own = this.loadTurns(id)[inherited.n];
        try {
          const u = await fillUsage(m, own && own.off >= 0 ? own.off : m.offset || 0);
          inherited.usage = u.usage;
          inherited.usageDays = u.usageDays;
        } catch (e) {
          log.warn('fork usage', m.file, e.message);
        }
      }
      if (this.meta.get(id) !== m) continue; // re-indexed meanwhile: the next scan looks again
      if (inherited) m.inherited = inherited;
      else delete m.inherited;
      out.push(id);
    }
    return out;
  }

  /** Claude account of older index entries (session-owner lines sit at the top of the transcript). */
  async backfillAccounts() {
    const changed = [];
    for (const [id, m] of this.meta) {
      if ((m.harness || 'claude') !== 'claude' || !m.file || m.accountUuid !== undefined) continue;
      this.meta.set(id, { ...m, accountUuid: await readAccountUuid(m.file) });
      changed.push(id);
    }
    return changed;
  }

  turnsFile(id) {
    return path.join(paths.turnsDir, `${id}.json`);
  }

  /** Keep only the 40 most recently used sessions' turns in memory (indexing used to keep every session's). Deferred
   * writes hold their own reference (pendingTurns), so evicting never loses data. */
  cacheTurns(id, turns) {
    this.turnCache.delete(id);
    this.turnCache.set(id, turns);
    while (this.turnCache.size > 40) this.turnCache.delete(this.turnCache.keys().next().value);
  }

  loadTurns(id) {
    if (this.pendingTurns.has(id)) return this.pendingTurns.get(id);
    if (this.turnCache.has(id)) return this.turnCache.get(id);
    const t = readJSONSync(this.turnsFile(id), null);
    let turns = Array.isArray(t) ? t : [];
    if (!turns.length) {
      const h = this.history.get(id);
      if (h) turns = h.prompts.map((x) => ({ t: x.t, o: 'h', p: x.p, off: -1, a: '', at: 0, n: 0, e: x.t }));
    }
    this.cacheTurns(id, turns);
    return turns;
  }

  isInternal(cwd) {
    return !cwd || isInternalPath(cwd);
  }

  /** All sessions (transcripts + history-only), excluding Pilotage's own. */
  list() {
    const out = [];
    for (const m of this.meta.values()) {
      if (this.isInternal(m.cwd)) continue;
      if (!m.turnCount && !m.lastAt) continue;
      out.push(m);
    }
    for (const [id, h] of this.history) {
      if (this.meta.has(id)) continue;
      if (this.isInternal(h.cwd)) continue;
      if (this.historyCovered(id, h)) continue;
      out.push(this.historyMeta(id, h));
    }
    return out;
  }

  /**
   * Older history lines (Windows side) have no session id; they were grouped per folder per day. Skip such a group
   * when a transcript in the same folder covers its prompts, so the same work isn't counted twice.
   */
  historyCovered(id, h) {
    if (!id.startsWith('hist-')) return false;
    if (h._covered !== undefined && h._coveredAt === this.meta.size) return h._covered;
    const first = h.prompts[0]?.t || 0;
    const last = h.prompts[h.prompts.length - 1]?.t || 0;
    let covered = false;
    for (const m of this.meta.values()) {
      if (m.cwd === h.cwd && m.startedAt - 120e3 <= first && m.lastAt + 120e3 >= last) {
        covered = true;
        break;
      }
    }
    h._covered = covered;
    h._coveredAt = this.meta.size;
    return covered;
  }

  get(id) {
    const m = this.meta.get(id);
    if (m) return m;
    const h = this.history.get(id);
    return h ? this.historyMeta(id, h) : null;
  }

  historyMeta(id, h) {
    const first = h.prompts[0];
    const last = h.prompts[h.prompts.length - 1];
    return {
      ...newMeta(id, h.source === 'win' ? 'win-history' : 'history', null, projectKeyFor(h.cwd)),
      harness: 'claude',
      cwd: h.cwd,
      startedAt: first?.t || 0,
      lastAt: last?.t || 0,
      lastHumanAt: last?.t || 0,
      firstPrompt: first ? clip(first.p, 600) : null,
      lastPrompt: last ? clip(last.p, 600) : null,
      counts: { ...newMeta().counts, h: h.prompts.length },
      turnCount: h.prompts.length,
      archived: true,
    };
  }

  /**
   * history.jsonl: every prompt typed, including sessions whose transcripts were cleaned up. It grows by one line per
   * prompt, so after the first read only the appended bytes are read (a full re-read of a big history on every prompt
   * stalled the server). Returns {changed, touched: ids that got prompts, added: ids new to this.history}.
   */
  async readHistory() {
    // WSL and Windows sides, once each when one is a link to the other (the same prompts would be merged twice).
    const files = this.allSources()
      .filter((s) => !s.extra)
      .map((s) => ({ src: s.id, file: path.join(s.dir, 'history.jsonl'), map: s.mapCwd }));
    const out = { changed: false, touched: new Set(), added: new Set() };
    for (const f of files) {
      let st;
      try {
        st = await fsp.stat(f.file);
      } catch {
        continue;
      }
      const key = `${f.src}:${st.size}:${st.mtimeMs}`;
      if (this.historyMtime[f.src] === key && this.historyLoaded.has(f.src)) continue;
      let read;
      try {
        read = await this.readHistoryBytes(f, this.historyLoaded.has(f.src) ? this.historyRead[f.src] : null);
      } catch (e) {
        log.warn('history read failed', f.file, e.message);
        continue;
      }
      this.historyLoaded.add(f.src);
      this.historyMtime[f.src] = key;
      out.changed = true;
      if (!read.append) for (const [id, h] of this.history) if (h.source === f.src) this.history.delete(id); // rewritten
      this.historyRead[f.src] = read.state;
      let anon = 0;
      const text = read.buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const disp = String(o.display || '').trim();
        if (!disp) continue;
        const first = disp.split(/\s/)[0];
        if (first.startsWith('/') && TRIVIAL_COMMANDS.has(first)) continue;
        const cwd = normalizeCwd(f.map(o.project || ''));
        // Older entries have no sessionId: group them per project per day.
        const id = o.sessionId || `hist-${projectKeyFor(cwd)}-${new Date(o.timestamp || 0).toISOString().slice(0, 10)}`;
        if (!o.sessionId) anon++;
        let h = this.history.get(id);
        if (!h) {
          h = { cwd, prompts: [], source: f.src };
          this.history.set(id, h);
          out.added.add(id);
        }
        h.prompts.push({ t: o.timestamp || 0, p: clip(disp, 1200) });
        out.touched.add(id);
      }
      for (const id of out.touched) {
        const h = this.history.get(id);
        if (!h) continue;
        h.prompts.sort((a, b) => a.t - b.t);
        h._covered = undefined; // its time span may have changed (historyCovered)
      }
      if (anon) log.info(`history ${f.src}: ${anon} prompts without session id grouped per day`);
    }
    return out;
  }

  /**
   * The complete lines of a history file not read yet: from `last.offset` when the file only grew since `last` (same
   * first bytes, not shorter), else all of it. `state` is what the next call needs.
   */
  async readHistoryBytes(f, last) {
    const fh = await fsp.open(f.file, 'r');
    try {
      const { size } = await fh.stat();
      const headBuf = Buffer.alloc(Math.min(size, 256));
      await fh.read(headBuf, 0, headBuf.length, 0);
      const head = headBuf.toString('latin1');
      const append = !!last && size >= last.size && head.startsWith(last.head);
      const from = append ? last.offset : 0;
      const buf = Buffer.alloc(Math.max(0, size - from));
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, from + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      // Up to the last complete line: a line being written is read whole next time.
      const end = buf.lastIndexOf(10, got - 1) + 1;
      return { append, buf: buf.subarray(0, end), state: { size: from + got, offset: from + end, head } };
    } finally {
      await fh.close();
    }
  }

  /** Every prompt from history (for the timeline). */
  allHistoryPrompts() {
    const out = [];
    for (const [id, h] of this.history) {
      if (this.historyCovered(id, h)) continue;
      for (const p of h.prompts) out.push({ t: p.t, cwd: h.cwd, id });
    }
    return out;
  }

  /**
   * Every transcript file, plus `files.unreadable`: folders (or files) that exist but couldn't be read this time (an
   * EIO on /mnt/c right after Windows sleeps). Their sessions are not missing, only unseen.
   */
  async listFiles() {
    const files = [];
    files.unreadable = new Set();
    const ids = new Set();
    for (const src of this.allSources()) {
      const projDir = path.join(src.dir, 'projects');
      let dirs = [];
      try {
        dirs = await fsp.readdir(projDir, { withFileTypes: true });
      } catch (e) {
        if (e?.code !== 'ENOENT') files.unreadable.add(projDir);
        continue;
      }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dp = path.join(projDir, d.name);
        let ents = [];
        try {
          ents = await fsp.readdir(dp, { withFileTypes: true });
        } catch (e) {
          if (e?.code !== 'ENOENT') files.unreadable.add(dp);
          continue;
        }
        for (const e of ents) {
          if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
          const id = e.name.slice(0, -6);
          // The same session in two places (a copied transcript): keep the first, or each scan would flip between
          // the two files and re-parse both from byte 0.
          if (ids.has(id)) continue;
          const file = path.join(dp, e.name);
          try {
            const st = await fsp.stat(file);
            files.push({ id, file, src, projectKey: d.name, size: st.size, mtimeMs: st.mtimeMs });
            ids.add(id);
          } catch (e2) {
            if (e2?.code === 'ENOENT') continue;
            files.unreadable.add(file); // EIO on stat (/mnt/c after sleep): not deleted
            ids.add(id); // nor replaced by another copy for this one scan
          }
        }
      }
    }
    return files;
  }

  /** Scan everything; parse only what changed. Returns ids of sessions that changed. */
  async scan() {
    if (this.scanning) return [];
    this.scanning = true;
    const changed = [];
    try {
      if (this.flushing) await this.flushing;
      const cwdBefore = new Map();
      for (const [id, m] of this.meta) cwdBefore.set(id, m.cwd);
      let onlyAppends = true; // every change is new lines on a session already indexed → writes can wait
      const hist = await this.readHistory();
      const files = await this.listFiles();
      const seen = new Set(files.map((f) => f.id));
      // Transcripts that disappeared (Claude Code cleanup) fall back to history. Not when their folder just couldn't be
      // read: dropping them would empty the UI, save an index without them and re-parse every file from byte 0.
      const unreadable = [...(files.unreadable || [])];
      const unseenOnly = (file) => unreadable.some((d) => isInside(file, d));
      for (const [id, m] of this.meta) {
        if (!seen.has(id) && m.file && (m.harness || 'claude') === 'claude' && !unseenOnly(m.file)) {
          this.meta.delete(id);
          this.turnCache.delete(id);
          this.pendingTurns.delete(id);
          changed.push(id);
          onlyAppends = false;
        }
      }
      const todo = files.filter((f) => {
        const m = this.meta.get(f.id);
        // (Indexed before turns kept their uuids: parsed again once, so forks are recognised.)
        return !m || m.size !== f.size || m.mtimeMs !== f.mtimeMs || !m.roots;
      });
      todo.sort((a, b) => b.mtimeMs - a.mtimeMs);
      this.progress = { ...this.progress, total: todo.length, done: 0, bytes: 0, running: todo.length > 0 };
      if (todo.length) this.emit('progress', this.progress);
      for (const f of todo) {
        try {
          if (!(await this.indexFile(f))) onlyAppends = false;
          changed.push(f.id);
        } catch (e) {
          log.warn('index failed', f.file, e.message);
        }
        this.progress.done++;
        this.progress.bytes += f.size;
        if (this.progress.done % 5 === 0) this.emit('progress', this.progress);
      }
      const grew = new Set();
      const other = [...(await this.scanAdapters(grew)), ...(await this.backfillAccounts()), ...(await this.backfillUsage())];
      if (other.some((id) => !grew.has(id))) onlyAppends = false;
      changed.push(...other);
      for (const id of await this.markForks(changed)) if (!changed.includes(id)) changed.push(id);
      this.progress.running = false;
      this.progress.firstDone = true;
      // History lines of sessions with a transcript change nothing shown (their prompts come from the transcript);
      // those of history-only sessions refresh them, and a new one is structural (a session appears).
      const histOnly = [...hist.touched].filter((id) => !this.meta.has(id) && !changed.includes(id));
      if (changed.length || hist.changed) {
        if (onlyAppends) this.scheduleFlush();
        else await this.flush();
      }
      this.emit('progress', this.progress);
      // Structural: sessions appeared, disappeared or changed folder (a new history-only session included).
      this.lastScan = {
        structural: histOnly.some((id) => hist.added.has(id)) || changed.some((id) => !cwdBefore.has(id) || !this.meta.has(id) || cwdBefore.get(id) !== this.meta.get(id).cwd),
      };
      changed.push(...histOnly);
    } finally {
      this.scanning = false;
    }
    return changed;
  }

  /** Index one transcript. Returns true when it only appended to an already indexed session (its write is deferred). */
  async indexFile(f) {
    let meta = this.meta.get(f.id);
    let turns;
    let from = 0;
    if (meta && meta.roots && meta.file === f.file && meta.offset > 0 && f.size >= meta.size && (this.pendingTurns.has(f.id) || fs.existsSync(this.turnsFile(f.id)))) {
      // incremental. Deep copies: the parser changes counts, tools and the open turn in place, and a read error halfway
      // must leave the indexed session as it was (a retry from the same offset would count those lines twice).
      turns = this.loadTurns(f.id).slice();
      if (turns.length) turns[turns.length - 1] = { ...turns[turns.length - 1] };
      from = meta.offset;
      meta = structuredClone(meta); // usage fields included
      // An entry from before usage was counted: count the part already indexed first, then the new lines add to it.
      if (meta.usage === undefined) Object.assign(meta, await fillUsage(meta));
      if (turns.length !== (meta.turnCount || 0)) {
        // turns file and index disagree (e.g. killed between the two writes): re-parse from scratch, never replay
        meta = newMeta(f.id, f.src.id, f.file, f.projectKey);
        turns = [];
        from = 0;
      }
    } else {
      meta = newMeta(f.id, f.src.id, f.file, f.projectKey);
      turns = [];
    }
    await parseFile(meta, turns, f.src.mapCwd, from, f.size);
    meta.size = f.size;
    meta.mtimeMs = f.mtimeMs;
    if (!meta.cwd) {
      // fall back to decoding the folder name
      const guess = f.projectKey.replace(/-/g, '/');
      meta.cwd = fs.existsSync(guess) ? guess : null;
    }
    if (!meta.cwd && this.history.get(f.id)) meta.cwd = this.history.get(f.id).cwd;
    meta.harness = 'claude';
    // The parser picks up session-owner lines; a full parse that saw none checks the head/tail once (then null).
    if (!from && !meta.accountUuid) meta.accountUuid = await readAccountUuid(f.file);
    // No await from here on: meta and its turns always change together.
    this.meta.set(f.id, meta);
    this.cacheTurns(f.id, turns);
    if (from > 0) {
      this.pendingTurns.set(f.id, turns);
      return true;
    }
    this.pendingTurns.delete(f.id);
    await writeJSON(this.turnsFile(f.id), turns);
    return false;
  }

  async save() {
    await writeJSON(paths.index, { version: 4, savedAt: Date.now(), historyMtime: this.historyMtime, sessions: [...this.meta.values()] });
  }

  /** Write deferred turns, then the index (at most once per FLUSH_MS while a session keeps growing). */
  scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this.scanning) return this.scheduleFlush(); // the scan in progress flushes or reschedules itself
      this.flush().catch((e) => log.warn('index flush', e.message));
    }, FLUSH_MS);
    this._flushTimer.unref?.();
  }

  /**
   * Turns files first, then the index, from the same moment: a crash in between leaves a turn count that
   * disagrees with the index, which indexFile() answers with a clean re-parse.
   */
  async flush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    const run = (async () => {
      const pending = [...this.pendingTurns];
      this.pendingTurns.clear();
      const sessions = [...this.meta.values()];
      for (const [id, turns] of pending) {
        try {
          await writeJSON(this.turnsFile(id), turns);
        } catch (e) {
          log.warn('turns write failed', id, e.message);
          if (!this.pendingTurns.has(id)) this.pendingTurns.set(id, turns);
        }
      }
      await writeJSON(paths.index, { version: 4, savedAt: Date.now(), historyMtime: this.historyMtime, sessions });
    })();
    this.flushing = run;
    try {
      await run;
    } finally {
      if (this.flushing === run) this.flushing = null;
    }
  }

  /** Synchronous flush for shutdown. */
  flushNow() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (!this.pendingTurns.size) return;
    try {
      for (const [id, turns] of this.pendingTurns) writeJSONSync(this.turnsFile(id), turns);
      this.pendingTurns.clear();
      writeJSONSync(paths.index, { version: 4, savedAt: Date.now(), historyMtime: this.historyMtime, sessions: [...this.meta.values()] });
    } catch (e) {
      log.warn('index flush on exit', e.message);
    }
  }

  /** Full detail of one turn, read straight from the transcript (assistant texts + tool calls). */
  async turnDetail(id, index) {
    const m = this.meta.get(id);
    const turns = this.loadTurns(id);
    const turn = turns[index];
    if (m && m.harness && m.harness !== 'claude') {
      const a = this.adapters.find((x) => x.id === m.harness);
      if (a?.turnDetail) {
        try {
          return await a.turnDetail(m, turns, index);
        } catch (e) {
          log.warn(`turnDetail ${m.harness}`, e.message);
        }
      }
      return { items: turn ? [{ kind: 'prompt', text: turn.p, t: turn.t }, ...(turn.a ? [{ kind: 'text', text: turn.a, t: turn.at }] : [])] : [] };
    }
    if (!m || !m.file || !turn || turn.off < 0) return { items: turn ? [{ kind: 'prompt', text: turn.p, t: turn.t }] : [] };
    const next = turns.slice(index + 1).find((x) => x.off > turn.off);
    const end = Math.min(next ? next.off : m.offset, turn.off + 40 * 1024 * 1024);
    const items = [];
    const fh = await fsp.open(m.file, 'r');
    try {
      let pos = turn.off;
      let carry = Buffer.alloc(0);
      const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
      while (pos < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
        if (!bytesRead) break;
        let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl === -1) break;
          const line = data.subarray(start, nl);
          start = nl + 1;
          const text = line.length > MAX_PARSE ? parsable(line) : null; // once per oversized line
          if (line.length > MAX_PARSE && text == null) continue; // screenshots alone are fine (blanked)
          const head = line.toString('latin1', 0, Math.min(700, line.length));
          if (head.includes('"isSidechain":true')) continue;
          const isToolResult = head.includes('"tool_use_id"') || head.includes('"type":"tool_result"');
          if (isToolResult) {
            if (line.length < 400_000) {
              try {
                const o = JSON.parse(line.toString('utf8'));
                const r = (o.message?.content || []).find((x) => x.type === 'tool_result');
                if (r) {
                  const last = [...items].reverse().find((x) => x.kind === 'tool' && x.id === r.tool_use_id);
                  if (last) {
                    last.error = !!r.is_error;
                    const txt = typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
                    last.result = clip(txt, 1200);
                  }
                }
              } catch {}
            }
            continue;
          }
          const ht = headType(head);
          if (ht !== 'user' && ht !== 'assistant') continue;
          let o;
          try {
            o = JSON.parse(text ?? line.toString('utf8'));
          } catch {
            continue;
          }
          if (o.isSidechain) continue;
          const t = tsOf(o);
          if (o.type === 'user') {
            const c = o.message?.content;
            const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
            const cls = classifyUserText(o, raw);
            if (cls && cls.origin !== 'x') items.push({ kind: 'prompt', origin: cls.origin, text: clip(stripReminders(raw), 20000), t });
          } else {
            for (const b of o.message?.content || []) {
              if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'text', text: clip(b.text, 30000), t });
              else if (b.type === 'tool_use') items.push({ kind: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input), t });
            }
          }
          if (items.length > 1500) break;
        }
        carry = Buffer.from(data.subarray(start));
        if (carry.length > MAX_LINE) carry = Buffer.alloc(0);
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
    return { items };
  }
}

/** accountUuid from a {"type":"session-owner","accountUuid":...} line: head of the file, else its tail. */
export async function readAccountUuid(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    for (const [pos, len] of [[0, 64 * 1024], [Math.max(0, size - 256 * 1024), 256 * 1024]]) {
      const buf = Buffer.alloc(Math.min(len, size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      const m = /"type":"session-owner"[^\n]*?"accountUuid":"([0-9a-fA-F-]{8,64})"/.exec(buf.toString('utf8', 0, bytesRead));
      if (m) return m[1];
      if (size <= len) break;
    }
  } catch {
  } finally {
    await fh?.close().catch(() => {});
  }
  return null;
}

export function toolSummary(name, input = {}) {
  if (!input || typeof input !== 'object') return '';
  const pick = (k) => (typeof input[k] === 'string' ? input[k] : '');
  switch (name) {
    case 'Bash':
      return clip(pick('description') || pick('command'), 220);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return clip(pick('file_path'), 220);
    case 'Grep':
    case 'Glob':
      return clip(`${pick('pattern')} ${pick('path')}`.trim(), 220);
    case 'WebFetch':
      return clip(pick('url'), 220);
    case 'WebSearch':
      return clip(pick('query'), 220);
    case 'Agent':
    case 'Task':
      return clip(pick('description') || pick('prompt'), 220);
    default: {
      const s = Object.values(input).find((v) => typeof v === 'string');
      return clip(s || '', 160);
    }
  }
}

/** Parse one transcript from scratch (used by tests and tools). */
export async function parseTranscriptFile(file, mapCwd = (p) => p) {
  const st = await fsp.stat(file);
  const meta = newMeta(path.basename(file, '.jsonl'), 'test', file, 'test');
  const turns = [];
  await parseFile(meta, turns, mapCwd, 0, st.size);
  meta.size = st.size;
  return { meta, turns };
}

let index = null;
export function getSessionIndex() {
  if (!index) index = new SessionIndex();
  return index;
}
