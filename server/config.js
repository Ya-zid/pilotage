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
export const DATA = process.env.PILOTAGE_DATA || path.join(ROOT, 'data');
export const WEB_DIST = process.env.PILOTAGE_WEB_DIST || path.join(ROOT, 'web', 'dist'); // override: preview builds
export const PORT = Number(process.env.PILOTAGE_PORT || 4747);
/** Port the Windows-side forwarder listens on (Wi-Fi / NetBird). */
export const LAN_PORT = Number(process.env.PILOTAGE_LAN_PORT || 4748);
/** Loopback port the Windows forwarder targets (phones only); PORT serves the PC browser + CLI. */
export const LAN_INTERNAL_PORT = Number(process.env.PILOTAGE_LAN_INTERNAL_PORT || PORT - 1);
export const BIND = '127.0.0.1';

export const CLAUDE_DIR = path.join(HOME, '.claude');
export const CLAUDE_BIN = fs.existsSync(path.join(HOME, '.local/bin/claude')) ? path.join(HOME, '.local/bin/claude') : 'claude';
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

/** Paths Pilotage itself creates; never shown as projects. */
export const INTERNAL_PATHS = [path.join(ROOT, '.sandbox'), path.join(DATA, 'ai-sandbox')];

export const paths = {
  state: path.join(DATA, 'state.json'),
  secrets: path.join(DATA, 'secrets.json'),
  index: path.join(DATA, 'index', 'sessions.json'),
  turnsDir: path.join(DATA, 'index', 'turns'),
  ai: path.join(DATA, 'ai.json'),
  launchDir: path.join(DATA, 'launch'),
  logs: path.join(DATA, 'logs'),
  backups: path.join(DATA, 'backups'),
  aiSandbox: path.join(DATA, 'ai-sandbox'),
  gitCache: path.join(DATA, 'index', 'git.json'),
  netInfo: path.join(DATA, 'net.json'),
};

export function ensureDirs() {
  for (const d of [DATA, path.dirname(paths.index), paths.turnsDir, paths.launchDir, paths.logs, paths.backups, paths.aiSandbox]) {
    fs.mkdirSync(d, { recursive: true });
  }
  try {
    fs.chmodSync(DATA, 0o700);
  } catch {}
}
