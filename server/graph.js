// The Map: one graph of the user's work, built only from what Pilotage already holds (no AI call, no disk read beyond
// the in-memory index). Contract: docs/API-GRAPH.md. Route: server/routes/graph.js (memo-cached, cleared by broadcast).
//
// Nodes: workspace, project, thread (a workstream of a project summary), topic (a digest topic shared by 2+ sessions),
// session (recent, capped), idea (saved ideas + open possible projects), task (To do / Doing), chat (claude.ai,
// sources/claude-ai.js), file (edited by 2+ sessions or 2+ projects).
import path from 'node:path';
import { HOME } from './config.js';
import { clip, hash, oneLine, plain, dejargon, isInside } from './util.js';
import { isAutomation } from './sources/projects.js';

const DAY = 86400e3;

/** Size caps. `nodes` is the hard one; the per-type caps keep one kind from crowding out the others. */
export const LIMITS = { nodes: 400, projects: 150, sessions: 160, threadsPerProject: 8, topics: 60, tasks: 80, ideas: 40, files: 40, chats: 80 };

/** Workspaces and projects are the skeleton: they're kept first, everything else competes on links and recency. */
const SKELETON = new Set(['workspace', 'project']);

/** Topics that group nothing. */
const GENERIC_TOPIC = new Set(['misc', 'miscellaneous', 'general', 'other', 'others', 'none', 'n a', 'na', 'unknown', 'greeting', 'greetings', 'small talk', 'chat', 'conversation']);

/** Agent folders: plans, todos and memory files there are Claude's bookkeeping, not the user's shared work. */
const AGENT_DIRS = ['.claude', '.codex', '.gemini'].map((d) => path.join(HOME, d));

