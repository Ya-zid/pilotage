// Turns raw sessions into "work blocks" (a stretch of prompts without a long break),
// summarizes each block with a cheap model, then writes project briefs (with threads),
// a daily brief and CV text. Everything is cached in data/ai.json and only redone
// when its input changes. The project scout (ai/scout.js, attached as this.scout by routes/scout.js) runs last.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { paths } from '../config.js';
import { writeJSON, writeJSONSync, hash, clip, oneLine, debounce, log, isoDay, dejargonAll } from '../util.js';
import { callAI, capStatus, usesClaudeUsage, currentProvider, providerConfig, keyInfo, resolveEndpoint } from './providers.js';
import { usageNow } from './usage.js';
import { isAutomation, automationKey, listDocs } from '../sources/projects.js';
import { userName } from '../profile.js';

const GAP = 4 * 3600e3;
const IDLE_READY = 45 * 60e3;
const QUIET_NOT_LIVE = 10 * 60e3;
const PRIMARY = new Set(['h', 's', 'p']);
const TEMP_PAUSE = 15 * 60e3; // outage, usage limit, timeout: the whole queue waits
const SETUP_PAUSE = 30 * 60e3; // logged out, bad key, no credit: waits longer, or until the AI settings change
const FLAKY_STRIKES = 3; // the same input timing out / erroring this often...
const FLAKY_BACKOFF = 6 * 3600e3; // ...is set aside this long, so it can't hold up the rest
const PROJECT_CODE = /\bp(\d{1,2})\b/gi; // daily-brief project ids (p1..p25)
export const WHO = new Set(['you', 'claude', 'waiting']); // who does a next step (digest.who, brief.whos)

const fmt = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '?');

// What a failed call says. 'setup': the provider can't work until the user fixes something (login, key, credit, CLI,
// model). 'busy': provider-wide and temporary (usage/rate limit, overload, network). 'flaky': temporary but maybe
// tied to this input (timeout, 5xx). 'input': a bad answer for this input. Only 'input' (and repeated 'flaky')
// failures count against a block or brief; the others pause the queue instead.
const SETUP_ERR = /please run \/login|not logged in|log ?in again|invalid[ _-]?(x-)?(api[ _-]?)?key|api key (was )?(rejected|invalid|not valid)|incorrect api key|authenticat|unauthori[sz]ed|forbidden|permission denied|out of credit|credit balance|insufficient[ _](balance|credit|funds)|billing|payment required|\bHTTP 40[1-4]\b|CLI not found|No API key|No API base URL|No model configured|\bmodel\b.{0,60}\b(not found|does not exist|not available)|\bENOENT\b|\bEACCES\b/i;
const BUSY_ERR = /usage limit|limit reached|hit your (usage )?limit|rate.?limit|too many requests|\b429\b|overloaded|\b529\b|quota|cap reached|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|network|socket hang up|fetch failed|\bspawn\b/i;
const FLAKY_ERR = /timeout|timed out|ETIMEDOUT|took too long|\b5\d\d\b|internal (server )?error|bad gateway|service unavailable|\bexit -1\b|SIGTERM|SIGKILL/i;

/** r: a failed callAI() result ({error, apiStatus, notSent, capped, timedOut}) or {error} from a thrown job. */
export function classifyFailure(r = {}) {
  const st = Number(r.apiStatus) || 0;
  const msg = String(r.error || '');
  if (r.notSent || (st >= 401 && st <= 404)) return 'setup';
  if (r.capped || st === 429 || st === 529) return 'busy';
  if (r.timedOut || st === 408 || st >= 500) return 'flaky';
  if (SETUP_ERR.test(msg)) return 'setup';
  if (BUSY_ERR.test(msg)) return 'busy';
  if (FLAKY_ERR.test(msg)) return 'flaky';
  return 'input';
}

function aiError(r, cls) {
  const e = new Error(r.error || 'AI call failed');
  e.aiClass = cls;
  return e;
}

/** One more 'flaky' failure of the same input; the third in a row sets it aside for FLAKY_BACKOFF. */
function flakyStrike(prev, h, now = Date.now()) {
  const n = (prev?.flakyHash === h ? prev.flaky || 0 : 0) + 1;
  return { flakyHash: h, flaky: n, retryAt: n >= FLAKY_STRIKES ? now + FLAKY_BACKOFF : 0 };
}

/**
 * Fit items (oldest first) into a character budget, spending it from the newest: the most recent get their full
 * line, older ones a short line while `shortBudget` lasts, the oldest are left out. Returns the kept
 * [{item, line, short}] oldest first, so what the model reads is always the current work.
 */
export function fitNewestFirst(items, { full, short = null, fullBudget, shortBudget = 0 }) {
  const kept = [];
  let room = fullBudget;
  let shortMode = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (!shortMode) {
      const line = full(items[i]);
      if (line.length <= room) {
        room -= line.length;
        kept.push({ item: items[i], line, short: false });
        continue;
      }
      if (!short) break;
      shortMode = true;
      room += shortBudget;
    }
    const line = short(items[i]);
    if (line.length > room) break;
    room -= line.length;
    kept.push({ item: items[i], line, short: true });
  }
  return kept.reverse();
}

/** The first `bytes` of a file as text (docs only feed a short excerpt; never read a 2 MB file for it). */
function readHead(file, bytes = 8192) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8').replace(/�+$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

export function computeBlocks(meta, turns) {
  const blocks = [];
  let cur = null;
  let lastE = 0;
  // A fork's first turns are copies of its parent's (see markForks in sources/sessions.js): their blocks are the parent's.
  for (let i = meta.inherited?.n || 0; i < turns.length; i++) {
    const t = turns[i];
    const primary = PRIMARY.has(t.o);
    const gap = t.t && lastE && t.t - lastE > GAP;
    // Any primary turn counts as "something in the block": a block opened by a scripted (sdk) or peer prompt must
    // still split when the user comes back after the gap.
    if (!cur || (primary && cur.prompts + cur.sdk + cur.peers > 0 && (gap || cur.prompts >= 60))) {
      cur = { key: `${meta.id}:${i}`, sessionId: meta.id, i0: i, i1: i, startAt: t.t || meta.startedAt, endAt: t.e || t.t, prompts: 0, sdk: 0, peers: 0, texts: 0 };
      blocks.push(cur);
    }
    cur.i1 = i;
    cur.endAt = Math.max(cur.endAt || 0, t.e || 0, t.at || 0, t.t || 0);
    if (t.o === 'h') cur.prompts++;
    if (t.o === 's') cur.sdk++;
    if (t.o === 'p') cur.peers++;
    if (t.a) cur.texts++;
    lastE = Math.max(lastE, t.e || t.t || 0);
  }
  return blocks.filter((b) => b.prompts + b.sdk + b.peers > 0);
}

function blockHash(b, turns) {
  const parts = [];
  for (let i = b.i0; i <= b.i1; i++) {
    const t = turns[i];
    if (PRIMARY.has(t.o)) parts.push(t.p.slice(0, 120));
  }
  const last = turns[b.i1];
  parts.push((last?.a || '').slice(0, 300));
  return hash(parts.join('\n'), 20);
}

const BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short specific title, max 8 words, no project name prefix' },
    summary: { type: 'string', description: '1-2 sentences: what this work was about' },
    outcome: { type: 'string', description: '1-2 sentences: what was actually achieved or where it stopped' },
    status: { type: 'string', enum: ['done', 'in_progress', 'blocked', 'abandoned', 'ongoing'] },
    nextStep: { type: 'string', description: 'If not done: what a new Claude session needs to continue, 1-2 sentences with the specifics (files, commands, names). Else empty string.' },
    todo: {
      type: 'string',
      description:
        'If not done: the same next step as a to-do the user reads on a phone. 3-7 words, verb first, plain words. No file names, paths, commands, env vars, dates, reasons or conditions; never "then", "since", "before", "after", "once". Examples: "Fix the double reminder emails", "Ask the printer for a new quote", "Retest checkout on a real phone". Else empty string.',
    },
    who: { type: 'string', enum: ['you', 'claude', 'waiting'], description: 'Who does the next step: you = the user acts by hand (call, decide, send, test on a device); claude = a Claude session can do it; waiting = blocked on someone else. "claude" when done.' },
    topic: { type: 'string', description: '2-4 word stable label for the thread of work this belongs to (e.g. "Payroll export", "Clinic outreach", "Landing page")' },
    kind: { type: 'string', enum: ['build', 'fix', 'research', 'ops', 'writing', 'design', 'planning', 'outreach', 'learning', 'other'] },
    cvWorthy: { type: 'boolean', description: 'Would this be worth mentioning on a CV/portfolio?' },
    highlights: { type: 'array', items: { type: 'string' }, description: '0-3 concrete achievements, phrased for a CV (past tense, specific, with numbers if present)' },
  },
  required: ['title', 'summary', 'outcome', 'status', 'nextStep', 'todo', 'who', 'topic', 'kind', 'cvWorthy', 'highlights'],
};

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    oneLiner: { type: 'string', description: 'What this project is, max 14 words' },
    description: { type: 'string', description: '2-4 sentences: purpose, users/client, what exists today' },
    currentState: { type: 'string', description: '1-2 sentences: where things stand right now' },
    nextSteps: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to 3 open pieces of work, most important first, one sentence each (max 20 words). Merge steps about the same thing. Never standing rules from CLAUDE.md or memory (e.g. "run the lint before publishing", "never push to main"), never "check whether X is still true/relevant", never git housekeeping (commit, push, worktrees). Empty if nothing is open.',
    },
    todos: { type: 'array', items: { type: 'string' }, description: 'Same length and order as nextSteps: each one as a 3-7 word to-do, verb first, plain words, no file names, commands, dates or reasons.' },
    whos: { type: 'array', items: { type: 'string', enum: ['you', 'claude', 'waiting'] }, description: 'Same length and order as nextSteps: you = the user acts by hand; claude = a Claude session can do it; waiting = blocked on someone else.' },
    threads: {
      type: 'array',
      description: 'Group the work blocks into 1-8 threads (distinct lines of work inside this folder). Every block id appears in exactly one thread.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '2-5 words' },
          summary: { type: 'string', description: 'one sentence' },
          status: { type: 'string', enum: ['active', 'paused', 'done'] },
          blocks: { type: 'array', items: { type: 'string' }, description: 'block ids like b3' },
        },
        required: ['name', 'summary', 'status', 'blocks'],
      },
    },
    attention: { type: 'array', items: { type: 'string' }, description: 'Up to 4 things that look forgotten, risky or unfinished' },
    cv: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Portfolio-ready project name' },
        role: { type: 'string', description: 'Likely role, e.g. "Full-stack developer (solo)"' },
        bullets: { type: 'array', items: { type: 'string' }, description: '2-4 CV bullets, past tense, concrete' },
      },
      required: ['title', 'role', 'bullets'],
    },
  },
  required: ['oneLiner', 'description', 'currentState', 'nextSteps', 'todos', 'whos', 'threads', 'attention', 'cv'],
};

const DAILY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string', description: 'Max 12 words, fragments ok: the state of things today' },
    focus: {
      type: 'array',
      description: 'Up to 3 things that must happen today (a deadline, someone waiting, a job running tonight). If one matches an open task on stdin, copy that task title exactly.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', description: 'project id like p2' },
          title: { type: 'string', description: '3-7 words, verb first, plain words' },
          why: { type: 'string', description: 'Max 14 words, one clause: why today. No recap.' },
          action: { type: 'string', description: 'A first prompt the user could give Claude to start' },
        },
        required: ['project', 'title', 'why', 'action'],
      },
    },
    forgotten: {
      type: 'array',
      description: 'Up to 4 things that slipped',
      items: { type: 'object', additionalProperties: false, properties: { project: { type: 'string', description: 'project id like p2' }, note: { type: 'string', description: 'Max 15 words' } }, required: ['project', 'note'] },
    },
    ideas: { type: 'array', items: { type: 'string' }, description: '2-4 fresh ideas that connect their projects or skills (concrete, not generic)' },
  },
  required: ['headline', 'focus', 'forgotten', 'ideas'],
};

const CV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    tagline: { type: 'string', description: 'One line for the CV under the title' },
    role: { type: 'string' },
    period: { type: 'string', description: 'e.g. "Sep 2026 – present"' },
    stack: { type: 'array', items: { type: 'string' } },
    bullets: { type: 'array', items: { type: 'string' }, description: '3-5 strong CV bullets: action verb, what, impact; specific numbers when known; no fluff' },
  },
  required: ['title', 'tagline', 'role', 'period', 'stack', 'bullets'],
};

/** Shared rules for every summary prompt; the user's name comes from Settings (server/profile.js). */
function systemRules(name = userName()) {
  return (
    `You summarize software-work logs for ${name}, a developer who works through Claude Code. ` +
    'Use only facts present in the input. Be specific and concrete (names, features, numbers). ' +
    `Write in English, plainly, no hype. "${name}" is the user; the assistant is their AI coding agent (Claude Code unless the input says Codex or Gemini). ` +
    'Never use internal words like "work block", "block", "digest", "brief" or "thread" in what you write: say "session", "work" or "summary".'
  );
}

/** Said in every prompt whose short fields end up on Home or in Tasks. */
const SHORT_RULE = 'Short fields (to-dos, titles, why, notes) are read on a phone: write them for the user, not for Claude.';

const AI_BACKUPS_KEPT = 3;

/** data/ai.json holds hundreds of paid digests: a damaged file is set aside and the newest daily backup is used instead of starting empty. */
function loadAiFile(file) {
  let why;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && !Array.isArray(d)) return d;
    why = 'not a JSON object';
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    why = e.message;
  }
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
    log.error(`ai: ${path.basename(file)} is unreadable (${clip(why, 120)}); kept it as ${path.basename(aside)}`);
  } catch {}
  let backups = [];
  try {
    backups = fs.readdirSync(paths.backups).filter((f) => /^ai-.*\.json$/.test(f)).sort().reverse();
  } catch {}
  for (const f of backups) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(paths.backups, f), 'utf8'));
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        log.warn(`ai: restored digests from backups/${f}`);
        return d;
      }
    } catch {}
  }
  log.error('ai: no readable backup; digests will be rebuilt');
  return {};
}

/** One copy of ai.json per day (before the first save of the day), keeping the last few. */
function backupAiFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    const daily = path.join(paths.backups, `ai-${isoDay(Date.now())}.json`);
    if (fs.existsSync(daily)) return;
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.copyFileSync(file, daily);
    const files = fs.readdirSync(paths.backups).filter((f) => /^ai-.*\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - AI_BACKUPS_KEPT))) fs.unlinkSync(path.join(paths.backups, f));
  } catch (e) {
    log.warn('ai backup', e.message);
  }
}

