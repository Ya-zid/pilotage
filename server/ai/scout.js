// Project scout: finds parts of the user's work that deserve to become their own project (a spin-off already built
// inside a folder, a piece their other projects would reuse) and project ideas they voiced but never started.
//
// - Input per project (no AI, read-only, every section capped): the brief and its threads, block digests (newest
//   first), the user's own typed prompts (newest first, deduped) and, separately, the prompts that sound like an idea
//   (EN/FR) with more context, sub-folders that look like their own project (own manifest/README at depth ≤ 2)
//   and where the edits went (files edited in sessions, by folder). Files matching SENSITIVE are never read.
// - One AI call per project through the engine queue + guard (purpose 'scout', settings.ai.scoutModel).
// - Results: ai.state.scout[projectPath] = {at, hash, model, auto, candidates[]} in data/ai.json. Candidate ids are
//   stable: hash of projectPath + normalized title, and a close title on a later run keeps the earlier id.
// - Decisions: store.data.scout[id] = {status: 'dismissed'|'saved'|'accepted'|'new', at, from, title, candidate,
//   ideaId?, projectPath?}. A dismissed candidate never comes back for that project (same id, close title or pitch).
// - Automatic runs (engine.tick, lowest priority, after digests and briefs): projects with interactive activity in
//   the last 120 days and a brief, with no scout yet, or whose input changed and whose last scout is > 3 days old.
//   At most AUTO_PER_DAY automatic attempts a day. Contract for the UI: docs/API-SCOUT.md.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, SCAN_SKIP } from '../config.js';
import { clip, oneLine, hash, isInside, redact, randomToken, plain } from '../util.js';
import { callAI as providerCallAI } from './providers.js';
import { fitNewestFirst, classifyFailure } from './engine.js';
import { isAutomation } from '../sources/projects.js';
import { ownPrompts } from '../sources/sessions.js';
import { SENSITIVE, tilde } from '../work/spinoff.js';
import { normText, tokenSet, similar } from '../work/extract.js';
import { userName } from '../profile.js';

const DAY = 86400e3;
export const ACTIVE_DAYS = 120;
export const RESCOUT_AFTER = 3 * DAY;
export const AUTO_PER_DAY = 8;
const FAIL_PAUSE = 30 * 60e3;
const FLAKY_STRIKES = 3;
const FLAKY_BACKOFF = 6 * 3600e3;
const EVIDENCE_TTL = 10 * 60e3; // folder scan / input cache when nothing in the project's sessions changed
export const BUDGET = {
  prompts: 20000, // the user's other prompts, newest first
  promptChars: 200,
  ideas: 8000, // prompts with idea language
  ideaChars: 400,
  ideaWeakMax: 5,
  blocksFull: 7000,
  blocksShort: 3000,
  subprojects: 3500,
  edits: 2000,
  others: 4000,
  evidence: 46000, // hard cap on the hashed part
};
export const KINDS = ['spin-off', 'idea', 'reusable'];
const CONFIDENCE = ['high', 'medium', 'low'];
const STATUS_ORDER = { new: 0, saved: 1, accepted: 2, dismissed: 3 };
const fmtDay = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');

// ---------------------------------------------------------------- text helpers

/** Lower-case and strip accents without changing the length (match offsets stay valid in the original text). */
export function fold(s) {
  return String(s ?? '')
    .replace(/[À-ɏ]/g, (ch) => ch.normalize('NFD')[0])
    .toLowerCase();
}

// Matched on fold()ed text. Tier 1: the user talks about an idea, a separate project, a product, a tool for something.
// Tier 2: "we could", "I want to build" (also said about the current work, so they come after tier 1). Weak: "later",
// "separate", "product" alone — common in ordinary work talk, so they only fill what the others leave.
// "an idea", "my idea for…" (tier 1) vs "good idea", "no idea" (a reaction: tier 2).
function ideaWord(f) {
  const rx = /\b(?:ideas?|idees?)\b/g;
  let m;
  let first = -1;
  while ((m = rx.exec(f))) {
    if (first < 0) first = m.index;
    if (!/\b(?:good|great|bad|nice|rough|no|any|cool|better|best|clear|vague|exact|bonne|mauvaise|aucune)\s+$/.test(f.slice(Math.max(0, m.index - 12), m.index))) return { index: m.index, tier: 1 };
  }
  return first >= 0 ? { index: first, tier: 2 } : null;
}

