// Spin-offs: start a NEW project folder from existing work (a session or a thread of a project), with a
// CLAUDE.md context handoff, optional `git init`, registration in Pilotage and an optional kickoff session.
// Also brand-new projects from an idea (same safety rules, no source).
//
// Safety: the new folder must resolve inside $HOME (realpath, so no symlink tricks), its name is a slug
// (a-z0-9-), it must not exist (never overwrite), '..' is refused, and Pilotage's own / sensitive dot-folders
// are off limits. Only the new folder is ever written to; the source project is read-only.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ROOT, DATA } from '../config.js';
import { run, clip, oneLine, hash, isInside, isoDay, redact } from '../util.js';
import { similar, toTitle } from './extract.js';
import { userName } from '../profile.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- folder planning (pure + fs checks)

export function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export const tilde = (p, home = HOME) => (isInside(p, home) ? `~${p.slice(home.length)}` || '~' : p);

function forbiddenRoots(home) {
  return [...['.claude', '.ssh', '.gnupg', '.config', '.local', '.nvm', '.npm', '.cache', '.aws', '.kube', '.docker'].map((d) => path.join(home, d)), ROOT, DATA].map(realOr);
}

/** Default parent: the folder that holds the source's top-level workspace folder (~/acme/x → ~). */
export function defaultParent(sourcePath, home = HOME) {
  if (sourcePath && isInside(sourcePath, home) && sourcePath !== home) {
    const top = path.join(home, path.relative(home, sourcePath).split(path.sep)[0]);
    return path.dirname(top);
  }
  return home;
}