export class AIEngine extends EventEmitter {
  constructor({ index, registry, store, live }) {
    super();
    this.index = index;
    this.registry = registry;
    this.store = store;
    this.live = live;
    const saved = loadAiFile(paths.ai);
    this.state = {
      blocks: saved.blocks || {},
      projects: saved.projects || {},
      daily: saved.daily || null,
      cv: saved.cv || {},
      stats: saved.stats || { calls: 0, cost: 0, errors: 0, lastError: null, lastRunAt: 0, byKind: {} },
      callLog: saved.callLog || [],
      dailyFail: saved.dailyFail || null,
      scout: saved.scout || {}, // project scout (ai/scout.js): projectPath -> {at, hash, model, candidates[]}
      scoutAutoLog: Array.isArray(saved.scoutAutoLog) ? saved.scoutAutoLog : [], // automatic scout attempts (daily cap)
    };
    this.queue = [];
    this.queued = new Set();
    this.running = new Map();
    this.cvWaits = new Map(); // cv job id -> the promise its requests wait on (writeCV)
    this.blockCache = new Map();
    this.guardReason = null;
    this._save = debounce(() => {
      backupAiFile(paths.ai);
      writeJSON(paths.ai, this.state).catch((e) => log.warn('ai save', e.message));
    }, 1500);
  }

  get settings() {
    return this.store.settings.ai;
  }

  /** "Pause" in Settings → AI. Kept in the settings (state.json), so a restart or the login autostart doesn't resume
   * spending after the user paused because their usage was running low. */
  get pausedByUser() {
    return !!this.store.settings.ai.paused;
  }
  set pausedByUser(v) {
    if (!!this.store.settings.ai.paused === !!v) return;
    this.store.settings.ai.paused = !!v;
    this.store.save();
  }

  /** Blocks of one session (cached on lastAt/turnCount). */
  blocksOf(meta) {
    const sig = `${meta.lastAt}:${meta.turnCount}:${meta.offset || 0}:${meta.inherited?.n || 0}`;
    const c = this.blockCache.get(meta.id);
    if (c && c.sig === sig) return c.blocks;
    const turns = this.index.loadTurns(meta.id);
    const blocks = computeBlocks(meta, turns).map((b) => ({ ...b, hash: blockHash(b, turns) }));
    this.blockCache.set(meta.id, { sig, blocks });
    return blocks;
  }

  digestOf(key) {
    return this.state.blocks[key]?.digest || null;
  }

  /** Digest or a cheap fallback for display. */
  blockView(meta, b) {
    const d = this.state.blocks[b.key];
    const turns = this.index.loadTurns(meta.id);
    const lastText = turns[b.i1]?.a || '';
    const firstPrompt = turns.slice(b.i0, b.i1 + 1).find((t) => PRIMARY.has(t.o))?.p || '';
    return {
      key: b.key,
      sessionId: meta.id,
      startAt: b.startAt,
      endAt: b.endAt,
      prompts: b.prompts,
      sdk: b.sdk,
      i0: b.i0,
      i1: b.i1,
      digest: d?.digest ? dejargonAll(d.digest) : null,
      stale: !!d && d.hash !== b.hash,
      fallbackTitle: clip(oneLine(firstPrompt), 90),
      lastText: clip(oneLine(lastText), 280),
    };
  }

  /** Changes whenever the provider, its model/endpoint or its saved key changes (no secret in it). */
  providerSig() {
    try {
      const id = currentProvider();
      const cfg = providerConfig(id);
      const key = id === 'openai-compatible' ? keyInfo(resolveEndpoint(cfg).preset) : null;
      return hash(JSON.stringify([id, cfg, key, this.settings.digestModel, this.settings.briefModel]), 12);
    } catch {
      return '';
    }
  }

  /** Stop automatic calls for a while after a provider-wide failure. */
  pause(cls, msg) {
    const setup = cls === 'setup';
    this.pauseUntil = Date.now() + (setup ? SETUP_PAUSE : TEMP_PAUSE);
    this.pauseSig = setup ? this.providerSig() : null;
    this.pauseReason = setup ? `AI provider problem: ${clip(friendlyError(msg), 160)}` : null;
    log.warn(`ai paused ${setup ? 30 : 15} min after a ${setup ? 'provider setup' : 'temporary'} error`, msg);
  }

  guard() {
    if (!this.settings.enabled) return { ok: false, reason: 'AI is turned off in Settings' };
    if (this.pausedByUser) return { ok: false, reason: 'Paused by you' };
    if (this.pauseUntil && Date.now() < this.pauseUntil) {
      if (this.pauseSig && this.pauseSig !== this.providerSig()) this.pauseUntil = 0; // the AI settings changed since: try again now
      else return { ok: false, reason: this.pauseReason || 'Paused for a few minutes after a temporary error', until: this.pauseUntil };
    }
    const budget = this.callBudget();
    if (!budget.ok) return budget;
    const cap = capStatus(); // daily cap for non-Claude providers (ai/providers.js)
    if (!cap.ok) return cap;
    if (!usesClaudeUsage()) return { ok: true }; // the 5h/7d windows are Claude subscription limits
    const u = usageNow();
    if (u.five && u.five.pct >= this.settings.maxFiveHourPct) return { ok: false, reason: `5-hour usage at ${Math.round(u.five.pct)}% (limit ${this.settings.maxFiveHourPct}%)`, until: u.five.resetsAt };
    if (u.seven && u.seven.pct >= this.settings.maxSevenDayPct) return { ok: false, reason: `7-day usage at ${Math.round(u.seven.pct)}%`, until: u.seven.resetsAt };
    return { ok: true };
  }

  /** Blocks that need a (re)digest, most recent first. */
  /**
   * Blocks waiting for a digest, newest first. Automatic work only covers blocks that ended in the last
   * `settings.ai.backfillDays` days (30 by default): on a first run, a long history would otherwise spend the
   * subscription on year-old work and keep Home empty until the whole backlog is done. "Summarize now" (manual)
   * covers everything.
   */
  /** Start of the automatic window (Settings → AI → "Summarize automatically: the last N days", 30 by default). */
  windowStart(now = Date.now()) {
    const days = Number(this.settings.backfillDays);
    return now - (Number.isFinite(days) && days > 0 ? days : 30) * 86400e3;
  }

  pendingBlocks({ manual = false } = {}) {
    const out = [];
    const now = Date.now();
    const sig = this.providerSig();
    const oldest = manual ? 0 : this.windowStart(now);
    for (const meta of this.index.list()) {
      if (isAutomation(meta)) continue;
      const proj = this.registry.projectOfSession(meta);
      if (!proj) continue;
      const liveInfo = this.live.get(meta.id);
      for (const b of this.blocksOf(meta)) {
        if ((b.endAt || 0) < oldest) continue;
        const d = this.state.blocks[b.key];
        if (d && d.hash === b.hash) continue;
        // Always require a quiet period (longer for live sessions), so an active session isn't re-summarized every tick.
        const quiet = liveInfo?.live ? IDLE_READY : QUIET_NOT_LIVE;
        if (now - (b.endAt || 0) < quiet) continue;
        if (!manual && d && d.failures >= 3 && d.failHash === b.hash && d.failSig === sig) continue; // gave up on this exact input with this provider (a manual run tries once more)
        if (d && d.retryAt > now && d.flakyHash === b.hash) continue; // keeps timing out: set aside so it can't stall the queue
        out.push({ meta, block: b, project: proj });
      }
    }
    out.sort((a, b) => b.block.endAt - a.block.endAt);
    return out;
  }

