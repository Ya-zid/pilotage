// Project discovery and grouping: turns folders, git repos, worktrees and session
// working directories into a Workspace → Project → (worktrees, sessions) tree.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HOME, WIN_HOME, SCAN_SKIP, HOME_SKIP, isInternalPath, CLAUDE_DIR, WIN_CLAUDE_DIR, paths } from '../config.js';
import { gitKind, statusOf, repoExtras, myCommitTimes, gitIdentities } from './git.js';
import { projectKeyFor, ownPrompts } from './sessions.js';
import { readJSONSync, writeJSON, hash, isInside, pLimit, log, clip, isoDay, holdsProjects } from '../util.js';
import { mergedWorkspaceKey } from '../workspaces.js';

const WIN_PROJECTS = WIN_HOME ? path.join(WIN_HOME, 'Documents', 'Projects') : null;
const MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pubspec.yaml', 'README.md', 'CLAUDE.md'];

export function baseOf(p) {
  if (WIN_PROJECTS && isInside(p, WIN_PROJECTS)) return WIN_PROJECTS;
  if (WIN_HOME && isInside(p, WIN_HOME)) return WIN_HOME;
  if (isInside(p, HOME)) return HOME;
  return '/';
}

function depthUnder(p, base) {
  const rel = path.relative(base, p);
  return rel ? rel.split(path.sep).length : 0;
}

function topSegment(p) {
  const base = baseOf(p);
  const rel = path.relative(base, p);
  return rel ? rel.split(path.sep)[0] : '';
}

const STACK_DEPS = {
  react: 'React', next: 'Next.js', vite: 'Vite', vue: 'Vue', svelte: 'Svelte', '@angular/core': 'Angular', express: 'Express',
  fastify: 'Fastify', '@nestjs/core': 'NestJS', '@supabase/supabase-js': 'Supabase', prisma: 'Prisma', '@prisma/client': 'Prisma',
  tailwindcss: 'Tailwind', electron: 'Electron', 'react-native': 'React Native', expo: 'Expo', '@playwright/test': 'Playwright',
  playwright: 'Playwright', typescript: 'TypeScript', 'drizzle-orm': 'Drizzle', stripe: 'Stripe', 'socket.io': 'Socket.IO',
  three: 'Three.js', '@tauri-apps/api': 'Tauri', mongoose: 'MongoDB', pg: 'PostgreSQL', firebase: 'Firebase', vitest: 'Vitest',
  jest: 'Jest', '@capacitor/core': 'Capacitor', 'better-sqlite3': 'SQLite', sqlite3: 'SQLite', '@anthropic-ai/sdk': 'Claude API',
  openai: 'OpenAI API', astro: 'Astro', '@remix-run/react': 'Remix', nuxt: 'Nuxt', 'framer-motion': 'Framer Motion',
};
const STACK_PY = {
  torch: 'PyTorch', tensorflow: 'TensorFlow', django: 'Django', flask: 'Flask', fastapi: 'FastAPI', streamlit: 'Streamlit',
  astropy: 'Astropy', pandas: 'pandas', numpy: 'NumPy', 'scikit-learn': 'scikit-learn', opencv: 'OpenCV', keras: 'Keras',
  selenium: 'Selenium', playwright: 'Playwright', anthropic: 'Claude API', openai: 'OpenAI API', langchain: 'LangChain',
};