/** Nearest git repo strictly below home that contains `dir` (a new folder there would merge into it). */
export function enclosingRepo(dir, home = HOME) {
  let cur = dir;
  while (cur && isInside(cur, home) && cur !== home) {
    if (lexists(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/**
 * Decide where the new folder goes, or throw HttpError. Never creates anything.
 * Returns {slug, parent, dir}.
 */
export function planFolder({ name, parentDir, sourcePath, home = HOME }) {
  const slug = slugify(name);
  if (!slug) throw new HttpError(400, 'Pick a name with letters or digits');
  const realHome = realOr(home);
  let parent;
  if (parentDir != null && parentDir !== '') {
    if (typeof parentDir !== 'string' || parentDir.length > 500 || parentDir.includes('\0')) throw new HttpError(400, 'Invalid folder');
    let p = parentDir.trim();
    // Check the raw text: path.join / resolve would silently normalize '..' away.
    if (p.split(/[\\/]+/).includes('..')) throw new HttpError(400, 'The folder must not contain ".."');
    if (p === '~') p = home;
    else if (p.startsWith('~/')) p = `${home}/${p.slice(2)}`;
    if (!path.isAbsolute(p)) throw new HttpError(400, 'The folder must be an absolute path (or start with ~/)');
    parent = path.resolve(p);
  } else parent = defaultParent(sourcePath, home);
  // The folder to create it in may not exist yet: it gets created along with the project. Its nearest existing
  // ancestor (links resolved) decides where it really lands, so the checks below see the real path.
  let existing = parent;
  const missing = [];
  let realParent;
  for (;;) {
    try {
      realParent = fs.realpathSync(existing);
      break;
    } catch {
      if (lexists(existing)) throw new HttpError(400, `${tilde(existing, home)} is a broken link`);
      const up = path.dirname(existing);
      if (up === existing) throw new HttpError(400, `${tilde(parent, home)} does not exist`);
      missing.unshift(path.basename(existing));
      existing = up;
    }
  }
  if (!fs.statSync(realParent).isDirectory()) throw new HttpError(400, `${tilde(existing, home)} is not a folder`);
  if (missing.length > 6) throw new HttpError(400, 'That creates too many new folders at once');
  if (missing.some((n) => !n || n === '.' || /[\0-\x1f]/.test(n))) throw new HttpError(400, 'Invalid folder');
  const firstNew = missing.length ? path.join(realParent, missing[0]) : null;
  if (missing.length) realParent = path.join(realParent, ...missing);
  if (!isInside(realParent, realHome)) throw new HttpError(400, 'New projects must be inside your home folder');
  if (forbiddenRoots(realHome).some((f) => isInside(realParent, f))) throw new HttpError(400, 'Projects cannot be created there');
  const dir = path.join(realParent, slug);
  if (!isInside(dir, realHome) || dir === realHome) throw new HttpError(400, 'New projects must be inside your home folder');
  // Case-insensitive too: ~/acme next to ~/Acme would be confusing (and lands in the same workspace).
  const names = missing.length ? [] : fs.readdirSync(realParent);
  const siblings = new Map(names.map((n) => [n.toLowerCase(), n]));
  const taken = (n) => siblings.has(n) || lexists(path.join(realParent, n));
  if (taken(slug)) {
    let suggestion = null;
    for (let i = 2; i < 10 && !suggestion; i++) if (!taken(`${slug}-${i}`)) suggestion = `${slug}-${i}`;
    const clash = path.join(realParent, siblings.get(slug) || slug);
    throw new HttpError(409, `${tilde(clash, realHome)} already exists`, { suggestion, existing: clash });
  }
  return { slug, parent: realParent, dir, newParent: firstNew };
}

// ---------------------------------------------------------------- handoff (CLAUDE.md)

const HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    background: { type: 'string', description: 'Markdown bullet list (4-10 bullets): what was learned in the source work that matters for the new goal: decisions, constraints, what already works, people involved, gotchas. Empty string if nothing is known.' },
    relevantFiles: {
      type: 'array',
      description: 'Up to 12 files from the "Files" list that matter most for the new goal. Empty if there is no list.',
      items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'Absolute path, copied verbatim from the list' }, why: { type: 'string', description: 'Max 12 words' } }, required: ['path', 'why'] },
    },
    openQuestions: { type: 'array', items: { type: 'string' }, description: '2-6 unresolved questions the user must answer before or during the work' },
    firstSteps: { type: 'array', items: { type: 'string' }, description: '3-6 concrete first steps for the new project, imperative mood, the first one small' },
    tasks: {
      type: 'array',
      items: { type: 'string' },
      description:
        "1-2 to-dos for the user's task list, 3-7 words each, verb first, plain words (e.g. \"Pick the launch date\", \"Send the draft to the client\"). Only things the user does or decides; never instructions or guardrails for Claude (\"only after…\", \"ask before…\", \"read this file\"). Empty if there is nothing for the user to do yet.",
    },
  },
  required: ['background', 'relevantFiles', 'openQuestions', 'firstSteps', 'tasks'],
};

const handoffRules = (name = userName()) =>
  `You write context handoffs for ${name}, a developer who works through Claude Code. ${name} is starting a new project folder and a fresh Claude session there will read your text as its CLAUDE.md. ` +
  'Use only facts present in the input. Be specific (names, numbers, file paths, decisions). Plain English, no hype. Fill the JSON schema. ' +
  'relevantFiles paths must be copied exactly from the "Files" list; never invent paths.';

const fmtDay = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');
export const SENSITIVE = /(^|\/)(\.env[^/]*|\.secrets?|secrets?\.[a-z]+|credentials?[^/]*|id_[rd]sa[^/]*|[^/]*\.pem|[^/]*\.key)$/i;