export function foldTopic(s) {
  return oneLine(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const tilde = (p) => (isInside(p, HOME) ? `~${p.slice(HOME.length)}` : p);
const sessionOfKey = (key) => key.slice(0, key.lastIndexOf(':'));

/**
 * src: { index, registry, store, ai, views, live?, workItems?, spinoffs?, candidates?, chats? }
 *   workItems / spinoffs: data/work.json (work/store.js); candidates: scout.list() views; chats: claude.ai index entries
 *   ({ uuid, name, createdAt, updatedAt, messages, projectPaths }).
 * opts: days (0 = all time), projectId (that project's own nodes and everything they touch), now, limits.
 */
export function buildGraph(src, { days = 90, projectId = null, now = Date.now(), limits = LIMITS } = {}) {
  const { index, registry, store, ai, views } = src;
  const since = days > 0 ? now - days * DAY : 0;
  const span = days > 0 ? days * DAY : 365 * DAY;
  const fresh = (t) => (t ? Math.max(0, Math.min(1, 1 - (now - t) / span)) : 0);
  const nodes = new Map();
  const edges = [];
  const left = {};
  const drop = (type, n = 1) => {
    if (n > 0) left[type] = (left[type] || 0) + n;
  };
  const add = (n) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const link = (source, target, kind) => edges.push({ source, target, kind });
  const pName = (p) => store.project(p.path).name || p.name;
  const pWs = (p) => store.project(p.path).workspace || p.workspace || null;

  // ---- AI digests, read once: each session's newest digest, its topics, and when each block ended.
  const latest = new Map(); // sessionId -> { endAt, digest }
  const topicsOf = new Map(); // sessionId -> Map(fold -> label)
  const blockEnd = new Map(); // block key -> endAt
  for (const [key, b] of Object.entries(ai.state.blocks || {})) {
    if (!b) continue;
    blockEnd.set(key, b.endAt || 0);
    if (!b.digest) continue;
    const sid = b.sessionId || sessionOfKey(key);
    const cur = latest.get(sid);
    if (!cur || (b.endAt || 0) >= cur.endAt) latest.set(sid, { endAt: b.endAt || 0, digest: b.digest });
    const label = clip(oneLine(b.digest.topic), 50);
    const f = foldTopic(label);
    if (!f || f.length < 2 || GENERIC_TOPIC.has(f)) continue;
    if (!topicsOf.has(sid)) topicsOf.set(sid, new Map());
    topicsOf.get(sid).set(f, label);
  }

  // ---- what pulls a quiet project onto the map: open tasks, open ideas, possible projects, recent chats
  const workItems = (src.workItems || []).filter((it) => it.status === 'todo' || it.status === 'doing');
  const ideas = (store.data.ideas || []).filter((x) => x && !x.doneAt && x.text);
  const candidates = (src.candidates || []).filter((c) => c.status === 'new');
  const chats = (src.chats || []).filter((c) => c && c.uuid && (c.updatedAt || c.createdAt || 0) >= since);
  const wanted = new Set([...workItems.map((it) => it.projectPath), ...ideas.map((x) => x.projectPath), ...candidates.map((c) => c.projectPath), ...chats.flatMap((c) => c.projectPaths || [])].filter(Boolean));

  // ---- workspaces and projects
  let projects = [];
  for (const p of registry.projects.values()) {
    if (store.project(p.path).hidden) continue;
    const last = views.lastActivity(p);
    if (since && last < since && !wanted.has(p.path) && p.id !== projectId) continue;
    projects.push({ p, last });
  }
  projects.sort((a, b) => (b.p.id === projectId) - (a.p.id === projectId) || b.last - a.last);
  drop('project', projects.length - limits.projects);
  projects = projects.slice(0, limits.projects);
  const byPath = new Map(projects.map((x) => [x.p.path, x.p]));
  // One project: only its own sessions, workstreams, tasks, ideas and chats compete for the caps; the other projects
  // stay available as link ends (a spin-off, the workspace) and the final filter keeps the ones it touches.
  const focus = projectId ? projects.find((x) => x.p.id === projectId)?.p || null : null;
  const inFocus = (pp) => !projectId || (!!focus && pp === focus.path);
  const sessionProject = new Map(); // sessionId -> project
  for (const { p } of projects) if (inFocus(p.path)) for (const id of p.sessionIds || []) sessionProject.set(id, p);

  // sessions in the window, newest first
  const windowSessions = [];
  for (const id of sessionProject.keys()) {
    const meta = index.get(id);
    if (!meta || isAutomation(meta) || store.session(id).hidden) continue;
    if ((meta.lastAt || 0) < since) continue;
    windowSessions.push(meta);
  }
  windowSessions.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const perProject = new Map();
  for (const m of windowSessions) {
    const p = sessionProject.get(m.id);
    perProject.set(p.path, (perProject.get(p.path) || 0) + 1);
  }

  const wsCount = new Map();
  for (const { p } of projects) {
    const ws = pWs(p);
    if (ws) wsCount.set(ws, (wsCount.get(ws) || 0) + 1);
  }
  for (const [ws, n] of wsCount) add({ id: `ws:${ws}`, type: 'workspace', label: views.workspaceName(ws), sub: plural(n, 'project'), weight: n, href: `/projects?ws=${encodeURIComponent(ws)}` });
  for (const { p, last } of projects) {
    const n = perProject.get(p.path) || 0;
    const ws = pWs(p);
    add({ id: `p:${p.id}`, type: 'project', label: pName(p), sub: n ? plural(n, 'session') : views.workspaceName(ws || ''), weight: Math.max(1, n), href: `/projects/${p.id}`, projectId: p.id, at: last || 0 });
    if (ws) link(`ws:${ws}`, `p:${p.id}`, 'workspace');
  }

  // ---- sessions (recent, capped)
  const shown = windowSessions.slice(0, limits.sessions);
  drop('session', windowSessions.length - shown.length);
  const shownIds = new Set(shown.map((m) => m.id));
  for (const m of shown) {
    const p = sessionProject.get(m.id);
    const d = latest.get(m.id)?.digest || null;
    add({
      id: `s:${m.id}`,
      type: 'session',
      label: dejargon(views.sessionTitle(m, d || {})),
      sub: pName(p),
      weight: Math.max(1, m.counts?.h || 0),
      href: `/sessions/${encodeURIComponent(m.id)}`,
      projectId: p.id,
      at: m.lastAt || 0,
      ...(d?.status ? { status: d.status } : {}),
      ...(src.live?.get(m.id)?.live ? { live: true } : {}),
      ...(m.archived ? { archived: true } : {}),
    });
  }

  // ---- threads (a project summary's workstreams) → their sessions
  for (const { p } of projects) {
    if (!inFocus(p.path)) continue;
    const threads = ai.state.projects?.[p.path]?.brief?.threads || [];
    const list = [];
    for (const t of threads) {
      if (!t?.name) continue;
      const keys = Array.isArray(t.blockKeys) ? t.blockKeys : [];
      let at = 0;
      for (const k of keys) at = Math.max(at, blockEnd.get(k) || 0);
      if (since && at < since) continue;
      list.push({ t, keys, at });
    }
    list.sort((a, b) => b.at - a.at);
    drop('thread', list.length - limits.threadsPerProject);
    for (const { t, keys, at } of list.slice(0, limits.threadsPerProject)) {
      const id = `t:${hash(`${p.path}\n${t.name}`, 10)}`;
      add({ id, type: 'thread', label: clip(dejargon(oneLine(t.name)), 80), sub: pName(p), weight: Math.max(1, keys.length), href: `/projects/${p.id}?workstream=${encodeURIComponent(t.name)}`, projectId: p.id, at, ...(t.status ? { status: t.status } : {}) });
      link(`p:${p.id}`, id, 'thread');
      for (const sid of new Set(keys.map(sessionOfKey))) if (shownIds.has(sid)) link(id, `s:${sid}`, 'session');
    }
  }

  // ---- topics shared by 2+ sessions
  const topics = new Map(); // fold -> { labels: Map(label -> n), sessions: Set, projects: Map(pid -> n), at }
  for (const m of shown) {
    const p = sessionProject.get(m.id);
    for (const [f, label] of topicsOf.get(m.id) || []) {
      let t = topics.get(f);
      if (!t) topics.set(f, (t = { fold: f, labels: new Map(), sessions: new Set(), projects: new Map(), at: 0 }));
      t.labels.set(label, (t.labels.get(label) || 0) + 1);
      t.sessions.add(m.id);
      t.projects.set(p.id, (t.projects.get(p.id) || 0) + 1);
      t.at = Math.max(t.at, m.lastAt || 0);
    }
  }
  const shared = [...topics.values()].filter((t) => t.sessions.size >= 2).sort((a, b) => b.projects.size - a.projects.size || b.sessions.size - a.sessions.size || b.at - a.at);
  drop('topic', shared.length - limits.topics);
  for (const t of shared.slice(0, limits.topics)) {
    const id = `topic:${hash(t.fold, 10)}`;
    const label = [...t.labels].sort((a, b) => b[1] - a[1])[0][0];
    add({ id, type: 'topic', label, sub: `${plural(t.sessions.size, 'session')} · ${plural(t.projects.size, 'project')}`, weight: t.sessions.size, href: `/sessions?kind=all&q=${encodeURIComponent(label)}`, at: t.at });
    for (const sid of t.sessions) link(`s:${sid}`, id, 'topic');
    for (const [pid, n] of t.projects) if (n >= 2) link(`p:${pid}`, id, 'topic');
  }

  // ---- open tasks (To do / Doing): your commitments, not the AI's suggestions
  const tasks = workItems
    .filter((it) => byPath.has(it.projectPath) && inFocus(it.projectPath))
    .sort((a, b) => (b.status === 'doing') - (a.status === 'doing') || (b.updatedAt || 0) - (a.updatedAt || 0));
  drop('task', tasks.length - limits.tasks);
  for (const it of tasks.slice(0, limits.tasks)) {
    const p = byPath.get(it.projectPath);
    const id = `k:${it.id}`;
    add({ id, type: 'task', label: clip(oneLine(it.title), 120), sub: it.status === 'doing' ? 'Doing' : 'To do', weight: 1 + (it.priority || 0), href: `/tasks?open=${encodeURIComponent(it.id)}`, projectId: p.id, at: it.updatedAt || it.createdAt || 0, status: it.status });
    link(id, `p:${p.id}`, 'task');
    if (it.source?.sessionId && shownIds.has(it.source.sessionId)) link(id, `s:${it.source.sessionId}`, 'source');
  }

  // ---- ideas: saved ideas and open possible projects (the scout's), linked to their project
  const ideaNodes = [
    ...ideas.map((x) => ({ id: `i:${x.id}`, type: 'idea', label: clip(plain(x.text), 90), sub: 'Idea', weight: 1, href: '/ideas', projectPath: x.projectPath || null, at: x.createdAt || 0 })),
    ...candidates.map((c) => ({ id: `sc:${c.id}`, type: 'idea', label: clip(oneLine(c.title), 90), sub: 'Possible project', weight: 2, href: '/ideas', projectPath: c.projectPath || null, at: c.at || 0 })),
  ]
    .filter((x) => (projectId ? inFocus(x.projectPath) : !x.at || x.at >= since || byPath.has(x.projectPath)))
    .sort((a, b) => b.at - a.at);
  drop('idea', ideaNodes.length - limits.ideas);
  for (const { projectPath, ...n } of ideaNodes.slice(0, limits.ideas)) {
    const p = projectPath ? byPath.get(projectPath) : null;
    add({ ...n, ...(p ? { projectId: p.id } : {}) });
    if (p) link(n.id, `p:${p.id}`, 'idea');
  }

  // ---- spin-offs: the project a new one came out of
  for (const r of src.spinoffs || []) {
    const a = r?.from ? byPath.get(r.from) : null;
    const b = r?.to ? byPath.get(r.to) : null;
    if (a && b && a !== b) link(`p:${a.id}`, `p:${b.id}`, 'spinoff');
  }

  // ---- files edited by 2+ sessions or 2+ projects
  const files = new Map(); // path -> { sessions: [], projects: Map(pid -> n) }
  for (const m of shown) {
    const p = sessionProject.get(m.id);
    for (const f of Object.keys(m.files || {})) {
      if (typeof f !== 'string' || !f.startsWith('/') || AGENT_DIRS.some((d) => isInside(f, d))) continue;
      let e = files.get(f);
      if (!e) files.set(f, (e = { path: f, sessions: [], projects: new Map(), at: 0 }));
      e.sessions.push(m.id);
      e.projects.set(p.id, (e.projects.get(p.id) || 0) + 1);
      e.at = Math.max(e.at, m.lastAt || 0);
    }
  }
  const sharedFiles = [...files.values()].filter((e) => e.sessions.length >= 2 || e.projects.size >= 2).sort((a, b) => b.projects.size - a.projects.size || b.sessions.length - a.sessions.length || b.at - a.at);
  drop('file', sharedFiles.length - limits.files);
  for (const e of sharedFiles.slice(0, limits.files)) {
    const id = `f:${hash(e.path, 10)}`;
    const top = [...e.projects].sort((a, b) => b[1] - a[1])[0][0];
    add({ id, type: 'file', label: path.basename(e.path), sub: tilde(e.path), weight: e.sessions.length, href: `/projects/${top}?tab=notes`, at: e.at });
    for (const sid of e.sessions) link(`s:${sid}`, id, 'edit');
    for (const pid of e.projects.keys()) link(id, `p:${pid}`, 'file');
  }

  // ---- claude.ai chats, linked to the projects they mention
  const chatList = chats.filter((c) => !projectId || (c.projectPaths || []).some(inFocus)).sort((a, b) => (b.projectPaths?.length ? 1 : 0) - (a.projectPaths?.length ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  drop('chat', chatList.length - limits.chats);
  for (const c of chatList.slice(0, limits.chats)) {
    const id = `c:${c.uuid}`;
    add({ id, type: 'chat', label: clip(oneLine(c.name), 90) || 'Untitled chat', sub: `claude.ai · ${plural(c.messages || 0, 'message')}`, weight: Math.max(1, Math.round((c.messages || 0) / 2)), href: `https://claude.ai/chat/${encodeURIComponent(c.uuid)}`, at: c.updatedAt || c.createdAt || 0 });
    for (const pp of c.projectPaths || []) {
      const p = byPath.get(pp);
      if (p) link(id, `p:${p.id}`, 'chat');
    }
  }

  // ---- one project: its own nodes and everything they touch
  let all = [...nodes.values()];
  if (projectId) {
    const own = new Set(all.filter((n) => n.projectId === projectId).map((n) => n.id));
    const keep = new Set(own);
    for (const e of edges) {
      if (own.has(e.source)) keep.add(e.target);
      if (own.has(e.target)) keep.add(e.source);
    }
    all = all.filter((n) => keep.has(n.id));
  }

  // ---- the cap: skeleton first, then the most connected and newest
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const score = (n) => (degree.get(n.id) || 0) + 4 * fresh(n.at);
  all.sort((a, b) => SKELETON.has(b.type) - SKELETON.has(a.type) || score(b) - score(a) || (b.at || 0) - (a.at || 0) || (a.id < b.id ? -1 : 1));
  for (const n of all.slice(limits.nodes)) drop(n.type);
  const kept = all.slice(0, limits.nodes);
  const keptIds = new Set(kept.map((n) => n.id));

  const seen = new Set();
  const links = [];
  const put = (e) => {
    const k = `${e.source}>${e.target}>${e.kind}`;
    if (seen.has(k) || !keptIds.has(e.source) || !keptIds.has(e.target)) return;
    seen.add(k);
    links.push(e);
  };
  for (const e of edges) put(e);
  // A session outside every shown workstream still hangs off its project.
  const inThread = new Set(links.filter((e) => e.kind === 'session').map((e) => e.target));
  for (const n of kept) if (n.type === 'session' && !inThread.has(n.id)) put({ source: `p:${n.projectId}`, target: n.id, kind: 'session' });

  const dropped = Object.values(left).reduce((a, b) => a + b, 0);
  return {
    nodes: kept,
    links,
    ...(dropped ? { truncated: { shown: kept.length, total: kept.length + dropped, left } } : {}),
    days,
    at: now,
  };
}
