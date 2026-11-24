// Paths and constants. Everything machine-specific is detected here, once.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
export const HOME = os.homedir();

/**
 * WSL2 + Windows unlocks the full feature set (Windows Terminal launches, the phone forwarder, autostart).
 * Elsewhere (plain Linux, macOS) Pilotage runs without them. PILOTAGE_WSL=0|1 overrides the detection.
 */
function detectWsl() {
  if (process.env.PILOTAGE_WSL === '0') return false;
  if (process.env.PILOTAGE_WSL === '1') return true;
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(os.release()) || /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}
export const IS_WSL = detectWsl();
/** 'wsl' | 'linux' | 'darwin' | … (process.platform outside WSL). */
export const OS_NAME = IS_WSL ? 'wsl' : process.platform;
/**
 * Where Pilotage keeps its state, keys and caches. A git clone keeps using <clone>/data (as before); an npm install
 * lives in node_modules, which updates replace and npx caches get cleared, so it uses ~/.pilotage.
 * bin/pilotage applies the same rule and passes it on as PILOTAGE_DATA.
 */
export function defaultDataDir(root = ROOT, home = os.homedir()) {
  if (fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, 'data'))) return path.join(root, 'data');
  return path.join(home, '.pilotage');
}
export const DATA = process.env.PILOTAGE_DATA || defaultDataDir();
export const WEB_DIST = process.env.PILOTAGE_WEB_DIST || path.join(ROOT, 'web', 'dist'); // override: preview builds
export const PORT = Number(process.env.PILOTAGE_PORT || 4747);
/** Port the Windows-side forwarder listens on (Wi-Fi / NetBird). */
export const LAN_PORT = Number(process.env.PILOTAGE_LAN_PORT || 4748);
/** Loopback port the Windows forwarder targets (phones only); PORT serves the PC browser + CLI. */
export const LAN_INTERNAL_PORT = Number(process.env.PILOTAGE_LAN_INTERNAL_PORT || PORT - 1);
export const BIND = '127.0.0.1';

export const CLAUDE_DIR = path.join(HOME, '.claude');
/**
 * The `claude` binary as an absolute path when found, else the bare name (pure; tested). Pilotage often runs from the
 * login item or the Windows Startup entry, whose PATH has no nvm, and launch tabs are fresh login shells: a bare
 * `claude` is then "command not found" for Claude Code installed with npm under nvm. Order: the native installer, the
 * folder of the node running Pilotage (bin/pilotage picks the newest nvm node), PATH (never Windows' /mnt/...), the
 * old ~/.claude/local install, the newest nvm node, then system folders (an old `sudo npm i -g` copy comes last).
 */
export function resolveClaudeBin({ home = HOME, envPath = process.env.PATH || '', execDir = path.dirname(process.execPath), systemDirs = ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin'] } = {}) {
  const isExe = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  let nvm = [];
  try {
    const root = path.join(home, '.nvm/versions/node');
    nvm = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => path.join(root, v, 'bin'));
  } catch {}
  const onPath = envPath.split(':').filter((d) => d && !d.startsWith('/mnt/'));
  const dirs = [path.join(home, '.local/bin'), execDir, ...onPath, path.join(home, '.claude/local'), ...nvm, ...systemDirs];
  for (const d of dirs) if (isExe(path.join(d, 'claude'))) return path.join(d, 'claude');
  return 'claude';
}
export const CLAUDE_BIN = resolveClaudeBin();
/** Is this claude a JavaScript file (`#!/usr/bin/env node`, an npm install) rather than the native binary? (tested) */
export function isNodeScript(bin) {
  if (!path.isAbsolute(bin)) return false;
  try {
    const fd = fs.openSync(fs.realpathSync(bin), 'r');
    const head = Buffer.alloc(128);
    const n = fs.readSync(fd, head, 0, 128, 0);
    fs.closeSync(fd);
    const first = head.subarray(0, n).toString('utf8').split('\n')[0];
    return first.startsWith('#!') && /\bnode\b/.test(first);
  } catch {
    return false;
  }
}
/**
 * The command that runs claude: [bin] for the native binary; [this node, the script] for an npm install, so it never
 * depends on which node comes first on PATH (an old distro node 12 would crash it) or on node being on PATH at all.
 */
export const CLAUDE_CMD = isNodeScript(CLAUDE_BIN) ? [process.execPath, CLAUDE_BIN] : [CLAUDE_BIN];
export const WSL_DISTRO = process.env.WSL_DISTRO_NAME || 'Ubuntu';

/** Find the Windows user profile as seen from WSL (e.g. /mnt/c/Users/<you>). Null outside WSL. */
function detectWinHome() {
  if (!IS_WSL) return null;
  if (process.env.PILOTAGE_WIN_HOME) return process.env.PILOTAGE_WIN_HOME;
  const base = '/mnt/c/Users';
  try {
    const candidates = fs
      .readdirSync(base)
      .filter((n) => !['All Users', 'Default', 'Default User', 'Public', 'TEMP', 'desktop.ini'].includes(n))
      .map((n) => path.join(base, n))
      .filter((p) => fs.existsSync(path.join(p, 'AppData', 'Local')));
    // Prefer the profile that has Windows Terminal installed (the one actually used)
    const wt = candidates.find((p) => fs.existsSync(path.join(p, 'AppData/Local/Microsoft/WindowsApps/wt.exe')));
    return wt || candidates[0] || null;
  } catch {
    return null;
  }
}