/** Source material for a spin-off: brief, chosen digests, edited files. */
export function gatherSource(ctx, project, { sessionId, threadName } = {}) {
  const { ai, index, registry, views } = ctx;
  const brief = ai.state.projects[project.path]?.brief || null;
  const keys = new Set();
  let sessionMeta = null;
  if (sessionId) {
    const meta = index.get(sessionId);
    if (!meta) throw new HttpError(404, 'Session not found');
    const pj = registry.projectOfSession(meta);
    if (!pj || pj.path !== project.path) throw new HttpError(400, 'That session belongs to another project');
    sessionMeta = meta;
    for (const b of ai.blocksOf(meta)) keys.add(b.key);
  }
  let thread = null;
  if (threadName) {
    const want = String(threadName).trim().toLowerCase();
    thread = views.threadsOf(project).find((t) => t.name.toLowerCase() === want) || null;
    if (!thread) throw new HttpError(400, 'Thread not found in this project');
    for (const k of thread.blockKeys) keys.add(k);
  }
  let blocks;
  if (keys.size) blocks = [...keys].map((k) => ({ key: k, ...(ai.state.blocks[k] || {}) })).filter((b) => b.digest);
  else
    blocks = Object.entries(ai.state.blocks)
      .filter(([, b]) => b.digest && b.projectPath === project.path)
      .map(([k, b]) => ({ key: k, ...b }))
      .sort((a, b) => (b.endAt || 0) - (a.endAt || 0))
      .slice(0, 10);
  blocks.sort((a, b) => (a.startAt || 0) - (b.startAt || 0));
  const sids = new Set(blocks.map((b) => b.sessionId).filter(Boolean));
  if (sessionMeta) sids.add(sessionMeta.id);
  const roots = [project.path, ...(project.worktrees ? project.worktrees.keys() : [])];
  const counts = new Map();
  for (const sid of sids) for (const [f, n] of Object.entries(index.get(sid)?.files || {})) counts.set(f, (counts.get(f) || 0) + n);
  const files = [...counts]
    .filter(([f]) => roots.some((r) => isInside(f, r) && f !== r) && !SENSITIVE.test(f) && isFile(f))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([p, n]) => ({ path: p, n }));
  return {
    brief,
    blocks,
    files,
    thread: thread ? { name: thread.name, summary: thread.summary } : null,
    session: sessionMeta ? { id: sessionMeta.id, title: views.sessionTitle(sessionMeta, null) } : null,
  };
}

function handoffInput({ name, goal, origin, src, related, ideaText }) {
  const L = [];
  L.push(`New project: ${name}`);
  L.push(`Goal (from ${userName()}): ${goal}`);
  if (ideaText) L.push(`Original idea: ${ideaText}`);
  if (origin) {
    L.push(`\nSource project: ${origin.name} at ${origin.path}`);
    const b = src?.brief;
    if (b) {
      L.push(`What it is: ${b.oneLiner}`);
      if (b.description) L.push(`Description: ${b.description}`);
      if (b.currentState) L.push(`Current state: ${b.currentState}`);
      if (b.nextSteps?.length) L.push(`Its next steps: ${b.nextSteps.join(' | ')}`);
      if (b.threads?.length) L.push(`Its threads: ${b.threads.map((t) => `${t.name} (${t.status})`).join(', ')}`);
    }
    if (src?.session) L.push(`Selected session: "${src.session.title}" (${src.session.id})`);
    if (src?.thread) L.push(`Selected thread: ${src.thread.name}${src.thread.summary ? ` — ${src.thread.summary}` : ''}`);
    L.push(`\nSelected work, oldest first:`);
    let budget = 9000;
    for (const b of src?.blocks || []) {
      const d = b.digest;
      const line = `[${fmtDay(b.startAt)}] ${d.title}: ${d.summary} Outcome: ${d.outcome} (${d.status}${d.nextStep ? `; next: ${d.nextStep}` : ''})${d.highlights?.length ? ` Highlights: ${d.highlights.join('; ')}` : ''}`;
      budget -= line.length;
      if (budget < 0) break;
      L.push(line);
    }
    if (src?.files?.length) {
      L.push('\nFiles (edited in that work, absolute paths, with edit counts):');
      for (const f of src.files) L.push(`${f.path} (${f.n})`);
    }
  }
  if (related?.length) {
    L.push('\nRelated projects in the same workspace:');
    for (const r of related) L.push(`- ${r.name} (${r.path}): ${r.oneLiner}${r.currentState ? ` Now: ${r.currentState}` : ''}`);
  }
  return L.join('\n');
}

