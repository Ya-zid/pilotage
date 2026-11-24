// The terminal Pilotage opens sessions in, on this computer.
//   WSL2 + Windows: a Windows Terminal tab (launch.js builds the wt.exe command line).
//   macOS: `open -a Terminal SCRIPT.command`. PILOTAGE_TERMINAL names another app that runs a script it is opened with
//          (e.g. iTerm). `open` needs no Automation permission, unlike AppleScript.
//   Linux: the first terminal emulator found on PATH (PILOTAGE_TERMINAL picks one), in a graphical session only.
// PILOTAGE_TERMINAL=none turns terminal windows off: Claude sessions then start in the background.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IS_WSL, HOME, WT_EXE } from './config.js';

/** Run `bash -l SCRIPT` in a new window: the argument style of each emulator. Order = preference. */
const RUN_LOGIN = (s) => ['-e', 'bash', '-l', s];
const LINUX_TERMINALS = [
  ['x-terminal-emulator', RUN_LOGIN], // Debian / Ubuntu: the default the user picked
  ['gnome-terminal', (s) => ['--', 'bash', '-l', s]],
  ['konsole', RUN_LOGIN],
  ['xfce4-terminal', (s) => ['-x', 'bash', '-l', s]],
  ['ptyxis', (s) => ['--', 'bash', '-l', s]],
  ['kitty', (s) => ['bash', '-l', s]],
  ['alacritty', RUN_LOGIN],
  ['wezterm', (s) => ['start', '--', 'bash', '-l', s]],
  ['ghostty', RUN_LOGIN],
  ['foot', (s) => ['bash', '-l', s]],
  ['tilix', RUN_LOGIN],
  ['xterm', RUN_LOGIN],
];
const LINUX_ARGS = Object.fromEntries(LINUX_TERMINALS);

const isExec = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function findOnPath(name, envPath = process.env.PATH || '') {
  if (name.includes('/')) return isExec(name) ? name : null;
  for (const dir of envPath.split(path.delimiter)) {
    if (dir && isExec(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** "gnome-terminal" for /usr/bin/x-terminal-emulator → /etc/alternatives/… → gnome-terminal.wrapper. */
function labelOf(bin) {
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch {}
  return path.basename(real).replace(/\.(wrapper|real)$/, '');
}

/**
 * The terminal to open sessions in, or null when there is none (tested with explicit inputs).
 * Returns {kind: 'wt'|'open'|'exec', label, cmd?, args?(script), ext}.
 */
export function detectTerminal({ platform = process.platform, env = process.env, wsl = IS_WSL, wtExe = WT_EXE } = {}) {
  const want = String(env.PILOTAGE_TERMINAL || '').trim();
  if (want.toLowerCase() === 'none') return null;
  // Windows 10 doesn't ship Windows Terminal: without it, Claude sessions start in the background (launch.js).
  if (wsl) return wtExe && fs.existsSync(wtExe) ? { kind: 'wt', label: 'Windows Terminal', ext: '.sh' } : null;
  if (platform === 'darwin') {
    const app = want || 'Terminal';
    return { kind: 'open', label: app, cmd: 'open', args: (s) => ['-a', app, s], ext: '.command' };
  }
  if (platform !== 'linux' && !/bsd$/.test(platform)) return null;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null; // SSH or a headless box: no window to open
  const list = want ? [[want, LINUX_ARGS[path.basename(want)] || RUN_LOGIN]] : LINUX_TERMINALS;
  for (const [name, args] of list) {
    const bin = findOnPath(name, env.PATH);
    if (bin) return { kind: 'exec', label: labelOf(bin), cmd: bin, args, ext: '.sh' };
  }
  return null;
}

/**
 * Open `script` in a new window (macOS / Linux). Resolves once the window is up: the opener exited 0 (open,
 * gnome-terminal) or is still running after a moment (kitty, xterm…, which stay in the foreground).
 */
export function openInTerminal(t, script, { settleMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const child = spawn(t.cmd, t.args(script), { detached: true, stdio: 'ignore', cwd: HOME });
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (err) reject(err);
      else resolve();
    };
    child.on('error', (e) => done(new Error(e.code === 'ENOENT' ? `${t.label} not found` : `Could not open ${t.label}: ${e.message}`)));
    child.on('exit', (code, sig) => done(code === 0 ? null : new Error(`Could not open ${t.label} (exit ${code ?? sig})`)));
    timer = setTimeout(() => done(null), settleMs);
  });
}
