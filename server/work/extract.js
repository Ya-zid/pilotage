// Zero-click task extraction: turns AI digests (work blocks) and project briefs into work items.
// Deterministic and cheap: no AI calls, only the summaries the engine already wrote.
//
// Rules
// - Per session, only the LATEST digested block counts. If it is in_progress / blocked / ongoing and has a nextStep,
//   that next step is an open loop (source key `blk:<blockKey>`). Only sessions active in the last LOOP_DAYS make
//   new items; older loops still count as evidence.
// - The top BRIEF_TOP project brief nextSteps are open loops (source key `brf:<projectHash>:<textHash>`).
// - Titles: the AI's short to-do (digest.todo, brief.todos[i]) when there is one, else toTitle() of the step. The
//   detail is the Claude-facing step itself. "waiting" steps (blocked on someone else) never make new items.
// - Dedupe across a project and its parent/child folders: a candidate whose title (or step text) matches an existing
//   item (normalized text, or ≥60% shared words) attaches its key to that item instead of creating a new one. Keys
//   are stable, so an item keeps its id.
// - At most MAX_OPEN_SUGGESTIONS untouched suggestions per project: older ones expire (restorable).
// - New items land in 'inbox' (shown as Suggested). Only the user moves things to To do (v3, docs/SIMPLIFY.md §1).
// - Evidence for an item = the newest signal among its keys: open (still a candidate), done (session's latest
//   digest says done), abandoned, superseded (a newer block in that session moved on), removed (the brief was
//   rewritten without it), stale (project idle > 45 days or marked done/archived). Ties go to "open".
//   A brief step that is still listed, just below the top 3, keeps its item but never reopens one; "removed" doesn't
//   beat a session loop that is still open and less than a week old.
// - Status changes only for AI-managed items that the user has not edited. user/idea items are never touched. A title
//   the cleanup pass shortened (titleBy 'short', work/retitle.js) is never replaced by a re-digest's longer wording.
//   Everything else only gets `aiStatus` (a hint the UI can show: "AI thinks this is done"), except the closing
//   evidence the user already overruled by restoring an AI-closed card.
// - A new session loop never hides inside a task the user closed as done before it (recurring work: deploy again,
//   rerun the tests): it becomes a new item. Loops matching a task they dropped still attach to it, so it stays gone.
import { hash, oneLine, clip } from '../util.js';
import { HOME, WIN_HOME } from '../config.js';
import { OPEN_STATUSES, AI_KINDS, MAX_TOMBSTONES, normalizeItem } from './store.js';
import { userName, nameRxSource } from '../profile.js';

const DAY = 86400e3;
export const STALE_DAYS = 45; // a project this quiet: its open items go stale
export const LOOP_DAYS = 10; // a session's next step makes a new suggestion only while the session is this recent
export const MAX_OPEN_SUGGESTIONS = 3; // per project; a 4th expires the oldest
export const TODO_MAX = 60; // a task title from the AI's short to-do
const OPEN_DIGEST = new Set(['in_progress', 'blocked', 'ongoing']);
const BRIEF_TOP = 2;
const LOOP_TRUST = 7 * DAY; // a session loop this recent outweighs a brief that dropped the step
const GIT_HYGIENE = /\b(?:worktrees?|uncommitted|unpushed|stash(?:es)?)\b|\bcommit (?:it|them|or discard)|\bpush (?:the|your|those) commits\b/i;
const PRUNE_CLOSED_AFTER = 150 * DAY;

// ---------------------------------------------------------------- text helpers

