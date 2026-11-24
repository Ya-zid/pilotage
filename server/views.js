// Read models for the UI: everything the client renders comes from here.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';
import { clip, oneLine, isoDay, isInside, plain, dejargonAll, redact } from './util.js';
import { isAutomation, automationKey, listDocs, detectStack } from './sources/projects.js';
import { ownPrompts, ownUsage } from './sources/sessions.js';
import { WORKSPACE_DISPLAY } from './workspaces.js';
import { shortTitle } from './work/extract.js';

const DAY = 86400e3;

/** Auto titles that say nothing about the work. */
const GENERIC_TITLE = /^(?:greetings?|hello|hi|hey|hi there|hello there|untitled(?: session)?|new (?:chat|session|conversation)|quick question|test(?:ing)?|session start|(?:casual|initial|simple|friendly) greeting|general (?:chat|question)|introduction|small talk)\b[\s.!?]*$/i;


/** [start, end) of a local calendar day: 23 or 25 hours on DST days, so day detail matches the heatmap (tested). */
export function dayRange(day) {
  const s = new Date(`${day}T00:00:00`);
  const e = new Date(s);
  e.setDate(e.getDate() + 1);
  return [s.getTime(), e.getTime()];
}

export class Views {
  constructor({ index, registry, store, live, ai, processes }) {
    this.index = index;
    this.registry = registry;
    this.store = store;
    this.live = live;
    this.ai = ai;
    this.processes = processes; // () => list
    this.stackCache = new Map();
  }

  stackOf(p) {
    const c = this.stackCache.get(p.path);
    if (c && Date.now() < c.until) return c.stack;
    const stack = detectStack(p.path);
    // staggered expiry so all projects don't re-scan at the same moment
    this.stackCache.set(p.path, { until: Date.now() + (30 + Math.random() * 30) * 60e3, stack });
    return stack;
  }

  workspaceName(key) {
    return this.store.data.workspaces[key]?.name || WORKSPACE_DISPLAY(key);
  }

  effectiveStatus(p) {
    const user = this.store.project(p.path).status;
    if (user) return user;
    const age = Date.now() - (this.lastActivity(p) || 0);
    if (age < 14 * DAY) return 'active';
    if (age < 60 * DAY) return 'idle';
    return 'dormant';
  }

  /** The user's own activity: their sessions and their own commits (not teammates' commits pulled into a clone). */
  lastActivity(p) {
    const g = this.registry.gitOf(p.path);
    let mine = 0;
    if (g.extras?.commitDays) {
      const days = Object.keys(g.extras.commitDays).sort();
      if (days.length) mine = Math.min(Date.now(), Date.parse(`${days[days.length - 1]}T18:00:00`));
    } else if (g.status?.ok) mine = g.status.lastCommitAt || 0;
    return Math.max(p.lastAt || 0, mine);
  }

  // ---------- sessions ----------

  /** One title per session, used everywhere (lists, timeline, threads, live). */
  sessionTitle(meta, latestDigest) {
    const over = this.store.session(meta.id).title;
    if (over) return over;
    if (isAutomation(meta)) return automationKey(meta).replace(/^./, (c) => c.toUpperCase());
    if (meta.customTitle) return meta.customTitle;
    if (meta.aiTitle && !GENERIC_TITLE.test(meta.aiTitle.trim())) return meta.aiTitle;
    // Claude Code's auto title is generic ("Greeting") or missing: the AI summary of the work says more.
    const d = latestDigest || this.latestDigest(meta);
    if (d?.title) return d.title;
    if (meta.summaryTitle && !GENERIC_TITLE.test(meta.summaryTitle.trim())) return meta.summaryTitle;
    return meta.aiTitle || meta.summaryTitle || clip(plain(meta.firstPrompt || meta.lastPrompt || ''), 90) || 'Untitled session';
  }

  latestDigest(meta) {
    const b = this.latestBlock(meta);
    const d = b ? this.ai.state.blocks[b.key]?.digest || null : null;
    return d ? dejargonAll(d) : null;
  }

  /** Display-ready block: never a raw prompt as title, markdown stripped, live flag set (latest block of a live session only). */
  displayBlock(meta, b) {
    const v = this.ai.blockView(meta, b);
    const all = this.ai.blocksOf(meta);
    const p = this.registry.projectOfSession(meta);
    const sessionTitle = this.sessionTitle(meta, null);
    return {
      ...v,
      title: v.digest?.title || sessionTitle,
      sessionTitle,
      lastText: clip(plain(v.lastText), 280),
      fallbackTitle: sessionTitle,
      projectId: p?.id || null,
      projectName: p ? this.store.project(p.path).name || p.name : null,
      // Older blocks of a running session are finished work: they keep their own status, not the live dot.
      live: !!this.live.get(meta.id)?.live && all[all.length - 1]?.key === b.key,
    };
  }

  sessionKind(meta) {
    if (isAutomation(meta)) return 'automation';
    if (meta.archived) return 'archived';
    return 'interactive';
  }