function readText(p, max = 200_000) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function detectStack(dir) {
  const found = new Set();
  const dirs = [dir];
  for (const sub of ['frontend', 'backend', 'server', 'web', 'app', 'client', 'api', 'apps', 'packages', 'mobile', 'desktop']) {
    const p = path.join(dir, sub);
    try {
      if (fs.statSync(p).isDirectory()) dirs.push(p);
    } catch {}
  }
  for (const d of dirs) {
    const pkg = readText(path.join(d, 'package.json'));
    if (pkg) {
      found.add('Node.js');
      try {
        const j = JSON.parse(pkg);
        const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
        for (const k of Object.keys(deps)) if (STACK_DEPS[k]) found.add(STACK_DEPS[k]);
      } catch {}
    }
    const py = readText(path.join(d, 'requirements.txt')) + readText(path.join(d, 'pyproject.toml'));
    if (py) {
      found.add('Python');
      const low = py.toLowerCase();
      for (const [k, v] of Object.entries(STACK_PY)) if (new RegExp(`(^|[\\s"'\\[,])${k.replace('-', '[-_]')}([\\s=<>~!\\[;,"']|$)`, 'm').test(low)) found.add(v);
    }
  }
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml')) found.add('Docker');
  if (has('vercel.json')) found.add('Vercel');
  if (has('railway.json') || has('railway.toml')) found.add('Railway');
  if (has('supabase')) found.add('Supabase');
  if (has('Cargo.toml')) found.add('Rust');
  if (has('go.mod')) found.add('Go');
  if (has('pubspec.yaml')) found.add('Flutter');
  if (has('composer.json')) found.add('PHP');
  if (has('Gemfile')) found.add('Ruby');
  if (has('android')) found.add('Android');
  try {
    if (fs.readdirSync(dir).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) found.add('.NET');
    if (fs.readdirSync(dir).some((f) => f.endsWith('.ipynb'))) found.add('Jupyter');
  } catch {}
  if (found.has('TypeScript')) found.delete('Node.js');
  return [...found].slice(0, 14);
}

/** Markdown/doc files of a project and its Claude memory files. */
export function listDocs(project, extraKeys = []) {
  const docs = [];
  const add = (p, group) => {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return; // never follow links out of the project (e.g. README.md -> ~/.ssh/key)
      const st = fs.statSync(p);
      if (st.isFile() && st.size <= 2_000_000) docs.push({ path: p, name: path.relative(project.path, p) || path.basename(p), group, size: st.size, mtime: st.mtimeMs });
    } catch {}
  };
  try {
    for (const f of fs.readdirSync(project.path)) if (/\.(md|markdown|txt)$/i.test(f) && !f.startsWith('.')) add(path.join(project.path, f), 'Project');
  } catch {}
  for (const sub of ['docs', 'doc', '.claude']) {
    const d = path.join(project.path, sub);
    try {
      for (const f of fs.readdirSync(d).slice(0, 40)) if (/\.(md|markdown)$/i.test(f)) add(path.join(d, f), sub === '.claude' ? 'Claude config' : 'Docs');
    } catch {}
  }
  const keys = new Set([projectKeyFor(project.path), ...extraKeys]);
  for (const base of [CLAUDE_DIR, WIN_CLAUDE_DIR].filter(Boolean)) {
    for (const k of keys) {
      const md = path.join(base, 'projects', k, 'memory');
      try {
        for (const f of fs.readdirSync(md)) if (f.endsWith('.md')) add(path.join(md, f), 'Claude memory');
      } catch {}
    }
  }
  docs.sort((a, b) => {
    const order = (d) => (/^claude\.md$/i.test(d.name) ? 0 : /^readme/i.test(d.name) ? 1 : d.group === 'Claude memory' ? 3 : 2);
    return order(a) - order(b) || b.mtime - a.mtime;
  });
  return docs.slice(0, 80);
}

export class ProjectRegistry {
  constructor(index, store) {
    this.index = index;
    this.store = store;
    this.projects = new Map(); // path -> project
    this.resolveCache = new Map();
    this.git = readJSONSync(paths.gitCache, {}) || {}; // path -> {status, extras}
    // Session folder -> main repo, for folders inside a git worktree. Once a worktree outside the repo is removed
    // (`git worktree remove ../repo-feat`), nothing on disk ties the folder to its repo any more: without this its
    // sessions would leave the repo for a phantom non-git project.
    this.worktreeRoots = readJSONSync(paths.worktreeRoots, {}) || {};
    this.scanned = []; // candidate dirs from filesystem scan
    this.known = new Set(); // folders Pilotage created (spin-offs, new projects): projects at any depth, dot-folders too
    this.lastScanAt = 0;
    this.gitBusy = false;
  }

  hidden(p) {
    const hiddenPaths = this.store.settings.scan.hiddenPaths || [];
    return isInternalPath(p) || hiddenPaths.some((x) => isInside(p, x));
  }

