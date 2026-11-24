// Work items (tasks / open loops), spin-offs and new projects. Contract: docs/API-WORK.md.
import path from 'node:path';
import { HOME, CLAUDE_DIR } from '../config.js';
import { clip, hash, oneLine, isInside, readJSONSync } from '../util.js';
import { launch, getLaunch, sanitizeName, askFirstMode } from '../launch.js';
import { callAI } from '../ai/providers.js';
import { getWorkStore, STATUSES, OPEN_STATUSES, AI_KINDS } from '../work/store.js';
import { reconcile, liveInput } from '../work/extract.js';
import { makeCleanup } from '../work/retitle.js';
import { classifyFailure } from '../ai/engine.js';
import { userName } from '../profile.js';
import { HttpError, planFolder, gatherSource, buildHandoff, queueAIHandoff, createProjectFolder, kickoffPrompt, cleanName, firstStepTitle, enclosingRepo, tilde, MAX_STARTER_TASKS } from '../work/spinoff.js';

const STATUS_ORDER = { doing: 0, todo: 1, inbox: 2, done: 3, dropped: 4 };
const RECENT_CLOSED = 14 * 86400e3;
const isPhoneUA = (ua = '') => /android|iphone|ipad|mobile/i.test(ua);

export default function ({ route, ctx }) {
  const { index, registry, store, live, ai, views, broadcast, json, fail, log } = ctx;
  const work = getWorkStore();
  ctx.workView = (it) => view(it); // shared with routes/plan.js (Today + triage)
  ctx.workSort = (a, b) => sortItems(a, b); // and with routes/reports.js (standup)
  // Folders Pilotage created stay projects after a restart, wherever they are (the scan only goes 3 levels deep).
  for (const r of work.data.spinoffs) if (r.to) registry.known.add(r.to);

  // ------------------------------------------------------------ helpers
  const projectName = (p) => store.project(p).name || registry.projects.get(p)?.name || path.basename(p) || p;
  const projectHidden = (p) => !!store.project(p).hidden;

  function view(it) {
    const reg = registry.projects.get(it.projectPath);
    let sessionTitle = null;
    if (it.source.sessionId) {
      const meta = index.get(it.source.sessionId);
      if (meta) sessionTitle = views.sessionTitle(meta, null);
    }
    return {
      id: it.id,
      projectId: hash(it.projectPath, 10),
      projectPath: it.projectPath,
      projectName: projectName(it.projectPath),
      workspace: store.project(it.projectPath).workspace || reg?.workspace || null,
      title: it.title,
      detail: it.detail,
      status: it.status,
      priority: it.priority,
      source: { ...it.source, sessionTitle },
      ai: AI_KINDS.has(it.source.kind),
      autoManaged: AI_KINDS.has(it.source.kind) && !it.userEdited,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      sourceAt: it.sourceAt,
      doneAt: it.doneAt,
      dueAt: it.dueAt,
      startedAt: it.startedAt,
      userEdited: it.userEdited,
      aiStatus: it.aiStatus,
      closedBy: it.closedBy,
      plannedFor: it.plannedFor,
      snoozeUntil: it.snoozeUntil,
      dismissReason: it.dismissReason,
      restoredAt: it.restoredAt,
      who: it.who || null,
      titleBy: it.titleBy || null,
      launches: it.launches.map((l) => ({ launchId: l.launchId, at: l.at, mode: l.mode, sessionId: l.sessionId || getLaunch(l.launchId)?.sessionId || null })),
    };
  }

  function sortItems(a, b) {
    return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.priority - a.priority || (a.dueAt || Infinity) - (b.dueAt || Infinity) || (b.sourceAt || b.updatedAt) - (a.sourceAt || a.updatedAt);
  }

  function parseDue(v) {
    if (v === null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v));
    if (!Number.isFinite(t) || t < Date.parse('2000-01-01') || t > Date.parse('2100-01-01')) throw new HttpError(400, 'Invalid dueAt');
    return t;
  }

  function projectFromId(id) {
    const p = typeof id === 'string' ? registry.byId(id) : null;
    if (!p) throw new HttpError(404, 'Project not found');
    return p;
  }

  const handle = (fn) => async (req, res, args) => {
    try {
      await fn(req, res, args);
    } catch (e) {
      if (e instanceof HttpError) return json(res, { error: e.message, ...e.extra }, e.status);
      log.error('work route failed', e);
      fail(res, 500, clip(e.message, 300));
    }
  };

  const changed = () => {
    work.save();
    broadcast('work');
  };

  // A background launch's session id, from Claude's own job state (it outlives Pilotage restarts and the job).
  function jobSession(bgId) {
    if (!/^[0-9a-f]{6,40}$/.test(bgId || '')) return null;
    const sid = readJSONSync(path.join(CLAUDE_DIR, 'jobs', bgId, 'state.json'), null)?.sessionId;
    return typeof sid === 'string' && sid ? sid : null;
  }

  // launch.js learns a new session's id a few seconds after the launch, in memory only. Copy it onto the item as
  // soon as it is known, so a server restart before the next extraction can't cut the task off from its session.
  function pinLaunchSession(itemId, launchId, tries = 0) {
    const t = setTimeout(() => {
      const l = work.get(itemId)?.launches.find((x) => x.launchId === launchId);
      if (!l || l.sessionId) return;
      const sid = getLaunch(launchId)?.sessionId || jobSession(l.bgId);
      if (sid) {
        l.sessionId = sid;
        changed();
      } else if (tries < 14) pinLaunchSession(itemId, launchId, tries + 1);
    }, tries < 4 ? 3000 : 20000);
    t.unref?.();
  }

  // ------------------------------------------------------------ automatic extraction
  let extractTimer = null;
  let booted = false;
  function extractNow(reason) {
    if (!booted) return;
    try {
      const st = reconcile(work.data, liveInput({ ai, index, registry, store, views, getLaunch, jobSession }), Date.now());
      if (st.changed) {
        changed();
        if (st.created || st.closed || st.dropped || st.reopened) log.info(`work: ${reason} → +${st.created} new, ${st.closed} done, ${st.dropped} dropped, ${st.reopened} reopened, ${st.attached} merged`);
      }
    } catch (e) {
      log.warn('work extraction failed', e.message);
    }
  }
  // One-time tidy-up of the suggestions made before the short-title rules (work/retitle.js): through the AI queue.
  const cleanup = makeCleanup({ work, ai, callAI, projectName, changed, log, classify: classifyFailure });
  const cleanupTick = () => {
    try {
      cleanup.tick();
    } catch (e) {
      log.warn('work cleanup failed', e.message);
    }
  };
  const scheduleExtract = (reason, ms = 2500) => {
    clearTimeout(extractTimer);
    extractTimer = setTimeout(() => extractNow(reason), ms);
    extractTimer.unref?.();
  };
  ai.on('changed', (e) => {
    if (e?.kind === 'queue' || e?.kind === 'handoff' || e?.kind === 'scout') return;
    scheduleExtract(`ai ${e?.kind || 'change'}`);
  });
  // The registry is built after modules load; wait for it so project activity is known.
  const boot = setInterval(() => {
    if (!registry.projects.size) return;
    clearInterval(boot);
    booted = true;
    extractNow('startup');
    cleanupTick();
  }, 2000);
  boot.unref?.();
  ctx.every(10 * 60e3, async () => {
    extractNow('periodic');
    if (booted) cleanupTick();
  });

  ctx.extendOverview(() => {
    const open = work.items.filter((it) => OPEN_STATUSES.has(it.status) && !projectHidden(it.projectPath));
    const top = open.slice().sort(sortItems).slice(0, 5).map((it) => {
      const v = view(it);
      return { id: v.id, title: v.title, status: v.status, priority: v.priority, projectId: v.projectId, projectName: v.projectName, ai: v.ai, aiStatus: v.aiStatus, dueAt: v.dueAt, sourceAt: v.sourceAt };
    });
    return {
      work: {
        openCount: open.length,
        doingCount: open.filter((x) => x.status === 'doing').length,
        todoCount: open.filter((x) => x.status === 'todo').length,
        inboxCount: open.filter((x) => x.status === 'inbox').length,
        topNext: top,
        lastExtractAt: work.data.meta.lastExtractAt || 0,
      },
    };
  });

  // ------------------------------------------------------------ work items
  route('GET', '/api/work', handle(async (req, res, { url }) => {
    const pid = url.searchParams.get('project') || '';
    const statusQ = (url.searchParams.get('status') || '').trim();
    const q = oneLine(url.searchParams.get('q') || '').toLowerCase();
    const includeHidden = url.searchParams.get('hidden') === '1';
    let items = work.items;
    if (pid) items = items.filter((it) => hash(it.projectPath, 10) === pid);
    else if (!includeHidden) items = items.filter((it) => !projectHidden(it.projectPath));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const it of items) counts[it.status]++;
    if (statusQ && statusQ !== 'all') {
      const want = new Set(statusQ.split(',').flatMap((s) => (s === 'open' ? [...OPEN_STATUSES] : [s.trim()])));
      items = items.filter((it) => want.has(it.status));
    } else if (!statusQ) {
      const now = Date.now();
      items = items.filter((it) => OPEN_STATUSES.has(it.status) || now - (it.doneAt || it.updatedAt || 0) < RECENT_CLOSED);
    }
    if (q) items = items.filter((it) => `${it.title} ${it.detail}`.toLowerCase().includes(q));
    const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 2000);
    json(res, { items: items.slice().sort(sortItems).slice(0, limit).map(view), counts, lastExtractAt: work.data.meta.lastExtractAt || 0 });
  }));

  route('POST', '/api/work', handle(async (req, res, { body }) => {
    let idea = null;
    if (body.fromIdeaId) {
      idea = (store.data.ideas || []).find((x) => x.id === body.fromIdeaId);
      if (!idea) throw new HttpError(404, 'Idea not found');
    }
    let projectPath;
    if (body.projectId) projectPath = projectFromId(body.projectId).path;
    else if (idea?.projectPath) projectPath = idea.projectPath;
    else throw new HttpError(400, 'Pick a project');
    const title = clip(oneLine(body.title || (idea ? idea.text : '')), 200);
    if (!title) throw new HttpError(400, 'Empty title');
    const status = body.status === undefined ? 'todo' : body.status;
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status');
    const priority = body.priority === undefined ? 1 : Number(body.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) throw new HttpError(400, 'Priority must be 0-3');
    const source = { kind: idea ? 'idea' : 'user' };
    if (idea) source.ideaId = idea.id;
    if (typeof body.sessionId === 'string' && index.get(body.sessionId)) source.sessionId = body.sessionId;
    const now = Date.now();
    const item = work.add({
      projectPath,
      title,
      detail: clip(String(body.detail ?? (idea && idea.text.length > title.length ? idea.text : '')), 8000),
      status,
      priority,
      source,
      createdAt: now,
      updatedAt: now,
      doneAt: status === 'done' ? now : null,
      dueAt: body.dueAt === undefined ? null : parseDue(body.dueAt),
      userEdited: true,
      closedBy: status === 'done' || status === 'dropped' ? 'user' : null,
    });
    if (idea) {
      idea.doneAt = now;
      idea.workItemId = item.id;
      store.save();
      broadcast('ideas');
    }
    changed();
    json(res, view(item));
  }));

  route('PATCH', '/api/work/([\\w-]{4,40})', handle(async (req, res, { m, body }) => {
    const it = work.get(m[1]);
    if (!it) throw new HttpError(404, 'Work item not found');
    const now = Date.now();
    const prev = { status: it.status, closedBy: it.closedBy };
    if (body.title !== undefined) {
      const t = clip(oneLine(body.title), 200);
      if (!t) throw new HttpError(400, 'Empty title');
      it.title = t;
    }
    if (body.detail !== undefined) it.detail = clip(String(body.detail ?? ''), 8000);
    if (body.priority !== undefined) {
      const p = Number(body.priority);
      if (!Number.isInteger(p) || p < 0 || p > 3) throw new HttpError(400, 'Priority must be 0-3');
      it.priority = p;
    }
    if (body.dueAt !== undefined) it.dueAt = parseDue(body.dueAt);
    if (body.projectId !== undefined) it.projectPath = projectFromId(body.projectId).path;
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
      if (body.status !== it.status) {
        it.status = body.status;
        it.doneAt = body.status === 'done' ? now : null;
        it.closedBy = OPEN_STATUSES.has(body.status) ? null : 'user';
      }
    }
    // Moving a card between open columns (inbox → todo → doing) doesn't take it away from the AI,
    // so finished work still closes itself. Editing text/priority/project, closing it yourself, or bringing a closed
    // card back (Restore) does: the evidence that closed it hasn't changed, so the next extraction would close it again.
    const reopened = !OPEN_STATUSES.has(prev.status) && OPEN_STATUSES.has(it.status);
    const onlyOpenStatusMove = Object.keys(body).every((k) => k === 'status') && OPEN_STATUSES.has(body.status) && !reopened;
    if (!onlyOpenStatusMove) it.userEdited = true;
    // The user overruled the AI's close: its old reason is no hint any more (extract.js skips evidence up to closedEvidenceAt).
    if (reopened && prev.closedBy === 'ai') it.aiStatus = 'open';
    it.updatedAt = now;
    changed();
    json(res, view(it));
  }));

  route('DELETE', '/api/work/([\\w-]{4,40})', handle(async (req, res, { m }) => {
    if (!work.remove(m[1])) throw new HttpError(404, 'Work item not found');
    broadcast('work');
    json(res, { ok: true });
  }));

  route('POST', '/api/work/([\\w-]{4,40})/start', handle(async (req, res, { m, body, dev }) => {
    const it = work.get(m[1]);
    if (!it) throw new HttpError(404, 'Work item not found');
    const proj = registry.projects.get(it.projectPath);
    if (!proj) throw new HttpError(400, 'This item\'s project folder is not known to Pilotage any more');
    let cwd = proj.path;
    let resumeId = null;
    if (body.resume && it.source.sessionId) {
      const meta = index.get(it.source.sessionId);
      if (!meta || meta.archived) throw new HttpError(400, 'The source session cannot be resumed (its transcript is gone)');
      if (live.get(meta.id)?.live) throw new HttpError(409, 'The source session is already running. Open it instead.');
      const known = [proj.path, ...proj.worktrees.keys()].some((p) => isInside(meta.cwd, p));
      if (!known) throw new HttpError(400, 'The source session ran outside this project');
      cwd = meta.cwd;
      resumeId = meta.id;
    }
    const mode = body.mode === 'terminal' || body.mode === 'background' ? body.mode : isPhoneUA(req.headers['user-agent']) ? store.settings.launch.phoneMode : store.settings.launch.pcMode;
    const lines = [`Work item from Pilotage (${projectName(proj.path)}): ${it.title}`];
    if (it.detail && it.detail !== it.title) lines.push('', it.detail);
    if (!resumeId && it.source.sessionId) lines.push('', `This came out of an earlier session (${it.source.sessionId}); check the current state of the folder before acting.`);
    lines.push('', `Do this task. If anything is unclear or risky, ask ${userName()} first. Say clearly when it is done.`);
    // As /api/launch: answer Claude Code's "trust this folder?" first when Settings says so (or the user ticked it),
    // or a Start from the phone (background by default) waits for an answer at the PC.
    await ctx.trustBeforeLaunch?.(cwd, body.trust === true, body.trust === true ? `asked from ${dev?.name || 'a device'}` : 'setting');
    const rec = await launch({
      cwd,
      name: sanitizeName(it.title, projectName(proj.path)),
      prompt: lines.join('\n'),
      mode,
      resumeId,
      fork: false,
      model: typeof body.model === 'string' ? body.model : store.settings.launch.model,
      // A suggested task's text was written by the AI from transcripts: it asks before acting, whatever Settings says.
      permissionMode: AI_KINDS.has(it.source.kind) ? askFirstMode(store.settings.launch.permissionMode) : store.settings.launch.permissionMode,
      from: dev?.name,
    });
    if (rec.state === 'error') throw new HttpError(500, rec.error || 'Launch failed');
    const now = Date.now();
    if (it.status !== 'done') it.status = 'doing';
    it.startedAt = now;
    it.updatedAt = now;
    it.launches.push({ launchId: rec.id, at: now, mode: rec.mode, sessionId: rec.sessionId || null, bgId: rec.bgId || null });
    changed();
    if (!rec.sessionId) pinLaunchSession(it.id, rec.id);
    setTimeout(() => live.refresh().then((c) => c && broadcast('live')).catch(() => {}), 4000);
    json(res, { item: view(it), launch: rec });
  }));

  // ------------------------------------------------------------ spin-offs / new projects
  function relView(r) {
    const fromReg = r.from ? registry.projects.get(r.from) : null;
    const toReg = registry.projects.get(r.to);
    return {
      ...r,
      fromProjectId: r.from ? hash(r.from, 10) : null,
      fromName: r.from ? projectName(r.from) : null,
      toProjectId: hash(r.to, 10),
      toName: projectName(r.to),
      toDisplayPath: tilde(r.to),
      fromRegistered: !!fromReg,
      toRegistered: !!toReg,
    };
  }

  route('GET', '/api/spinoffs', handle(async (req, res, { url }) => {
    const pid = url.searchParams.get('project') || '';
    let rels = work.data.spinoffs;
    if (pid) rels = rels.filter((r) => (r.from && hash(r.from, 10) === pid) || hash(r.to, 10) === pid);
    json(res, { spinoffs: rels.slice().sort((a, b) => b.createdAt - a.createdAt).map(relView) });
  }));

  // Through callAI like every other AI job: the provider chosen in Settings → AI, the pinned Claude account, the caps.
  const aiCaller = (model) => (instruction, input) => queueAIHandoff(ctx, { instruction, input, model, callAI });

  async function finishCreate({ plan, name, goal, workspace, origin, src, related, ideaText, body, dev, rel }) {
    const h = await buildHandoff({ name, goal, origin, src, related, ideaText, callAI: body.useAI === false ? null : aiCaller('haiku') });
    const made = await createProjectFolder(plan, h.markdown, { gitInit: !!body.gitInit });
    registry.known.add(made.dir); // registered even below the scan depth or in a dot-folder
    // Pilotage just made this folder and holds only what it wrote, so it can answer Claude Code's "trust this
    // folder?" for it when the user turned that on (or ticked it here). The same step as every launch (ctx).
    await ctx.trustBeforeLaunch?.(made.dir, body.trust === true, 'new project');
    const patch = { name, status: 'active' };
    if (workspace) patch.workspace = workspace;
    store.patchProject(made.dir, patch);
    const now = Date.now();
    const relation = work.addSpinoff({ ...rel, to: made.dir, name, goal: clip(goal, 1000), createdAt: now });
    const items = h.tasks.slice(0, MAX_STARTER_TASKS).map((t, i) =>
      work.add({
        projectPath: made.dir,
        title: firstStepTitle(t.title),
        detail: t.detail,
        status: 'todo',
        priority: i === 0 ? 2 : 1,
        source: { kind: 'spinoff', spinoffId: relation.id },
        createdAt: now + i,
        updatedAt: now + i,
        sourceAt: now,
        aiBucket: 'todo',
      }),
    );
    registry.lastScanAt = 0;
    await registry.rebuild();
    let rec = null;
    if (body.launch === 'terminal' || body.launch === 'background') {
      rec = await launch({
        cwd: made.dir,
        name: sanitizeName(name, plan.slug),
        prompt: kickoffPrompt({ name, origin }),
        mode: body.launch,
        model: typeof body.model === 'string' ? body.model : store.settings.launch.model,
        // Its first read is CLAUDE.md, assembled from AI summaries (or written by the AI): ask before acting.
        permissionMode: askFirstMode(store.settings.launch.permissionMode),
        from: dev?.name,
      });
      if (rec.state !== 'error') setTimeout(() => live.refresh().then((c) => c && broadcast('live')).catch(() => {}), 4000);
    }
    work.save();
    broadcast('projects');
    broadcast('work');
    const reg = registry.projects.get(made.dir);
    return {
      ok: true,
      project: { id: hash(made.dir, 10), path: made.dir, displayPath: tilde(made.dir), name, workspace: workspace || reg?.workspace || null, registered: !!reg },
      claudeMd: { path: made.claudeMd, generatedBy: h.generatedBy, aiError: h.aiError },
      git: made.git,
      launch: rec,
      items: items.map(view),
      spinoff: relView(relation),
    };
  }

  function commonInputs(body) {
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, 'Give the new project a name');
    if (body.launch != null && body.launch !== 'terminal' && body.launch !== 'background') throw new HttpError(400, 'launch must be "terminal", "background" or null');
    let workspace;
    if (body.workspace === null || body.workspace === '') workspace = null;
    else if (typeof body.workspace === 'string') {
      workspace = body.workspace.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9 _.-]{0,39}$/.test(workspace)) throw new HttpError(400, 'Invalid workspace');
    }
    return { name, goal: clip(String(body.goal || '').trim(), 4000), workspace };
  }

  // A project-scout candidate (routes/scout.js) behind this spin-off / new project: its text feeds the handoff, and
  // it is marked 'accepted' once the folder exists. Unknown ids are ignored (creation never fails because of them).
  const scoutIdOf = (body) => (typeof body.scoutId === 'string' && /^[a-f0-9]{12}$/.test(body.scoutId) ? body.scoutId : null);
  function acceptScout(scoutId, out) {
    if (!scoutId || !ctx.scout) return;
    const r = ctx.scout.accept(scoutId, out.project.path);
    if (!r.ok) return;
    out.scout = { id: scoutId, status: 'accepted' };
    broadcast('scout');
    if (r.ideaDone) broadcast('ideas');
  }

  function checkRepo(plan, gitInit) {
    const repo = enclosingRepo(plan.parent);
    if (repo && !gitInit) throw new HttpError(400, `${tilde(plan.parent)} is inside the git repo ${tilde(repo)}; the new folder would just be part of it. Turn on git init or pick another folder.`);
    return repo;
  }

  route('POST', '/api/spinoff', handle(async (req, res, { body, dev }) => {
    const source = projectFromId(body.fromProjectId);
    const { name, goal: goalIn, workspace: wsIn } = commonInputs(body);
    const src = gatherSource(ctx, source, { sessionId: typeof body.fromSessionId === 'string' ? body.fromSessionId : null, threadName: typeof body.threadName === 'string' && body.threadName.trim() ? body.threadName : null });
    const origin = { name: projectName(source.path), path: source.path };
    const goal = goalIn || `Take ${src.thread ? `the "${src.thread.name}" work` : src.session ? `the work from "${src.session.title}"` : 'part of the work'} out of ${origin.name} into its own project.`;
    const workspace = wsIn === undefined ? store.project(source.path).workspace || source.workspace || null : wsIn;
    const plan = planFolder({ name, parentDir: body.parentDir, sourcePath: source.path });
    const repo = checkRepo(plan, !!body.gitInit);
    if (body.dryRun) {
      return json(res, { ok: true, dryRun: true, path: plan.dir, displayPath: tilde(plan.dir), slug: plan.slug, parent: plan.parent, newParent: plan.newParent ? tilde(plan.newParent) : null, insideRepo: repo, workspace, goal, source: { projectId: source.id, name: origin.name, session: src.session, thread: src.thread, blocks: src.blocks.length, files: src.files.length } });
    }
    const rel = { kind: 'spinoff', from: source.path, sessionId: src.session?.id || null, threadName: src.thread?.name || null };
    const scoutId = scoutIdOf(body);
    const ideaText = (scoutId && ctx.scout?.ideaText(scoutId)) || '';
    const out = await finishCreate({ plan, name, goal, workspace, origin, src, related: [], ideaText: ideaText !== goal ? ideaText : '', body, dev, rel });
    acceptScout(scoutId, out);
    json(res, out);
  }));

  route('POST', '/api/projects/new', handle(async (req, res, { body, dev }) => {
    const { name, goal: goalIn, workspace } = commonInputs(body);
    let idea = null;
    if (body.fromIdeaId) {
      idea = (store.data.ideas || []).find((x) => x.id === body.fromIdeaId);
      if (!idea) throw new HttpError(404, 'Idea not found');
      if (!body.scoutId && typeof idea.scoutId === 'string') body.scoutId = idea.scoutId; // a saved scout idea: mark the candidate accepted too
    }
    const scoutGoal = scoutIdOf(body) && ctx.scout?.find(scoutIdOf(body))?.c.pitch;
    const goal = goalIn || (idea ? clip(idea.text, 4000) : '') || clip(scoutGoal || '', 4000);
    if (!goal) throw new HttpError(400, 'Describe the goal');
    const plan = planFolder({ name, parentDir: body.parentDir, sourcePath: null });
    const repo = checkRepo(plan, !!body.gitInit);
    const related = workspace
      ? [...registry.projects.values()]
          .filter((p) => (store.project(p.path).workspace || p.workspace) === workspace && ai.state.projects[p.path]?.brief)
          .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
          .slice(0, 6)
          .map((p) => ({ name: projectName(p.path), path: p.path, oneLiner: ai.state.projects[p.path].brief.oneLiner, currentState: ai.state.projects[p.path].brief.currentState }))
      : [];
    if (body.dryRun) return json(res, { ok: true, dryRun: true, path: plan.dir, displayPath: tilde(plan.dir), slug: plan.slug, parent: plan.parent, newParent: plan.newParent ? tilde(plan.newParent) : null, insideRepo: repo, workspace: workspace || null, goal, related: related.map((r) => r.name) });
    const rel = { kind: 'new', from: null, ideaId: idea?.id || null };
    const scoutId = scoutIdOf(body);
    const scoutText = (scoutId && ctx.scout?.ideaText(scoutId)) || '';
    const ideaText = idea && idea.text !== goal ? idea.text : scoutText && scoutText !== goal ? scoutText : '';
    const out = await finishCreate({ plan, name, goal, workspace, origin: null, src: null, related, ideaText, body, dev, rel });
    acceptScout(scoutId, out);
    if (idea) {
      idea.doneAt = Date.now();
      idea.projectPath = out.project.path;
      store.save();
      broadcast('ideas');
    }
    json(res, out);
  }));

  // Give the daily brief the open tasks, so "focus today" builds on what's already on the board.
  ctx.ai.dailyExtras = () => {
    const open = work.items
      .filter((it) => OPEN_STATUSES.has(it.status) && !projectHidden(it.projectPath))
      .sort((a, b) => (b.status === 'doing') - (a.status === 'doing') || (b.priority || 0) - (a.priority || 0) || (b.sourceAt || 0) - (a.sourceAt || 0))
      .slice(0, 15);
    if (!open.length) return '';
    return `Open tasks on ${userName()}'s board (${open.length} shown):\n${open.map((it) => `- [${it.status}] ${it.title} (${it.projectPath.split('/').pop()})`).join('\n')}`;
  };
  log.info(`work: ${work.items.length} items, ${work.data.spinoffs.length} spin-offs loaded (home ${HOME})`);
}