  buildBlockInput(meta, b, project) {
    const turns = this.index.loadTurns(meta.id);
    const title = meta.customTitle || meta.aiTitle || meta.summaryTitle || '';
    const lines = [];
    lines.push(`Project folder: ${project.path} (workspace: ${project.workspace})`);
    if (meta.harness && meta.harness !== 'claude') lines.push(`Tool: ${meta.harness} CLI session`);
    lines.push(`Session: ${title ? `"${title}"` : '(untitled)'} · block ${fmt(b.startAt)} → ${fmt(b.endAt)} · ${b.prompts} user prompts`);
    if (meta.archived) lines.push('(Only the user prompts survived for this old session; no assistant replies available.)');
    if (meta.awaySummary && meta.awayAt >= b.startAt && meta.awayAt <= b.endAt + 3600e3) lines.push(`Claude's recap at ${fmt(meta.awayAt)}: ${meta.awaySummary}`);
    const compact = turns.slice(b.i0, b.i1 + 1).find((t) => t.o === 'x');
    if (compact) lines.push(`Summary of earlier context (from compaction):\n${clip(compact.p, 2200)}`);
    const prim = [];
    const me = userName();
    for (let i = b.i0; i <= b.i1; i++) if (PRIMARY.has(turns[i].o)) prim.push(i);
    const pick = prim.length > 60 ? [...prim.slice(0, 15), ...prim.slice(-45)] : prim;
    const texts = pick.map((i) => clip(oneLine(turns[i].p), prim.length > 30 ? 240 : 500));
    // Spend the budget from the last prompt backwards (where the block ended up matters most), keeping the opening ask.
    let budget = 9000 - (texts[0]?.length || 0);
    let from = pick.length;
    while (from > 1 && budget - texts[from - 1].length >= 0) budget -= texts[--from].length;
    const keep = pick.length ? [0, ...Array.from({ length: pick.length - from }, (_, k) => from + k)] : [];
    const pos = new Map(prim.map((i, k) => [i, k]));
    lines.push('\nPrompts, in order:');
    keep.forEach((k, n) => {
      const skipped = n ? pos.get(pick[k]) - pos.get(pick[keep[n - 1]]) - 1 : 0;
      if (skipped > 0) lines.push(`(… ${skipped} prompt${skipped > 1 ? 's' : ''} left out …)`);
      const t = turns[pick[k]];
      const who = t.o === 'p' ? 'Another Claude session' : t.o === 's' ? 'Automated run' : me;
      lines.push(`[${fmt(t.t)}] ${who}: ${texts[k]}`);
    });
    const finals = [];
    for (let i = b.i1; i >= b.i0 && finals.length < 3; i--) if (turns[i].a) finals.unshift(turns[i]);
    if (finals.length) {
      lines.push(`\n${meta.harness && meta.harness !== 'claude' ? meta.harness[0].toUpperCase() + meta.harness.slice(1) : 'Claude'}'s last replies in this block:`);
      for (const t of finals) lines.push(`[${fmt(t.at || t.t)}] ${clip(oneLine(t.a), 900)}`);
    }
    const files = Object.entries(meta.files || {})
      .sort((a, b2) => b2[1] - a[1])
      .slice(0, 10)
      .map(([f]) => path.relative(project.path, f) || f);
    if (files.length) lines.push(`\nFiles most edited in the session: ${files.join(', ')}`);
    if (meta.prs?.length) lines.push(`Pull requests mentioned: ${meta.prs.slice(-8).join(' ')}`);
    return lines.join('\n');
  }

  async digestBlock(job) {
    const { meta, block, project } = job;
    const input = this.buildBlockInput(meta, block, project);
    const r = await callAI({
      purpose: 'digest',
      instruction: `${systemRules()} Summarize the work block described on stdin into the JSON schema. Do not mention "the input", "the log" or "the block"; just describe the work. If replies are missing, summarize what was asked. ${SHORT_RULE} In "todo", never write "${userName()}", "the user" or "Claude".`,
      input,
      schema: BLOCK_SCHEMA,
      model: this.settings.digestModel,
    });
    const prev = this.state.blocks[block.key];
    if (!r.ok) {
      const cls = classifyFailure(r);
      const keep = { ...(prev || {}), hash: prev?.hash || null, lastError: r.error };
      if (cls === 'input') {
        const sig = this.providerSig();
        const same = prev?.failHash === block.hash && prev?.failSig === sig;
        this.state.blocks[block.key] = { ...keep, failHash: block.hash, failSig: sig, failures: (same ? prev.failures || 0 : 0) + 1 };
      } else if (cls === 'flaky') this.state.blocks[block.key] = { ...keep, ...flakyStrike(prev, block.hash) };
      // 'setup' / 'busy': the provider's problem, not this block's. The queue pauses (pump) and nothing is counted.
      throw aiError(r, cls);
    }
    this.state.blocks[block.key] = {
      hash: block.hash,
      failures: 0,
      at: Date.now(),
      model: r.model,
      sessionId: meta.id,
      projectPath: project.path,
      startAt: block.startAt,
      endAt: block.endAt,
      digest: sanitizeDigest(r.data),
    };
    return r;
  }

  /**
   * The work-block part of a brief: which blocks the model sees, their ids and the brief's hash. No file access,
   * so pendingBriefs() can afford it for every project. The budget goes to the newest blocks first (full lines),
   * then older ones by title; only what the model is shown counts toward the hash.
   */
  briefBlocks(project) {
    const blocks = [];
    for (const id of project.sessionIds) {
      const s = this.index.get(id);
      if (s && !isAutomation(s)) for (const b of this.blocksOf(s)) blocks.push({ s, b, d: this.state.blocks[b.key] });
    }
    blocks.sort((a, b) => a.b.startAt - b.b.startAt);
    const day = (b) => fmt(b.startAt).slice(0, 10);
    const untitled = (s, b, n) => `[${day(b)}] (not summarized) ${clip(oneLine(this.blockView(s, b).fallbackTitle), n)}`;
    const kept = fitNewestFirst(blocks, {
      full: ({ s, b, d }) => (d?.digest ? `[${day(b)}] ${d.digest.title} — ${d.digest.summary} (status: ${d.digest.status}; topic: ${d.digest.topic})` : untitled(s, b, 140)),
      short: ({ s, b, d }) => (d?.digest ? `[${day(b)}] ${d.digest.title} (${d.digest.status}; ${d.digest.topic})` : untitled(s, b, 70)),
      fullBudget: 12000,
      shortBudget: 6000,
    });
    const ids = {};
    const lines = kept.map(({ item, line }, i) => {
      ids[`b${i + 1}`] = item.b.key;
      return `b${i + 1} ${line}`;
    });
    const st = this.registry.gitOf(project.path).status;
    // Only meaningful changes trigger a new brief: new/changed work blocks or a new commit day.
    // (Doc mtimes and automation run counts change constantly and are deliberately left out.)
    const sig = hash(JSON.stringify([kept.map(({ item: { b, d } }) => `${b.key}:${d?.hash || ''}`), st?.lastCommitAt ? isoDay(st.lastCommitAt) : 0]), 20);
    return { blocks, lines, ids, sig, shortCount: kept.filter((k) => k.short).length, omitted: blocks.length - kept.length };
  }