  latestBlock(meta) {
    if (isAutomation(meta)) return null;
    const blocks = this.ai.blocksOf(meta);
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  sessionSummary(meta) {
    const project = this.registry.projectOfSession(meta);
    const lb = this.latestBlock(meta);
    const d = lb ? this.ai.digestOf(lb.key) : null;
    const live = this.live.get(meta.id);
    const r = project ? this.registry.resolve(meta.cwd) : null;
    const models = Object.entries(meta.models || {}).sort((a, b) => b[1] - a[1]);
    const userOver = this.store.session(meta.id);
    return {
      id: meta.id,
      title: this.sessionTitle(meta, d),
      kind: this.sessionKind(meta),
      source: meta.source,
      projectId: project?.id || null,
      projectName: project ? this.store.project(project.path).name || project.name : null,
      workspace: project?.workspace || null,
      cwd: meta.cwd,
      worktree: r?.worktree ? path.basename(r.worktree) : null,
      branch: meta.gitBranch,
      startedAt: meta.startedAt,
      lastAt: meta.lastAt,
      humanPrompts: ownPrompts(meta),
      turns: meta.turnCount || 0,
      lastPrompt: clip(plain(meta.lastPrompt || ''), 260),
      recap: meta.awaySummary ? clip(meta.awaySummary, 400) : null,
      recapAt: meta.awayAt || 0,
      digest: d ? { title: d.title, summary: d.summary, outcome: d.outcome, status: d.status, nextStep: d.nextStep, todo: d.nextStep ? shortTitle(d.todo, d.nextStep) : '', who: d.who || null, topic: d.topic } : null,
      blocks: isAutomation(meta) ? 0 : this.ai.blocksOf(meta).length,
      automation: isAutomation(meta) ? automationKey(meta) : null,
      model: models[0]?.[0] || null,
      prs: (meta.prs || []).slice(-10),
      compactions: meta.compactions || 0,
      live: live && live.live ? { status: live.status, state: live.state, kind: live.kind, bgId: live.bgId, detail: live.detail, bridgeUrl: live.bridgeUrl, name: live.name, pid: live.pid } : null,
      pinned: !!userOver.pinned,
      hidden: !!userOver.hidden,
      harness: meta.harness || 'claude',
      account: meta.accountUuid ? String(meta.accountUuid).slice(0, 8) : null,
      tokens: tokensOf(meta),
    };
  }

  sessionDetail(id) {
    const meta = this.index.get(id);
    if (!meta) return null;
    const sum = this.sessionSummary(meta);
    const blocks = isAutomation(meta) ? [] : this.ai.blocksOf(meta).map((b) => this.displayBlock(meta, b));
    const live = this.live.get(meta.id);
    const files = Object.entries(meta.files || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([f, n]) => ({ path: f, n }));
    const tools = Object.entries(meta.tools || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, n]) => ({ name, n }));
    const project = this.registry.projectOfSession(meta);
    const threads = project ? this.threadsOf(project) : [];
    const myThreads = threads.filter((t) => t.blockKeys.some((k) => k.startsWith(`${meta.id}:`))).map((t) => t.name);
    return {
      ...sum,
      firstPrompt: meta.firstPrompt,
      blocksDetail: blocks,
      files,
      tools,
      counts: meta.counts,
      outTokens: ownUsage(meta)?.usage.out ?? meta.outTokens, // a fork's copied replies are its parent's
      models: meta.models,
      version: meta.version,
      entrypoint: meta.entrypoint,
      archived: !!meta.archived,
      transcript: meta.file || null,
      sizeBytes: meta.size || 0,
      liveRaw: live || null,
      threads: myThreads,
      resumeCommand:
        sum.harness === 'codex' ? `cd ${shellPath(meta.cwd)} && codex resume ${String(meta.id).replace(/^codex-/, '')}` : sum.harness === 'gemini' ? `cd ${shellPath(meta.cwd)} && gemini --resume latest` : `cd ${shellPath(meta.cwd)} && claude --resume ${meta.id}`,
    };
  }

  turns(id, { before, limit = 60, includeSystem = false } = {}) {
    const all = this.index.loadTurns(id);
    const idx = [];
    for (let i = 0; i < all.length; i++) {
      const t = all[i];
      if (!includeSystem && (t.o === 'n' || t.o === 'c' || t.o === 'y') && !t.a) continue;
      idx.push(i);
    }
    let end = idx.length;
    if (before != null) {
      end = idx.findIndex((i) => i >= before);
      if (end === -1) end = idx.length;
    }
    const start = Math.max(0, end - limit);
    return {
      total: all.length,
      shown: idx.length,
      hasMore: start > 0,
      turns: idx.slice(start, end).map((i) => {
        const t = all[i];
        return { i, t: t.t, o: t.o, p: t.p, a: t.a, at: t.at, n: t.n, e: t.e, hasDetail: t.off >= 0 };
      }),
    };
  }

  listSessions({ projectId, q, kind, limit = 200, liveOnly, includeHidden, idPrefix } = {}) {
    let metas = this.index.list();
    if (idPrefix) metas = metas.filter((m) => m.id.startsWith(idPrefix));
    if (projectId) {
      const p = this.registry.byId(projectId);
      if (!p) return [];
      const ids = new Set(p.sessionIds);
      metas = metas.filter((m) => ids.has(m.id));
    }
    let out = metas.map((m) => this.sessionSummary(m));
    if (!includeHidden) out = out.filter((s) => !s.hidden);
    if (kind) out = out.filter((s) => s.kind === kind);
    if (liveOnly) out = out.filter((s) => s.live);
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter((s) => `${s.title} ${s.lastPrompt} ${s.projectName} ${s.digest?.summary || ''} ${s.automation || ''}`.toLowerCase().includes(needle));
    }
    out.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.lastAt - a.lastAt);
    return out.slice(0, limit);
  }

  // ---------- projects ----------

  threadsOf(project) {
    const brief = this.ai.state.projects[project.path]?.brief;
    const threads = (brief?.threads || []).map((t) => ({ ...t }));
    // Blocks not assigned by the brief (newer than it) → "Recent, not yet grouped"
    const assigned = new Set(threads.flatMap((t) => t.blockKeys));
    const loose = [];
    for (const id of project.sessionIds) {
      const meta = this.index.get(id);
      if (!meta || isAutomation(meta)) continue;
      for (const b of this.ai.blocksOf(meta)) if (!assigned.has(b.key)) loose.push(b.key);
    }
    if (loose.length) threads.push({ name: threads.length ? 'Newer work (not grouped yet)' : 'All work', summary: '', status: 'active', blockKeys: loose, loose: true });
    return threads;
  }

  /**
   * A first prompt for a fresh session that picks up where a long or compacted one left off: its AI summaries (no new
   * AI call), the next step it noted, the files it touched most and the last requests. Secrets are masked.
   */
  recapPrompt(id) {
    const meta = this.index.get(id);
    if (!meta) return null;
    const turns = this.index.loadTurns(id);
    const blocks = this.ai.blocksOf(meta).slice(-4);
    const digests = blocks.map((b) => this.ai.state.blocks[b.key]?.digest).filter(Boolean);
    const title = meta.customTitle || meta.aiTitle || meta.summaryTitle || 'an earlier session';
    const day = new Date(meta.lastAt || Date.now()).toISOString().slice(0, 10);
    const files = Object.entries(meta.files || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f]) => (meta.cwd && f.startsWith(`${meta.cwd}/`) ? f.slice(meta.cwd.length + 1) : f));
    const asks = turns.filter((t) => t.o === 'h' && t.p).slice(-3).map((t) => `"${oneLine(t.p).slice(0, 220)}"`);
    const lines = [`Continuing from an earlier session ("${title}", ${day}${meta.gitBranch ? `, branch ${meta.gitBranch}` : ''}). Its history is long${meta.compactions ? ` and was compacted ${meta.compactions} time${meta.compactions > 1 ? 's' : ''}` : ''}, so here is a recap instead:`];
    if (digests.length) for (const d of digests) lines.push(`- ${d.title}: ${d.outcome || d.summary}`);
    const next = [...digests].reverse().find((d) => d.nextStep)?.nextStep;
    if (next) lines.push(`- Next step it noted: ${next}`);
    if (files.length) lines.push(`- Files it worked on most: ${files.join(', ')}`);
    if (asks.length) lines.push(`- Last requests: ${asks.join(' / ')}`);
    lines.push('Look at the current state of those files (and git status) before changing anything, then continue from the next step. Ask me if something in this recap no longer matches the code.');
    return redact(lines.join('\n'));
  }

  /** Running sessions in the same checkout that edited the same files: they can overwrite each other's work. */
  collisionsOf(p) {
    const byCheckout = new Map();
    for (const id of p.sessionIds) {
      if (!this.live.get(id)?.live) continue;
      const meta = this.index.get(id);
      if (!meta?.cwd) continue;
      const r = this.registry.resolve(meta.cwd);
      const checkout = r?.worktree || r?.root || meta.cwd;
      if (!byCheckout.has(checkout)) byCheckout.set(checkout, []);
      byCheckout.get(checkout).push(meta);
    }
    const out = [];
    for (const [checkout, metas] of byCheckout) {
      if (metas.length < 2) continue;
      const shared = new Map();
      for (const m of metas) for (const f of Object.keys(m.files || {})) shared.set(f, (shared.get(f) || 0) + 1);
      const both = [...shared].filter(([, n]) => n > 1).map(([f]) => path.relative(checkout, f) || f);
      if (!both.length) continue;
      const names = both.slice(0, 3).join(', ') + (both.length > 3 ? ` and ${both.length - 3} more` : '');
      out.push({ kind: 'collision', severity: 'warn', text: `${metas.length} running sessions in ${path.basename(checkout)} are editing the same files (${names}): give one its own worktree`, sessionIds: metas.map((m) => m.id) });
    }
    return out;
  }

  signalsOf(p, procs) {
    const out = [];
    const now = Date.now();
    const st = this.registry.gitOf(p.path).status;
    const last = this.lastActivity(p);
    const status = this.effectiveStatus(p);
    const days = (t) => Math.round((now - t) / DAY);
    if (status === 'archived' || status === 'done') return out;
    out.push(...this.collisionsOf(p));
    const changes = st?.ok ? st.dirty + st.untracked : 0;
    if (changes > 0 && last && now - last > 5 * DAY && now - last < 120 * DAY) out.push({ kind: 'dirty', severity: 'warn', text: `${changes} uncommitted change${changes > 1 ? 's' : ''}, untouched for ${days(last)} days` });
    if (st?.ok && st.ahead > 0 && now - (st.lastCommitAt || 0) > 2 * DAY) out.push({ kind: 'unpushed', severity: 'warn', text: `${st.ahead} commit${st.ahead > 1 ? 's' : ''} on ${st.branch} not pushed` });
    const ex = this.registry.gitOf(p.path).extras;
    if (p.worktrees.size) {
      const merged = new Set(ex?.merged || []);
      let mergedClean = 0;
      let stale = 0;
      for (const w of p.worktrees.values()) {
        const ws = this.registry.gitOf(w.path).status;
        if (!ws?.ok) continue;
        if (ws.branch && merged.has(ws.branch) && !ws.dirty && !ws.untracked) mergedClean++;
        else if (now - Math.max(w.lastAt || 0, ws.lastCommitAt || 0) > 10 * DAY) stale++;
      }
      if (mergedClean >= 2) out.push({ kind: 'worktrees', severity: 'info', text: `${mergedClean} worktrees are merged and clean (safe to clean up)` });
      if (stale >= 2) out.push({ kind: 'worktrees-stale', severity: 'info', text: `${stale} worktrees untouched for 10+ days` });
    }
    const mine = (procs || []).filter((x) => x.projectPath === p.path);
    const old = mine.filter((x) => now - (x.startedAt || now) > DAY);
    const gone = old.filter((x) => x.deleted);
    if (gone.length) out.push({ kind: 'servers', severity: 'warn', text: `${gone.length} dev server${gone.length > 1 ? 's' : ''} still running from deleted folders (ports ${gone.flatMap((x) => x.ports).join(', ')})` });
    else if (old.length) out.push({ kind: 'servers', severity: 'info', text: `${old.length} dev server${old.length > 1 ? 's' : ''} running for over a day (ports ${old.flatMap((x) => x.ports).join(', ')})` });
    // Work left in progress
    const blocks = [];
    for (const id of p.sessionIds) {
      const meta = this.index.get(id);
      if (!meta || isAutomation(meta)) continue;
      const bl = this.ai.blocksOf(meta);
      if (bl.length) blocks.push({ meta, b: bl[bl.length - 1] });
    }
    blocks.sort((a, b) => b.b.endAt - a.b.endAt);
    for (const { meta, b } of blocks.slice(0, 6)) {
      const d = this.ai.digestOf(b.key);
      if (!d) continue;
      const age = now - b.endAt;
      if ((d.status === 'in_progress' || d.status === 'blocked') && age > 3 * DAY && age < 45 * DAY && !this.live.get(meta.id)?.live) {
        out.push({ kind: 'left', severity: 'info', text: `Left ${d.status === 'blocked' ? 'blocked' : 'in progress'} ${days(b.endAt)} days ago: ${d.title}`, sessionId: meta.id });
        break;
      }
    }
    if (status === 'active' && this.store.project(p.path).status === 'active' && now - last > 14 * DAY) out.push({ kind: 'idle', severity: 'info', text: `Marked active but no activity for ${days(last)} days` });
    return out;
  }

  projectSummary(p, procs) {
    const over = this.store.project(p.path);
    const st = this.registry.gitOf(p.path).status;
    const brief = this.ai.state.projects[p.path]?.brief;
    let liveCount = 0;
    const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
    let counted = 0;
    for (const id of p.sessionIds) {
      if (this.live.get(id)?.live) liveCount++;
      const t = tokensOf(this.index.meta.get(id));
      if (t) {
        counted++;
        for (const k in tokens) tokens[k] += t[k];
      }
    }
    const stack = this.stackOf(p);
    p.stack = stack;
    const ws = over.workspace || p.workspace;
    return {
      id: p.id,
      path: p.path,
      displayPath: p.path.replace(HOME, '~'),
      name: over.name || p.name,
      folderName: path.basename(p.path),
      workspace: ws,
      workspaceName: this.workspaceName(ws),
      isGit: p.isGit,
      isWorkspaceRoot: !!p.isWorkspaceRoot,
      windows: !!p.windows,
      status: this.effectiveStatus(p),
      userStatus: over.status || null,
      pinned: !!over.pinned,
      color: over.color || null,
      lastAt: this.lastActivity(p),
      lastSessionAt: p.lastAt || 0,
      firstAt: p.firstAt || 0,
      sessionCount: p.sessionIds.length,
      humanPrompts: p.humanPrompts,
      automationRuns: p.automationRuns,
      liveCount,
      worktreeCount: p.worktrees.size,
      git: st?.ok
        ? { branch: st.branch, dirty: st.dirty, untracked: st.untracked, ahead: st.ahead, behind: st.behind, lastCommitAt: st.lastCommitAt, lastCommitMsg: st.lastCommitMsg, webUrl: st.webUrl, commits30d: st.commits30d }
        : null,
      oneLiner: over.oneLiner || brief?.oneLiner || null,
      stack,
      attention: this.signalsOf(p, procs),
      threadCount: brief?.threads?.length || 0,
      hasBrief: !!brief,
      tokens: counted ? tokens : null, // all time, the sessions whose usage is recorded (Claude Code)
    };
  }

  listProjects({ includeHidden = false } = {}) {
    const procs = this.processes();
    const out = [];
    for (const p of this.registry.projects.values()) {
      const over = this.store.project(p.path);
      if (over.hidden && !includeHidden) continue;
      out.push(this.projectSummary(p, procs));
    }
    out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.lastAt - a.lastAt);
    return out;
  }

  projectDetail(id) {
    const p = this.registry.byId(id);
    if (!p) return null;
    const procs = this.processes();
    const sum = this.projectSummary(p, procs);
    const over = this.store.project(p.path);
    const git = this.registry.gitOf(p.path);
    const aiEntry = this.ai.state.projects[p.path];
    const brief = aiEntry?.brief || null;
    const sessions = this.listSessions({ projectId: id, limit: 1000, includeHidden: true });
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const blockMeta = new Map();
    for (const s of sessions) {
      const meta = this.index.get(s.id);
      if (!meta || isAutomation(meta)) continue;
      for (const b of this.ai.blocksOf(meta)) blockMeta.set(b.key, this.displayBlock(meta, b));
    }
    const threads = this.threadsOf(p).map((t) => {
      const blocks = t.blockKeys.map((k) => blockMeta.get(k)).filter(Boolean).sort((a, b) => b.endAt - a.endAt);
      return {
        name: t.name,
        summary: t.summary,
        status: t.status,
        loose: !!t.loose,
        lastAt: blocks[0]?.endAt || 0,
        firstAt: blocks.length ? blocks[blocks.length - 1].startAt : 0,
        blocks: blocks.map((b) => ({ ...b, sessionTitle: sessionsById.get(b.sessionId)?.title || '' })),
      };
    });
    threads.sort((a, b) => (a.loose ? 1 : 0) - (b.loose ? 1 : 0) || b.lastAt - a.lastAt);
    const automations = {};
    for (const s of sessions.filter((x) => x.kind === 'automation')) {
      const k = s.automation || 'Automation';
      const a = (automations[k] = automations[k] || { name: k, runs: 0, lastAt: 0, lastResult: '', lastSessionId: null });
      a.runs++;
      if (s.lastAt > a.lastAt) {
        a.lastAt = s.lastAt;
        const turns = this.index.loadTurns(s.id);
        const lastA = [...turns].reverse().find((t) => t.a)?.a || '';
        a.lastResult = clip(plain(lastA), 600);
        a.lastSessionId = s.id;
      }
    }
    const merged = new Set(git.extras?.merged || []);
    const worktrees = [...p.worktrees.values()].map((w) => {
      const ws = this.registry.gitOf(w.path).status || {};
      return {
        path: w.path,
        name: w.name,
        branch: ws.branch || null,
        dirty: ws.dirty || 0,
        untracked: ws.untracked || 0,
        ahead: ws.ahead || 0,
        lastCommitAt: ws.lastCommitAt || 0,
        lastCommitMsg: ws.lastCommitMsg || '',
        missing: !!ws.missing,
        merged: !!(ws.branch && merged.has(ws.branch)),
        sessions: w.sessionIds.length,
        lastAt: Math.max(w.lastAt || 0, ws.lastCommitAt || 0),
        servers: procs.filter((x) => x.worktree === w.path).map((x) => ({ pid: x.pid, ports: x.ports })),
      };
    });
    worktrees.sort((a, b) => b.lastAt - a.lastAt);
    return {
      ...sum,
      notes: over.notes || '',
      links: over.links || [],
      hidden: !!over.hidden,
      brief: brief ? dejargonAll(brief) : brief,
      briefAt: aiEntry?.at || 0,
      briefError: aiEntry?.lastError || null,
      threads,
      automations: Object.values(automations).sort((a, b) => b.lastAt - a.lastAt),
      sessions,
      worktrees,
      docs: listDocs(p, [...(p.projectKeys || [])]).map((d) => ({ ...d, path: d.path })),
      gitExtras: git.extras ? { defaultBranch: git.extras.defaultBranch, recentLog: git.extras.recentLog, firstCommitAt: git.extras.firstCommitAt } : null,
      gitFull: git.status || null,
      processes: procs.filter((x) => x.projectPath === p.path),
      cv: this.ai.state.cv[p.path] || null,
      portfolio: over.portfolio || null,
    };
  }

  // ---------- overview / timeline ----------

  attentionAll(projects) {
    const out = [];
    for (const p of projects) for (const a of p.attention) out.push({ ...a, projectId: p.id, projectPath: p.path, projectName: p.name, lastAt: p.lastAt });
    const weight = { left: 0, dirty: 1, unpushed: 2, servers: 3, idle: 4, worktrees: 5, 'worktrees-stale': 6 };
    out.sort((a, b) => (weight[a.kind] ?? 9) - (weight[b.kind] ?? 9) || b.lastAt - a.lastAt);
    return out;
  }

  activityByDay(days = 400) {
    const map = new Map();
    const since = Date.now() - days * DAY;
    const bump = (day, key, projectPath, n = 1) => {
      let d = map.get(day);
      if (!d) {
        d = { day, prompts: 0, commits: 0, sessions: new Set(), projects: {} };
        map.set(day, d);
      }
      d[key] += n;
      if (projectPath) {
        const pp = (d.projects[projectPath] = d.projects[projectPath] || { prompts: 0, commits: 0 });
        pp[key] += n;
      }
      return d;
    };
    const projOf = (cwd) => {
      const r = this.registry.resolve(cwd);
      return r ? r.root : null;
    };
    const seenPrompt = new Set();
    // Transcript prompts (cover sessions history.jsonl misses, e.g. automation runs)
    for (const meta of this.index.list()) {
      if (meta.archived) continue;
      if ((meta.lastAt || 0) < since) continue; // don't load turns of sessions outside the window
      const pr = projOf(meta.cwd);
      const turns = this.index.loadTurns(meta.id);
      for (let i = meta.inherited?.n || 0; i < turns.length; i++) {
        const t = turns[i]; // (a fork's copied first turns are counted in its parent)
        if (t.o !== 'h' && t.o !== 's') continue;
        if (!t.t || t.t < since) continue;
        const d = bump(isoDay(t.t), 'prompts', pr);
        d.sessions.add(meta.id);
        seenPrompt.add(`${meta.id}:${Math.round(t.t / 1000)}`);
      }
    }
    for (const h of this.index.allHistoryPrompts()) {
      if (!h.t || h.t < since) continue;
      if (this.index.meta.has(h.id)) continue; // already counted from its transcript
      const d = bump(isoDay(h.t), 'prompts', projOf(h.cwd));
      d.sessions.add(h.id);
    }
    for (const p of this.registry.projects.values()) {
      const cd = this.registry.gitOf(p.path).extras?.commitDays || {};
      for (const [day, n] of Object.entries(cd)) {
        if (Date.parse(day) < since) continue;
        bump(day, 'commits', p.path, n);
      }
    }
    return [...map.values()]
      .map((d) => ({ ...d, sessions: d.sessions.size }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  dayDetail(day) {
    const [start, end] = dayRange(day);
    return { day, blocks: this.blocksBetween(start, end) };
  }

  /** Work blocks and automation runs that overlap [start, end), oldest first (History's day view, standups). */
  blocksBetween(start, end) {
    const blocks = [];
    for (const meta of this.index.list()) {
      if (meta.lastAt < start || meta.startedAt > end) continue;
      if (this.store.session(meta.id).hidden) continue;
      if (isAutomation(meta)) {
        const p = this.registry.projectOfSession(meta);
        blocks.push({ kind: 'automation', sessionId: meta.id, title: this.sessionTitle(meta, null), startAt: meta.startedAt, endAt: meta.lastAt, project: p?.id || null, projectId: p?.id || null, projectName: p ? this.store.project(p.path).name || p.name : null });
        continue;
      }
      for (const b of this.ai.blocksOf(meta)) {
        if (b.endAt < start || b.startAt > end) continue;
        const v = this.displayBlock(meta, b);
        blocks.push({ kind: 'block', ...v, project: v.projectId });
      }
    }
    blocks.sort((a, b) => a.startAt - b.startAt);
    return blocks;
  }

  /**
   * What was worked on in [from, to), per project (most recent first), from the work blocks' AI summaries; a block
   * without one shows its session title. One line per piece of work: a session's unsummarized blocks merge, and so do
   * summaries with the same title (the later one wins). Plus the running sessions waiting for the user.
   */
  standup({ from, to, projectId = null }) {
    const groups = new Map();
    for (const b of this.blocksBetween(from, to)) {
      if (b.kind !== 'block' || (projectId && b.projectId !== projectId)) continue;
      const p = b.projectId ? this.registry.byId(b.projectId) : null;
      if (p && this.store.project(p.path).hidden) continue;
      let g = groups.get(b.projectId || '');
      if (!g) groups.set(b.projectId || '', (g = { id: b.projectId || null, name: b.projectName || 'Other folders', lastAt: 0, items: [], seen: new Map() }));
      const d = b.digest;
      const title = oneLine(plain(d?.title || '')) || b.sessionTitle;
      const item = {
        title,
        status: d?.status || null,
        detail: d ? clip(plain(d.outcome || d.summary || ''), 240) : '',
        next: d && d.status !== 'done' && d.nextStep ? shortTitle(d.todo, d.nextStep) : '',
        summarized: !!d,
        sessionId: b.sessionId,
        sessionTitle: b.sessionTitle,
        startAt: b.startAt,
        endAt: b.endAt,
        live: !!b.live,
      };
      const key = d ? `t:${title.toLowerCase()}` : `s:${b.sessionId}`;
      const prev = g.seen.get(key);
      if (prev) Object.assign(prev, item, { startAt: prev.startAt });
      else {
        g.items.push(item);
        g.seen.set(key, item);
      }
      g.lastAt = Math.max(g.lastAt, b.endAt || 0);
    }
    const projects = [...groups.values()].sort((a, b) => b.lastAt - a.lastAt).map(({ seen, ...g }) => g);
    const waiting = this.listSessions({ liveOnly: true, limit: 100 })
      .filter((s) => needsYou(s) && (!projectId || s.projectId === projectId))
      .map((s) => ({ id: s.id, title: s.title, projectId: s.projectId, projectName: s.projectName, detail: s.live.detail || 'Waiting for you', bridgeUrl: s.live.bridgeUrl || null }));
    return { projects, needsYou: waiting };
  }

  /**
   * Tokens spent in the local days from..to (YYYY-MM-DD, inclusive): per day, per project and the top sessions, from
   * each session's per-day usage in the index. Every session counts, automations and hidden ones included: they spent
   * the tokens. `pending`: Claude sessions not counted yet (older index entries the background backfill hasn't reached).
   */
  usage({ fromDay, toDay, projectId = null, top = 10 }) {
    const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });
    const add = (t, u) => {
      t.input += u[0];
      t.output += u[1];
      t.cacheWrite += u[2];
      t.cacheRead += u[3];
      t.total += u[0] + u[1] + u[2] + u[3];
    };
    const days = new Map();
    for (let d = new Date(`${fromDay}T12:00:00`); isoDay(d) <= toDay; d.setDate(d.getDate() + 1)) days.set(isoDay(d), { day: isoDay(d), ...zero() });
    const totals = zero();
    const projects = new Map();
    const sessions = [];
    for (const meta of this.index.list()) {
      const usageDays = ownUsage(meta)?.usageDays; // a fork's copied lines count in its parent only
      if (!usageDays) continue;
      const p = this.registry.projectOfSession(meta);
      if (projectId && p?.id !== projectId) continue;
      const st = zero();
      for (const [day, u] of Object.entries(usageDays)) {
        if (day < fromDay || day > toDay) continue;
        add(st, u);
        add(days.get(day), u);
      }
      if (!st.total) continue;
      for (const k in totals) totals[k] += st[k];
      const key = p?.id || '';
      let g = projects.get(key);
      if (!g) projects.set(key, (g = { id: p?.id || null, name: p ? this.store.project(p.path).name || p.name : 'Other folders', ...zero(), sessions: 0 }));
      for (const k in st) g[k] += st[k];
      g.sessions++;
      sessions.push({ meta, p, t: st });
    }
    sessions.sort((a, b) => b.t.total - a.t.total);
    return {
      fromDay,
      toDay,
      totals,
      days: [...days.values()],
      projects: [...projects.values()].sort((a, b) => b.total - a.total),
      sessions: sessions.slice(0, top).map(({ meta, p, t }) => ({ id: meta.id, title: this.sessionTitle(meta, null), projectId: p?.id || null, projectName: p ? this.store.project(p.path).name || p.name : null, lastAt: meta.lastAt, kind: this.sessionKind(meta), ...t })),
      pending: this.index.usagePending ? this.index.usagePending() : 0,
    };
  }

  /**
   * Today's brief for display. The model refers to projects by prompt ids ("p3"); show each project's display
   * name instead, in the item labels and in the text (also fixes briefs stored before this mapping existed).
   */
  dailyView(daily) {
    const b = daily.brief || {};
    const items = [...(b.focus || []), ...(b.forgotten || [])];
    const nameOf = (f) => {
      const p = f.projectPath ? this.registry.projects.get(f.projectPath) : null;
      return { p, name: p ? this.store.project(p.path).name || p.name : f.projectPath ? path.basename(f.projectPath) : '' };
    };
    const ids = new Map();
    for (const f of items) {
      const id = typeof f.project === 'string' ? f.project.trim().toLowerCase() : '';
      const { name } = nameOf(f);
      if (/^p\d+$/.test(id) && name) ids.set(id, name);
    }
    const text = (s) => (typeof s === 'string' && ids.size ? s.replace(/\bp\d+\b/g, (m) => ids.get(m) || m) : s);
    const item = (f) => {
      const { p, name } = nameOf(f);
      const raw = typeof f.project === 'string' ? f.project.trim() : '';
      const out = { ...f, project: name || (/^p\d+$|^\?$/i.test(raw) ? '' : raw), projectId: p?.id || null };
      for (const k of ['title', 'why', 'action', 'note']) if (k in out) out[k] = text(out[k]);
      return out;
    };
    return {
      ...b,
      headline: text(b.headline),
      ideas: (b.ideas || []).map(text),
      day: daily.day,
      at: daily.at,
      focus: (b.focus || []).map(item),
      forgotten: (b.forgotten || []).map(item),
    };
  }

  overview(projects) {
    const now = Date.now();
    const live = this.listSessions({ liveOnly: true, limit: 50 });
    // Continue where you left off: latest blocks of recent sessions
    const recent = [];
    for (const meta of this.index.list()) {
      if (isAutomation(meta) || now - meta.lastAt > 10 * DAY) continue;
      if (this.store.session(meta.id).hidden) continue;
      if (this.live.get(meta.id)?.live) continue; // already shown under "Live now"
      const bl = this.ai.blocksOf(meta);
      const b = bl[bl.length - 1];
      if (!b) continue;
      recent.push(this.displayBlock(meta, b));
    }
    recent.sort((a, b) => b.endAt - a.endAt);
    const activity = this.activityByDay(28);
    const automations = [];
    for (const meta of this.index.list()) if (isAutomation(meta) && now - meta.lastAt < 2 * DAY) automations.push(meta);
    const daily = this.ai.state.daily;
    return {
      now,
      live,
      recent: recent.slice(0, 14),
      attention: this.attentionAll(projects).slice(0, 14),
      activity,
      daily: daily ? dejargonAll(this.dailyView(daily)) : null,
      ideas: (this.store.data.ideas || []).filter((x) => !x.doneAt).slice(-6).reverse(),
      pickup: this.pickup(projects),
      counts: {
        projects: projects.length,
        activeProjects: projects.filter((p) => p.status === 'active').length,
        sessions: this.index.list().length,
        interactive: this.index.list().filter((m) => !isAutomation(m) && !m.archived && !this.store.session(m.id).hidden).length,
        archived: this.index.list().filter((m) => !isAutomation(m) && m.archived).length,
        automated: this.index.list().filter((m) => isAutomation(m)).length,
        automationRuns48h: automations.length,
      },
      automationsRecent: automations
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, 6)
        .map((m) => ({ id: m.id, name: automationKey(m), lastAt: m.lastAt, projectId: this.registry.projectOfSession(m)?.id || null, result: clip(plain([...this.index.loadTurns(m.id)].reverse().find((t) => t.a)?.a || ''), 220) })),
    };
  }

  /** Home › Pick up: sessions you can resume, newest first. Merges "where you left off" (last 10 days) with work
   *  left in progress longer ago ("Gone quiet N d"). Live sessions are shown elsewhere; "Not now" hides a row until
   *  that session has new activity. */
  pickup(projects, limit = 6) {
    const now = Date.now();
    const hidden = this.store.data.pickupHidden || {};
    const known = new Set(projects.map((p) => p.id));
    const out = [];
    const seen = new Set();
    const add = (meta, { onlyOpen }) => {
      if (!meta || seen.has(meta.id) || isAutomation(meta) || this.store.session(meta.id).hidden) return;
      if (this.live.get(meta.id)?.live) return;
      const h = hidden[`s:${meta.id}`];
      if (h && h >= (meta.lastAt || 0)) return;
      const p = this.registry.projectOfSession(meta);
      if (!p || !known.has(p.id)) return;
      const d = this.latestDigest(meta);
      if (onlyOpen && (!d || (d.status === 'done' && !d.nextStep))) return;
      seen.add(meta.id);
      const age = now - (meta.lastAt || now);
      out.push({
        key: `s:${meta.id}`,
        kind: 'session',
        sessionId: meta.id,
        title: this.sessionTitle(meta, d),
        projectId: p.id,
        projectName: this.store.project(p.path).name || p.name,
        workspace: p.workspace || null,
        summary: clip(plain(d?.outcome || d?.summary || meta.lastPrompt || ''), 240),
        nextStep: clip(plain(d?.nextStep || ''), 180), // Claude-facing (the Resume prompt's context)
        todo: d?.nextStep ? shortTitle(d.todo, d.nextStep) : '', // the same step as a short to-do, for the row
        status: d?.status || null,
        lastAt: meta.lastAt,
        quietDays: age < 3 * DAY ? 0 : Math.floor(age / DAY),
        resumable: !meta.archived,
      });
    };
    const metas = this.index.list().slice().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    // 1. unfinished work from the last 10 days
    for (const m of metas) if (now - m.lastAt <= 10 * DAY) add(m, { onlyOpen: true });
    // 2. work left in progress longer ago (the old "Needs attention")
    for (const a of this.attentionAll(projects)) if (a.kind === 'left' && a.sessionId) add(this.index.get(a.sessionId), { onlyOpen: false });
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
  }

  search(q) {
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return { projects: [], sessions: [], ideas: [] };
    const projects = this.listProjects({ includeHidden: true })
      .filter((p) => `${p.name} ${p.folderName} ${p.displayPath} ${p.oneLiner || ''} ${p.workspaceName} ${p.stack.join(' ')}`.toLowerCase().includes(needle))
      .slice(0, 12);
    const sessions = [];
    // Newest first, so the cap keeps the most recent matches (the index is in insertion order, newest sessions last).
    const metas = this.index.list().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    for (const meta of metas) {
      const s = this.sessionSummary(meta);
      let hit = `${s.title} ${s.digest?.summary || ''} ${s.digest?.outcome || ''} ${s.digest?.nextStep || ''} ${s.digest?.topic || ''} ${s.recap || ''} ${s.lastPrompt}`.toLowerCase().includes(needle);
      let match = null;
      if (!hit) {
        const turns = this.index.loadTurns(meta.id);
        const t = turns.find((x) => (x.o === 'h' || x.o === 's') && x.p.toLowerCase().includes(needle));
        if (t) {
          hit = true;
          const i = t.p.toLowerCase().indexOf(needle);
          // start at a word boundary before the hit, with a leading … when the prompt was cut
          let from = Math.max(0, i - 60);
          if (from > 0) {
            const sp = t.p.lastIndexOf(' ', from);
            from = sp >= 0 && i - sp <= 90 ? sp + 1 : from;
          }
          match = clip((from > 0 ? '…' : '') + oneLine(t.p.slice(from, i + 140)), 200);
        }
      }
      if (hit) sessions.push({ ...s, match });
      if (sessions.length >= 30) break;
    }
    sessions.sort((a, b) => b.lastAt - a.lastAt);
    const ideas = (this.store.data.ideas || []).filter((x) => x.text.toLowerCase().includes(needle)).slice(0, 10);
    return { projects, sessions, ideas };
  }

  portfolio() {
    const projects = this.listProjects({ includeHidden: false });
    return projects
      .filter((p) => !p.isWorkspaceRoot || p.sessionCount > 0)
      .map((p) => {
        const reg = this.registry.byId(p.id);
        const git = this.registry.gitOf(p.path);
        const over = this.store.project(p.path);
        const brief = this.ai.state.projects[p.path]?.brief;
        const cvGen = this.ai.state.cv[p.path] || null;
        const first = Math.min(...[reg.firstAt, git.extras?.firstCommitAt].filter((x) => x > 0), Infinity);
        const highlights = Object.values(this.ai.state.blocks)
          .filter((b) => b.projectPath === p.path && b.digest?.cvWorthy)
          .sort((a, b) => b.endAt - a.endAt)
          .flatMap((b) => b.digest.highlights || [])
          .slice(0, 8);
        return {
          ...p,
          periodStart: Number.isFinite(first) ? first : 0,
          periodEnd: p.lastAt,
          briefCv: brief?.cv || null,
          description: brief?.description || null,
          generated: cvGen,
          portfolio: over.portfolio || null,
          highlights,
          commits: Object.values(git.extras?.commitDays || {}).reduce((a, b) => a + b, 0),
        };
      });
  }
}

/**
 * A session's recorded token usage (Claude Code transcripts), or null: another harness, no transcript, or not counted
 * yet. A fork's copied lines are left out (they count in the parent).
 */
export function tokensOf(meta) {
  const u = ownUsage(meta)?.usage;
  if (!u || !meta.file || (meta.harness || 'claude') !== 'claude') return null;
  return { input: u.in, output: u.out, cacheWrite: u.cw, cacheRead: u.cr, total: u.in + u.out + u.cw + u.cr };
}

/** A running session waiting for the user (the web's "Needs you"): a terminal session asking for input or a permission,
 * or a background one that is blocked. Takes a sessionSummary(). */
export function needsYou(s) {
  if (!s?.live) return false;
  return s.live.kind === 'background' ? s.live.state === 'blocked' : s.live.status === 'waiting';
}

function shellPath(p) {
  return /^[\w/.~-]+$/.test(p || '') ? p : `'${String(p).replace(/'/g, `'\\''`)}'`;
}
