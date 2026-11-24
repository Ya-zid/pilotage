// Terminal windows on macOS and Linux (server/terminal.js and the non-WSL launch path). A fake terminal emulator and a
// fake `claude` stand in for the real ones: no window opens and no session starts.
// On macOS with PILOTAGE_TEST_TERMINAL_APP=1 (CI), one test opens the real Terminal.app, still with the fake claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-term-'));
const HOME = path.join(BASE, 'home');
const BIN = path.join(BASE, 'bin');
fs.mkdirSync(HOME);
fs.mkdirSync(BIN);
process.env.HOME = HOME; // CLAUDE_BIN = <fake home>/.local/bin/claude (our fake), never the real one
const MAC_REAL = process.platform === 'darwin' && process.env.PILOTAGE_TEST_TERMINAL_APP === '1';
const SKIP_OFF_LINUX = process.platform === 'linux' ? false : 'the fake terminal runs on Linux';
process.env.PILOTAGE_DATA = path.join(BASE, 'data');
process.env.PILOTAGE_WSL = '0';
process.env.DISPLAY = ':99';
delete process.env.WAYLAND_DISPLAY;
if (MAC_REAL) delete process.env.PILOTAGE_TERMINAL;
else process.env.PILOTAGE_TERMINAL = path.join(BIN, 'xterm'); // the fake one, even where a real terminal is on PATH
process.env.SHELL = '/bin/true'; // the "keep the window open" shell at the end of a launch script exits at once
process.env.PATH = `${BIN}:/usr/bin:/bin`;