  /** Inputs for a project's brief; returns {input, hash, ids, blockCount, bb} */
  buildBriefInput(project, bb = this.briefBlocks(project)) {
    const lines = [];
    const sessions = project.sessionIds.map((id) => this.index.get(id)).filter(Boolean);
    const autos = sessions.filter((s) => isAutomation(s));
    const git = this.registry.gitOf(project.path);
    lines.push(`Project folder: ${project.path}`);
    lines.push(`Workspace: ${project.workspace}${project.worktrees.size ? ` · ${project.worktrees.size} git worktrees` : ''}`);
    if (project.stack?.length) lines.push(`Stack: ${project.stack.join(', ')}`);
    const st = git.status;
    if (st?.ok) lines.push(`Git: branch ${st.branch}, ${st.dirty} uncommitted changes, ${st.ahead} unpushed commits, last commit ${fmt(st.lastCommitAt)} "${st.lastCommitMsg}", ${st.commits30d} commits in 30 days${st.webUrl ? `, remote ${st.webUrl}` : ''}`);
    if (git.extras?.recentLog?.length) lines.push(`Recent commits:\n${git.extras.recentLog.slice(0, 15).map((c) => `  ${c.d} ${c.s}`).join('\n')}`);
    const docs = listDocs(project, [...(project.projectKeys || [])]);
    let docBudget = 5000;
    for (const d of docs.slice(0, 8)) {
      if (docBudget <= 0) break;
      if (!/claude\.md$|readme|memory|goal|strategy|handoff|overview|context/i.test(d.name) && d.group !== 'Claude memory') continue;
      try {
        const txt = clip(readHead(d.path), Math.min(1800, docBudget));
        docBudget -= txt.length;
        lines.push(`\n--- ${d.group}: ${d.name} ---\n${txt}`);
      } catch {}
    }
    if (autos.length) {
      const groups = {};
      for (const a of autos) {
        const k = automationKey(a);
        const g = (groups[k] = groups[k] || { n: 0, last: 0 });
        g.n++;
        g.last = Math.max(g.last, a.lastAt);
      }
      lines.push(`\nAutomated runs in this folder: ${Object.entries(groups).map(([k, g]) => `"${k}" ×${g.n} (last ${fmt(g.last)})`).join('; ')}`);
    }
    const shown = bb.lines.length;
    const how = [shown - bb.shortCount && `the latest ${shown - bb.shortCount} with summaries`, bb.shortCount && `${bb.shortCount} older ones by title only`, bb.omitted && `the ${bb.omitted} oldest not listed`].filter(Boolean);
    lines.push(`\nWork blocks (${bb.blocks.length}), oldest first${bb.shortCount || bb.omitted ? ` (${how.join(', ')})` : ''}:`);
    lines.push(...bb.lines);
    return { input: lines.join('\n'), hash: bb.sig, ids: bb.ids, blockCount: bb.blocks.length, bb };
  }

  /**
   * Blocks the brief's threads don't hold: those of a known topic join that topic's thread; the oldest ones
   * the model wasn't shown go to "Earlier work". What remains (a block the model skipped) stays loose.
   */
  placeUnassigned(threads, bb) {
    const assigned = new Set(threads.flatMap((t) => t.blockKeys));
    const topicOf = (k) => oneLine(this.state.blocks[k]?.digest?.topic).toLowerCase();
    const votes = new Map(); // topic -> Map(thread index -> blocks of that topic in it)
    threads.forEach((t, ti) => {
      for (const k of t.blockKeys) {
        const tp = topicOf(k);
        if (!tp) continue;
        const v = votes.get(tp) || new Map();
        v.set(ti, (v.get(ti) || 0) + 1);
        votes.set(tp, v);
      }
    });
    const shown = new Set(Object.values(bb.ids));
    const earlier = [];
    for (const { b } of bb.blocks) {
      if (assigned.has(b.key)) continue;
      const v = votes.get(topicOf(b.key));
      if (v) threads[[...v].sort((x, y) => y[1] - x[1])[0][0]].blockKeys.push(b.key);
      else if (!shown.has(b.key)) earlier.push(b.key);
    }
    if (earlier.length) threads.push({ name: 'Earlier work', summary: 'Older work, from before the threads above.', status: 'paused', blockKeys: earlier });
    return threads;
  }

  async briefProject(job) {
    const { project } = job;
    const { input, hash: h, ids, bb } = this.buildBriefInput(project);
    const r = await callAI({
      purpose: 'brief',
      instruction: `${systemRules()} Write a brief for the project described on stdin, and group its work blocks into threads. Fill the JSON schema. Block ids (b1, b2...) belong only in threads[].blocks; never mention them in any text field. Write the text as of today; do not say "the input" or "the log". ${SHORT_RULE} In "todos", never write "${userName()}", "the user" or "Claude".`,
      input,
      schema: BRIEF_SCHEMA,
      model: this.settings.briefModel,
    });
    if (!r.ok) {
      const cls = classifyFailure(r);
      const prev = this.state.projects[project.path] || {};
      if (cls === 'input') {
        const sig = this.providerSig();
        const same = prev.failHash === h && prev.failSig === sig;
        this.state.projects[project.path] = { ...prev, failHash: h, failSig: sig, failures: (same ? prev.failures || 0 : 0) + 1, lastError: r.error, failedAt: Date.now() };
      } else if (cls === 'flaky') this.state.projects[project.path] = { ...prev, ...flakyStrike(prev, h), lastError: r.error, failedAt: Date.now() };
      throw aiError(r, cls);
    }
    const brief = r.data || {};
    const threads = this.placeUnassigned(
      (brief.threads || []).map((t) => ({
        name: clip(t.name, 60),
        summary: clip(t.summary, 300),
        status: t.status,
        blockKeys: (t.blocks || []).map((id) => ids[id]).filter(Boolean),
      })),
      bb,
    );
    this.state.projects[project.path] = {
      hash: h,
      at: Date.now(),
      model: r.model,
      brief: {
        oneLiner: clip(brief.oneLiner, 160),
        description: clip(brief.description, 900),
        currentState: clip(brief.currentState, 500),
        ...briefSteps(brief),
        attention: asList(brief.attention).slice(0, 5).map((s) => clip(String(s), 240)),
        cv: brief.cv || null,
        threads,
      },
    };
    return r;
  }

  pendingBriefs(pending = this.pendingBlocks()) {
    const out = [];
    const now = Date.now();
    const sig = this.providerSig();
    const pendingByProject = new Map();
    for (const p of pending) pendingByProject.set(p.project.path, (pendingByProject.get(p.project.path) || 0) + 1);
    const oldest = this.windowStart(now);
    for (const project of this.registry.projects.values()) {
      if (pendingByProject.get(project.path)) continue; // wait for its block digests first
      // Same window as the blocks: on a first run, projects untouched for a year don't each get a brief ("Summarize
      // now" on the project still writes one). A new session or commit brings a project back into the window.
      const lastCommitAt = this.registry.gitOf?.(project.path)?.status?.lastCommitAt || 0;
      if (Math.max(project.lastAt || 0, lastCommitAt) < oldest) continue;
      const cur = this.state.projects[project.path];
      if (cur && now - (cur.at || 0) < 2 * 3600e3) continue; // at most one brief per project every 2 h
      if (cur && cur.failedAt && now - cur.failedAt < 30 * 60e3) continue;
      const { sig: h, blocks } = this.briefBlocks(project); // the hash only: docs and git log are read when the brief is written
      if (cur && cur.hash === h) continue;
      if (cur && cur.failHash === h && cur.failures >= 3 && cur.failSig === sig) continue;
      if (cur && cur.retryAt > now && cur.flakyHash === h) continue;
      // Repos without sessions (cloned libraries, old checkouts) get a brief only when asked for ("Summarize now").
      const hasSomething = blocks.length > 0 || project.sessionIds.length;
      if (!hasSomething) continue;
      out.push({ project, recent: project.lastAt || 0 });
    }
    out.sort((a, b) => b.recent - a.recent);
    return out;
  }

  /** The name the user sees for a project (their rename first). */
  projectName(projectPath) {
    return this.store.project(projectPath).name || this.registry.projects.get(projectPath)?.name || path.basename(projectPath);
  }

  /** The projects the daily brief looks at, in the order that gives them their ids (p1 = most recent). */
  dailyProjects() {
    const projects = [...this.registry.projects.values()].filter((p) => Date.now() - (p.lastAt || 0) < 45 * 86400e3 || this.store.project(p.path).status === 'active');
    projects.sort((a, b) => b.lastAt - a.lastAt);
    return projects.slice(0, 25);
  }