function templateParts({ origin, src, related, ideaText, name, goal }) {
  const srcName = origin?.name || 'the source project';
  const bg = [];
  const b = src?.brief;
  if (b?.description) bg.push(b.description);
  if (b?.currentState) bg.push(`Current state of ${srcName}: ${b.currentState}`);
  if (ideaText) bg.push(`Original idea: ${ideaText}`);
  const blocks = (src?.blocks || []).slice(-10).reverse();
  if (blocks.length) {
    bg.push(`Recent work in ${srcName}:\n${blocks.map((x) => `- **${x.digest.title}** (${fmtDay(x.endAt)}, ${x.digest.status.replace('_', ' ')}): ${x.digest.outcome}`).join('\n')}`);
  }
  const loops = [];
  for (const x of blocks) {
    const s = x.digest.nextStep;
    if (!s || x.digest.status === 'done' || x.digest.status === 'abandoned' || loops.some((y) => similar(y, s))) continue;
    loops.push(s);
  }
  if (loops.length) bg.push(`Open loops in ${srcName} at hand-off time (they stay with ${srcName}):\n${loops.slice(0, 5).map((s) => `- ${s}`).join('\n')}`);
  if (b?.attention?.length) bg.push(`Watch-outs noted in ${srcName}:\n${b.attention.slice(0, 4).map((s) => `- ${s}`).join('\n')}`);
  if (related?.length) {
    bg.push(`Related projects in the same workspace:\n${related.map((r) => `- **${r.name}** (\`${r.path}\`): ${r.oneLiner}`).join('\n')}`);
  }
  const questions = [];
  for (const x of blocks) if (x.digest.status === 'blocked' && x.digest.nextStep && questions.length < 2) questions.push(`Still blocked in ${srcName}: ${x.digest.nextStep}`);
  if (origin) questions.push(`Which parts of ${origin.name} should ${name} reuse, and which should it rebuild?`);
  questions.push('What does "done" look like for the first version?');
  const steps = [
    origin ? `Read this file and the relevant files listed below (in \`${origin.path}\`).` : `Read this file and ask ${userName()} anything that is unclear.`,
    origin ? `Map what ${name} needs from ${origin.name}: the pieces to reuse (with paths) and what to build fresh.` : 'Sketch the smallest first version that meets the goal.',
    `Write a short plan for the first version in this file and wait for ${userName()}'s go before building.`,
  ];
  return {
    background: bg.join('\n\n'),
    relevantFiles: (src?.files || []).slice(0, 20).map((f) => ({ path: f.path, why: `edited ${f.n}× in the source work` })),
    openQuestions: questions.slice(0, 6),
    firstSteps: steps,
    // Template mode makes one task in the new project instead of copying boilerplate steps into the task list.
    ...starterTask(name, goal),
  };
}

/** New projects get at most this many starter tasks (the user's to-dos, not Claude's first steps). */
export const MAX_STARTER_TASKS = 2;
const starterTask = (name, goal) => ({ tasks: [clip(`Plan the first version of ${name}`, 80)], taskDetail: goal });

export function renderHandoff({ name, goal, origin, src, parts, generatedBy, now = Date.now() }) {
  const L = [`# ${name}`, ''];
  if (origin) {
    L.push(`> Spun off from **${origin.name}** (\`${origin.path}\`) by Pilotage on ${fmtDay(now)}.`);
    if (src?.session) L.push(`> Source session: \`${src.session.id}\` “${src.session.title}”.`);
    if (src?.thread) L.push(`> Source thread: ${src.thread.name}.`);
  } else L.push(`> New project created by Pilotage on ${fmtDay(now)}.`);
  const how = generatedBy === 'ai' ? 'written by AI from Pilotage summaries' : 'assembled by Pilotage from its summaries';
  L.push(`> This file is the context handoff for Claude sessions in this folder (${how}). Keep it current.`, '');
  L.push('## Goal', '', goal.trim(), '');
  const bg = String(parts.background || '').replace(/^#{1,6}\s+/gm, '**').trim();
  L.push('## Background', '', bg || '_Nothing recorded yet._', '');
  L.push('## Relevant files in the source project', '');
  if (parts.relevantFiles.length) {
    for (const f of parts.relevantFiles) L.push(`- \`${f.path}\`${f.why ? ` — ${oneLine(f.why)}` : ''}`);
    L.push('', `_Read these in place. Do not edit the source project from here unless ${userName()} asks._`);
  } else L.push(origin ? '_None recorded._' : '_None (new project)._');
  L.push('', '## Open questions', '');
  if (parts.openQuestions.length) for (const q of parts.openQuestions) L.push(`- ${oneLine(q)}`);
  else L.push('_None yet._');
  L.push('', '## First steps', '');
  parts.firstSteps.forEach((s, i) => L.push(`${i + 1}. ${oneLine(s)}`));
  L.push('', '## Working agreement', '', `- Summarize the plan and wait for ${userName()}'s go before big changes (new dependencies, many new files${origin ? ', anything that touches the source project' : ''}).`, '- Record decisions and the current state in this file as you go.', '');
  return redact(L.join('\n'));
}

function cleanAIParts(data, src) {
  const allowed = new Set((src?.files || []).map((f) => f.path));
  const arr = (x, n, len) => (Array.isArray(x) ? x : []).map((s) => clip(oneLine(s), len)).filter(Boolean).slice(0, n);
  const relevantFiles = (Array.isArray(data?.relevantFiles) ? data.relevantFiles : [])
    .filter((f) => f && allowed.has(String(f.path)))
    .slice(0, 12)
    .map((f) => ({ path: String(f.path), why: clip(oneLine(f.why), 120) }));
  return {
    background: clip(String(data?.background || ''), 5000),
    relevantFiles,
    openQuestions: arr(data?.openQuestions, 8, 300),
    firstSteps: arr(data?.firstSteps, 8, 300),
    tasks: arr(data?.tasks, MAX_STARTER_TASKS, 60), // the user's to-dos (firstSteps are Claude's, in CLAUDE.md)
  };
}

/**
 * One AI call through the engine queue (manual job), or {ok:false} when AI is unavailable / too slow.
 * `callAI` is providers.js callAI (the provider chosen in Settings → AI, its account and daily cap); tests pass a fake.
 */
export function queueAIHandoff(ctx, { instruction, input, model = 'haiku', startWithinMs = 60_000, totalMs = 170_000, callAI }) {
  const { ai, store } = ctx;
  if (process.env.PILOTAGE_NO_AI === '1') return Promise.resolve({ ok: false, error: 'AI disabled for this server' });
  if (!store.settings.ai.enabled) return Promise.resolve({ ok: false, error: 'AI is turned off in Settings' });
  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      resolve(r);
    };
    const t1 = setTimeout(() => !started && finish({ ok: false, error: 'AI queue busy' }), startWithinMs);
    const t2 = setTimeout(() => finish({ ok: false, error: 'AI took too long' }), totalMs);
    const queued = ai.enqueue({
      id: `handoff:${hash(input, 10)}:${Date.now()}`,
      kind: 'handoff',
      priority: 90,
      manual: true,
      label: 'Spin-off handoff',
      run: async () => {
        if (settled) return { cost: 0 };
        started = true;
        const r = await callAI({ purpose: 'brief', instruction, input, schema: HANDOFF_SCHEMA, model, timeout: totalMs - 10_000 });
        finish(r);
        return r;
      },
    });
    if (!queued) finish({ ok: false, error: 'Could not queue the AI call' });
  });
}