  /** Walk scan roots for git repos / CLAUDE.md folders / top-level code folders. */
  async scanFs() {
    const roots = [{ dir: HOME, depth: this.store.settings.scan.depth || 3 }];
    if (WIN_PROJECTS && fs.existsSync(WIN_PROJECTS)) roots.push({ dir: WIN_PROJECTS, depth: 2 });
    for (const r of this.store.settings.scan.extraRoots || []) roots.push({ dir: r, depth: 3 });
    const found = new Set();
    const walk = async (dir, depth, maxDepth) => {
      let ents;
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const names = new Set(ents.map((e) => e.name));
      const isRepo = names.has('.git');
      if (depth > 0) {
        if (isRepo || names.has('CLAUDE.md') || (depth === 1 && MARKERS.some((m) => names.has(m)))) found.add(dir);
      }
      if (isRepo && depth > 0) return; // don't descend into repos (worktrees are found via git)
      if (depth >= maxDepth) return;
      const subdirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SCAN_SKIP.has(e.name) && !(dir === HOME && HOME_SKIP.has(e.name))).map((e) => e.name);
      // Huge folders are usually generated (e.g. 900 concept dirs), unless they hold repos (~/code with 400+ projects).
      // Below depth 1 only .git and CLAUDE.md make a project.
      if (ents.length > 400 && depth >= 1 && !(await holdsProjects(dir, subdirs, ['.git', 'CLAUDE.md']))) return;
      for (const name of subdirs) await walk(path.join(dir, name), depth + 1, maxDepth);
    };
    for (const r of roots) await walk(r.dir, 0, r.depth);
    this.scanned = [...found].filter((p) => !this.hidden(p));
    this.lastScanAt = Date.now();
  }

  /** Map any folder (session cwd, file path) to {root, worktreeOf}. */
  resolve(dir) {
    if (!dir) return null;
    if (this.resolveCache.has(dir)) return this.resolveCache.get(dir);
    const base = baseOf(dir);
    let res = null;
    const wasIn = this.worktreeRoots[dir];
    if (wasIn && !fs.existsSync(dir)) res = { root: wasIn, worktree: null }; // a removed worktree: back to its repo
    // nearest ancestor with .git (stop at base)
    let cur = res ? null : dir;
    while (cur && isInside(cur, base) && cur !== base) {
      const gk = gitKind(cur);
      if (gk) {
        if (gk.kind === 'worktree') res = { root: gk.mainRoot, worktree: cur };
        else res = { root: cur, worktree: null };
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!res) {
      // Non-git folder: attach deep sub-folders to a known ancestor project (depth ≥ 2).
      res = { root: dir, worktree: null };
      let a = path.dirname(dir);
      while (a && a !== base && isInside(a, base) && depthUnder(a, base) >= 2) {
        if (this.candidateSet?.has(a)) {
          res = { root: a, worktree: null };
          break;
        }
        a = path.dirname(a);
      }
    }
    this.resolveCache.set(dir, res);
    return res;
  }

  workspaceKeyFor(p, known) {
    if (p === HOME || baseOf(p) === p) return 'home';
    // Top folder, merged into another workspace when state.json says so (workspaces[key].mergeInto).
    const merges = this.store.data?.workspaces || {};
    let key = mergedWorkspaceKey(topSegment(p).toLowerCase(), merges);
    if (key.includes('-')) {
      const prefix = key.split('-')[0];
      if (known.has(prefix)) key = mergedWorkspaceKey(prefix, merges);
    }
    return key;
  }

  /** Rebuild the project tree from sessions + filesystem. */
  async rebuild() {
    if (!this.lastScanAt || Date.now() - this.lastScanAt > 10 * 60 * 1000) await this.scanFs();
    this.resolveCache.clear();
    const sessions = this.index.list();
    const cwds = new Set(sessions.map((s) => s.cwd).filter(Boolean));
    this.candidateSet = new Set([...this.scanned, ...cwds, ...[...this.known].filter((d) => fs.existsSync(d))]);
    const projects = new Map();
    const ensure = (root) => {
      if (projects.has(root)) return projects.get(root);
      const p = {
        id: hash(root, 10),
        path: root,
        name: root === HOME ? 'Home folder' : path.basename(root),
        workspace: null,
        isGit: !!gitKind(root),
        worktrees: new Map(),
        sessionIds: [],
        firstAt: 0,
        lastAt: 0,
        humanPrompts: 0,
        automationRuns: 0,
        projectKeys: new Set(),
      };
      projects.set(root, p);
      return p;
    };
    for (const dir of this.candidateSet) {
      if (this.hidden(dir)) continue;
      const r = this.resolve(dir);
      if (!r || this.hidden(r.root)) continue;
      const p = ensure(r.root);
      if (r.worktree && !p.worktrees.has(r.worktree)) p.worktrees.set(r.worktree, { path: r.worktree, name: path.basename(r.worktree), sessionIds: [], lastAt: 0 });
    }
    for (const s of sessions) {
      if (!s.cwd || this.hidden(s.cwd)) continue;
      const r = this.resolve(s.cwd);
      if (!r) continue;
      const p = ensure(r.root);
      p.sessionIds.push(s.id);
      if (s.projectKey) p.projectKeys.add(s.projectKey);
      const last = s.lastAt || 0;
      p.lastAt = Math.max(p.lastAt, last);
      if (s.startedAt) p.firstAt = p.firstAt ? Math.min(p.firstAt, s.startedAt) : s.startedAt;
      p.humanPrompts += ownPrompts(s);
      if (isAutomation(s)) p.automationRuns++;
      if (r.worktree) {
        let w = p.worktrees.get(r.worktree);
        if (!w) {
          w = { path: r.worktree, name: path.basename(r.worktree), sessionIds: [], lastAt: 0 };
          p.worktrees.set(r.worktree, w);
        }
        w.sessionIds.push(s.id);
        w.lastAt = Math.max(w.lastAt, last);
      }
    }
    const saving = this.saveWorktreeRoots(cwds);
    // Workspaces
    const tops = new Set([...projects.keys()].map((p) => topSegment(p).toLowerCase()));
    for (const p of projects.values()) {
      const over = this.store.project(p.path);
      p.workspace = over.workspace || this.workspaceKeyFor(p.path, tops);
      p.isWorkspaceRoot = depthUnder(p.path, baseOf(p.path)) === 1 && [...projects.keys()].some((q) => q !== p.path && isInside(q, p.path));
      if (p.path.startsWith('/mnt/')) p.windows = true;
    }
    // Git worktrees reported by git itself (catches worktrees outside scan roots)
    for (const p of projects.values()) {
      const ex = this.git[p.path]?.extras;
      if (!ex) continue;
      for (const w of ex.worktrees || []) {
        if (!p.worktrees.has(w.path) && !this.hidden(w.path)) p.worktrees.set(w.path, { path: w.path, name: path.basename(w.path), sessionIds: [], lastAt: 0 });
      }
    }
    this.projects = projects;
    await saving;
    return projects;
  }

  /**
   * Remember which session folders sit in a worktree (see worktreeRoots); written only when it changes. The map is
   * updated at once, only the write is awaited.
   */
  async saveWorktreeRoots(cwds) {
    const next = {};
    for (const cwd of cwds) {
      const r = this.resolve(cwd);
      if (r && (r.worktree || this.worktreeRoots[cwd] === r.root)) next[cwd] = r.root;
    }
    const prev = this.worktreeRoots;
    const keys = Object.keys(next);
    if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) return;
    this.worktreeRoots = next;
    await writeJSON(paths.worktreeRoots, next).catch((e) => log.warn('worktree folders not saved', e.message));
  }

  /**
   * Cheap path after a scan where sessions only grew (same ids, same folders): recompute the activity totals of
   * their projects instead of a full rebuild. Returns false when a full rebuild() is needed instead.
   */
  refreshSessions(ids) {
    if (!this.projects.size || !this.lastScanAt || Date.now() - this.lastScanAt > 10 * 60 * 1000) return false;
    const touched = new Set();
    for (const id of ids) {
      const s = this.index.get(id);
      if (!s) return false;
      if (!s.cwd || this.index.isInternal(s.cwd) || this.hidden(s.cwd)) continue; // never part of a project
      const r = this.resolve(s.cwd);
      if (!r || this.hidden(r.root)) continue; // same rules as rebuild()
      const p = this.projects.get(r.root);
      if (!p || !p.sessionIds.includes(id)) return false;
      touched.add(p);
    }
    for (const p of touched) {
      p.firstAt = 0;
      p.lastAt = 0;
      p.humanPrompts = 0;
      p.automationRuns = 0;
      for (const w of p.worktrees.values()) w.lastAt = 0;
      for (const id of p.sessionIds) {
        const s = this.index.get(id);
        if (!s) continue;
        const last = s.lastAt || 0;
        p.lastAt = Math.max(p.lastAt, last);
        if (s.startedAt) p.firstAt = p.firstAt ? Math.min(p.firstAt, s.startedAt) : s.startedAt;
        p.humanPrompts += ownPrompts(s);
        if (isAutomation(s)) p.automationRuns++;
        const wt = this.resolve(s.cwd)?.worktree;
        const w = wt ? p.worktrees.get(wt) : null;
        if (w) w.lastAt = Math.max(w.lastAt, last);
      }
    }
    return true;
  }

  byId(id) {
    for (const p of this.projects.values()) if (p.id === id) return p;
    return null;
  }

  projectOfSession(s) {
    if (!s?.cwd) return null;
    const r = this.resolve(s.cwd);
    return r ? this.projects.get(r.root) || null : null;
  }

  /** Refresh git info. `force` re-checks everything, otherwise only stale entries. */
  async refreshGit({ force = false, only = null } = {}) {
    if (this.gitBusy && !only) return false;
    if (!only) this.gitBusy = true;
    const lim = pLimit(3);
    let changed = false;
    try {
      const jobs = [];
      const now = Date.now();
      const targets = only ? [only] : [...this.projects.values()];
      for (const p of targets) {
        if (!p.isGit) continue;
        const entry = this.git[p.path] || {};
        const recent = now - p.lastAt < 24 * 3600e3;
        const ttl = force ? 0 : recent ? 3 * 60e3 : 20 * 60e3;
        if (!entry.status || now - (entry.status.checkedAt || 0) > ttl) {
          jobs.push(
            lim(async () => {
              const st = await statusOf(p.path);
              let ex = entry.extras;
              if (!ex || force || now - (ex.extrasAt || 0) > 30 * 60e3) {
                ex = await repoExtras(p.path);
                if (!this.identities) this.identities = await gitIdentities();
                const days = {};
                for (const t of await myCommitTimes(p.path, this.identities)) {
                  const d = isoDay(t);
                  days[d] = (days[d] || 0) + 1;
                }
                ex.commitDays = days;
              }
              this.git[p.path] = { status: st, extras: ex };
              changed = true;
            }),
          );
        }
        for (const w of p.worktrees.values()) {
          const we = this.git[w.path] || {};
          const wttl = force ? 0 : 30 * 60e3;
          if (!we.status || now - (we.status.checkedAt || 0) > wttl) {
            jobs.push(
              lim(async () => {
                if (!fs.existsSync(w.path)) {
                  this.git[w.path] = { status: { ok: false, missing: true, checkedAt: Date.now() } };
                } else this.git[w.path] = { status: await statusOf(w.path) };
                changed = true;
              }),
            );
          }
        }
      }
      await Promise.all(jobs);
      if (changed) await writeJSON(paths.gitCache, this.git);
    } catch (e) {
      log.warn('git refresh failed', e.message);
    } finally {
      if (!only) this.gitBusy = false;
    }
    return changed;
  }

  gitOf(p) {
    return this.git[p] || {};
  }
}

export function isAutomation(s) {
  if (!s) return false;
  const c = s.counts || {};
  return (s.entrypoint === 'sdk-cli' || c.s > 0) && !(c.h > 0);
}

/** Normalize an automation's first prompt into a stable group name. */
export function automationKey(s) {
  const p = String(s.firstPrompt || s.lastPrompt || '').replace(/\s+/g, ' ').trim();
  const quoted = /'([^']{2,40})' run/i.exec(p) || /"([^"]{2,40})" run/i.exec(p);
  if (quoted) return clip(`${quoted[1]} run`, 60);
  return clip(p.replace(/\d+/g, '#').split(/[.:!?\n]/)[0], 60) || 'Automation';
}