  /**
   * The model refers to projects by id (p3); the user reads names. `project` becomes the name (projectPath stays
   * beside it) and every id left in the text is replaced by the project's name. ids: {p3: path}.
   */
  nameDaily(brief, ids) {
    const nameOf = (code) => (ids[code.toLowerCase()] ? this.projectName(ids[code.toLowerCase()]) : null);
    // "p12 (shop-api)" → "shop-api", not "shop-api (shop-api)"
    const text = (s) => String(s ?? '').replace(new RegExp(`${PROJECT_CODE.source}( \\(([^()]{1,80})\\))?`, 'gi'), (m, _n, paren, inner) => {
      const name = nameOf(m.slice(0, m.length - (paren || '').length));
      if (!name) return m;
      return paren && inner.trim().toLowerCase() === name.toLowerCase() ? name : name + (paren || '');
    });
    const byName = new Map(Object.values(ids).map((p) => [this.projectName(p).toLowerCase(), p]));
    const item = (x, fields) => {
      const ref = String(x.project || '').trim().toLowerCase();
      const projectPath = x.projectPath || ids[ref] || byName.get(ref) || null; // an id, or a name when the model wrote one
      const out = { ...x, project: projectPath ? this.projectName(projectPath) : text(x.project), projectPath };
      for (const f of fields) if (f in x) out[f] = text(x[f]);
      return out;
    };
    return {
      headline: clip(text(brief.headline), 360), // names are longer than ids: a little more room than before
      focus: (brief.focus || []).map((x) => item(x, ['title', 'why', 'action'])),
      forgotten: (brief.forgotten || []).map((x) => item(x, ['note'])),
      ideas: (brief.ideas || []).map((s) => clip(text(s), 420)),
    };
  }

  /**
   * A daily brief saved before ids were mapped to names: map the ids its focus/forgotten entries pin down, and the
   * rest from today's project order when that order agrees with all of those. Anything left unmapped gets the
   * brief rewritten (needDaily). Waits until the registry is loaded.
   */
  fixStoredDaily() {
    const d = this.state.daily;
    if (!d?.brief || d.v >= 2 || !this.registry.projects.size) return;
    const ids = {};
    for (const x of [...(d.brief.focus || []), ...(d.brief.forgotten || [])]) if (/^p\d{1,2}$/i.test(x.project || '') && x.projectPath) ids[x.project.toLowerCase()] = x.projectPath;
    const order = Object.fromEntries(this.dailyProjects().map((p, i) => [`p${i + 1}`, p.path]));
    if (Object.keys(ids).length && Object.entries(ids).every(([c, p]) => order[c] === p)) for (const [c, p] of Object.entries(order)) ids[c] ??= p;
    d.brief = this.nameDaily(d.brief, ids);
    d.v = 2;
    const b = d.brief;
    const texts = [b.headline, ...b.ideas, ...b.focus.flatMap((x) => [x.project, x.title, x.why, x.action]), ...b.forgotten.flatMap((x) => [x.project, x.note])];
    if (texts.some((s) => new RegExp(PROJECT_CODE.source, 'i').test(String(s ?? '')))) d.stale = true;
    this._save();
    this.emit('changed', { kind: 'daily' });
  }

  buildDailyInput(overview) {
    const lines = [];
    const ids = {};
    lines.push(`Today is ${new Date().toDateString()}.`);
    lines.push('Projects (most recent activity first):');
    this.dailyProjects().forEach((p, i) => {
      const id = `p${i + 1}`;
      ids[id] = p.path;
      const br = this.state.projects[p.path]?.brief;
      const st = this.registry.gitOf(p.path).status;
      lines.push(
        `${id}: ${this.projectName(p.path)} (${p.workspace}) · last activity ${fmt(p.lastAt).slice(0, 10)}` +
          (br ? ` · ${br.oneLiner} · now: ${br.currentState} · next: ${(br.nextSteps || []).slice(0, 2).join(' / ')}` : '') +
          (st?.ok && st.dirty ? ` · ${st.dirty} uncommitted changes` : '') +
          (st?.ok && st.ahead ? ` · ${st.ahead} unpushed commits` : ''),
      );
    });
    const recent = Object.values(this.state.blocks)
      .filter((b) => b.digest && Date.now() - (b.endAt || 0) < 8 * 86400e3)
      .sort((a, b) => b.endAt - a.endAt)
      .slice(0, 30);
    if (recent.length) {
      lines.push('\nWork in the last 8 days:');
      for (const b of recent) {
        const name = b.projectPath ? this.projectName(b.projectPath) : '?';
        lines.push(`[${fmt(b.endAt).slice(0, 10)}] ${name} · ${b.digest.title}: ${b.digest.outcome} (${b.digest.status}${b.digest.nextStep ? `; next: ${b.digest.nextStep}` : ''})`);
      }
    }
    if (overview?.attention?.length) {
      lines.push('\nSignals:');
      for (const a of overview.attention.slice(0, 12)) lines.push(`${a.projectPath ? this.projectName(a.projectPath) : '?'}: ${a.text}`);
    }
    try {
      const extra = this.dailyExtras?.();
      if (extra) lines.push(`\n${extra}`);
    } catch {}
    const ideas = (this.store.data.ideas || []).filter((x) => !x.doneAt).slice(-10);
    if (ideas.length) lines.push(`\nIdeas inbox: ${ideas.map((x) => clip(x.text, 120)).join(' | ')}`);
    return { input: lines.join('\n'), ids };
  }

  async runDaily(overview) {
    const { input, ids } = this.buildDailyInput(overview);
    const r = await callAI({
      purpose: 'daily',
      instruction: `${systemRules()} You are ${userName()}'s chief of staff. From the state of their projects on stdin, write today's brief. Fill the JSON schema. Each listed project has an id (p1, p2, ...): put it only in the "project" fields. Everywhere else (headline, title, why, action, note, ideas) call projects by their names, never by id. ${SHORT_RULE}`,
      input,
      schema: DAILY_SCHEMA,
      model: this.settings.briefModel,
    });
    if (!r.ok) throw aiError(r, classifyFailure(r));
    const d = r.data || {};
    const prev = this.state.daily;
    this.state.daily = {
      v: 2,
      day: isoDay(Date.now()),
      at: Date.now(),
      // same-day rewrites (afternoon refresh after new work); needDaily caps them
      refreshes: prev && prev.day === isoDay(Date.now()) ? (prev.refreshes || 0) + 1 : 0,
      brief: this.nameDaily({ headline: d.headline, focus: (d.focus || []).slice(0, 3), forgotten: (d.forgotten || []).slice(0, 5), ideas: (d.ideas || []).slice(0, 5) }, ids),
    };
    return r;
  }

