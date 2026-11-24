// Starting / resuming Claude sessions, and opening folders on the PC.
// A terminal launch writes a SCRIPT that runs `claude --remote-control NAME ...` (so the session shows up in the
// Claude app on the user's phone too) and opens it in a terminal (terminal.js):
//   WSL2 + Windows: wt.exe -w 0 new-tab --title T wsl.exe -d Ubuntu --cd DIR -- bash -l SCRIPT
//   macOS: open -a Terminal SCRIPT.command      Linux: <terminal emulator> -e bash -l SCRIPT
// With no terminal to open (SSH, headless, PILOTAGE_TERMINAL=none), Claude sessions start in the background (`claude --bg`).
// Other harnesses (opts.harness = 'codex' | 'gemini') use the same terminal path with their own CLI
// (`codex [-m M] -- PROMPT`, `codex resume ID`, `gemini --prompt-interactive=PROMPT`). Background mode is Claude-only.
// Windows Terminal splits its command line on ';' in any argument: paths with ';' are refused there (assertWtSafe).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CLAUDE_CMD, CLAUDE_DIR, WT_EXE, WSL_DISTRO, VSCODE_CLI, EXPLORER_EXE, CMD_EXE, paths, HOME, IS_WSL } from './config.js';
import { run, shq, clip, readJSONSync, log } from './util.js';
import { bridgeUrl } from './sources/live.js';
import { findBin } from './sources/harness/common.js';
import { detectTerminal, openInTerminal } from './terminal.js';

