// `pilotage doctor`: checks what a new install needs and says how to fix what's missing. Read-only: it never
// changes anything, and the only programs it runs are `--version` calls (and, on WSL, Windows' `cmd.exe /c ver`).
// bin/pilotage checks Node.js itself (this file needs it) and passes a few facts it knows better (PATH, autostart).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VERSION, IS_WSL, OS_NAME, DATA, PORT, WEB_DIST, CLAUDE_BIN, CLAUDE_CMD, CLAUDE_DIR, WIN_HOME, WT_EXE, WIN_NODE } from './config.js';

const SYS32 = process.env.PILOTAGE_WIN_SYSTEM32 || '/mnt/c/Windows/System32';

function version(bin, args = ['--version'], env) {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], env });
    return (/\d+\.\d+(\.\d+)?/.exec(out) || [out.trim().split('\n')[0]])[0] || 'found';
  } catch {
    return null;
  }
}

function countTranscripts(dir) {
  let n = 0;
  try {
    for (const d of fs.readdirSync(path.join(dir, 'projects'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(dir, 'projects', d.name))) if (f.endsWith('.jsonl')) n++;
      if (n > 9999) break;
    }
  } catch {}
  return n;
}

function launchMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'))?.settings?.launch?.permissionMode || null;
  } catch {
    return null;
  }
}