  async runCV(project, lang = 'en') {
    if (process.env.PILOTAGE_NO_AI === '1') throw new Error('AI disabled (PILOTAGE_NO_AI)');
    const brief = this.state.projects[project.path]?.brief;
    const git = this.registry.gitOf(project.path);
    const lines = [];
    lines.push(`Project folder: ${project.path}`);
    if (brief) lines.push(`Brief: ${brief.oneLiner}\n${brief.description}\nCurrent state: ${brief.currentState}`);
    if (project.stack?.length) lines.push(`Detected stack: ${project.stack.join(', ')}`);
    const first = Math.min(...[project.firstAt, git.extras?.firstCommitAt].filter(Boolean));
    const last = Math.max(project.lastAt || 0, git.status?.lastCommitAt || 0);
    lines.push(`Active period: ${Number.isFinite(first) ? fmt(first).slice(0, 10) : '?'} → ${last ? fmt(last).slice(0, 10) : '?'}`);
    if (git.status?.webUrl) lines.push(`Repository: ${git.status.webUrl}`);
    if (git.extras?.recentLog?.length) lines.push(`Recent commits: ${git.extras.recentLog.slice(0, 20).map((c) => c.s).join(' | ')}`);
    const digests = Object.values(this.state.blocks).filter((b) => b.projectPath === project.path && b.digest);
    digests.sort((a, b) => a.startAt - b.startAt);
    // Newest work in full, older work shortened: the budget never cuts off what was done last.
    const day = (b) => fmt(b.startAt).slice(0, 10);
    const worklog = fitNewestFirst(digests, {
      full: (b) => `[${day(b)}] ${b.digest.title}: ${b.digest.outcome}${b.digest.highlights?.length ? ` Highlights: ${b.digest.highlights.join('; ')}` : ''}`,
      short: (b) => `[${day(b)}] ${b.digest.title}${b.digest.highlights?.[0] ? ` (${b.digest.highlights[0]})` : ''}`,
      fullBudget: 9000,
      shortBudget: 4000,
    });
    const notes = [worklog.some((l) => l.short) && 'older entries shortened', digests.length > worklog.length && `the ${digests.length - worklog.length} oldest left out`].filter(Boolean);
    lines.push(`\nWork log, oldest first${notes.length ? ` (${notes.join('; ')})` : ''}:`);
    for (const l of worklog) lines.push(l.line);
    const over = this.store.project(project.path);
    if (over.notes) lines.push(`\n${userName()}'s own notes: ${clip(over.notes, 1500)}`);
    const language = lang === 'fr' ? 'French' : 'English';
    const r = await callAI({
      purpose: 'cv',
      instruction: `${systemRules().replace('Write in English', `Write in ${language}`)} Write a CV/portfolio entry for this project. Strong, honest, specific bullets. Fill the JSON schema in ${language}.`,
      input: lines.join('\n'),
      schema: CV_SCHEMA,
      model: this.settings.cvModel,
      effort: 'medium',
    });
    if (!r.ok) throw aiError(r, classifyFailure(r));
    this.state.cv[project.path] = { lang, at: Date.now(), model: r.model, entry: r.data };
    this.emit('changed', { kind: 'cv', path: project.path });
    return r; // a queue job (writeCV): pump() records the stats and saves
  }

  /**
   * POST /api/ai/cv: the CV entry as a manual queue job (within the concurrency limit, counted toward the call caps),
   * resolved with the stored entry. One in flight per project: a double tap or a retry gets the same answer.
   */
  writeCV(project, lang = 'en') {
    const id = `cv:${project.path}`;
    if (this.cvWaits.has(id)) return this.cvWaits.get(id);
    const done = new Promise((resolve, reject) => {
      const queued = this.enqueue({
        id,
        kind: 'cv',
        priority: 55,
        manual: true,
        label: project.name,
        projectPath: project.path,
        run: () =>
          this.runCV(project, lang).then(
            (r) => (resolve(this.state.cv[project.path]), r),
            (e) => {
              reject(e);
              throw e;
            },
          ),
      });
      if (!queued) reject(new Error(process.env.PILOTAGE_NO_AI === '1' ? 'AI disabled (PILOTAGE_NO_AI)' : 'Could not queue the AI call'));
    }).finally(() => this.cvWaits.delete(id));
    this.cvWaits.set(id, done);
    return done;
  }

  /** Pilotage's own call budget (the usage files can't see headless calls). */
  noteCall() {
    const now = Date.now();
    this.state.callLog = (this.state.callLog || []).filter((t) => now - t < 24 * 3600e3);
    this.state.callLog.push(now);
  }

  callBudget() {
    const now = Date.now();
    const log24 = (this.state.callLog || []).filter((t) => now - t < 24 * 3600e3);
    const in5h = log24.filter((t) => now - t < 5 * 3600e3).length;
    const max5h = this.settings.maxCallsPer5h ?? 500;
    const maxDay = this.settings.maxCallsPerDay ?? 1500;
    if (max5h && in5h >= max5h) return { ok: false, reason: `Pilotage made ${in5h} AI calls in 5 hours (cap ${max5h})` };
    if (maxDay && log24.length >= maxDay) return { ok: false, reason: `Pilotage made ${log24.length} AI calls today (cap ${maxDay})` };
    return { ok: true };
  }

  recordStats(kind, r) {
    const s = this.state.stats;
    s.calls = (s.calls || 0) + 1;
    s.cost = (s.cost || 0) + (r?.cost || 0);
    s.lastRunAt = Date.now();
    s.byKind = s.byKind || {};
    s.byKind[kind] = (s.byKind[kind] || 0) + 1;
  }

  enqueue(job) {
    if (process.env.PILOTAGE_NO_AI === '1') return false; // tests / experiments: never call a model
    if (this.running.has(job.id)) return false;
    if (this.queued.has(job.id)) {
      // Asked for by hand while it waits as an automatic job: it becomes the manual job (past the guard, sooner).
      const i = this.queue.findIndex((j) => j.id === job.id);
      if (!job.manual || i < 0 || this.queue[i].manual) return false;
      this.queue[i] = { ...this.queue[i], ...job, priority: Math.max(this.queue[i].priority || 0, job.priority || 0) };
      this.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
      this.pump();
      return true;
    }
    this.queued.add(job.id);
    this.queue.push(job);
    this.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.pump();
    return true;
  }

  /**
   * "Summarize now" on a project: its pending blocks (old ones too), then its brief. The brief waits for those digests
   * (`after`), so it includes the work just summarized instead of running beside it. Returns how many jobs it asked for.
   */
  summarizeProject(project) {
    const ids = [];
    for (const pb of this.pendingBlocks({ manual: true }).filter((x) => x.project.path === project.path)) {
      const id = `block:${pb.block.key}`;
      this.enqueue({ id, kind: 'block', priority: 50, manual: true, run: () => this.digestBlock(pb), label: project.name, projectPath: project.path });
      ids.push(id);
    }
    const id = ids.length ? `brief-after:${project.path}` : `brief:${project.path}`;
    this.enqueue({ id, kind: 'brief', priority: 49, manual: true, after: ids, run: () => this.briefProject({ project }), label: project.name, projectPath: project.path });
    return ids.length + 1;
  }