export function normText(s) {
  return oneLine(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOP = new Set(
  'the a an and or to of for in on at by with from into onto is are be been was were this that these those it its his her their them they she claude then next step steps up out off as so if not no any all some via per about after before again also once still'.split(
    ' ',
  ),
);

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// The user's name (Settings → Your name) is a stop word too, and a subject toTitle() strips. Cached per name.
let who = { name: null, words: new Set(), subj: '', third: '' };
function whoNow() {
  const name = userName();
  if (who.name !== name) {
    const first = name.split(' ')[0];
    const alts = [...new Set([name, first].filter(Boolean))].map(nameRxSource);
    who = {
      name,
      words: new Set(normText(name).split(' ').filter(Boolean)),
      subj: [...alts, 'the user', 'he', 'she', 'they', 'you'].join('|'), // "X: …", "X needs to …"
      third: [...alts, 'the user', 'he', 'she'].join('|'), // "X revokes …" → "Revoke …"
    };
  }
  return who;
}

export function tokenSet(s) {
  const mine = whoNow().words;
  return new Set(
    normText(s)
      .split(' ')
      .filter((w) => w.length > 2 && !STOP.has(w) && !mine.has(w))
      .map(stem),
  );
}

/**
 * Same task? Exact normalized match, or enough shared content words. `loose` (used between a brief step and a
 * session loop, which restate the same thing in different words) also accepts 4+ shared words covering 60%.
 */
export function similar(a, b, { loose = false } = {}) {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size < 3 || B.size < 3) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const contain = inter / Math.min(A.size, B.size);
  return jaccard >= 0.6 || (contain >= 0.85 && Math.min(A.size, B.size) >= 4) || (loose && inter >= 4 && contain >= 0.6);
}

const ABBR = /\b(?:dr|mr|mrs|ms|st|vs|e\.g|i\.e|etc|no|approx|cf|fig|p)$/i;

/** First sentence / clause of a next-step text (split on ';' and sentence ends, not on "Dr." or "v2.1"). */
export function firstClause(s) {
  const t = oneLine(s);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === ';') return t.slice(0, i).trim();
    if ((c === '.' || c === '!' || c === '?') && (i === t.length - 1 || /\s/.test(t[i + 1]))) {
      const before = t.slice(0, i);
      if (c === '.' && ABBR.test(before)) continue;
      const rest = t.slice(i + 1).trimStart();
      if (!rest || /^[A-Z0-9"“'(]/.test(rest)) return t.slice(0, i).trim();
    }
  }
  return t.trim();
}

function deconjugate(verb) {
  const v = verb.toLowerCase();
  const special = { goes: 'go', does: 'do', has: 'have' };
  if (special[v]) return special[v];
  if (/[^aeiou]ies$/.test(v)) return v.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x|z|o)es$/.test(v)) return v.slice(0, -2);
  if (/s$/.test(v) && !/(ss|us|is)$/.test(v)) return v.slice(0, -1);
  return null;
}

const NO_CUT_AFTER_COMMA = /^(?:or|which|who|whom|where|that|e\.g|i\.e|including|such|like|plus|\d)/i;

// A reason or condition tacked on after the action: "Rotate the keys since the old ones leaked" → "Rotate the keys".
const TAIL_CLAUSE = /,?\s+(?:since|because|so that|now that|as soon as|before|after|once|until|unless)\s/i;

/** Shorten a long clause at ", then" / a reason or condition / ", and" / the first comma that starts a new action. */
function cutLongClause(t, soft = 72) {
  const then = /,?\s+(?:and\s+)?then\s+/i.exec(t);
  if (then && then.index >= 20) t = t.slice(0, then.index);
  const tail = TAIL_CLAUSE.exec(t.slice(20));
  if (tail) t = t.slice(0, 20 + tail.index);
  if (t.length <= soft) return t;
  // "Before running X, check Y": the action is after the first comma, so never cut there.
  let skip = /^(?:before|after|if|when|once|while|until|unless|as soon as|since|because|to|for|in|on|with)\b/i.test(t) ? 1 : 0;
  const rx = /,\s+/g;
  let m;
  while ((m = rx.exec(t))) {
    if (skip > 0) {
      skip--;
      continue;
    }
    if (m.index < 25) continue;
    const rest = t.slice(m.index + m[0].length);
    if (NO_CUT_AFTER_COMMA.test(rest)) continue;
    if (/^[\w'’-]+(?:\s+[\w'’-]+){0,2}\s+(?:or|and)\s/i.test(rest)) continue; // a short list: "stop, extend or rework
    return t.slice(0, m.index);
  }
  return t;
}