export const WIN_HOME = detectWinHome();
export const WIN_USER = WIN_HOME ? path.basename(WIN_HOME) : null;
export const WIN_CLAUDE_DIR = WIN_HOME && fs.existsSync(path.join(WIN_HOME, '.claude')) ? path.join(WIN_HOME, '.claude') : null;
export const WT_EXE = WIN_HOME ? path.join(WIN_HOME, 'AppData/Local/Microsoft/WindowsApps/wt.exe') : null;
export const VSCODE_CLI = WIN_HOME ? path.join(WIN_HOME, 'AppData/Local/Programs/Microsoft VS Code/bin/code') : null;
export const WIN_NODE = '/mnt/c/Program Files/nodejs/node.exe';
export const CMD_EXE = '/mnt/c/Windows/System32/cmd.exe';
export const EXPLORER_EXE = '/mnt/c/Windows/explorer.exe';
export const POWERSHELL_EXE = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const IPCONFIG_EXE = '/mnt/c/Windows/System32/ipconfig.exe';
export const WIN_PILOTAGE_DIR = WIN_HOME ? path.join(WIN_HOME, 'AppData/Local/Pilotage') : null;

/** Folders scanned for projects (git repos / CLAUDE.md), relative depth-limited. */
export const DEFAULT_SCAN_ROOTS = [HOME];
export const SCAN_SKIP = new Set([
  'node_modules', '.git', 'android-sdk', 'Downloads', '.venv', 'venv', '.venvs', 'dist', 'build', '.next',
  '.cache', '__pycache__', 'site-packages', '.nvm', '.npm', 'snap', 'go', '.cargo', '.rustup',
]);

/**
 * macOS: folders of the home folder that hold app data and media, not projects. Reading inside them raises privacy
 * prompts ("node would like to access data from other apps", "... your Calendars", "... Apple Music"). Skipped only
 * right under HOME: a project named Library elsewhere is still found.
 */
export const HOME_SKIP = new Set(process.platform === 'darwin' ? ['Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Public'] : []);

/** Paths Pilotage itself creates; never shown as projects or sessions (data/ai-sandbox: where earlier versions ran AI calls). */
export const INTERNAL_PATHS = [path.join(ROOT, '.sandbox'), path.join(DATA, 'ai-sandbox')];

const AI_DIR_PREFIX = 'pilotage-ai-';
// Where Pilotage's private AI folders can be: the temp folder of this process and of earlier runs, which may have had
// another TMPDIR (a login item vs a terminal; macOS falls back to /tmp, really /private/tmp), in both spellings.
const TMP_ROOTS = (() => {
  const roots = new Set();
  for (const t of [os.tmpdir(), '/tmp', '/var/tmp', '/private/tmp']) {
    roots.add(t);
    try {
      roots.add(fs.realpathSync(t));
    } catch {}
  }
  return [...roots];
})();
let aiDir = null;

/**
 * The working folder of Pilotage's own `claude -p` / `codex exec` calls: a private (0700) folder in the system temp
 * folder, made once per process (again if a temp cleaner removed it) and deleted on exit. Claude Code loads CLAUDE.md
 * from its working folder and every folder above it, so a folder inside the Pilotage clone or under ~ would add
 * Pilotage's contributor rules or the user's ~/CLAUDE.md to every summary.
 */
export function aiWorkDir() {
  try {
    if (aiDir && fs.statSync(aiDir).isDirectory()) return aiDir;
  } catch {}
  if (!aiDir)
    process.once('exit', () => {
      try {
        fs.rmSync(aiDir, { recursive: true, force: true });
      } catch {}
    });
  aiDir = fs.mkdtempSync(path.join(TMP_ROOTS[0], AI_DIR_PREFIX));
  fs.chmodSync(aiDir, 0o700);
  return aiDir;
}

/** Inside a folder Pilotage made for itself (INTERNAL_PATHS, or the AI calls' folder of this or an earlier run)? */
export function isInternalPath(p) {
  if (!p) return false;
  const under = (parent) => {
    const rel = path.relative(parent, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : null;
  };
  if (INTERNAL_PATHS.some((x) => under(x) !== null)) return true;
  return TMP_ROOTS.some((t) => under(t)?.split(path.sep)[0].startsWith(AI_DIR_PREFIX));
}

export const paths = {
  state: path.join(DATA, 'state.json'),
  secrets: path.join(DATA, 'secrets.json'),
  index: path.join(DATA, 'index', 'sessions.json'),
  turnsDir: path.join(DATA, 'index', 'turns'),
  ai: path.join(DATA, 'ai.json'),
  launchDir: path.join(DATA, 'launch'),
  logs: path.join(DATA, 'logs'),
  backups: path.join(DATA, 'backups'),
  gitCache: path.join(DATA, 'index', 'git.json'),
  worktreeRoots: path.join(DATA, 'index', 'worktree-roots.json'),
  netInfo: path.join(DATA, 'net.json'),
  lock: path.join(DATA, 'server.lock'), // one server per data folder (instance-lock.js)
};

export function ensureDirs() {
  for (const d of [DATA, path.dirname(paths.index), paths.turnsDir, paths.launchDir, paths.logs, paths.backups]) {
    fs.mkdirSync(d, { recursive: true });
  }
  try {
    fs.chmodSync(DATA, 0o700);
  } catch {}
}