const SUBCOMMANDS = new Set(['agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade', 'remote-control', 'config']);
const MODELS = new Set(['', 'opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']);
/** Modes a launch may ask for. "manual" is Pilotage's older name for Claude Code's ask mode ("default"). */
export const PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits', 'auto', 'manual', 'default', 'plan', 'dontAsk']);
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HARNESSES = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' };
const CODEX_SUBCOMMANDS = new Set(['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'a', 'resume', 'cloud', 'features', 'help']);
const SAFE_MODEL = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;
const WT_SEMI = 'Folder path contains ";" or \'"\' which Windows Terminal cannot handle safely';
const NO_WT = 'Terminal tabs need WSL2 and Windows Terminal';
// On WSL the missing piece is Windows Terminal (Windows 10 doesn't ship it): say so.
const NO_TERM = IS_WSL && String(process.env.PILOTAGE_TERMINAL || '').toLowerCase() !== 'none' ? 'Windows Terminal (wt.exe) is not installed (get it from the Microsoft Store)' : 'No terminal window can be opened on this computer';
/** After the session ends, the window stays open on a shell (bash on WSL, the user's shell elsewhere). */
const KEEP_OPEN = IS_WSL ? 'exec bash -l' : 'exec "${SHELL:-/bin/bash}" -l';

let termCache = { at: 0, t: null };
/** The terminal sessions open in (Windows Terminal, Terminal.app, a Linux emulator), or null. Re-checked every 30 s. */
export function terminal() {
  if (Date.now() - termCache.at > 30_000) termCache = { at: Date.now(), t: detectTerminal() };
  return termCache.t;
}
const scriptFile = (base) => path.join(paths.launchDir, base + (terminal()?.ext || '.sh'));

/** Run a launch script in a new terminal tab (WSL) or window (macOS, Linux). */
async function openScript(script, { title, cwd }) {
  const t = terminal();
  if (!t) throw new Error(NO_TERM);
  if (t.kind !== 'wt') return openInTerminal(t, script);
  const r = await runWT(['-w', '0', 'new-tab', '--title', title, 'wsl.exe', '-d', WSL_DISTRO, '--cd', cwd, '--', 'bash', '-l', script]);
  if (r.code !== 0) throw new Error(`wt.exe failed: ${clip(r.stderr || r.stdout, 200)}`);
}
/** ';' only matters to Windows Terminal. */
const assertTermSafe = (p) => terminal()?.kind === 'wt' && assertWtSafe(p);
/** Linux / macOS opener for folders and links (Windows uses explorer.exe from WSL). */
const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open';

/** Windows Terminal treats ';' in any argument as a command separator. */
export function assertWtSafe(p) {
  // ';' splits wt.exe's command line; '"' breaks out of the quotes Windows Terminal adds around arguments with spaces
  // (it doesn't escape inner quotes), and wsl.exe then runs whatever follows `--`.
  if (/[;"]/.test(String(p ?? ''))) throw new Error(WT_SEMI);
}

/** Every wt.exe call goes through here: ';' refused in paths, replaced in titles. */
async function runWT(args) {
  const safe = args.map((a, i) => {
    if (args[i - 1] === '--title') return String(a).replace(/;/g, ',');
    assertWtSafe(a);
    return a;
  });
  if (!IS_WSL) throw new Error(NO_WT);
  if (!WT_EXE || !fs.existsSync(WT_EXE)) throw new Error('Windows Terminal (wt.exe) not found');
  return run(WT_EXE, safe, { timeout: 20000, cwd: '/mnt/c/' });
}

/** Which CLI a launch uses. A resume id carries its harness ('codex-…', 'gemini-…'). */
export function resolveHarness(harness, resumeId) {
  if (/^codex-/.test(resumeId || '')) return 'codex';
  if (/^gemini-/.test(resumeId || '')) return 'gemini';
  return HARNESSES[harness] ? harness : 'claude';
}

export function sanitizeName(s, fallback = 'Session') {
  const n = String(s || '')
    .replace(/[^\p{L}\p{N} _.()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+/, '')
    .slice(0, 60);
  return n || fallback;
}

function safePrompt(p, harness = 'claude') {
  let s = String(p || '').replace(/\r\n/g, '\n').trim();
  if (!s) return '';
  if ((harness === 'codex' ? CODEX_SUBCOMMANDS : SUBCOMMANDS).has(s.toLowerCase())) s += ' .';
  return s.slice(0, 20000);
}

/** Model names for non-Claude CLIs: any safe token that isn't a Claude alias (the launch default may be one). */
function harnessModel(m) {
  const s = typeof m === 'string' ? m.trim() : '';
  return s && SAFE_MODEL.test(s) && !MODELS.has(s) && !s.startsWith('claude-') ? s : '';
}

/**
 * Pilotage permission modes → codex / gemini flags (bypassPermissions = their "yolo" equivalents).
 * Fails closed: only the exact value bypassPermissions skips approvals; anything unknown or mistyped asks first.
 */
export function harnessPermissionArgs(harness, mode) {
  const edits = mode === 'acceptEdits' || mode === 'auto';
  const ask = mode !== 'bypassPermissions' && !edits;
  if (harness === 'codex') return ask ? [] : edits ? ['--full-auto'] : ['--dangerously-bypass-approvals-and-sandbox'];
  if (harness === 'gemini') return ['--approval-mode', ask ? 'default' : edits ? 'auto_edit' : 'yolo'];
  return permissionArgs(mode);
}

/**
 * Command for a codex / gemini terminal launch (pure; tested).
 * Returns {args, promptArg} where promptArg(varRef) gives the shell words that pass the prompt.
 */
export function buildHarnessCommand({ harness, model = '', permissionMode, resumeId = null }) {
  const args = [];
  if (harness === 'codex') {
    if (resumeId) args.push('resume');
    args.push(...harnessPermissionArgs('codex', permissionMode));
    if (model) args.push('-m', model);
    if (resumeId) args.push(resumeId);
    // `--` ends options, so a prompt starting with "-" stays a prompt.
    return { args, promptArg: (v) => `-- "${v}"` };
  }
  if (harness === 'gemini') {
    args.push(...harnessPermissionArgs('gemini', permissionMode));
    if (model) args.push('-m', model);
    // A positional prompt would be one-shot; -i keeps the session interactive. "=value" form: the prompt can't be read as a flag.
    return { args, promptArg: (v) => `"--prompt-interactive=${v}"` };
  }
  throw new Error(`Unknown harness ${harness}`);
}

/** Bash script run in the new Windows Terminal tab for codex / gemini (pure; tested). */
export function harnessScript({ cwd, name, bin, args, promptArg, promptFile = null, script, nodeBin = path.dirname(process.execPath) }) {
  return [
    '#!/usr/bin/env bash',
    `# Started by Pilotage on ${new Date().toISOString()}`,
    `cd -- ${shq(cwd)} || { echo "Pilotage: folder not found"; exec bash -l; }`,
    `printf '\\033]0;%s\\007' ${shq(name)}`,
    // codex / gemini are node scripts (#!/usr/bin/env node): make sure node 22 is found first.
    `export PATH=${shq(nodeBin)}:"$PATH"`,
    `BIN=${shq(bin)}`,
    `ARGS=(${args.map(shq).join(' ')})`,
    promptFile ? `PROMPT="$(cat ${shq(promptFile)})"; rm -f ${shq(promptFile)}; "$BIN" "\${ARGS[@]}" ${promptArg('$PROMPT')}` : `"$BIN" "\${ARGS[@]}"`,
    `rm -f ${shq(script)}`,
    KEEP_OPEN,
    '',
  ].join('\n');
}

const launches = new Map(); // launchId -> record

export function getLaunch(id) {
  return launches.get(id) || null;
}

export function listLaunches() {
  return [...launches.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
}

function permissionArgs(mode) {
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  // "default" (ask before acting) is the spelling every Claude Code version accepts; older ones refuse "manual".
  if (mode === 'manual' || !PERMISSION_MODES.has(mode)) return ['--permission-mode', 'default'];
  return ['--permission-mode', mode];
}

/**
 * Launch a session.
 * opts: {cwd, name, prompt, mode: 'terminal'|'background', resumeId, fork, model, permissionMode,
 *        harness: 'claude' (default) | 'codex' | 'gemini'}
 */
export async function launch(opts) {
  const id = crypto.randomUUID();
  const harness = resolveHarness(opts.harness, opts.resumeId);
  let mode = opts.mode === 'background' ? 'background' : 'terminal';
  // No terminal to open (SSH, headless): Claude sessions start in the background instead (attach with `claude attach`).
  const term = terminal();
  const fallback = !term && mode === 'terminal' && harness === 'claude';
  if (fallback) mode = 'background';
  const name = sanitizeName(opts.name, path.basename(opts.cwd));
  const model = harness === 'claude' ? (MODELS.has(opts.model || '') ? opts.model || '' : '') : harnessModel(opts.model);
  const prompt = safePrompt(opts.prompt, harness);
  const rawResume = harness === 'codex' ? String(opts.resumeId || '').replace(/^codex-/, '') : opts.resumeId;
  const resumeId = rawResume && UUID_RX.test(rawResume) && harness !== 'gemini' ? rawResume : null;
  const rec = {
    id,
    mode,
    harness,
    cwd: opts.cwd,
    name,
    model,
    resumeId,
    fork: !!opts.fork,
    hasPrompt: !!prompt,
    createdAt: Date.now(),
    state: 'starting',
    sessionId: null,
    bgId: null,
    bridgeUrl: null,
    error: null,
    from: opts.from || null,
    terminal: mode === 'terminal' ? term?.label || null : null,
  };
  launches.set(id, rec);
  if (!fs.existsSync(opts.cwd)) {
    rec.state = 'error';
    rec.error = 'Folder not found';
    return rec;
  }
  if (harness !== 'claude') {
    const label = HARNESSES[harness];
    let err = null;
    if (!term) err = `${NO_TERM}. Start ${label} yourself in a terminal: cd ${opts.cwd} && ${harness}`;
    else if (mode === 'background') err = `Background mode is Claude-only. Start ${label} in a terminal instead.`;
    else if (opts.fork) err = `Fork is Claude-only; ${label} sessions can be resumed, not forked.`;
    else if (harness === 'gemini' && opts.resumeId) err = 'Gemini CLI resumes by list position only, so Pilotage cannot resume a given Gemini session. Start a new one.';
    if (err) {
      rec.state = 'error';
      rec.error = err;
      return rec;
    }
  }
  try {
    if (harness !== 'claude') await launchHarnessTerminal(rec, { prompt, permissionMode: opts.permissionMode });
    else if (mode === 'terminal') await launchTerminal(rec, { prompt, permissionMode: opts.permissionMode });
    else await launchBackground(rec, { prompt, permissionMode: opts.permissionMode });
    if (fallback && rec.state !== 'error') {
      rec.fallback = true;
      rec.note = `${NO_TERM}, so it runs in the background. To type in it: claude attach ${rec.bgId}`;
    }
  } catch (e) {
    rec.state = 'error';
    rec.error = clip(e.message, 300);
  }
  if (rec.state !== 'error' && harness === 'claude') watchLaunch(rec);
  return rec;
}

/** codex / gemini in a new terminal tab or window. Not live-tracked: the session appears once its file is written. */
async function launchHarnessTerminal(rec, { prompt, permissionMode }) {
  assertTermSafe(rec.cwd);
  const bin = findBin(rec.harness);
  if (!bin) throw new Error(`${HARNESSES[rec.harness]} not found (looked for "${rec.harness}" on PATH and next to node)`);
  const { args, promptArg } = buildHarnessCommand({ harness: rec.harness, model: rec.model, permissionMode, resumeId: rec.resumeId });
  rec.sessionId = rec.harness === 'codex' && rec.resumeId ? `codex-${rec.resumeId}` : null;
  const promptFile = prompt ? path.join(paths.launchDir, `${rec.id}.prompt`) : null;
  if (promptFile) fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  const script = scriptFile(rec.id);
  fs.writeFileSync(script, harnessScript({ cwd: rec.cwd, name: rec.name, bin, args, promptArg, promptFile, script }), { mode: 0o700 });
  await openScript(script, { title: rec.name, cwd: rec.cwd });
  rec.state = 'launched';
  rec.note = `${HARNESSES[rec.harness]} started in ${rec.terminal || 'a terminal'}. It shows up in Pilotage after its first prompt (not live-tracked).`;
}

async function launchTerminal(rec, { prompt, permissionMode }) {
  assertTermSafe(rec.cwd);
  // New sessions get an id we choose so we can find them; resumes keep their id unless forked.
  const sessionId = rec.resumeId && !rec.fork ? rec.resumeId : crypto.randomUUID();
  rec.sessionId = sessionId;
  const args = [...permissionArgs(permissionMode), '--remote-control', rec.name];
  if (rec.model) args.push('--model', rec.model);
  if (rec.resumeId) {
    args.push('--resume', rec.resumeId);
    if (rec.fork) {
      args.push('--fork-session');
      rec.sessionId = null; // discovered after start (matched by folder + start time)
    }
  } else args.push('--session-id', sessionId);
  const promptFile = path.join(paths.launchDir, `${rec.id}.prompt`);
  if (prompt) fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  const script = scriptFile(rec.id);
  const lines = [
    '#!/usr/bin/env bash',
    `# Started by Pilotage on ${new Date().toISOString()}`,
    `cd -- ${shq(rec.cwd)} || { echo "Pilotage: folder not found"; exec bash -l; }`,
    `printf '\\033]0;%s\\007' ${shq(rec.name)}`,
    `CLAUDE=(${CLAUDE_CMD.map(shq).join(' ')})`, // [node] claude: an npm install runs with Pilotage's node
    // ...and node stays findable (last, so the user's own node wins) for claude's children: MCP servers run with npx,
    // node hooks, wrapper shims. Launch tabs are non-interactive login shells, where nvm usually isn't loaded.
    `export PATH="$PATH":${shq(path.dirname(process.execPath))}`,
    `ARGS=(${args.map(shq).join(' ')})`,
    prompt
      ? `PROMPT="$(cat ${shq(promptFile)})"; rm -f ${shq(promptFile)}; "\${CLAUDE[@]}" "\${ARGS[@]}" -- "$PROMPT"`
      : `"\${CLAUDE[@]}" "\${ARGS[@]}"`,
    `rm -f ${shq(script)}`,
    KEEP_OPEN,
    '',
  ];
  fs.writeFileSync(script, lines.join('\n'), { mode: 0o700 });
  await openScript(script, { title: rec.name, cwd: rec.cwd });
  rec.state = 'launched';
}

async function launchBackground(rec, { prompt, permissionMode }) {
  const args = ['--bg', '-n', rec.name, ...permissionArgs(permissionMode)];
  if (rec.model) args.push('--model', rec.model);
  if (rec.resumeId) {
    args.push('--resume', rec.resumeId);
    if (rec.fork) args.push('--fork-session');
  }
  if (prompt) args.push('--', prompt);
  // Run through a login shell so PATH / nvm match the user's normal terminals.
  const cmd = `export PATH="$PATH":${shq(path.dirname(process.execPath))}; ${[...CLAUDE_CMD, ...args].map(shq).join(' ')}`;
  const r = await run('bash', ['-lc', cmd], { cwd: rec.cwd, timeout: 60000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(out.replace(/\x1b\[[0-9;]*m/g, ''));
  if (!m) {
    if (/command not found|ENOENT/i.test(out)) throw new Error('Claude Code (the "claude" command) was not found. Install it and log in, then try again.');
    throw new Error(`claude --bg did not start: ${clip(out.trim(), 240)}`);
  }
  rec.bgId = m[1];
  rec.state = 'launched';
}

/** Poll Claude's own state files until we know the session id + phone link. */
function watchLaunch(rec) {
  let tries = 0;
  const tick = () => {
    tries++;
    try {
      if (rec.mode === 'background' && rec.bgId) {
        const j = readJSONSync(path.join(CLAUDE_DIR, 'jobs', rec.bgId, 'state.json'), null);
        if (j) {
          rec.sessionId = j.sessionId || rec.sessionId;
          if (j.bridgeSessionId) rec.bridgeUrl = bridgeUrl(j.bridgeSessionId);
          rec.state = rec.bridgeUrl ? 'ready' : 'running';
          rec.detail = clip(j.detail || '', 200);
        }
      }
      if (rec.mode === 'terminal') {
        const dir = path.join(CLAUDE_DIR, 'sessions');
        let best = null;
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          const j = readJSONSync(path.join(dir, f), null);
          if (!j) continue;
          if (rec.sessionId && j.sessionId === rec.sessionId) {
            best = j;
            break;
          }
          if (!rec.sessionId && j.cwd === rec.cwd && (j.startedAt || 0) >= rec.createdAt - 5000 && (!best || j.startedAt > best.startedAt)) best = j;
        }
        if (best) {
          rec.sessionId = best.sessionId;
          rec.pid = best.pid;
          rec.state = best.bridgeSessionId ? 'ready' : 'running';
          if (best.bridgeSessionId) rec.bridgeUrl = bridgeUrl(best.bridgeSessionId);
        }
      }
    } catch (e) {
      log.warn('watchLaunch', e.message);
    }
    if (rec.bridgeUrl || tries > 60) {
      if (!rec.bridgeUrl && rec.state !== 'ready') rec.note = 'Started, but no phone link yet. It appears in Live once Remote Control connects.';
      return;
    }
    setTimeout(tick, tries < 10 ? 1500 : 4000).unref?.();
  };
  setTimeout(tick, 1500).unref?.(); // the HTTP server keeps the process alive; tests and the CLI need not wait
}

export async function attachTerminal(bgId, name) {
  if (!/^[0-9a-f]{6,}$/.test(bgId || '')) throw new Error('bad id');
  if (!terminal()) throw new Error(`${NO_TERM}. In a terminal, run: claude attach ${bgId}`);
  assertTermSafe(HOME);
  const script = scriptFile(`attach-${bgId}`);
  assertTermSafe(script);
  const title = sanitizeName(name, bgId);
  fs.writeFileSync(script, ['#!/usr/bin/env bash', `cd -- ${shq(HOME)}`, `printf '\\033]0;%s\\007' ${shq(title)}`, `${[...CLAUDE_CMD, 'attach', bgId].map(shq).join(' ')}`, `rm -f ${shq(script)}`, KEEP_OPEN, ''].join('\n'), { mode: 0o700 });
  await openScript(script, { title, cwd: HOME });
}

export async function stopBackground(bgId) {
  if (!/^[0-9a-f]{6,}$/.test(bgId || '')) throw new Error('bad id');
  const r = await run(CLAUDE_CMD[0], [...CLAUDE_CMD.slice(1), 'stop', bgId], { timeout: 20000 });
  if (r.code !== 0) throw new Error(clip(r.stderr || r.stdout, 200));
}

export async function openShell(cwd, title) {
  const t = terminal();
  const name = sanitizeName(title, 'Shell');
  if (!t && !IS_WSL) throw new Error(NO_TERM);
  if (!t || t.kind === 'wt') {
    assertWtSafe(cwd);
    const r = await runWT(['-w', '0', 'new-tab', '--title', name, 'wsl.exe', '-d', WSL_DISTRO, '--cd', cwd]);
    if (r.code !== 0) throw new Error(clip(r.stderr, 200));
    return;
  }
  const script = scriptFile(`shell-${crypto.randomUUID()}`);
  fs.writeFileSync(script, ['#!/usr/bin/env bash', `cd -- ${shq(cwd)} || exit 1`, `printf '\\033]0;%s\\007' ${shq(name)}`, `rm -f ${shq(script)}`, KEEP_OPEN, ''].join('\n'), { mode: 0o700 });
  await openInTerminal(t, script);
}

export async function openVSCode(cwd) {
  if (!IS_WSL) {
    // Linux / macOS: the `code` command, when VS Code put it on PATH.
    const r = await run('code', [cwd], { timeout: 30000, cwd });
    if (r.code !== 0) throw new Error(/ENOENT/.test(r.stderr) ? 'VS Code not found (the "code" command is not on PATH)' : clip(r.stderr, 200));
    return;
  }
  if (!VSCODE_CLI || !fs.existsSync(VSCODE_CLI)) throw new Error('VS Code not found');
  const r = await run(VSCODE_CLI, [cwd], { timeout: 30000, cwd });
  if (r.code !== 0) throw new Error(clip(r.stderr, 200));
}

export async function openExplorer(cwd) {
  if (!IS_WSL) {
    const r = await run(OPENER, [cwd], { timeout: 15000 });
    if (r.code !== 0) throw new Error(/ENOENT/.test(r.stderr) ? `No file manager opener found (${OPENER})` : clip(r.stderr || `${OPENER} failed`, 200));
    return;
  }
  const w = await run('wslpath', ['-w', cwd]);
  const winPath = w.stdout.trim();
  if (!winPath) throw new Error('wslpath failed');
  // explorer.exe returns exit code 1 even on success
  await run(EXPLORER_EXE, [winPath], { timeout: 15000, cwd: '/mnt/c/' });
}

export async function openUrlOnPC(url) {
  if (!/^https?:\/\/[^\s"]+$/.test(url)) throw new Error('bad url');
  if (!IS_WSL) {
    const r = await run(OPENER, [url], { timeout: 15000 });
    if (r.code !== 0) throw new Error(`Could not open a browser (${OPENER})`);
    return;
  }
  await run(EXPLORER_EXE, [url], { timeout: 15000, cwd: '/mnt/c/' });
}