/** Build the CLAUDE.md text. `callAI(instruction, input)` → {ok, data}; omitted → deterministic template. */
export async function buildHandoff({ name, goal, origin = null, src = null, related = [], ideaText = '', callAI = null, now = Date.now() }) {
  let parts = null;
  let generatedBy = 'template';
  let aiError = null;
  if (callAI) {
    try {
      const r = await callAI(`${handoffRules()} ${origin ? 'Write the handoff for a project spun off from the source work on stdin.' : 'Write the starting brief for a brand-new project; there is no source project, so relevantFiles must be empty.'}`, handoffInput({ name, goal, origin, src, related, ideaText }));
      if (r?.ok && r.data && typeof r.data === 'object') {
        parts = cleanAIParts(r.data, src);
        if (!parts.firstSteps.length) parts = null;
        else {
          generatedBy = 'ai';
          if (!parts.tasks.length) Object.assign(parts, starterTask(name, goal)); // nothing for the user yet: one planning task
        }
      } else aiError = r?.error || 'AI call failed';
    } catch (e) {
      aiError = e.message;
    }
  }
  if (!parts) parts = templateParts({ origin, src, related, ideaText, name, goal });
  const tasks = (parts.tasks || []).slice(0, MAX_STARTER_TASKS).map((title) => ({ title, detail: parts.taskDetail || title }));
  return { markdown: renderHandoff({ name, goal, origin, src, parts, generatedBy, now }), generatedBy, aiError, firstSteps: parts.firstSteps, tasks };
}