/** Whether something accepts TCP connections on 127.0.0.1:port. */
function portTaken(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** [{level: 'ok'|'warn'|'fail', text, fix?}] */
export async function runChecks({ onPath = null, autostart = null, fromNpx = false } = {}) {
  const out = [];
  const ok = (text) => out.push({ level: 'ok', text });
  const warn = (text, fix) => out.push({ level: 'warn', text, fix });
  const fail = (text, fix) => out.push({ level: 'fail', text, fix });

  ok(`Node.js ${process.versions.node}, Pilotage ${VERSION} on ${OS_NAME === 'wsl' ? 'WSL2' : OS_NAME === 'darwin' ? 'macOS' : OS_NAME}`);

  // Data folder (read-only check: the nearest folder that exists must be writable; nothing is created)
  {
    let probe = DATA;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    try {
      fs.accessSync(probe, fs.constants.W_OK);
      ok(probe === DATA ? `Data folder ${DATA}` : `Data folder ${DATA} (created at the first start)`);
    } catch {
      fail(`Data folder ${DATA} is not writable`, 'Fix its permissions, or set PILOTAGE_DATA to a folder you own.');
    }
  }

  // The server
  let health = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2000) });
    health = r.ok ? await r.json().catch(() => ({})) : { other: true };
  } catch {}
  // No HTTP answer: free port, or a program that accepts connections but isn't a web server (it would make
  // `pilotage start` fail with "address in use" while doctor said "not running").
  if (!health && (await portTaken(PORT))) health = { other: true };
  if (health?.app === 'pilotage') ok(`Pilotage is running on port ${PORT} (sign in with: pilotage open)`);
  else if (health) fail(`Port ${PORT} is used by another program`, 'Stop it, or start Pilotage on another port: PILOTAGE_PORT=4757 pilotage start');
  else warn('Pilotage is not running', 'Start it with: pilotage   (it opens in your browser)');
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) warn('The web app is not built yet', 'Run: pilotage build   (pilotage start does it the first time)');

  // Claude Code
  const cv = version(CLAUDE_CMD[0], [...CLAUDE_CMD.slice(1), '--version']);
  if (!cv) {
    fail('Claude Code not found', 'Install it (https://claude.com/claude-code), then run `claude` and /login. Pilotage still lists sessions without it, but cannot summarize or start them.');
  } else if (Number(cv.split('.')[0]) < 2) {
    fail(`Claude Code ${cv} is too old (${CLAUDE_BIN})`, 'Update it: claude update   (or reinstall). Summaries and launches need Claude Code 2 or later.');
  } else {
    ok(`Claude Code ${cv} (${CLAUDE_BIN})`);
  }
  const keyVar = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : process.env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : null;
  if (keyVar) {
    if (process.env.ANTHROPIC_BASE_URL) ok(`Summaries use ANTHROPIC_BASE_URL with ${keyVar} (a gateway setup is kept as is)`);
    else if (process.env.PILOTAGE_USE_ANTHROPIC_API_KEY === '1') warn(`Summaries are billed to ${keyVar} (PILOTAGE_USE_ANTHROPIC_API_KEY=1)`, 'The usage guard only sees your subscription: keep an eye on the API account.');
    else ok(`${keyVar} is set, but summaries use your Claude login (set PILOTAGE_USE_ANTHROPIC_API_KEY=1 to bill it)`);
  }
  const n = countTranscripts(CLAUDE_DIR);
  if (n) ok(`${n} Claude Code session file${n === 1 ? '' : 's'} in ${CLAUDE_DIR}`);
  else warn(`No Claude Code sessions in ${CLAUDE_DIR} yet`, 'Pilotage fills up as you use Claude Code. Start one with: pilotage new <project> "first prompt"');

  // Tools
  if (version('git')) ok('git');
  else fail('git not found', 'Install git: projects are found and grouped through it.');
  if (!version(process.env.PILOTAGE_OPENSSL || 'openssl', ['version'])) warn('openssl not found: phones can only use plain http', 'Install openssl for HTTPS on the phone (optional).');

  // Windows side (WSL)
  if (IS_WSL) {
    const interop = WIN_HOME && version(path.join(SYS32, 'cmd.exe'), ['/c', 'ver']);
    if (!WIN_HOME) fail('Windows profile not found from WSL', 'Set PILOTAGE_WIN_HOME=/mnt/c/Users/<you>.');
    else if (!interop) fail("WSL can't start Windows programs (interop is off)", 'Pilotage can still be used: open the link `pilotage open` prints. To fix: enable interop in /etc/wsl.conf ([interop] enabled=true), then wsl --shutdown.');
    else ok(`Windows profile ${WIN_HOME}`);
    if (WIN_HOME) {
      if (WT_EXE && fs.existsSync(WT_EXE)) ok('Windows Terminal (sessions open in a tab)');
      else warn('Windows Terminal not found: sessions start in the background', 'Install Windows Terminal from the Microsoft Store to open sessions in a tab.');
      if (fs.existsSync(WIN_NODE)) ok('Node.js on Windows (needed for phone access)');
      else warn('Node.js is not installed on Windows: phone access needs it', 'Install Node.js for Windows (nodejs.org), only if you want to use Pilotage from your phone.');
    }
  }

  // The command, autostart, launch mode
  if (onPath === false) warn('The `pilotage` command is not on your PATH', fromNpx ? 'To keep it: npm install -g pilotage-cli && pilotage install' : 'Add ~/.local/bin (or npm\'s global bin folder) to PATH in your shell profile, then open a new terminal.');
  if (autostart === true) ok('Starts automatically at login');
  else if (autostart === false) warn('Not started automatically at login', OS_NAME === 'linux' ? 'Run: pilotage install   (a systemd user service)' : 'Run: pilotage install');
  const mode = launchMode() || 'default';
  if (mode === 'bypassPermissions') warn('Sessions you start from Pilotage skip permission prompts', 'Fine for your own code. To be asked first: Settings → New sessions → Permissions.');
  return out;
}

const ICON = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const flag = (v) => (v === '1' ? true : v === '0' ? false : null);
  const checks = await runChecks({ onPath: flag(process.env.PILOTAGE_DOCTOR_ON_PATH), autostart: flag(process.env.PILOTAGE_DOCTOR_AUTOSTART), fromNpx: process.env.PILOTAGE_DOCTOR_NPX === '1' });
  for (const c of checks) {
    console.log(`${ICON[c.level]} ${c.text}`);
    if (c.fix) console.log(`  \x1b[2m${c.fix}\x1b[0m`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  console.log(fails ? `\n${fails} problem${fails > 1 ? 's' : ''} to fix${warns ? `, ${warns} note${warns > 1 ? 's' : ''}` : ''}.` : warns ? `\nReady. ${warns} note${warns > 1 ? 's' : ''} above.` : '\nAll good.');
  process.exit(fails ? 1 : 0);
}
