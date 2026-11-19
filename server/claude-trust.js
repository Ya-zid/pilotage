// Claude Code's folder trust ("Do you trust the files in this folder?").
//
// Claude Code asks once per folder, the first time it starts there, and records the answer in its global config
// (~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json): projects[<folder>].hasTrustDialogAccepted. A folder inside a
// trusted folder counts as trusted too, except directly under the home folder, whose own answer is never recorded.
// A session started from the phone waits on that question until someone answers it at the PC. So, when the user
// asks for it (a checkbox in the launch dialog, or the "Trust folders" setting), Pilotage records the answer itself.
//
// This is the only place Pilotage writes to an agent's file, and it changes one key. It takes the lock Claude Code
// uses for that file (a `<file>.lock` directory, proper-lockfile style), re-reads the file under the lock, writes a
// temp file and renames it over the original, and keeps the previous version in data/backups/claude-config/.
// Claude Code re-reads the file under the same lock before each of its own saves, so running sessions keep the change.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, paths } from './config.js';

export const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(HOME, '.claude.json');
const BACKUP_DIR = path.join(paths.backups, 'claude-config');
const KEEP_BACKUPS = 5;
const LOCK_WAIT_MS = 5000;

const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readConfig(file = CLAUDE_CONFIG) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch {
    return null;
  }
}

/** Is `dir` trusted in Claude Code? {trusted, via: the folder whose answer counts, home: dir is the home folder}. */
export function trustState(dir, { file = CLAUDE_CONFIG, home = HOME } = {}) {
  const homes = new Set([path.resolve(home), realOr(home)]);
  // Claude Code records a folder as its process saw it, usually the real path; a symlinked folder (macOS temp folders
  // live under /var -> /private/var) has two spellings, so the parents of both are checked.
  const starts = [...new Set([path.resolve(dir), realOr(dir)])];
  if (starts.some((d) => homes.has(d))) return { trusted: false, via: null, home: true };
  const projects = readConfig(file)?.projects || {};
  const ok = (p) => projects[p] && typeof projects[p] === 'object' && projects[p].hasTrustDialogAccepted === true;
  for (const start of starts) {
    for (let d = start; ; ) {
      if (!homes.has(d) && ok(d)) return { trusted: true, via: d, home: false };
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return { trusted: false, via: null, home: false };
}

async function withConfigLock(file, fn) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('Claude Code is busy saving its settings. Try again in a moment.');
      await sleep(40 + Math.random() * 80);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}

function keepBackup(text) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(BACKUP_DIR, `claude.json.${Date.now()}`), text, { mode: 0o600 });
  const old = fs.readdirSync(BACKUP_DIR).filter((n) => n.startsWith('claude.json.')).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(BACKUP_DIR, n), { force: true });
}

/**
 * Record "trusted" for `dir` in Claude Code's config. Returns {changed}. Throws (and writes nothing) when the config
 * is missing or unreadable, when `dir` is the home folder, or when Claude Code holds the lock for too long.
 */
export async function trustFolder(dir, { file = CLAUDE_CONFIG, home = HOME, backup = true } = {}) {
  const real = realOr(dir);
  if (real === realOr(home)) throw new Error("Claude Code never records trust for the home folder. Start sessions in a project folder.");
  if (!fs.existsSync(real) || !fs.statSync(real).isDirectory()) throw new Error('Folder not found');
  const target = realOr(file); // write through a symlinked config, don't replace the link
  return withConfigLock(file, async () => {
    let st, text, cfg;
    try {
      st = fs.statSync(target);
      text = fs.readFileSync(target, 'utf8');
      cfg = JSON.parse(text);
    } catch {
      throw new Error("Can't read Claude Code's settings (~/.claude.json). Start Claude Code once on the PC first.");
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error("Claude Code's settings file has an unexpected format; not changing it.");
    const projects = cfg.projects && typeof cfg.projects === 'object' && !Array.isArray(cfg.projects) ? cfg.projects : {};
    let changed = false;
    for (const k of new Set([path.resolve(dir), real])) {
      const e = projects[k];
      if (e && typeof e === 'object' && e.hasTrustDialogAccepted === true) continue;
      projects[k] = { ...(e && typeof e === 'object' && !Array.isArray(e) ? e : {}), hasTrustDialogAccepted: true };
      changed = true;
    }
    if (!changed) return { changed: false };
    cfg.projects = projects;
    if (backup) keepBackup(text);
    const tmp = `${target}.pilotage-${process.pid}-${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', st.mode & 0o777);
    try {
      fs.writeSync(fd, JSON.stringify(cfg, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return { changed: true };
  });
}