const exe = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const ARGS_OUT = path.join(BASE, 'terminal-args');
const CLAUDE_OUT = path.join(BASE, 'claude-args');
// Fake xterm: records its arguments, then runs what follows -e (without -l: no login profile in tests).
exe('xterm', `printf '%s\\0' "$@" > ${JSON.stringify(ARGS_OUT)}\n[ "$1" = -e ] && shift\n[ "$1" = bash ] && shift\n[ "$1" = -l ] && shift\nexec bash "$@"`);
// Absolute, so it is found even in a Terminal.app window (whose PATH is the login shell's, not ours).
fs.mkdirSync(path.join(HOME, '.local', 'bin'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.local', 'bin', 'claude'), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${JSON.stringify(CLAUDE_OUT)}\n`, { mode: 0o755 });

const { ensureDirs, paths } = await import('../server/config.js');
ensureDirs();
const T = await import('../server/terminal.js');
const L = await import('../server/launch.js');

const waitFor = async (f, ms = 5000) => {
  for (let t = 0; t < ms; t += 50) {
    if (fs.existsSync(f)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const readArgs = (f) => fs.readFileSync(f, 'utf8').split('\0').slice(0, -1);

test('macOS: open -a Terminal with a .command script; PILOTAGE_TERMINAL names another app', () => {
  const t = T.detectTerminal({ platform: 'darwin', env: {}, wsl: false });
  assert.equal(t.kind, 'open');
  assert.equal(t.label, 'Terminal');
  assert.equal(t.ext, '.command');
  assert.deepEqual([t.cmd, ...t.args('/x/s.command')], ['open', '-a', 'Terminal', '/x/s.command']);
  const it = T.detectTerminal({ platform: 'darwin', env: { PILOTAGE_TERMINAL: 'iTerm' }, wsl: false });
  assert.deepEqual(it.args('/s'), ['-a', 'iTerm', '/s']);
});

test('Linux: a terminal only in a graphical session, the first one found, or the one asked for', () => {
  const env = { PATH: BIN, DISPLAY: ':0' };
  assert.equal(T.detectTerminal({ platform: 'linux', env: { PATH: BIN }, wsl: false }), null, 'no display: none');
  const t = T.detectTerminal({ platform: 'linux', env, wsl: false });
  assert.equal(t.kind, 'exec');
  assert.equal(t.label, 'xterm');
  assert.deepEqual(t.args('/s.sh'), ['-e', 'bash', '-l', '/s.sh']);
  assert.equal(T.detectTerminal({ platform: 'linux', env: { ...env, PILOTAGE_TERMINAL: 'kitty' }, wsl: false }), null, 'kitty is not installed');
  assert.equal(T.detectTerminal({ platform: 'linux', env: { ...env, PILOTAGE_TERMINAL: 'none' }, wsl: false }), null);
  assert.equal(T.detectTerminal({ platform: 'linux', env: { ...env, PILOTAGE_TERMINAL: 'none' }, wsl: true }), null);
  const wt = path.join(BASE, 'wt.exe');
  fs.writeFileSync(wt, '');
  assert.equal(T.detectTerminal({ platform: 'linux', env, wsl: true, wtExe: wt }).kind, 'wt');
  assert.equal(T.detectTerminal({ platform: 'win32', env, wsl: false }), null);
});

test('WSL: Windows Terminal only when wt.exe is there (Windows 10 has none: Claude sessions start in the background)', () => {
  const env = { PATH: BIN };
  assert.equal(T.detectTerminal({ platform: 'linux', env, wsl: true, wtExe: path.join(BASE, 'no-such-dir', 'wt.exe') }), null);
  assert.equal(T.detectTerminal({ platform: 'linux', env, wsl: true, wtExe: null }), null, 'no Windows profile found');
});

test('openInTerminal: a failing opener is an error, one still running after a moment means the window is up', async () => {
  exe('fail-term', 'exit 3');
  exe('slow-term', 'sleep 5');
  const mk = (cmd) => ({ kind: 'exec', label: cmd, cmd: path.join(BIN, cmd), args: (s) => [s] });
  await assert.rejects(T.openInTerminal(mk('fail-term'), '/s'), /Could not open fail-term \(exit 3\)/);
  await assert.rejects(T.openInTerminal(mk('no-such-term'), '/s'), /not found/);
  const t0 = Date.now();
  await T.openInTerminal(mk('slow-term'), '/s', { settleMs: 200 });
  assert.ok(Date.now() - t0 < 2000);
});

test('a Claude terminal launch outside WSL runs the script in the terminal, with the prompt as one argument', { skip: SKIP_OFF_LINUX }, async () => {
  const cwd = fs.mkdtempSync(path.join(BASE, 'proj-'));
  const prompt = `-x "; touch ${cwd}/pwned; $(touch ${cwd}/pwned2)\nline 2`;
  const rec = await L.launch({ cwd, name: 'Demo; one', prompt, mode: 'terminal', permissionMode: 'acceptEdits' });
  assert.equal(rec.error, null);
  assert.equal(rec.mode, 'terminal', 'no background fallback when a terminal exists');
  assert.equal(rec.terminal, 'xterm');
  assert.equal(rec.state, 'launched');
  assert.ok(await waitFor(CLAUDE_OUT), 'the fake claude ran');
  const term = readArgs(ARGS_OUT);
  assert.deepEqual(term.slice(0, 3), ['-e', 'bash', '-l']);
  assert.ok(term[3].startsWith(paths.launchDir) && term[3].endsWith('.sh'));
  const got = readArgs(CLAUDE_OUT);
  assert.deepEqual(got.slice(0, 4), ['--permission-mode', 'acceptEdits', '--remote-control', 'Demo one']);
  assert.equal(got[4], '--session-id');
  assert.equal(got[5], rec.sessionId);
  assert.deepEqual(got.slice(6), ['--', prompt]);
  assert.ok(!fs.existsSync(path.join(cwd, 'pwned')) && !fs.existsSync(path.join(cwd, 'pwned2')));
  for (let i = 0; i < 40 && fs.readdirSync(paths.launchDir).length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(paths.launchDir), [], 'script and prompt file remove themselves');
});

test('";" in a folder path is fine outside Windows Terminal', { skip: SKIP_OFF_LINUX }, async () => {
  const cwd = path.join(BASE, 'a;b');
  fs.mkdirSync(cwd);
  fs.rmSync(CLAUDE_OUT, { force: true });
  const rec = await L.launch({ cwd, name: 'x', mode: 'terminal', permissionMode: 'manual' });
  assert.equal(rec.error, null);
  assert.ok(await waitFor(CLAUDE_OUT));
});

test('macOS: a launch opens Terminal.app and runs the session there', { skip: !MAC_REAL && 'macOS CI only (PILOTAGE_TEST_TERMINAL_APP=1)' }, async () => {
  fs.rmSync(CLAUDE_OUT, { force: true });
  const cwd = fs.mkdtempSync(path.join(BASE, 'mac-'));
  const rec = await L.launch({ cwd, name: 'Mac test', prompt: 'hello there', mode: 'terminal', permissionMode: 'acceptEdits' });
  assert.equal(rec.error, null);
  assert.equal(rec.terminal, 'Terminal');
  assert.ok(await waitFor(CLAUDE_OUT, 30_000), 'Terminal ran the .command script');
  const got = readArgs(CLAUDE_OUT);
  assert.deepEqual(got.slice(0, 4), ['--permission-mode', 'acceptEdits', '--remote-control', 'Mac test']);
  assert.deepEqual(got.slice(-2), ['--', 'hello there']);
});