/** mkdir (0755, never recursive), write CLAUDE.md (never overwrite), optional git init. Rolls back on failure. */
export async function createProjectFolder(plan, markdown, { gitInit = false, home = HOME } = {}) {
  // Re-check right before writing: the AI call may have taken a while.
  const again = planFolder({ name: plan.slug, parentDir: plan.parent, home });
  if (again.dir !== plan.dir) throw new HttpError(409, 'The target folder changed; try again');
  // Folders it goes in that don't exist yet, outermost first (rolled back with the project folder on failure).
  const newParents = [];
  if (again.newParent) {
    const stop = path.dirname(again.newParent);
    for (let d = plan.parent; d !== stop && d !== path.dirname(d); d = path.dirname(d)) newParents.unshift(d);
  }
  const madeParents = [];
  let madeDir = false;
  let wrote = false;
  try {
    for (const d of newParents) {
      fs.mkdirSync(d, { mode: 0o755 });
      madeParents.push(d);
    }
    if (fs.realpathSync(plan.parent) !== plan.parent) throw new HttpError(400, 'Unexpected link in the new folder path');
    fs.mkdirSync(plan.dir, { mode: 0o755 });
    madeDir = true;
    fs.chmodSync(plan.dir, 0o755);
    if (fs.realpathSync(plan.dir) !== plan.dir) throw new HttpError(400, 'Unexpected link in the new folder path');
    fs.writeFileSync(path.join(plan.dir, 'CLAUDE.md'), markdown, { flag: 'wx', mode: 0o644 });
    wrote = true;
  } catch (e) {
    try {
      if (wrote) fs.unlinkSync(path.join(plan.dir, 'CLAUDE.md'));
      if (madeDir) fs.rmdirSync(plan.dir);
      for (const d of [...madeParents].reverse()) fs.rmdirSync(d);
    } catch {}
    throw e;
  }
  let git = null;
  if (gitInit) {
    const r = await run('git', ['--no-optional-locks', 'init', '-q'], { cwd: plan.dir, timeout: 20000 });
    git = r.code === 0 ? { ok: true } : { ok: false, error: clip(r.stderr || r.stdout || `exit ${r.code}`, 200) };
  }
  return { dir: plan.dir, claudeMd: path.join(plan.dir, 'CLAUDE.md'), git };
}

export function kickoffPrompt({ name, origin }) {
  return [
    `This is a new project, "${name}"${origin ? `, spun off from ${origin.name} (${origin.path})` : ''}. Pilotage just created this folder.`,
    `Read CLAUDE.md in this folder first. Then summarize the goal and your plan in a few bullets, list the open questions you need ${userName()} to answer,`,
    `and wait for ${userName()}'s go before big changes (installing dependencies, creating many files${origin ? ', or touching the source project' : ''}).`,
  ].join(' ');
}

export function cleanName(s) {
  return clip(oneLine(s).replace(/[\u0000-\u001f<>`]/g, ''), 80);
}

export const firstStepTitle = (s) => toTitle(s, 80);
