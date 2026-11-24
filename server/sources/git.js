// Read-only git inspection. Always --no-optional-locks so we never take index.lock
// while the user's own sessions are committing.
import fs from 'node:fs';
import path from 'node:path';
import { run, pLimit, clip, isInside } from '../util.js';
import { IS_WSL } from '../config.js';
import { winToWsl } from './sessions.js';

const limit = pLimit(4);
// Repos found on disk are untrusted (an unpacked archive can ship its own .git/config): a repo's own config could make
// git run commands. Every call disables fsmonitor, hooks, pagers and signature checks (log.showSignature would run
// gpg.program, gpg.ssh.program...), and never prompts. Filters are handled in statusOf().
const SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'protocol.allow=never', '-c', 'log.showSignature=false'];
// No network or helper programs either: GIT_ALLOW_PROTOCOL='' allows no transport at all (it overrides a repo's own
// protocol.<name>.allow, unlike -c protocol.allow=never), so a partial clone can't lazily "fetch" through an ext::
// command, core.sshCommand or a credential helper; GIT_NO_LAZY_FETCH (git 2.45+) says the same thing directly.
// Filters and helpers run with the repo as their working folder: a relative PATH entry (".", "", "node_modules/.bin")
// would find a program the repo ships under an allow-listed name (git-lfs, git-crypt). Absolute entries only.
export const gitEnvPath = (p = '') => String(p).split(':').filter((d) => d.startsWith('/')).join(':');
const GIT_ENV = { ...process.env, PATH: gitEnvPath(process.env.PATH), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' };
const G = (dir, args, timeout = 10000) => limit(() => run('git', [...SAFE, '-C', dir, ...args], { timeout, env: GIT_ENV }));

// Git for Windows writes `gitdir: C:/Users/alex/repo/.git/worktrees/feat`; on WSL that is /mnt/c/Users/..., which
// path.resolve would take for a relative path. Plain Linux and macOS have no drive letters: nothing to map.
const fromWindows = (p) => (IS_WSL ? winToWsl(p) : p);

/** The folder a `.git` file points to (`gitdir: ...`), resolved from the folder holding it; null if none. Throws. */
function gitdirOf(dotgit) {
  const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
  return m ? path.resolve(path.dirname(dotgit), fromWindows(m[1].trim())) : null;
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Main folder of a linked worktree whose repo is not <main>/.git, found as git itself tells a linked worktree: by its
 * `<gitdir>/commondir`. That is the bare-repo layout proj/.bare + proj/main, proj/feat, where `proj/.git` says
 * `gitdir: ./.bare`. Null when no folder points at the common dir (e.g. --separate-git-dir: git does not record where
 * the main checkout is either), so the worktree stays a repo of its own, as before.
 */
function mainOfCommonDir(gitdir) {
  let common;
  try {
    common = path.resolve(gitdir, fromWindows(fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()));
  } catch {
    return null;
  }
  const parent = path.dirname(common);
  try {
    const g = gitdirOf(path.join(parent, '.git'));
    if (g && (g === common || realOr(g) === realOr(common))) return parent;
  } catch {}
  return null;
}

/** If dir is a git worktree, return {mainRoot, gitdir}; if a main repo, {mainRoot: dir}; else null. */
export function gitKind(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try {
    st = fs.statSync(dotgit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return { kind: 'repo', mainRoot: dir };
  try {
    const gitdir = gitdirOf(dotgit);
    if (!gitdir) return null;
    const i = gitdir.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    if (i !== -1) return { kind: 'worktree', mainRoot: gitdir.slice(0, i), gitdir };
    const main = mainOfCommonDir(gitdir);
    if (main) return { kind: 'worktree', mainRoot: main, gitdir };
    const j = gitdir.indexOf(`${path.sep}.git${path.sep}modules${path.sep}`);
    if (j !== -1) return { kind: 'submodule', mainRoot: dir };
    return { kind: 'repo', mainRoot: dir };
  } catch {
    return null;
  }
}

export function webUrlFromRemote(remote) {
  if (!remote) return null;
  let r = remote.trim();
  let m = /^git@([^:]+):(.+?)(\.git)?$/.exec(r);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?$/.exec(r);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

// `git status` runs the clean/process filter of any file whose stat data changed, and a filter can be any command.
// The user's own filters (global/system config, e.g. git-lfs) are fine; a repo's own ones only when they are the
// well-known git-lfs / git-crypt commands (found on PATH, never a path into the repo, no shell syntax).
const KNOWN_FILTER = /^"?git-(lfs|crypt)"? (clean|smudge|filter-process)( -- %f)?$/;
// Config keys whose value is a program `git status` may run: filters, and git-lfs's extensions and transfer agents
// (git-lfs runs those even through the user's own, global lfs filter).
const RISKY_KEYS = '^(filter\\..*\\.(clean|smudge|process)|lfs\\.extension\\..*|lfs\\.customtransfer\\..*|lfs\\.standalonetransferagent)$';
/**
 * Entries of `git config --null --show-scope|--show-origin --get-regexp RISKY_KEYS`: "where\0key\nvalue\0" (values
 * may contain newlines). True when one names a program from the repo's own config, other than plain git-lfs /
 * git-crypt filters. `isLocal(where)` says if an entry comes from the repo (true), the user (false) or can't tell
 * (null). Fails closed: an error (a timeout), output it can't read, or an entry of unknown origin counts as yes.
 */
function riskyEntries(code, stdout, isLocal) {
  if (code === 1) return false; // no such key anywhere
  if (code !== 0) return true;
  const parts = String(stdout || '').split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  if (parts.length % 2) return true;
  for (let i = 0; i < parts.length; i += 2) {
    const local = isLocal(parts[i]);
    const nl = parts[i + 1].indexOf('\n');
    if (local == null || nl === -1) return true;
    if (!local) continue; // the user's own (global/system) config
    const key = parts[i + 1].slice(0, nl);
    const value = parts[i + 1].slice(nl + 1);
    if (key.startsWith('filter.') && KNOWN_FILTER.test(value)) continue; // plain git-lfs / git-crypt, nothing else
    return true;
  }
  return false;
}

/** riskyEntries for `--show-scope` output (git 2.26+): "local" and "worktree" are the repo's own. Pure; tested. */
export function riskyConfig(code, stdout) {
  return riskyEntries(code, stdout, (scope) => (/^\w+$/.test(scope) ? scope === 'local' || scope === 'worktree' : null));
}

/**
 * riskyEntries for `--show-origin` output (git 2.8+, which has no --show-scope): an entry is the repo's own when its
 * file lies in the repo (its git dir, common dir or working tree: a repo's config can include files it ships); our
 * own `-c` options are "command line:". Pure; tested.
 */
export function riskyOrigins(code, stdout, dir, roots) {
  const inRepo = (p) => {
    const abs = path.resolve(dir, p);
    const real = realOr(abs);
    return roots.some((r) => isInside(abs, r) || isInside(real, realOr(r)));
  };
  return riskyEntries(code, stdout, (where) => {
    if (where === 'command line:') return false;
    if (where.startsWith('file:') && where.length > 5) return inRepo(where.slice(5));
    return null;
  });
}

const unknownOption = (r, opt) => r.code === 129 && String(r.stderr || '').includes(opt);
/** 'ok' | 'risky' (the repo's own config names a program git status could run) | 'old' (git can't tell us). */
async function repoPrograms(dir) {
  const r = await G(dir, ['config', '--null', '--show-scope', '--get-regexp', RISKY_KEYS]);
  if (!unknownOption(r, 'show-scope')) return riskyConfig(r.code, r.stdout) ? 'risky' : 'ok';
  // git < 2.26: no --show-scope, so tell the repo's files from the user's by where each entry comes from.
  const [o, rp] = await Promise.all([
    G(dir, ['config', '--null', '--show-origin', '--get-regexp', RISKY_KEYS]),
    G(dir, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']),
  ]);
  const roots = rp.code === 0 ? rp.stdout.split('\n').filter(Boolean).map((p) => path.resolve(dir, p)) : [];
  if (unknownOption(o, 'show-origin') || roots.length < 3) return 'old';
  return riskyOrigins(o.code, o.stdout, dir, roots) ? 'risky' : 'ok';
}

/** Status of one checkout (repo or worktree). */
export async function statusOf(dir) {
  const programs = await repoPrograms(dir);
  if (programs === 'risky') return { ok: false, error: 'This repo defines its own git filters, so Pilotage does not run git status in it', checkedAt: Date.now() };
  if (programs === 'old') return { ok: false, error: 'Your git is too old for a safe status (Pilotage needs git 2.26 or newer)', checkedAt: Date.now() };
  const [st, last, remote, recent] = await Promise.all([
    // Submodules have their own config (and filters): don't recurse into them.
    G(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--ignore-submodules=all']),
    G(dir, ['log', '-1', '--format=%cI%x1f%s%x1f%an']),
    G(dir, ['remote', 'get-url', 'origin']),
    G(dir, ['rev-list', '--count', '--since=30.days', 'HEAD']),
  ]);
  if (st.code !== 0) return { ok: false, error: clip(st.stderr, 200), checkedAt: Date.now() };
  let branch = null;
  let ahead = 0;
  let behind = 0;
  let upstream = null;
  let dirty = 0;
  let untracked = 0;
  for (const line of st.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = +m[1];
        behind = +m[2];
      }
    } else if (line.startsWith('?')) untracked++;
    else if (line && !line.startsWith('#')) dirty++;
  }
  const [lastAt, lastMsg, lastAuthor] = last.stdout.trim().split('\x1f');
  return {
    ok: true,
    branch: branch === '(detached)' ? 'detached' : branch,
    upstream,
    ahead,
    behind,
    dirty,
    untracked,
    lastCommitAt: lastAt ? Date.parse(lastAt) : 0,
    lastCommitMsg: clip(lastMsg || '', 140),
    lastCommitAuthor: lastAuthor || '',
    remoteUrl: remote.code === 0 ? remote.stdout.trim() : null,
    webUrl: remote.code === 0 ? webUrlFromRemote(remote.stdout) : null,
    commits30d: Number(recent.stdout.trim()) || 0,
    checkedAt: Date.now(),
  };
}

/** Extra info for main repos: worktrees, merged branches, first commit, recent log. */
export async function repoExtras(dir) {
  const [wt, head, roots, logOut] = await Promise.all([
    G(dir, ['worktree', 'list', '--porcelain']),
    G(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    G(dir, ['rev-list', '--max-parents=0', 'HEAD']),
    G(dir, ['log', '-20', '--format=%cs%x1f%s']),
  ]);
  const worktrees = [];
  let cur = null;
  for (const line of wt.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9).trim(), branch: null, prunable: false, locked: false };
      worktrees.push(cur);
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '').trim();
    else if (cur && line.startsWith('detached')) cur.branch = 'detached';
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
    else if (cur && line.startsWith('locked')) cur.locked = true;
  }
  const defaultBranch = head.code === 0 ? head.stdout.trim() : null; // e.g. origin/main
  let merged = [];
  if (defaultBranch) {
    const mb = await G(dir, ['branch', '--format=%(refname:short)', '--merged', defaultBranch]);
    if (mb.code === 0) merged = mb.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  let firstCommitAt = 0;
  const firstSha = roots.stdout.trim().split('\n').pop();
  if (firstSha) {
    const fc = await G(dir, ['show', '-s', '--format=%cI', firstSha]);
    if (fc.code === 0) firstCommitAt = Date.parse(fc.stdout.trim()) || 0;
  }
  const recentLog = logOut.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [d, s] = l.split('\x1f');
      return { d, s: clip(s, 140) };
    });
  return { worktrees: worktrees.slice(1), defaultBranch, merged, firstCommitAt, recentLog, extrasAt: Date.now() };
}

/** Commit timestamps by the user over the last year (for the timeline). */
export async function myCommitTimes(dir, identities) {
  const args = ['log', '--since=13.months', '--all', '--no-merges', '--format=%ct%x1f%ae%x1f%an'];
  const r = await G(dir, args, 20000);
  if (r.code !== 0) return [];
  const ids = identities.map((s) => s.toLowerCase()).filter(Boolean);
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const [ct, ae, an] = line.split('\x1f');
    if (ids.length && !ids.includes((ae || '').toLowerCase()) && !ids.includes((an || '').toLowerCase())) continue;
    out.push(Number(ct) * 1000);
  }
  return out;
}

export async function gitIdentities() {
  const [e, n] = await Promise.all([run('git', ['config', '--global', 'user.email']), run('git', ['config', '--global', 'user.name'])]);
  const ids = [e.stdout.trim(), n.stdout.trim()].filter(Boolean);
  return ids;
}