const STRONG = [
  ['idea', ideaWord, 1],
  ['own project', /\bown (?:project|repo|repository|product|app|tool|package|library|service|startup|business|thing)\b/, 1],
  ['separate project', /\bseparate (?:project|repo|repository|app|tool|product|package|service|thing|business|module)\b|\b(?:a|another) new project\b/, 1],
  ['spin off', /\bspin(?:[- ]?off| (?:it|this|that) (?:off|out))\b|\b(?:take|pull|split|extract|move) (?:it|this|that) (?:out|into its own)\b/, 1],
  ['tool for', /\btool for\b|\ban? (?:tool|app|bot|extension|plugin|library|platform) (?:that|which) (?:would|could|can|lets?|helps?)\b/, 1],
  ['product', /\bproducti[sz]e\b|\b(?:a|as a|into a|our) product\b|\bsaas\b|\bsell (?:it|this|that)\b|\b(?:a|my|our|own) startup\b|\bopen[- ]?sourc(?:e|ed|ing)\b|\bside project\b|\breusable\b/, 1],
  ['projet a part', /\bprojet (?:a part|separe|independant)\b|\bson propre (?:projet|outil|produit|repo)\b|\b(?:en )?faire un (?:produit|projet|outil)\b|\bun outil (?:pour|qui)\b/, 1],
  ['arabic', /فكرة|مشروع/, 1],
  ['we could', /\bwe could\b|\bcould we\b|\bwhat if (?:we|i)\b|\bhow about (?:we|making|building)\b/, 2],
  ['should build', /\b(?:should|could|would|we'?ll|i'?ll|let'?s|want to|wanna|gonna|going to|plan to|thinking (?:of|about)) (?:also )?(?:build|create|launch|ship|sell|turn (?:it|this|that) into|make (?:a|an|my own|our own|something|it into))\b/, 2],
  ['on pourrait', /\bon pourrait\b|\bil faudrait\b|\bon devrait\b|\b(?:ce|ca) serait (?:bien|cool|top|genial)\b/, 2],
];
// A weak word only counts with building talk close by ("call them later" is not an idea; "build it later" may be).
const BUILDISH = /\b(?:build|building|built|create|creating|tool|app|application|bot|platform|project|saas|startup|business|outil|projet|appli|application|logiciel)s?\b/;
const WEAK = [
  ['later', /\blater\b|\bsomeday\b|\bone day\b|\beventually\b|\bin the future\b|\bfor the future\b|\bplus tard\b|\bun jour\b/],
  ['separate', /\bseparate(?:ly)?\b|\bsepare(?:e|s|es)?\b/],
  ['product', /\bproducts?\b|\bproduits?\b/],
];

/** Idea language in a text: null, or {strong, tier (1 best, 3 weak), score, index (first match), terms}. */
export function ideaHit(text) {
  const f = fold(text);
  for (const [list, strong] of [[STRONG, true], [WEAK, false]]) {
    const terms = [];
    let index = -1;
    let tier = 3;
    for (const [term, rx, t] of list) {
      const m = typeof rx === 'function' ? rx(f) : rx.exec(f);
      if (!m) continue;
      terms.push(term);
      tier = Math.min(tier, m.tier || t || 3);
      if (index < 0 || m.index < index) index = m.index;
    }
    if (terms.length && (strong || BUILDISH.test(f.slice(Math.max(0, index - 100), index + 100)))) return { strong, tier, score: terms.length, index, terms };
  }
  return null;
}

/** About `n` characters of `s` around `index` (more after the match than before), on word boundaries. */
export function windowAround(s, index, n) {
  if (s.length <= n) return s;
  let start = Math.max(0, Math.min(index - Math.floor(n * 0.35), s.length - n));
  if (start > 0) {
    const sp = s.indexOf(' ', start);
    if (sp > 0 && sp - start < 20) start = sp + 1;
  }
  let end = Math.min(s.length, start + n);
  if (end < s.length) {
    const sp = s.lastIndexOf(' ', end);
    if (sp > start + n * 0.8) end = sp;
  }
  return `${start > 0 ? '…' : ''}${s.slice(start, end)}${end < s.length ? '…' : ''}`;
}

const TAGS = /<\/?(?:command-[a-z-]+|local-command-[a-z-]+|system-reminder|user-prompt-submit-hook|bash-[a-z-]+)[^>]*>/gi;
const HEX_TOKEN = /\b[a-f0-9]{24,}\b/gi;
const MIXED_TOKEN = /\b(?=\w{28,}\b)(?=\w*\d)(?=\w*[A-Z])(?=\w*[a-z])\w+\b/g;
const APP_PASSWORD = /(\b(?:password|passwd|pwd|mot de passe|mdp)\b[^.\n]{0,25}?)\b[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}\b/gi;
/** Text that hands over a credential in plain words ("here is the password …", "app password user abcde-…"). Such
 *  prompts never help spot a project idea, so they are left out whole instead of masked token by token. */
export const CREDENTIAL_TALK = /\b(?:passwords?|passwd|pwd|pass ?phrase|passcode|mot de passe|mots de passe|mdp|app[- ]password|pin code|code pin|otp|2fa code|one[- ]time code|identifiants?|credentials?|login details|secret key|private key)\b/i;

/** The user's own words: what they pasted (logs, web pages, other people's messages) reduced to a marker. */
export function ownWords(s) {
  return String(s ?? '').replace(/<pasted_content[^>]*>[\s\S]*?(?:<\/pasted_content[^>]*>|$)/gi, ' [pasted text] ');
}

/** One line of text safe to quote to the model: tags dropped, pasted blocks marked, secrets and keys masked. */
export function cleanText(s, { dropCredentials = false } = {}) {
  if (dropCredentials && CREDENTIAL_TALK.test(String(s ?? ''))) return '[left out: mentions a password]';
  let t = String(s ?? '')
    .replace(/<pasted_content[^>]*>/gi, ' [pasted] ')
    .replace(/<\/pasted_content[^>]*>/gi, ' ')
    .replace(TAGS, ' ');
  t = redact(t);
  t = t.replace(APP_PASSWORD, '$1[hidden]').replace(HEX_TOKEN, '[key]').replace(MIXED_TOKEN, '[key]');
  return oneLine(t);
}

const TITLE_FILLER = new Set(['project', 'tool', 'app', 'system', 'platform', 'module', 'service', 'hub', 'kit', 'suite', 'engine']);
const titleTokens = (s) => [...tokenSet(s)].filter((w) => !TITLE_FILLER.has(w));

/** Same proposed project? Equal normalized titles, or close titles (filler words like "tool"/"app" ignored). */
export function similarTitle(a, b) {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const A = new Set(titleTokens(a));
  const B = new Set(titleTokens(b));
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  return jaccard >= 0.5 || (inter === Math.min(A.size, B.size) && inter >= 2);
}

export const sameCandidate = (a, b) => similarTitle(a?.title, b?.title) || (!!a?.pitch && !!b?.pitch && similar(a.pitch, b.pitch));

export const candidateId = (projectPath, title) => hash(`${projectPath}\n${normText(title)}`, 12);

const GENERIC_WORDS = new Set(
  (
    'add write improve improved better more new test tests testing unit e2e integration doc docs documentation readme guide dashboard admin ' +
    'panel refactor refactoring cleanup clean code quality ci cd pipeline monitoring logging logs analytics metrics mobile app application ' +
    'version redesign ui ux performance optimization security audit deploy deployment backup backups project tool tools system platform ' +
    'module service feature features website site landing page api backend frontend automation script scripts the a an and for of'
  ).split(' '),
);

/** "Analytics dashboard", "Add tests", "Mobile app": no specific noun, so not a candidate. */
export function isGenericTitle(title) {
  const words = normText(title).split(' ').filter(Boolean);
  return !words.length || words.every((w) => GENERIC_WORDS.has(w) || w.length <= 2);
}

/** A model candidate → the stored shape, or null when it is empty or generic. */
export function cleanCandidate(c, { threads = [] } = {}) {
  if (!c || typeof c !== 'object') return null;
  const title = clip(oneLine(c.title).replace(/^["'“”«»]+|["'“”«».]+$/g, ''), 70);
  const pitch = clip(redact(oneLine(c.pitch)), 320);
  if (!title || !pitch || isGenericTitle(title)) return null;
  const k = fold(oneLine(c.kind)).replace(/[\s_]+/g, '-');
  const kind = k === 'spinoff' ? 'spin-off' : KINDS.includes(k) ? k : 'idea';
  const want = oneLine(c.threadName).toLowerCase();
  const list = (x, n, len) => (Array.isArray(x) ? x : typeof x === 'string' && x.trim() ? [x] : []).map((s) => clip(redact(oneLine(s)), len)).filter(Boolean).slice(0, n);
  return {
    kind,
    title,
    pitch,
    why: clip(redact(oneLine(c.why)), 500),
    evidence: list(c.evidence, 3, 240),
    threadName: (want && threads.find((t) => t.toLowerCase() === want)) || '',
    firstSteps: list(c.firstSteps, 3, 240),
    confidence: CONFIDENCE.includes(c.confidence) ? c.confidence : 'low',
  };
}

// ---------------------------------------------------------------- scheduling (pure)

/**
 * Should this project be scouted automatically now?
 * eligible: {ok, reason}; prev: ai.state.scout[path]; hash: current input hash (may be null when not needed);
 * sig: provider signature (a project that failed 3× with this provider and this input is left alone).
 */
export function scoutDue({ eligible, prev, hash: h = null, now = Date.now(), sig = '' }) {
  if (!eligible?.ok) return { due: false, reason: eligible?.reason || 'not eligible' };
  if (prev?.failedAt && now - prev.failedAt < FAIL_PAUSE) return { due: false, reason: 'failed less than 30 minutes ago' };
  if (prev?.failures >= 3 && prev.failHash === h && prev.failSig === sig) return { due: false, reason: 'failed 3 times on this input' };
  if (prev?.retryAt > now && prev.flakyHash === h) return { due: false, reason: 'keeps timing out; set aside for a while' };
  if (!prev?.at) return { due: true, reason: 'never scouted' };
  if (now - prev.at < RESCOUT_AFTER) return { due: false, reason: 'scouted less than 3 days ago' };
  if (prev.hash === h) return { due: false, reason: 'nothing new since the last scout' };
  return { due: true, reason: 'new activity since the last scout' };
}

// ---------------------------------------------------------------- folder signals (read-only)

const SKIP_DIRS = new Set([...SCAN_SKIP, 'node_modules', '.git', 'dist', 'build', 'vendor', 'out', 'target', 'coverage', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'site-packages', 'bower_components']);
const EDIT_SKIP = new Set(['node_modules', '.git', '__pycache__', 'site-packages', '.venv', 'venv']);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'setup.py', 'composer.json', 'pubspec.yaml', 'deno.json', 'CLAUDE.md']);
const README = /^readme(\.(md|markdown|txt|rst))?$/i;

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** First `bytes` of a small regular file inside `realRoot`, '' when sensitive, a link, outside or unreadable. */
export function readSmall(file, realRoot, bytes = 4096) {
  if (SENSITIVE.test(file)) return '';
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return '';
    const real = fs.realpathSync(file);
    if (!isInside(real, realRoot) || SENSITIVE.test(real)) return '';
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(Math.min(bytes, st.size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8').replace(/�+$/, '');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readmeSummary(text) {
  let title = '';
  const para = [];
  for (const l of String(text).split(/\r?\n/)) {
    const t = l.trim();
    if (!title && !para.length && /^#{1,3}\s+/.test(t)) {
      title = t.replace(/^#+\s+/, '');
      continue;
    }
    if (!t || /^(#|!\[|<|\||```|---|===|\[!)/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
    if (para.join(' ').length > 320) break;
  }
  return clip(cleanText(plain([title, para.join(' ')].filter(Boolean).join(': '))), 260);
}

/** name/description from a manifest's head (no full parse of big files). */
function manifestSummary(name, text) {
  if (!text) return '';
  if (name === 'package.json' || name === 'composer.json' || name === 'deno.json') {
    try {
      const j = JSON.parse(text);
      return [j.name, j.description].filter((x) => typeof x === 'string' && x).join(': ');
    } catch {
      const n = /"name"\s*:\s*"([^"]{1,80})"/.exec(text)?.[1];
      const d = /"description"\s*:\s*"([^"]{1,300})"/.exec(text)?.[1];
      return [n, d].filter(Boolean).join(': ');
    }
  }
  if (name === 'go.mod') return /^module\s+(\S+)/m.exec(text)?.[1] || '';
  if (name === 'pyproject.toml' || name === 'Cargo.toml' || name === 'pubspec.yaml') {
    const n = /^\s*name\s*[=:]\s*["']?([^"'\n]{1,80})/m.exec(text)?.[1];
    const d = /^\s*description\s*[=:]\s*["']?([^"'\n]{1,300})/m.exec(text)?.[1];
    return [n, d].filter(Boolean).join(': ').trim();
  }
  return '';
}

/**
 * Sub-folders (depth 1..maxDepth) with their own manifest, README, CLAUDE.md or .git. Skips dot-folders, links,
 * node_modules/.git/dist/build/vendor and the like, and does not descend into folders with more than maxEntries
 * entries (generated output). Returns [{dir, rel, depth, markers, summary}].
 */
export function findSubProjects(root, { maxDepth = 2, maxDirs = 400, maxEntries = 300, limit = 40 } = {}) {
  const realRoot = realOr(root);
  const out = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (visited >= maxDirs || out.length >= limit) return;
    visited++;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0) {
      const markers = ents.filter((e) => (e.isFile() && (MANIFESTS.has(e.name) || README.test(e.name))) || (e.name === '.git' && (e.isDirectory() || e.isFile()))).map((e) => e.name);
      if (markers.length) {
        const parts = [];
        for (const m of markers) {
          if (!MANIFESTS.has(m) || m === 'CLAUDE.md') continue;
          const s = manifestSummary(m, readSmall(path.join(dir, m), realRoot, 16384));
          if (s) parts.push(`${m} "${clip(cleanText(s), 200)}"`);
        }
        const readme = markers.find((m) => README.test(m));
        if (readme) {
          const s = readmeSummary(readSmall(path.join(dir, readme), realRoot, 4096));
          if (s) parts.push(`README: "${s}"`);
        }
        out.push({ dir, rel: path.relative(root, dir), depth, markers: markers.sort(), summary: parts.join('; ') });
      }
    }
    if (depth >= maxDepth || (depth > 0 && ents.length > maxEntries) || ents.length > 1500) return;
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue; // links are not directories here
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Most specific root (project folder or one of its worktrees) that holds `file`. */
function rootOf(file, roots) {
  let best = null;
  for (const r of roots) if (isInside(file, r) && file !== r && (!best || r.length > best.length)) best = r;
  return best;
}

/**
 * Edited files of these sessions inside the project, grouped by top-level folder ('' = files at the top level).
 * Returns {groups: [{top, n, files, subs: [[name, n]]}], byFile: Map(rel → n)} sorted by edits.
 */
export function editGroups(sessions, roots) {
  const byFile = new Map();
  for (const meta of sessions) {
    for (const [f, n] of Object.entries(meta.files || {})) {
      if (SENSITIVE.test(f) || !Number.isFinite(n)) continue;
      const root = rootOf(f, roots);
      if (!root) continue;
      const rel = path.relative(root, f);
      if (rel.split(path.sep).some((p) => EDIT_SKIP.has(p))) continue;
      byFile.set(rel, (byFile.get(rel) || 0) + n);
    }
  }
  const groups = new Map();
  for (const [rel, n] of byFile) {
    const parts = rel.split(path.sep);
    const top = parts.length > 1 ? parts[0] : '';
    const g = groups.get(top) || { top, n: 0, files: 0, subs: new Map() };
    g.n += n;
    g.files++;
    const sub = top ? (parts.length > 2 ? `${parts[1]}/` : parts[1]) : parts[0];
    g.subs.set(sub, (g.subs.get(sub) || 0) + n);
    groups.set(top, g);
  }
  return {
    byFile,
    groups: [...groups.values()].sort((a, b) => b.n - a.n).map((g) => ({ ...g, subs: [...g.subs].sort((a, b) => b[1] - a[1]) })),
  };
}

function capLines(lines, budget) {
  const out = [];
  let room = budget;
  for (const l of lines) {
    if (l.length > room) break;
    room -= l.length + 1;
    out.push(l);
  }
  return { lines: out, omitted: lines.length - out.length };
}

// ---------------------------------------------------------------- the AI call

export const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      description: '0-3 candidates. Empty when nothing clearly qualifies (common).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Proposed project name, 2-5 words' },
          kind: { type: 'string', enum: KINDS },
          pitch: { type: 'string', description: 'One sentence: what the new project is and who it is for' },
          why: { type: 'string', description: '1-2 sentences from the evidence: why it deserves its own project' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short facts or quotes from the input, each with its date or folder' },
          threadName: { type: 'string', description: "'' or exactly one of the listed thread names" },
          firstSteps: { type: 'array', items: { type: 'string' }, description: 'Up to 3 concrete first steps for the new project, the first one small' },
          confidence: { type: 'string', enum: CONFIDENCE },
        },
        required: ['title', 'kind', 'pitch', 'why', 'evidence', 'threadName', 'firstSteps', 'confidence'],
      },
    },
    note: { type: 'string', description: 'One sentence: what else you weighed and why you left it out ("" if nothing)' },
  },
  required: ['candidates', 'note'],
};

/** The scout's instruction; `name` is the user's name from Settings (server/profile.js). */
export const scoutInstruction = (name = userName()) => [
  `You are the project scout for ${name}, a solo developer with many projects who builds through AI coding agents like Claude Code (the assistant in their sessions).`,
  `Stdin holds the record of ONE of ${name}'s project folders: Pilotage\'s brief of it, sub-folders that look like their own project, where the edits went, summaries of work blocks, and ${name}'s own prompts (those that sound like ideas or plans are listed separately, with more context).`,
  '',
  'Find at most 3 things in it that deserve to become a separate project of their own:',
  `- "spin-off": something already built (or half built) inside this folder that could live on its own: its own code folder, its own users or buyers, useful without the rest of this project. Often a tool ${name} built along the way to do the main job.`,
  `- "idea": a project ${name} personally voiced in their prompts (a product, tool, business or app they said they could, should or want to build) and never started.`,
  '- "reusable": a piece built here that the user\'s other projects (listed near the end) would reuse as a shared tool, library or template. Name in "why" which of those projects would use it and what for; if no other project visibly needs it, leave it out.',
  '',
  'Be strict. Every candidate must be:',
  '- specific: name the actual thing, what it does and for whom; a reader must know exactly which code or which remark you mean;',
  '- grounded: cite concrete evidence from the input (a quoted prompt with its date, a folder with its edit count, a work block title with its date). No evidence, no candidate;',
  '- separable: it makes sense as its own project with its own goal and users, not as a feature of this one.',
  '',
  'Never propose: this project\'s own next steps or roadmap (its brief\'s next steps, features of the same product, the frontend/backend/API/admin of the same app, a new campaign of the same work); generic engineering work ("add tests", "make a dashboard", "improve docs", "CI pipeline", "refactor", "mobile app version", "analytics"); anything already one of the user\'s other projects; anything listed as already handled.',
  'An empty list is a normal, good answer: most folders have nothing that qualifies. One strong candidate beats three weak ones; never pad the list.',
  '',
  'Fields: title = a proposed project name, 2-5 words (a name, not a sentence; no prefix with this project\'s name). pitch = one sentence: what the new project is and who it is for. why = 1-2 sentences on why it deserves its own project, from the evidence. evidence = up to 3 short facts or quotes from the input, each with its date (YYYY-MM-DD) or folder. threadName = "" or exactly one of the listed thread names. firstSteps = up to 3 concrete first steps for the new project, the first one small. confidence: high = the separable code already exists, or the user said in their own words that it should be its own thing; medium = a clear signal with some inference; low = plausible but thin (usually better left out).',
  `note = one sentence on what else you weighed and why you left it out (shown to ${name} when the list is short or empty).`,
  'Write in English, plainly, no hype. Use only facts from the input; never invent features, users or numbers.',
].join('\n');

// ---------------------------------------------------------------- service

export class Scout {
  constructor({ ai, index, registry, store, callAI = providerCallAI, home = HOME }) {
    this.ai = ai;
    this.index = index;
    this.registry = registry;
    this.store = store;
    this.callAI = callAI;
    this.home = home;
    this.cache = new Map(); // projectPath -> {sig, at, ev}
  }

  get state() {
    if (!this.ai.state.scout || typeof this.ai.state.scout !== 'object') this.ai.state.scout = {};
    return this.ai.state.scout;
  }

  get decisions() {
    if (!this.store.data.scout || typeof this.store.data.scout !== 'object' || Array.isArray(this.store.data.scout)) this.store.data.scout = {};
    return this.store.data.scout;
  }

  projectName(p) {
    return this.store.project(p).name || this.registry.projects.get(p)?.name || path.basename(p) || p;
  }

  sessionsOf(project) {
    return (project.sessionIds || []).map((id) => this.index.get(id)).filter((s) => s && !isAutomation(s));
  }

  lastInteractiveAt(project) {
    let t = 0;
    for (const s of this.sessionsOf(project)) t = Math.max(t, s.lastHumanAt || s.lastAt || 0);
    return t;
  }

  brief(project) {
    return this.ai.state.projects?.[project.path]?.brief || null;
  }

  /** Automatic-run eligibility. */
  eligible(project, now = Date.now()) {
    if (!project || project.path === this.home) return { ok: false, reason: 'home folder' };
    const over = this.store.project(project.path);
    if (over.hidden || over.status === 'archived') return { ok: false, reason: 'hidden or archived' };
    if (!this.brief(project)) return { ok: false, reason: 'no brief yet' };
    const last = this.lastInteractiveAt(project);
    if (!last || now - last > ACTIVE_DAYS * DAY) return { ok: false, reason: `no interactive work in ${ACTIVE_DAYS} days` };
    return { ok: true, reason: '' };
  }

  failSig() {
    let base = '';
    try {
      base = this.ai.providerSig?.() || '';
    } catch {}
    return hash(`${base}:${this.ai.settings?.scoutModel || 'sonnet'}`, 12);
  }

  /** Cheap signature: changes when the project's sessions, digests or brief change. */
  sigOf(project, sessions) {
    const parts = [this.ai.state.projects?.[project.path]?.hash || '', this.ai.state.projects?.[project.path]?.at || 0];
    for (const s of sessions) {
      parts.push(`${s.id}:${s.lastAt}:${s.turnCount}:${s.offset || 0}`);
      for (const b of this.ai.blocksOf(s)) parts.push(this.ai.state.blocks?.[b.key]?.hash || '-');
    }
    return hash(parts.join('|'), 16);
  }

  /** The hashed part of the input (cached while the project's sessions and brief don't change). */
  evidence(project, { fresh = false } = {}) {
    const sessions = this.sessionsOf(project);
    const sig = this.sigOf(project, sessions);
    const c = this.cache.get(project.path);
    if (!fresh && c && c.sig === sig && Date.now() - c.at < EVIDENCE_TTL) return c.ev;
    const ev = buildEvidence({ project, sessions, ai: this.ai, index: this.index, registry: this.registry, store: this.store, name: this.projectName(project.path) });
    this.cache.set(project.path, { sig, at: Date.now(), ev });
    if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    return ev;
  }

  /** Evidence + the parts that must not trigger a re-scout: today, the user's other projects, what they already decided. */
  composeInput(project, ev, now = Date.now()) {
    const me = userName();
    const L = [`Today is ${fmtDay(now)}.`, ev.text];
    const others = [...this.registry.projects.values()]
      .filter((p) => p.path !== project.path && p.path !== this.home && !this.store.project(p.path).hidden)
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
      .map((p) => {
        const br = this.ai.state.projects?.[p.path]?.brief;
        return `- ${this.projectName(p.path)} (${tilde(p.path, this.home)})${br?.oneLiner ? `: ${clip(oneLine(br.oneLiner), 110)}` : ''}`;
      });
    const o = capLines(others, BUDGET.others);
    if (o.lines.length) L.push(`\n## ${me}'s other projects (already separate; never propose one of these)\n${o.lines.join('\n')}${o.omitted ? `\n(… ${o.omitted} older ones not listed)` : ''}`);
    const handled = Object.values(this.decisions)
      .filter((d) => d.from === project.path && d.status && d.status !== 'new')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, 15)
      .map((d) => `- "${d.title}" (${d.status === 'dismissed' ? `dismissed by ${me}` : d.status === 'saved' ? 'saved as an idea' : 'already turned into a project'})`);
    if (handled.length) L.push(`\n## Candidates already handled for this folder (never propose these again, or anything close)\n${handled.join('\n')}`);
    const decided = new Set(Object.keys(this.decisions));
    const open = (this.state[project.path]?.candidates || []).filter((c) => !decided.has(c.id) || this.decisions[c.id]?.status === 'new');
    if (open.length) L.push(`\n## Your earlier candidates for this folder, still open (keep the same title if one still holds; drop it if the evidence no longer supports it)\n${open.map((c) => `- "${c.title}" (${c.kind}): ${c.pitch}`).join('\n')}`);
    return L.join('\n');
  }

  inputFor(project, now = Date.now()) {
    const ev = this.evidence(project);
    const input = this.composeInput(project, ev, now);
    return { input, hash: ev.hash, chars: input.length, stats: ev.stats };
  }

  /** {due, reason} for an automatic run. The input hash is only computed when the cheap checks pass. */
  due(project, now = Date.now()) {
    const eligible = this.eligible(project, now);
    if (!eligible.ok) return { due: false, reason: eligible.reason };
    const prev = this.state[project.path];
    const needHash = prev && ((prev.at && now - prev.at >= RESCOUT_AFTER) || prev.failures || prev.retryAt);
    return scoutDue({ eligible, prev, hash: needHash ? this.evidence(project).hash : null, now, sig: this.failSig() });
  }

  jobId(project) {
    return `scout:${project.path}`;
  }

  job(project, { manual = false, auto = false, priority } = {}) {
    return {
      id: this.jobId(project),
      kind: 'scout',
      priority: priority ?? (manual ? 45 : 0.5 + (project.lastAt || 0) / 1e14), // below the daily brief (1)
      manual,
      auto,
      label: `Scout: ${this.projectName(project.path)}`,
      projectPath: project.path,
      run: () => this.run(project, { auto }),
    };
  }

  /** Automatic jobs for engine.tick: due projects, most recently active first, ≤ 2 per scan, ≤ AUTO_PER_DAY a day. */
  autoJobs(now = Date.now()) {
    const recent = (this.ai.state.scoutAutoLog || []).filter((t) => now - t < DAY).length;
    const waiting = (this.ai.queue || []).filter((j) => j.kind === 'scout' && j.auto).length;
    const room = Math.min(2, AUTO_PER_DAY - recent - waiting);
    if (room <= 0) return [];
    const out = [];
    const projects = [...this.registry.projects.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    for (const p of projects) {
      if (out.length >= room) break;
      const id = this.jobId(p);
      if (this.ai.queued?.has(id) || this.ai.running?.has(id)) continue;
      if (this.due(p, now).due) out.push(this.job(p, { auto: true }));
    }
    return out;
  }

  /** Manual run for one project (a manual job, like POST /api/ai/run). Returns true when it is queued. */
  queueOne(project) {
    const id = this.jobId(project);
    if (this.ai.running?.has(id)) return true;
    const waiting = (this.ai.queue || []).find((j) => j.id === id);
    if (waiting) {
      // already queued automatically: move it up and let it run like a manual job
      waiting.manual = true;
      waiting.auto = false;
      waiting.priority = 45;
      waiting.run = () => this.run(project, { auto: false });
      this.ai.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
      this.ai.pump?.();
      return true;
    }
    return !!this.ai.enqueue(this.job(project, { manual: true }));
  }

  /** "Scout all": every eligible project, whatever its last run; ordinary (guarded) jobs. Returns how many were queued. */
  queueAll(now = Date.now()) {
    let n = 0;
    const projects = [...this.registry.projects.values()].filter((p) => this.eligible(p, now).ok).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    for (const p of projects.slice(0, 40)) if (this.ai.enqueue(this.job(p, { priority: 3 + (p.lastAt || 0) / 1e14 }))) n++;
    return n;
  }

  /** The job itself: one AI call, then merge with what the user already decided. Resolves with the callAI result. */
  async run(project, { auto = false } = {}) {
    const now = Date.now();
    const ev = this.evidence(project, { fresh: true });
    const input = this.composeInput(project, ev, now);
    const prev = this.state[project.path] || {};
    this.state[project.path] = { ...prev, lastAttemptAt: now, auto };
    if (auto) {
      // Every automatic attempt counts toward the daily cap (a project that keeps failing can't multiply calls).
      const log = (this.ai.state.scoutAutoLog ||= []).filter((t) => now - t < DAY);
      log.push(now);
      this.ai.state.scoutAutoLog = log;
    }
    const r = await this.callAI({
      purpose: 'scout',
      instruction: scoutInstruction(),
      input,
      schema: SCOUT_SCHEMA,
      model: this.ai.settings?.scoutModel || 'sonnet',
      effort: 'medium',
      timeout: 300000,
    });
    const cur = this.state[project.path];
    if (!r?.ok) {
      const cls = classifyFailure(r || {});
      if (cls === 'input') {
        const sig = this.failSig();
        const same = cur.failHash === ev.hash && cur.failSig === sig;
        this.state[project.path] = { ...cur, failHash: ev.hash, failSig: sig, failures: (same ? cur.failures || 0 : 0) + 1, lastError: r?.error || 'failed', failedAt: now };
      } else if (cls === 'flaky') {
        const n = (cur.flakyHash === ev.hash ? cur.flaky || 0 : 0) + 1;
        this.state[project.path] = { ...cur, flakyHash: ev.hash, flaky: n, retryAt: n >= FLAKY_STRIKES ? now + FLAKY_BACKOFF : 0, lastError: r?.error || 'failed', failedAt: now };
      } else this.state[project.path] = { ...cur, lastError: r?.error || 'failed' }; // provider-wide: the queue pauses instead
      const e = new Error(r?.error || 'AI call failed');
      e.aiClass = cls;
      throw e;
    }
    const raw = Array.isArray(r.data?.candidates) ? r.data.candidates : [];
    const fresh = raw.map((c) => cleanCandidate(c, ev)).filter(Boolean).slice(0, 3);
    const done = Date.now();
    const candidates = this.merge(project.path, fresh, prev.candidates || [], done);
    const note = clip(redact(oneLine(r.data?.note)), 400);
    this.state[project.path] = { at: done, hash: ev.hash, model: r.model || null, auto, lastAttemptAt: now, inputChars: input.length, proposed: raw.length, note, candidates };
    return r;
  }

  /**
   * New candidates → stored ones. A candidate the user already decided on keeps that id (dismissed ones are dropped, so
   * they never come back); one close to an earlier open candidate keeps its id and first-seen date.
   */
  merge(projectPath, fresh, previous, now = Date.now()) {
    const decided = Object.entries(this.decisions)
      .filter(([, d]) => d.from === projectPath)
      .map(([id, d]) => ({ id, ...d }));
    const out = [];
    const used = new Set();
    for (const c of fresh) {
      let id = candidateId(projectPath, c.title);
      let firstAt = now;
      const dec = decided.find((d) => d.id === id) || decided.find((d) => sameCandidate(d.candidate || { title: d.title }, c));
      if (dec) {
        if (dec.status === 'dismissed') continue;
        id = dec.id;
        firstAt = dec.candidate?.firstAt || dec.at || now;
      } else {
        const old = previous.find((p) => p.id === id) || previous.find((p) => sameCandidate(p, c));
        if (old) {
          id = old.id;
          firstAt = old.firstAt || old.at || now;
        }
      }
      if (used.has(id)) continue;
      used.add(id);
      out.push({ id, ...c, firstAt, at: now });
    }
    return out;
  }

  // ------------------------------------------------------------ reads

  find(id) {
    for (const [p, e] of Object.entries(this.state)) {
      const c = (e.candidates || []).find((x) => x.id === id);
      if (c) return { c, projectPath: p, entry: e };
    }
    const d = this.decisions[id];
    if (d?.from && d.candidate) return { c: { ...d.candidate, id }, projectPath: d.from, entry: null };
    return null;
  }

  view(c, projectPath, entry) {
    const d = this.decisions[c.id];
    const reg = this.registry.projects.get(projectPath);
    return {
      id: c.id,
      projectId: hash(projectPath, 10),
      projectName: this.projectName(projectPath),
      projectPath,
      displayPath: tilde(projectPath, this.home),
      workspace: this.store.project(projectPath).workspace || reg?.workspace || null,
      registered: !!reg,
      kind: c.kind,
      title: c.title,
      pitch: c.pitch,
      why: c.why,
      evidence: c.evidence || [],
      threadName: c.threadName || '',
      firstSteps: c.firstSteps || [],
      confidence: c.confidence,
      at: c.at,
      firstAt: c.firstAt || c.at,
      model: entry?.model || null,
      current: !!entry,
      status: d?.status || 'new',
      decidedAt: d && d.status !== 'new' ? d.at : null,
      ideaId: d?.ideaId || null,
      acceptedProjectPath: d?.status === 'accepted' ? d.projectPath || null : null,
      acceptedProjectId: d?.status === 'accepted' && d.projectPath ? hash(d.projectPath, 10) : null,
    };
  }

  list({ projectId = null, includeHidden = false } = {}) {
    const out = new Map();
    for (const [p, e] of Object.entries(this.state)) for (const c of e.candidates || []) out.set(c.id, this.view(c, p, e));
    for (const [id, d] of Object.entries(this.decisions)) if (!out.has(id) && d.from && d.candidate) out.set(id, this.view({ ...d.candidate, id }, d.from, null));
    let arr = [...out.values()];
    if (projectId) arr = arr.filter((c) => c.projectId === projectId);
    else if (!includeHidden) arr = arr.filter((c) => !this.store.project(c.projectPath).hidden);
    arr.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (b.at || 0) - (a.at || 0));
    return arr;
  }

  /** One line per scouted project (also the empty ones): when, which model, how many open candidates, the model's note. */
  scouted({ projectId = null } = {}) {
    const out = [];
    for (const [p, e] of Object.entries(this.state)) {
      if (!e.at) continue;
      const id = hash(p, 10);
      if (projectId && id !== projectId) continue;
      if (!projectId && this.store.project(p).hidden) continue;
      out.push({ projectId: id, projectName: this.projectName(p), projectPath: p, at: e.at, model: e.model || null, auto: !!e.auto, candidates: (e.candidates || []).length, note: e.note || '', lastError: e.failedAt && e.failedAt > e.at ? e.lastError || null : null });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  lastRunAt() {
    let t = 0;
    for (const e of Object.values(this.state)) t = Math.max(t, e.at || 0);
    return t;
  }

  /** Projects waiting for a scout: running, queued, or due for an automatic run. */
  pending(now = Date.now()) {
    const seen = new Map();
    for (const j of this.ai.running?.values?.() || []) if (j.kind === 'scout') seen.set(j.projectPath, { state: 'running', reason: '' });
    for (const j of this.ai.queue || []) if (j.kind === 'scout' && !seen.has(j.projectPath)) seen.set(j.projectPath, { state: 'queued', reason: j.manual ? 'asked by you' : '' });
    for (const p of this.registry.projects.values()) {
      if (seen.has(p.path)) continue;
      const d = this.due(p, now);
      if (d.due) seen.set(p.path, { state: 'due', reason: d.reason });
    }
    return [...seen].map(([p, s]) => ({ projectId: hash(p, 10), projectName: this.projectName(p), projectPath: p, ...s }));
  }

  overview() {
    const open = this.list().filter((c) => c.status === 'new');
    return {
      newCount: open.length,
      top: open.slice(0, 3).map((c) => ({ id: c.id, title: c.title, pitch: c.pitch, kind: c.kind, confidence: c.confidence, projectId: c.projectId, projectName: c.projectName, at: c.at })),
      lastRunAt: this.lastRunAt(),
    };
  }

  // ------------------------------------------------------------ decisions

  snapshot(c) {
    const { kind, title, pitch, why, evidence, threadName, firstSteps, confidence, at, firstAt } = c;
    return { kind, title, pitch, why, evidence, threadName, firstSteps, confidence, at, firstAt };
  }

  /** status 'dismissed' or 'new' (undo a dismissal). Returns the view, or throws {status, message}. */
  decide(id, status, now = Date.now()) {
    const f = this.find(id);
    if (!f) throw httpError(404, 'Candidate not found');
    const prev = this.decisions[id];
    if (status === 'dismissed') {
      this.decisions[id] = { ...(prev || {}), status: 'dismissed', at: now, from: f.projectPath, title: f.c.title, candidate: this.snapshot(f.c) };
    } else if (status === 'new') {
      if (prev?.status === 'accepted') throw httpError(409, 'This candidate was already turned into a project');
      if (prev?.status === 'saved' && (this.store.data.ideas || []).some((x) => x.id === prev.ideaId)) throw httpError(409, 'This candidate is saved as an idea; delete the idea first');
      // Still proposed by the latest scout: forget the decision. Otherwise keep the snapshot so it stays listed.
      if (f.entry) delete this.decisions[id];
      else this.decisions[id] = { ...(prev || {}), status: 'new', at: now, from: f.projectPath, title: f.c.title, candidate: this.snapshot(f.c), ideaId: undefined };
    } else throw httpError(400, 'status must be "dismissed" or "new"');
    this.store.save();
    return this.view(f.c, f.projectPath, f.entry);
  }

  /** Save as a normal idea (source 'ai'). Idempotent. Returns {idea, candidate, created}. */
  save(id, now = Date.now()) {
    const f = this.find(id);
    if (!f) throw httpError(404, 'Candidate not found');
    const prev = this.decisions[id];
    if (prev?.status === 'accepted') throw httpError(409, 'This candidate was already turned into a project');
    const ideas = (this.store.data.ideas = this.store.data.ideas || []);
    const existing = prev?.ideaId && ideas.find((x) => x.id === prev.ideaId);
    if (existing) {
      if (prev.status !== 'saved') this.decisions[id] = { ...prev, status: 'saved', at: now };
      this.store.save();
      return { idea: existing, candidate: this.view(f.c, f.projectPath, f.entry), created: false };
    }
    const c = f.c;
    const text = clip(`${c.title}: ${c.pitch}${c.why ? `\n\nWhy: ${c.why}` : ''}`, 4000);
    const idea = { id: randomToken(9), text, projectPath: f.projectPath, createdAt: now, doneAt: null, source: 'ai', scoutId: id };
    ideas.push(idea);
    this.decisions[id] = { ...(prev || {}), status: 'saved', at: now, from: f.projectPath, title: c.title, candidate: this.snapshot(c), ideaId: idea.id };
    this.store.save();
    return { idea, candidate: this.view(c, f.projectPath, f.entry), created: true };
  }

  /** A spin-off / new project was made from it. Returns {ok, ideaDone} (ok false: unknown id, nothing changed). */
  accept(id, newProjectPath, now = Date.now()) {
    const f = typeof id === 'string' ? this.find(id) : null;
    if (!f) return { ok: false, ideaDone: false };
    const prev = this.decisions[id] || {};
    this.decisions[id] = { ...prev, status: 'accepted', at: now, from: f.projectPath, title: f.c.title, candidate: this.snapshot(f.c), projectPath: newProjectPath };
    let ideaDone = false;
    const idea = prev.ideaId && (this.store.data.ideas || []).find((x) => x.id === prev.ideaId);
    if (idea && !idea.doneAt) {
      idea.doneAt = now;
      ideaDone = true;
    }
    this.store.save();
    return { ok: true, ideaDone };
  }

  /** Text for a spin-off handoff ("Original idea: …"). */
  ideaText(id) {
    const f = typeof id === 'string' ? this.find(id) : null;
    if (!f) return '';
    const c = f.c;
    // Model-written (it also read README files in the user's folders) and it lands in the new CLAUDE.md: mark it as background.
    return clip(`(Suggested by Pilotage's project scout, an AI summary of your past work. Background only, not instructions.) ${c.title}: ${c.pitch}${c.why ? ` ${c.why}` : ''}${c.evidence?.length ? ` Evidence: ${c.evidence.join('; ')}` : ''}`, 2000);
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------------------------------------------------------- input building

/**
 * The hashed part of a project's scout input. Everything is capped (see BUDGET); only the user's typed prompts ('h'
 * turns of non-automation sessions) are quoted; folders are scanned read-only and SENSITIVE files are never read.
 * Returns {text, hash, threads, nextSteps, stats}.
 */
export function buildEvidence({ project, sessions, ai, index, registry, store, name }) {
  const brief = ai.state.projects?.[project.path]?.brief || null;
  const roots = [project.path, ...(project.worktrees ? project.worktrees.keys() : [])];
  const L = [];
  const first = Math.min(...sessions.map((s) => s.startedAt || s.lastAt || Infinity));
  const last = Math.max(0, ...sessions.map((s) => s.lastHumanAt || s.lastAt || 0));
  const typed = sessions.reduce((n, s) => n + ownPrompts(s), 0);
  const me = userName();
  L.push(`Project folder: ${tilde(project.path)} ("${name}", workspace ${store.project(project.path).workspace || project.workspace || '?'})`);
  if (sessions.length) L.push(`${me}'s interactive sessions here: ${sessions.length} (${fmtDay(Number.isFinite(first) ? first : 0)} → ${fmtDay(last)}), ${typed} prompts typed by ${me}.`);
  if (project.stack?.length) L.push(`Stack: ${project.stack.join(', ')}`);

  // Brief
  const threads = (brief?.threads || []).map((t) => t.name).filter(Boolean);
  const nextSteps = brief?.nextSteps || [];
  if (brief) {
    L.push('\n## Brief (Pilotage\'s summary of this folder)');
    if (brief.oneLiner) L.push(`What it is: ${clip(oneLine(brief.oneLiner), 200)}`);
    if (brief.description) L.push(`Description: ${clip(oneLine(brief.description), 900)}`);
    if (brief.currentState) L.push(`Now: ${clip(oneLine(brief.currentState), 500)}`);
    if (nextSteps.length) L.push(`Its own next steps (this project's roadmap, not candidates):\n${nextSteps.slice(0, 6).map((s) => `- ${clip(oneLine(s), 200)}`).join('\n')}`);
    if (threads.length) L.push(`Threads (threadName must be "" or one of these exact names):\n${(brief.threads || []).slice(0, 10).map((t) => `- ${t.name} (${t.status}): ${clip(oneLine(t.summary), 200)}`).join('\n')}`);
  }

  // Edits by folder (also used for the sub-projects' edit counts)
  const { groups, byFile } = editGroups(sessions, roots);

  // Sub-folders that look like their own project
  const subs = findSubProjects(project.path);
  const editsUnder = (rel) => {
    let n = 0;
    for (const [f, k] of byFile) if (f === rel || f.startsWith(`${rel}${path.sep}`)) n += k;
    return n;
  };
  // Real manifests and README.md first; a folder with only a README.txt is usually a batch of output, not a project.
  const weight = (s) => (s.markers.some((m) => MANIFESTS.has(m) && m !== 'CLAUDE.md') || s.markers.includes('.git') ? 2 : s.markers.some((m) => m === 'CLAUDE.md' || /\.md$|^readme$/i.test(m)) ? 1 : 0);
  const subLines = subs
    .map((s) => ({ ...s, edits: editsUnder(s.rel), own: registry.projects.get(s.dir), w: weight(s) }))
    .sort((a, b) => b.edits - a.edits || b.w - a.w || a.depth - b.depth || a.rel.localeCompare(b.rel))
    .map((s) => `- ${s.rel}/ [${s.markers.join(', ')}]${s.own ? ` (already its own Pilotage project "${store.project(s.dir).name || s.own.name}"; not a candidate)` : ''}${s.summary ? ` ${s.summary}` : ''}${s.edits ? `; ${s.edits} edits in ${me}'s sessions` : ''}`);
  const sl = capLines(subLines, BUDGET.subprojects);
  if (sl.lines.length) L.push(`\n## Sub-folders that look like their own project (own manifest, README or CLAUDE.md, depth ≤ 2)\n${sl.lines.join('\n')}${sl.omitted ? `\n(… ${sl.omitted} more)` : ''}`);

  const editLines = groups.map((g) => {
    const top = g.subs.slice(0, 4).map(([s, n]) => `${s} (${n})`).join(', ');
    return g.top ? `- ${g.top}/ — ${g.n} edits to ${g.files} files; most in ${top}` : `- top-level files — ${g.n} edits: ${top}`;
  });
  const el = capLines(editLines, BUDGET.edits);
  if (el.lines.length) L.push(`\n## Where the edits went (files edited in ${me}'s sessions, by folder)\n${el.lines.join('\n')}${el.omitted ? `\n(… ${el.omitted} smaller folders)` : ''}`);

  // Work blocks, newest first
  const items = [];
  for (const meta of sessions) for (const b of ai.blocksOf(meta)) items.push({ meta, b, d: ai.state.blocks?.[b.key]?.digest || null });
  items.sort((a, b) => (a.b.startAt || 0) - (b.b.startAt || 0));
  const range = (b) => {
    const a = fmtDay(b.startAt);
    const e = fmtDay(b.endAt);
    return a === e ? a : `${a} → ${e.slice(5)}`;
  };
  const untitled = ({ meta, b }, n) => `- [${range(b)}] (not summarized) ${clip(cleanText(ai.blockView ? ai.blockView(meta, b).fallbackTitle : ''), n)}`;
  const kept = fitNewestFirst(items, {
    full: (x) => (x.d ? `- [${range(x.b)}] ${x.d.title} — ${clip(oneLine(x.d.summary), 320)} (${x.d.status}; topic: ${x.d.topic})` : untitled(x, 140)),
    short: (x) => (x.d ? `- [${range(x.b)}] ${x.d.title} (${x.d.topic})` : untitled(x, 70)),
    fullBudget: BUDGET.blocksFull,
    shortBudget: BUDGET.blocksShort,
  }).reverse();
  if (kept.length) L.push(`\n## Work blocks (summaries of stretches of work), newest first${items.length > kept.length ? ` (the ${items.length - kept.length} oldest not listed)` : ''}\n${kept.map((k) => k.line).join('\n')}`);

  // The user's prompts: newest first, deduped
  const all = [];
  for (const meta of sessions) {
    const turns = index.loadTurns(meta.id) || [];
    for (const t of turns) {
      if (t.o !== 'h' || !t.p) continue;
      all.push({ t: t.t || meta.startedAt || 0, raw: t.p, a: t.a || '' });
    }
  }
  all.sort((a, b) => b.t - a.t);
  const seen = new Set();
  const prompts = [];
  for (const x of all) {
    const text = cleanText(ownWords(x.raw), { dropCredentials: true });
    if (text.length < 12 || (text.startsWith('/') && text.length < 60)) continue;
    const key = normText(text).slice(0, 100);
    if (key.length < 8 || seen.has(key)) continue;
    seen.add(key);
    prompts.push({ t: x.t, text, a: x.a });
  }
  const hits = [];
  for (const x of prompts) {
    const h = ideaHit(x.text);
    if (h) hits.push({ x, h });
  }
  const order = [1, 2, 3].flatMap((tier) => hits.filter((y) => y.h.tier === tier)); // each tier newest first
  const ideaKept = [];
  let room = BUDGET.ideas;
  let weak = 0;
  for (const { x, h } of order) {
    if (!h.strong && weak >= BUDGET.ideaWeakMax) break;
    const reply = x.a ? ` → Claude replied: "${clip(cleanText(x.a, { dropCredentials: true }), 160)}"` : '';
    const line = `- [${fmtDay(x.t)}] "${windowAround(x.text, h.index, BUDGET.ideaChars)}"${reply}`;
    if (line.length + 1 > room) {
      if (room < 250) break;
      continue;
    }
    room -= line.length + 1;
    if (!h.strong) weak++;
    ideaKept.push({ x, line });
  }
  ideaKept.sort((a, b) => b.x.t - a.x.t);
  if (ideaKept.length) L.push(`\n## ${me}'s prompts that sound like an idea or a plan (newest first, with context)\n${ideaKept.map((k) => k.line).join('\n')}`);
  const inIdeas = new Set(ideaKept.map((k) => k.x));
  const rest = prompts.filter((x) => !inIdeas.has(x)).map((x) => `- [${fmtDay(x.t)}] ${clip(x.text, BUDGET.promptChars)}`);
  const pl = capLines(rest, BUDGET.prompts);
  if (pl.lines.length) L.push(`\n## ${me}'s other prompts, newest first (each cut to ${BUDGET.promptChars} characters)\n${pl.lines.join('\n')}${pl.omitted ? `\n(… ${pl.omitted} older prompts not listed)` : ''}`);

  const text = clip(L.join('\n'), BUDGET.evidence);
  return {
    text,
    hash: hash(text, 20),
    threads,
    nextSteps,
    stats: { sessions: sessions.length, prompts: prompts.length, promptsShown: pl.lines.length, ideaPrompts: ideaKept.length, ideaHits: hits.length, blocks: items.length, blocksShown: kept.length, subprojects: subs.length, editGroups: groups.length, chars: text.length },
  };
}
