// Shared helpers for non-Claude session adapters (Codex, Gemini, ...).
// An adapter = { id, label, scan(ctx) → {metas, turns}, turnDetail?(meta, turns, i) → {items} }.
// Metas use the same shape as Claude metas (see newMeta in ../sessions.js) plus `harness`.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../../config.js';
import { clip as rawClip, redact, run } from '../../util.js';

// Everything stored or shown from transcripts goes through redact().
// Redact the whole text, then clip (see sessions.js).
export const clip = (s, n) => rawClip(redact(typeof s === 'string' ? s : s == null ? '' : String(s)), n);

const PR_RX = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export function addPrLinks(meta, s) {
  if (!s || typeof s !== 'string' || s.indexOf('/pull/') === -1) return;
  for (const u of s.match(PR_RX) || []) {
    if (!meta.prs.includes(u)) {
      meta.prs.push(u);
      if (meta.prs.length > 60) meta.prs.shift();
    }
  }
}

export function pruneFiles(meta) {
  const entries = Object.entries(meta.files);
  if (entries.length <= 300) return;
  entries.sort((a, b) => b[1] - a[1]);
  meta.files = Object.fromEntries(entries.slice(0, 200));
}

export function tsOf(s) {
  if (!s) return 0;
  const t = typeof s === 'number' ? (s < 1e12 ? s * 1000 : s) : Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

export function cleanCwd(p) {
  if (!p || typeof p !== 'string') return null;
  return p.replace(/\/+$/, '') || '/';
}

/** Same fields as a Claude meta, so views / engine / registry treat it identically. */
export function baseMeta(id, harness, file) {
  return {
    id,
    source: harness,
    harness,
    file,
    projectKey: null,
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
    firstPrompt: null,
    turnCount: 0,
    archived: false,
    accountUuid: null,
  };
}

/** Turn-tracking helper shared by the parsers (mirrors the Claude parser's touch()). */
export class TurnBuilder {
  constructor(meta, turns) {
    this.meta = meta;
    this.turns = turns;
  }
  cur() {
    return this.turns[this.turns.length - 1];
  }
  touch(ts) {
    if (!ts) return;
    const m = this.meta;
    if (!m.startedAt || ts < m.startedAt) m.startedAt = ts;
    if (ts > m.lastAt) m.lastAt = ts;
    const c = this.cur();
    if (c && ts > (c.e || 0)) c.e = ts;
  }
  prompt(origin, text, ts, off) {
    const m = this.meta;
    const lim = origin === 'h' || origin === 's' ? 1500 : origin === 'x' ? 5000 : 400;
    const p = clip(text, lim);
    m.counts[origin] = (m.counts[origin] || 0) + 1;
    if (origin === 'x') m.compactions++;
    if ((origin === 'h' || origin === 's') && !m.firstPrompt) m.firstPrompt = clip(p, 600);
    if (origin === 'h' || origin === 's') m.lastPrompt = clip(p, 600);
    if (origin === 'h') m.lastHumanAt = Math.max(m.lastHumanAt, ts);
    this.turns.push({ t: ts, o: origin, p, off, a: '', at: 0, n: 0, e: ts });
    this.touch(ts);
  }
  reply(text, ts, off) {
    if (!text || !String(text).trim()) return;
    let c = this.cur();
    if (!c) {
      c = { t: ts, o: 'y', p: '', off, a: '', at: 0, n: 0, e: ts };
      this.turns.push(c);
    }
    c.a = clip(String(text).trim(), 1600);
    c.at = ts;
    addPrLinks(this.meta, text);
    this.touch(ts);
  }
  tool(name, ts) {
    const m = this.meta;
    m.counts.toolUse++;
    const n = String(name || '?');
    m.tools[n] = (m.tools[n] || 0) + 1;
    const c = this.cur();
    if (c) c.n++;
    this.touch(ts);
  }
  file(p, base) {
    if (!p || typeof p !== 'string') return;
    const abs = path.isAbsolute(p) ? p : base ? path.resolve(base, p) : null;
    if (!abs) return;
    this.meta.files[abs] = (this.meta.files[abs] || 0) + 1;
  }
}

/** Iterate complete JSONL lines of a buffer with their byte offsets. Returns the end of the last complete line. */
export function eachLine(buf, fn, from = 0) {
  let start = from;
  for (;;) {
    const nl = buf.indexOf(10, start);
    if (nl === -1) break;
    if (nl > start) fn(buf.subarray(start, nl), start);
    start = nl + 1;
  }
  return start;
}

/**
 * Locate a Linux-side CLI: the running node's bin dir first (npm -g installs under nvm), ~/.local/bin, then PATH.
 * Windows installs seen through WSL interop (/mnt/c/.../npm/codex) are skipped: they would run the Windows
 * CLI against the Windows config dir.
 */
export function findBin(name) {
  const dirs = [path.dirname(process.execPath), path.join(HOME, '.local/bin'), ...String(process.env.PATH || '').split(':'), '/usr/local/bin', '/usr/bin'];
  for (const d of dirs) {
    if (!d || d.startsWith('/mnt/')) continue;
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/** Environment for spawning node-based CLIs (codex, gemini): node 22 first on PATH, no PILOTAGE_* vars. */
export function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('PILOTAGE_')) delete env[k];
  env.PATH = `${path.dirname(process.execPath)}:${env.PATH || '/usr/bin:/bin'}`;
  return env;
}

const versionCache = new Map();
/** `<bin> --version`, cached 10 minutes. */
export async function cliVersion(bin) {
  if (!bin) return null;
  const c = versionCache.get(bin);
  if (c && Date.now() - c.at < 10 * 60e3) return c.v;
  const r = await run(bin, ['--version'], { timeout: 20000, env: cliEnv() });
  const v = r.code === 0 ? clip((r.stdout || r.stderr).trim().split('\n')[0], 80) : null;
  versionCache.set(bin, { at: Date.now(), v });
  return v;
}