  /** Periodic scheduling of automatic work. */
  tick(overview) {
    this.fixStoredDaily(); // no AI call: renames the ids of a brief stored by an older version
    if (process.env.PILOTAGE_NO_AI === '1') return;
    if (!this.settings.enabled || !this.settings.autoDigest) return;
    if (this.queue.length > 6) return;
    const g = this.guard();
    this.guardReason = g.ok ? null : g.reason;
    if (!g.ok) return;
    let n = 0;
    const pending = this.pendingBlocks();
    for (const p of pending) {
      if (n >= 12) break;
      if (this.enqueue({ id: `block:${p.block.key}`, kind: 'block', priority: 10 + p.block.endAt / 1e13, run: () => this.digestBlock(p), label: p.meta.aiTitle || p.project.name, projectPath: p.project.path })) n++;
    }
    if (n === 0 && pending.length === 0 && this.running.size === 0 && Date.now() - (this._lastBriefScan || 0) > 2 * 60e3) {
      this._lastBriefScan = Date.now();
      const briefs = this.pendingBriefs(pending);
      for (const b of briefs.slice(0, 4)) {
        this.enqueue({ id: `brief:${b.project.path}`, kind: 'brief', priority: 5 + b.recent / 1e13, run: () => this.briefProject(b), label: b.project.name, projectPath: b.project.path });
      }
      const today = isoDay(Date.now());
      const df = this.state.dailyFail;
      const dailyBackoff = df && df.day === today && (df.failures >= 3 || Date.now() - df.at < 30 * 60e3);
      const d0 = this.state.daily;
      // One brief per day, written fresh in the morning: a brief made during the night is redone once after 05:00.
      // Also refresh once or twice during the day when it's 6 h old and new work was summarized since (so Home's
      // plan doesn't talk about the morning all evening). Not after 22:00.
      const hourNow = new Date().getHours();
      const newWork = !!d0 && Object.values(this.state.blocks).some((b) => b.digest && (b.at || 0) > d0.at);
      const dayRefresh = !!d0 && d0.day === today && Date.now() - d0.at > 6 * 3600e3 && newWork && (d0.refreshes || 0) < 3 && hourNow >= 5 && hourNow < 22;
      const needDaily = !d0 || d0.day !== today || !!d0.stale || (new Date(d0.at).getHours() < 5 && hourNow >= 5) || dayRefresh;
      if (briefs.length === 0 && this.settings.dailyBrief && !dailyBackoff && needDaily) {
        this.enqueue({
          id: `daily:${today}:${new Date().getHours() >= 5 ? 'am' : 'night'}:${d0 && d0.day === today ? d0.refreshes || 0 : 'new'}`,
          kind: 'daily',
          priority: 1,
          run: () =>
            this.runDaily(overview?.()).catch((e) => {
              // A logged-out provider or a usage limit is not this brief's fault: the queue pause covers it.
              if (e.aiClass !== 'setup' && e.aiClass !== 'busy') {
                const cur = this.state.dailyFail && this.state.dailyFail.day === today ? this.state.dailyFail : { day: today, failures: 0 };
                this.state.dailyFail = { day: today, failures: cur.failures + 1, at: Date.now() };
              }
              throw e;
            }),
          label: 'Daily brief',
        });
      }
      // Lowest priority: the project scout, once digests and briefs are caught up (it reads them).
      if (briefs.length === 0 && this.scout) {
        try {
          for (const job of this.scout.autoJobs()) this.enqueue(job);
        } catch (e) {
          log.warn('scout scheduling failed', e.message);
        }
      }
    }
  }

  pump() {
    const conc = Math.max(1, Math.min(4, this.settings.concurrency || 2));
    while (this.running.size < conc && this.queue.length) {
      const g = this.guard();
      this.guardReason = g.ok ? null : g.reason;
      // The first job that may start: an automatic job the guard holds back doesn't block a manual one behind it, and
      // a job with `after` waits while those jobs are running or still queued to run.
      const willRun = (id) => this.running.has(id) || this.queue.some((j) => j.id === id && (g.ok || j.manual));
      const i = this.queue.findIndex((j) => (g.ok || j.manual) && !(j.after || []).some(willRun));
      if (i < 0) return;
      const [job] = this.queue.splice(i, 1);
      this.queued.delete(job.id);
      this.running.set(job.id, { ...job, startedAt: Date.now() });
      this.emit('changed', { kind: 'queue' });
      this.noteCall();
      Promise.resolve()
        .then(() => job.run()) // a synchronous throw inside run() must not leave the job stuck in `running`
        .then((r) => {
          this.recordStats(job.kind, r);
        })
        .catch((e) => {
          const s = this.state.stats;
          s.errors = (s.errors || 0) + 1;
          s.lastError = { at: Date.now(), msg: clip(friendlyError(e.message), 300), job: job.id };
          const cls = e.aiClass || classifyFailure({ error: e.message });
          if (cls !== 'input') this.pause(cls, e.message);
          log.warn('ai job failed', job.id, e.message);
        })
        .finally(() => {
          this.running.delete(job.id);
          this._save();
          this.emit('changed', { kind: job.kind, projectPath: job.projectPath });
          this.pump();
        });
    }
  }

  /** Flush to disk now (used on shutdown). */
  saveNow() {
    try {
      writeJSONSync(paths.ai, this.state);
    } catch (e) {
      log.warn('ai save failed', e.message);
    }
  }

  status() {
    const pendingBlocks = this.pendingBlocks().length;
    return {
      enabled: this.settings.enabled,
      autoDigest: this.settings.autoDigest,
      pausedByUser: this.pausedByUser,
      guard: this.guard(),
      queue: this.queue.map((j) => ({ id: j.id, kind: j.kind, label: j.label })).slice(0, 30),
      queueLength: this.queue.length,
      running: [...this.running.values()].map((j) => ({ id: j.id, kind: j.kind, label: j.label, startedAt: j.startedAt })),
      pendingBlocks,
      digested: Object.values(this.state.blocks).filter((b) => b.digest).length,
      briefs: Object.keys(this.state.projects).filter((k) => this.state.projects[k].brief).length,
      scouted: Object.keys(this.state.scout || {}).filter((k) => this.state.scout[k].at).length,
      stats: this.state.stats,
      daily: this.state.daily ? { day: this.state.daily.day, at: this.state.daily.at } : null,
    };
  }
}

/** Human wording for errors shown in the UI. */
function friendlyError(msg = '') {
  if (/structured_output|no structured output/i.test(msg)) return 'The model returned an invalid summary; it will be retried.';
  if (/please run \/login|not logged in/i.test(msg))
    return (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && process.env.PILOTAGE_USE_ANTHROPIC_API_KEY !== '1' && !process.env.ANTHROPIC_BASE_URL
      ? 'Claude is logged out on this PC (run claude, then /login). To bill ANTHROPIC_API_KEY instead, start Pilotage with PILOTAGE_USE_ANTHROPIC_API_KEY=1'
      : 'Claude is logged out on this PC (run claude in a terminal, then /login)';
  if (/usage limit|limit reached|rate.?limit|429/i.test(msg)) return 'Claude usage limit reached; summaries resume automatically later.';
  if (/timeout|timed out/i.test(msg)) return 'A summary took too long and was stopped; it will be retried.';
  return msg;
}

/** A brief's open work: nextSteps (Claude-facing) with todos/whos parallel to it (index i = step i), so every reader
 *  of nextSteps keeps working and work/extract.js can pick the short to-do of step i. */
export function briefSteps(brief = {}) {
  const at = (arr, i) => (Array.isArray(arr) ? arr[i] : undefined);
  const steps = (Array.isArray(brief.nextSteps) ? brief.nextSteps : [])
    .map((s, i) => ({ text: clip(oneLine(s), 240), i }))
    .filter((x) => x.text)
    .slice(0, 3);
  return {
    nextSteps: steps.map((x) => x.text),
    todos: steps.map((x) => clip(oneLine(at(brief.todos, x.i)), 60)),
    whos: steps.map((x) => (WHO.has(at(brief.whos, x.i)) ? at(brief.whos, x.i) : null)),
  };
}

/** A list from a model field that should be one: a lone string becomes [string], anything else []. */
const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []);

export function sanitizeDigest(d = {}) {
  d = d && typeof d === 'object' ? d : {};
  return {
    title: clip(oneLine(d.title), 90),
    summary: clip(oneLine(d.summary), 400),
    outcome: clip(oneLine(d.outcome), 400),
    status: d.status,
    nextStep: clip(oneLine(d.nextStep), 240),
    todo: clip(oneLine(d.todo), 60),
    who: WHO.has(d.who) ? d.who : null,
    topic: clip(oneLine(d.topic), 50),
    kind: d.kind,
    cvWorthy: !!d.cvWorthy,
    highlights: asList(d.highlights).slice(0, 3).map((s) => clip(oneLine(s), 240)),
  };
}