/** "Sam to decide whether X; then Y." → "Decide whether X" (Sam = the user's name). Short imperative title for a task. */
export function toTitle(text, max = 96) {
  const TIME_PREFIX = /^(?:do\s+)?(?:today|tonight|tomorrow|now|first|asap|urgent(?:ly)?)\s*[:,–—-]\s*/i;
  let t = oneLine(text).replace(/^[-*•\s]+/, '');
  t = t.replace(/^(?:next(?:\s+steps?)?|todo|then|action)\s*[:\-–—]\s*/i, '').replace(TIME_PREFIX, '');
  t = firstClause(t);
  let m;
  const { subj, third } = whoNow();
  if ((m = new RegExp(`^(?:${subj})\\s*[:,–—-]\\s*`, 'i').exec(t))) t = t.slice(m[0].length);
  else if ((m = new RegExp(`^(?:${subj})\\s+(?:(?:still\\s+)?(?:needs?|has|have|wants?|plans?|should|must|will|can|could|may|might|would|is going|is expected|is due|are going|are expected|are due)(?:\\s+to)?|to)\\s+`, 'i').exec(t))) t = t.slice(m[0].length);
  else if ((m = new RegExp(`^(?:${third})\\s+([a-z]+)\\b`, 'i').exec(t))) {
    const base = deconjugate(m[1]);
    if (base) t = base + t.slice(m[0].length);
  }
  t = t.replace(TIME_PREFIX, '');
  // "Only after the cause is clear, propose a patch" → "propose a patch": the condition is not the task.
  t = t.replace(/^(?:before|after|once|only after|only once|when)\b[^,]{0,60},\s*/i, '');
  // Parentheticals go before any comma cut so "(a, b)" never gets split in half.
  t = t.replace(/\s*\([^()]{0,160}\)/g, '').replace(/\s*\([^()]*$/, '').replace(/\s{2,}/g, ' ');
  t = cutLongClause(t);
  t = t.replace(/[\s.;:,–—-]+$/, '').trim();
  if (t.length > max) {
    const cut = t.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    t = `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
  }
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** The task title: the AI's short to-do when it wrote one, else a shortened next step (older summaries). */
export function shortTitle(todo, step) {
  const t = oneLine(todo).replace(/[\s.;:,–—-]+$/, '');
  if (t) return clip(t[0].toUpperCase() + t.slice(1), TODO_MAX);
  return toTitle(step);
}
const WHO = new Set(['you', 'claude', 'waiting']);
const whoOf = (w) => (WHO.has(w) ? w : null);

/** The step text an item was made from: its detail without the "From: …" recap older versions appended. */
export const stepText = (detail) => String(detail || '').split(/\n\s*\n/)[0].trim();

/** Same folder, or one inside the other (a repo and its subfolder are often separate projects about the same work). */
/**
 * The same project, or one inside the other. A workspace base (the home folder, Windows' profile) is nobody's parent:
 * running claude once in ~ makes a "Home folder" project, which would otherwise swallow every project's suggestions
 * and, once a suggestion there is deleted, hide look-alikes everywhere.
 */
export const relatedPaths = (a, b, bases = []) => {
  if (!a || !b) return false;
  if (a === b) return true;
  if (bases.includes(a) || bases.includes(b)) return false;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

const blockIndex = (key) => Number(String(key).split(':').pop()) || 0;
const projectHash = (p) => hash(p, 10);
const stepHash = (step) => hash(normText(step), 10);

// ---------------------------------------------------------------- inputs

/**
 * input = {
 *   blocks: ai.state.blocks              // key -> {sessionId, projectPath, startAt, endAt, digest}
 *   briefs: ai.state.projects            // projectPath -> {at, brief: {nextSteps: []}}
 *   projectOfSession(sessionId, fallbackPath) -> path | null
 *   project(path) -> {lastActivityAt, hidden, closed} | null
 *   sessionHidden(sessionId) -> bool
 *   launchSession(launchId) -> sessionId | null
 * }
 */
function buildIndex(input) {
  const bySession = new Map();
  for (const [key, b] of Object.entries(input.blocks || {})) {
    if (!b?.digest || !b.sessionId) continue;
    const arr = bySession.get(b.sessionId) || [];
    arr.push({ key, ...b });
    bySession.set(b.sessionId, arr);
  }
  const latest = new Map(); // sessionId -> latest digested block
  const projectOf = new Map(); // sessionId -> project path
  const projectLatest = new Map(); // project path -> latest block key
  const projectLastBlockAt = new Map();
  for (const [sid, arr] of bySession) {
    arr.sort((a, b) => (a.startAt || 0) - (b.startAt || 0) || blockIndex(a.key) - blockIndex(b.key));
    const L = arr[arr.length - 1];
    latest.set(sid, L);
    const p = input.projectOfSession ? input.projectOfSession(sid, L.projectPath) : L.projectPath;
    if (!p) continue;
    projectOf.set(sid, p);
    if (input.sessionHidden && input.sessionHidden(sid)) continue;
    for (const b of arr) {
      if ((b.endAt || 0) > (projectLastBlockAt.get(p) || 0)) {
        projectLastBlockAt.set(p, b.endAt || 0);
        projectLatest.set(p, b.key);
      }
    }
  }
  const briefByHash = new Map();
  const briefSteps = new Map(); // projectPath -> text hashes of every step the brief lists (not only the top 3)
  for (const [p, entry] of Object.entries(input.briefs || {})) {
    briefByHash.set(projectHash(p), p);
    briefSteps.set(p, new Set((entry?.brief?.nextSteps || []).map(stepHash)));
  }
  return { bySession, latest, projectOf, projectLatest, projectLastBlockAt, briefByHash, briefSteps };
}

function projectState(input, ix, p, now) {
  const info = (input.project && input.project(p)) || {};
  const activity = Math.max(info.lastActivityAt || 0, ix.projectLastBlockAt.get(p) || 0);
  return { hidden: !!info.hidden, closed: !!info.closed, activity, idle: now - activity > STALE_DAYS * DAY };
}

/** Open loops as of now. `create: false` candidates still count as evidence but never make new items. */
export function deriveCandidates(input, ix, now = Date.now()) {
  const out = [];
  for (const [sid, L] of ix.latest) {
    const d = L.digest;
    if (!OPEN_DIGEST.has(d.status) || !oneLine(d.nextStep)) continue;
    const p = ix.projectOf.get(sid);
    if (!p) continue;
    const ps = projectState(input, ix, p, now);
    const title = shortTitle(d.todo, d.nextStep);
    if (!title) continue;
    const isLatest = ix.projectLatest.get(p) === L.key;
    const at = L.endAt || L.startAt || 0;
    const tooOld = now - at > LOOP_DAYS * DAY;
    const who = whoOf(d.who);
    out.push({
      key: `blk:${L.key}`,
      projectPath: p,
      title,
      detail: oneLine(d.nextStep), // what a Claude session needs (shown on tap; the Start prompt)
      at,
      bucket: 'inbox', // v3: AI finds suggestions; only the user moves things to To do (SIMPLIFY §1)
      priority: d.status === 'blocked' || isLatest ? 2 : 1,
      source: { kind: 'ai', sessionId: sid, blockKey: L.key },
      digestStatus: d.status,
      who,
      create: !ps.hidden && !ps.closed && !tooOld && who !== 'waiting' && !(input.sessionHidden && input.sessionHidden(sid)),
    });
  }
  for (const [p, entry] of Object.entries(input.briefs || {})) {
    // Top steps only (the brief lists them most important first), minus git hygiene that Pilotage already shows as
    // signals. The index into nextSteps is kept: todos[i] / whos[i] run parallel to it.
    const b = entry?.brief || {};
    const steps = (b.nextSteps || [])
      .map((step, i) => ({ step, i }))
      .filter(({ step }) => !GIT_HYGIENE.test(step))
      .slice(0, BRIEF_TOP);
    if (!steps.length) continue;
    const ps = projectState(input, ix, p, now);
    steps.forEach(({ step, i }, rank) => {
      const title = shortTitle(b.todos?.[i], step);
      if (!title) return;
      const who = whoOf(b.whos?.[i]);
      out.push({
        key: `brf:${projectHash(p)}:${stepHash(step)}`,
        projectPath: p,
        title,
        detail: oneLine(step),
        at: entry.at || 0,
        bucket: 'inbox',
        priority: rank === 0 ? 2 : 1,
        source: { kind: 'brief', step: i },
        who,
        create: !ps.hidden && !ps.closed && !ps.idle && who !== 'waiting',
      });
    });
  }
  // Session loops before brief steps (sessions are the primary evidence; a brief step that restates one attaches to it),
  // then newest first, so the freshest phrasing becomes the item and older duplicates attach to it.
  const kindRank = (c) => (c.key.startsWith('blk:') ? 0 : 1);
  out.sort((a, b) => kindRank(a) - kindRank(b) || b.at - a.at || (a.key < b.key ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------- evidence

function digestState(status) {
  if (status === 'done') return 'done';
  if (status === 'abandoned') return 'abandoned';
  return 'open';
}

function evidenceFor(item, input, ix, current, stats, now = Date.now()) {
  const evs = [];
  for (const k of item.keys) {
    const c = current.get(k);
    if (c) {
      evs.push({ state: 'open', at: c.at });
      continue;
    }
    if (k.startsWith('blk:')) {
      const blockKey = k.slice(4);
      const b = input.blocks?.[blockKey];
      const sid = b?.sessionId || blockKey.slice(0, blockKey.lastIndexOf(':'));
      const L = ix.latest.get(sid);
      if (!L) continue;
      const at = L.endAt || 0;
      if (L.key === blockKey) evs.push({ state: digestState(L.digest.status), at });
      else {
        const st = digestState(L.digest.status);
        evs.push({ state: st === 'open' ? 'superseded' : st, at });
      }
    } else if (k.startsWith('brf:')) {
      const [, ph, th] = k.split(':');
      const p = ix.briefByHash.get(ph);
      const entry = p ? input.briefs[p] : null;
      if (!entry?.brief) continue;
      // Only "removed" when the brief no longer lists the step at all. A rewrite that just reordered or added steps
      // above it is a weak "open": it keeps the item where it is but never reopens a closed one.
      if (ix.briefSteps.get(p)?.has(th)) evs.push({ state: 'open', at: entry.at || 0, listed: true });
      else evs.push({ state: 'removed', at: entry.at || 0 });
    }
  }
  // Sessions started from this item ("Start" button): their latest digest counts too.
  for (const l of item.launches || []) {
    const sid = l.sessionId || (input.launchSession && input.launchSession(l.launchId, l)) || null;
    if (!sid) continue;
    if (l.sessionId !== sid) {
      l.sessionId = sid;
      if (stats) stats.changed = true;
    }
    const L = ix.latest.get(sid);
    if (!L || (L.endAt || 0) < (l.at || 0)) continue;
    evs.push({ state: digestState(L.digest.status), at: L.endAt || 0 });
  }
  if (!evs.length) return null;
  // Open unless something closed it after the newest "still open" signal (ties stay open). When closed, the
  // strongest closing signal wins: done > abandoned > superseded / removed. A brief rewrite that dropped the step
  // doesn't close a loop a session reported open this week (briefs always postdate digests, so it would always win);
  // sessions often just stop "in progress", so after that the brief's judgment counts again.
  const opens = evs.filter((e) => e.state === 'open');
  const openAt = Math.max(-Infinity, ...opens.map((e) => e.at));
  const loopOpen = item.keys.some((k) => k.startsWith('blk:') && current.has(k) && now - current.get(k).at <= LOOP_TRUST);
  const closers = evs.filter((e) => e.state !== 'open' && e.at > openAt && !(e.state === 'removed' && loopOpen));
  if (!closers.length) return { state: 'open', at: openAt, weak: opens.every((e) => e.listed) };
  const rank = { done: 3, abandoned: 2, superseded: 1, removed: 0 };
  closers.sort((a, b) => rank[b.state] - rank[a.state] || b.at - a.at);
  return closers[0];
}

// ---------------------------------------------------------------- reconcile

function isTombstoned(data, c, bases = []) {
  for (const t of data.tombstones || []) {
    if (t.keys?.includes(c.key)) return true;
    if (t.title && relatedPaths(t.projectPath, c.projectPath, bases) && similar(t.title, c.title)) return true; // key-only ones match by key
  }
  return false;
}

/**
 * Bring data.items in line with the AI state. Mutates `data`; returns stats (stats.changed tells whether to save).
 */
export function reconcile(data, input, now = Date.now()) {
  const bases = input.bases || [];
  const stats = { created: 0, attached: 0, refreshed: 0, closed: 0, dropped: 0, reopened: 0, expired: 0, pruned: 0, hints: 0, changed: false, candidates: 0 };
  data.items = (data.items || []).map((it) => (it.keys && it.launches ? it : normalizeItem(it)));
  const ix = buildIndex(input);
  const cands = deriveCandidates(input, ix, now);
  stats.candidates = cands.length;
  const byKey = new Map();
  for (const it of data.items) for (const k of it.keys) byKey.set(k, it);
  const current = new Map();
  for (const c of cands) {
    current.set(c.key, c);
    let item = byKey.get(c.key);
    if (item) {
      // Same source, maybe re-digested with new wording: refresh unless the user took ownership. A title the cleanup
      // pass shortened stays while the step is the same work (a re-digest of an old block would bring the long
      // wording back); a different next step (the detail is what Start sends) takes the new title.
      if (!item.userEdited && item.keys[0] === c.key && AI_KINDS.has(item.source.kind)) {
        const keepShort = item.titleBy === 'short' && (item.detail === c.detail || similar(stepText(item.detail), stepText(c.detail), { loose: true }));
        const title = keepShort ? item.title : c.title;
        const who = c.who || item.who || null;
        if (item.titleBy === 'short' && !keepShort) {
          item.titleBy = null;
          stats.changed = true;
        }
        if (item.title !== title || item.detail !== c.detail || item.who !== who) {
          item.title = title;
          item.detail = c.detail;
          item.who = who;
          item.updatedAt = now;
          stats.refreshed++;
          stats.changed = true;
        }
      }
    } else {
      if (isTombstoned(data, c, bases)) continue;
      const loose = (it) => (it.source.kind === 'brief') !== c.key.startsWith('brf:') || it.source.kind === 'user' || it.source.kind === 'idea';
      // The same title, or the same step in other words (the detail is the step text the title was made from).
      const same = (it) => relatedPaths(it.projectPath, c.projectPath, bases) && (similar(it.title, c.title, { loose: loose(it) }) || similar(stepText(it.detail), c.detail));
      // A session loop newer than the moment the user marked a lookalike task done is new work (deploy again, rerun):
      // attaching it there would hide it, since closed cards show no AI hint. AI-closed items can still take it (the
      // evidence reopens them), and so can dropped ones, so a loop the user threw away doesn't come back.
      // A finished task doesn't swallow newer session work (recurring work), and an expired suggestion doesn't swallow new
      // work either: it expired from neglect, not because the user said no.
      const takes = (it) => it.closedBy !== 'expired' && !(it.status === 'done' && it.closedBy !== 'ai' && c.key.startsWith('blk:') && c.at > (it.doneAt || 0));
      item = data.items.find((it) => OPEN_STATUSES.has(it.status) && same(it)) || data.items.find((it) => !OPEN_STATUSES.has(it.status) && takes(it) && same(it));
      if (item) {
        item.keys.push(c.key);
        stats.attached++;
      } else {
        if (!c.create) continue;
        item = normalizeItem({
          id: `ai_${hash(c.key, 10)}`,
          projectPath: c.projectPath,
          title: c.title,
          detail: c.detail,
          status: c.bucket,
          priority: c.priority,
          source: c.source,
          createdAt: now,
          updatedAt: now,
          userEdited: false,
          aiStatus: 'open',
          keys: [c.key],
          sourceAt: c.at,
          aiBucket: c.bucket,
          who: c.who,
        });
        if (data.items.some((x) => x.id === item.id)) item.id = `ai_${hash(`${c.key}:${now}`, 10)}`;
        data.items.push(item);
        stats.created++;
      }
      byKey.set(c.key, item);
      stats.changed = true;
    }
    if (c.at > (item.sourceAt || 0)) {
      item.sourceAt = c.at;
      stats.changed = true;
    }
  }

  for (const item of data.items) {
    let ev = evidenceFor(item, input, ix, current, stats, now);
    if (!ev && AI_KINDS.has(item.source.kind) && OPEN_STATUSES.has(item.status)) ev = { state: 'open', at: item.sourceAt || 0, implicit: true };
    if (!ev) continue;
    if (ev.weak && !OPEN_STATUSES.has(item.status)) continue; // only listed lower in the brief: never brings a card back
    let state = ev.state;
    // The user restored a card the AI had closed: the evidence it closed on (or older) is overruled, not a hint any more.
    if (state !== 'open' && item.userEdited && OPEN_STATUSES.has(item.status) && item.closedEvidenceAt && (ev.at || 0) <= item.closedEvidenceAt) state = 'open';
    if (state === 'open') {
      const ps = projectState(input, ix, item.projectPath, now);
      if (ps.closed || (now - (item.sourceAt || item.createdAt || 0) > STALE_DAYS * DAY && ps.idle)) state = 'stale';
    }
    // A stale-dropped item only comes back with newer evidence, not just because the project woke up again.
    if (state === 'open' && item.closedBy === 'ai' && item.aiStatus === 'stale' && !OPEN_STATUSES.has(item.status) && (ev.at || 0) <= (item.closedEvidenceAt || 0)) state = 'stale';
    if (ev.implicit && state === 'open') continue; // nothing new to say about a key-less item
    if (item.aiStatus !== state) {
      item.aiStatus = state;
      stats.hints++;
      stats.changed = true;
    }
    if (item.userEdited || !AI_KINDS.has(item.source.kind)) continue;
    if (state === 'open') {
      // An expired suggestion stays closed (like a dismissed one); the user can restore it from Dropped.
      if (!OPEN_STATUSES.has(item.status) && item.closedBy === 'ai') {
        item.status = item.aiBucket || 'inbox';
        item.doneAt = null;
        item.closedBy = null;
        item.updatedAt = now;
        stats.reopened++;
        stats.changed = true;
      }
    } else if (state === 'done') {
      if (OPEN_STATUSES.has(item.status) || (item.status === 'dropped' && item.closedBy === 'ai')) {
        item.status = 'done';
        item.doneAt = Math.min(ev.at || now, now);
        item.closedBy = 'ai';
        item.closedEvidenceAt = ev.at || 0;
        item.updatedAt = now;
        stats.closed++;
        stats.changed = true;
      }
    } else if (item.status === 'inbox' || item.status === 'todo') {
      // abandoned / superseded / removed / stale. A 'doing' item (started from Pilotage) only closes on "done".
      item.status = 'dropped';
      item.closedBy = 'ai';
      item.closedEvidenceAt = ev.at || 0;
      item.updatedAt = now;
      stats.dropped++;
      stats.changed = true;
    }
  }

  stats.expired = capSuggestions(data.items, now);
  if (stats.expired) stats.changed = true;

  // Housekeeping: forget long-closed AI items nobody touched (their sources are far too old to come back). Expired and
  // "dismiss old" suggestions too: most untouched suggestions end that way, and kept forever they slow every pass and
  // grow work.json. Their source can still be listed (a brief step), so they leave a key-only tombstone.
  const before = data.items.length;
  const tombs = [];
  data.items = data.items.filter((it) => {
    if (!AI_KINDS.has(it.source.kind) || it.userEdited || OPEN_STATUSES.has(it.status) || now - (it.updatedAt || 0) <= PRUNE_CLOSED_AFTER) return true;
    if (it.closedBy === 'ai') return false;
    if (it.closedBy === 'expired' || (it.closedBy === 'user' && it.dismissReason === 'old')) {
      if (it.keys.length) tombs.push({ keys: it.keys, projectPath: it.projectPath, at: now });
      return false;
    }
    return true;
  });
  if (tombs.length) data.tombstones = [...(data.tombstones || []), ...tombs].slice(-MAX_TOMBSTONES);
  stats.pruned = before - data.items.length;
  if (stats.pruned) stats.changed = true;
  data.meta = { ...(data.meta || {}), lastExtractAt: now, lastExtract: { ...stats, at: now } };
  return stats;
}

/**
 * At most MAX_OPEN_SUGGESTIONS untouched AI suggestions per project: the ones with the oldest evidence expire
 * (dropped, closedBy 'expired', restorable). Snoozed, restored and edited ones are the user's and don't count.
 * Mutates items; returns how many expired.
 */
export function capSuggestions(items, now = Date.now(), max = MAX_OPEN_SUGGESTIONS) {
  const groups = new Map();
  for (const it of items) {
    if (it.status !== 'inbox' || it.userEdited || it.restoredAt || !AI_KINDS.has(it.source.kind) || (it.snoozeUntil && it.snoozeUntil > now)) continue;
    const g = groups.get(it.projectPath) || [];
    g.push(it);
    groups.set(it.projectPath, g);
  }
  let n = 0;
  for (const g of groups.values()) {
    if (g.length <= max) continue;
    g.sort((a, b) => (b.sourceAt || 0) - (a.sourceAt || 0) || (b.priority || 0) - (a.priority || 0) || (b.createdAt || 0) - (a.createdAt || 0));
    for (const it of g.slice(max)) {
      it.status = 'dropped';
      it.closedBy = 'expired';
      it.closedEvidenceAt = now;
      it.updatedAt = now;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- live adapter

/** Build reconcile() input from the running server's objects. `jobSession(bgId)` reads a background job's session id. */
export function liveInput({ ai, index, registry, store, views, getLaunch, jobSession }) {
  return {
    bases: [HOME, WIN_HOME].filter(Boolean),
    blocks: ai.state.blocks,
    briefs: ai.state.projects,
    projectOfSession: (sid, fallback) => {
      const meta = index.get(sid);
      const p = meta ? registry.projectOfSession(meta) : null;
      return p?.path || fallback || null;
    },
    project: (p) => {
      const reg = registry.projects.get(p);
      const over = store.project(p);
      return { lastActivityAt: reg ? views.lastActivity(reg) : 0, hidden: !!over.hidden, closed: over.status === 'done' || over.status === 'archived' };
    },
    sessionHidden: (sid) => !!store.session(sid).hidden,
    // In-memory launch records are gone after a restart; a background launch can still be found by its job id.
    launchSession: (id, l) => (getLaunch && getLaunch(id)?.sessionId) || (l?.bgId && jobSession ? jobSession(l.bgId) : null) || null,
  };
}

export const _test = { buildIndex, evidenceFor, clip };
