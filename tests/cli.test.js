// bin/pilotage itself, run against a temp data folder and a spare port (plain-Linux mode: no Windows side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(ROOT, 'bin', 'pilotage');
const SKIP = process.platform === 'win32' && 'bash script';

function tempEnv() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-cli-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-cli-home-'));
  const port = 4931 + 2 * Math.floor(Math.random() * 30);
  return {
    data,
    home,
    port,
    env: { ...process.env, HOME: home, PILOTAGE_DATA: data, PILOTAGE_PORT: String(port), PILOTAGE_LAN_INTERNAL_PORT: String(port - 1), PILOTAGE_WSL: '0', PILOTAGE_NO_AI: '1', PILOTAGE_NO_FORWARDER: '1', PILOTAGE_NODE: process.execPath },
  };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('pilotage stop never kills a process that reused a stale pid', { skip: SKIP }, () => {
  const { data, env } = tempEnv();
  // The pid file outlives the server (crash, reboot, `wsl --shutdown`), and pids are reused: here it now belongs to
  // an unrelated process of the same user.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(data, 'pilotage.pid'), String(other.pid));
    const out = execFileSync('bash', [CLI, 'stop'], { env, encoding: 'utf8' });
    assert.match(out, /not running/);
    assert.ok(alive(other.pid), 'pilotage stop killed an unrelated process');
    const status = execFileSync('bash', [CLI, 'status'], { env, encoding: 'utf8' });
    assert.doesNotMatch(status, new RegExp(`pid ${other.pid}`));
  } finally {
    other.kill();
  }
});

test('the server removes its pid file when it stops', { skip: SKIP }, async () => {
  const { data, port, env } = tempEnv();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' });
  const pidFile = path.join(data, 'pilotage.pid');
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    }
    assert.ok(up, 'server did not start');
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(proc.pid));
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await exited;
    assert.equal(fs.existsSync(pidFile), false, 'the pid file is still there after a clean stop');
  } finally {
    if (alive(proc.pid)) proc.kill('SIGKILL');
  }
});

const inGitCheckout = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim() === 'true';
test('export-public leaves out the audit notes (unfixed findings must not be published)', { skip: SKIP || (!inGitCheckout && 'needs a git checkout') }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'out');
  // No inherited GIT_DIR / GIT_WORK_TREE (set inside git hooks and some worktree setups): the export's `git init`
  // must only ever touch the target folder.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@users.noreply.github.com', PILOTAGE_EXPORT_MESSAGE: 'test export' });
  execFileSync('bash', [path.join(ROOT, 'scripts', 'export-public.sh'), target], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(fs.existsSync(path.join(target, 'README.md')), 'the export did not run');
  for (const f of ['AUDIT.md', 'BUILD-LOG.md', 'server/local-workspaces.json', 'scripts/leak-patterns.txt']) assert.equal(fs.existsSync(path.join(target, f)), false, `${f} was exported`);
});

test('pilotage open on WSL prints the login link when no Windows opener works', { skip: SKIP }, async () => {
  const { home, port, env: base } = tempEnv();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-cli-sys32-')); // no rundll32.exe / cmd.exe / curl.exe here
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-cli-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
  const env = { ...base, PILOTAGE_WSL: '1', PILOTAGE_WIN_SYSTEM32: empty, PILOTAGE_WIN_HOME: path.join(home, 'win'), PILOTAGE_WEB_DIST: dist, PILOTAGE_NO_RELAY_WATCH: '1' };
  fs.mkdirSync(env.PILOTAGE_WIN_HOME);
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    }
    assert.ok(up, 'server did not start');
    const out = execFileSync('bash', [CLI, 'open'], { env, encoding: 'utf8' });
    assert.match(out, /\/auth\/login\?c=\w+/, 'no login link printed');
    assert.doesNotMatch(out, /Opened Pilotage/, 'claims a browser opened');
  } finally {
    proc.kill('SIGKILL');
  }
});

test('pilotage stop stops the real server, however it was started (absolute path, `node server/index.js`, narrow COLUMNS)', { skip: SKIP }, async () => {
  for (const how of ['absolute', 'relative']) {
    const { port, env: base } = tempEnv();
    const env = { ...base, COLUMNS: '60' };
    const args = how === 'absolute' ? [path.join(ROOT, 'server', 'index.js')] : ['server/index.js'];
    const proc = spawn(process.execPath, args, { env, cwd: ROOT, stdio: 'ignore' });
    try {
      let up = false;
      for (let i = 0; i < 80 && !up; i++) {
        await new Promise((r) => setTimeout(r, 250));
        up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      }
      assert.ok(up, `${how}: server did not start`);
      const exited = new Promise((r) => proc.once('exit', r));
      const out = execFileSync('bash', [CLI, 'stop'], { env, encoding: 'utf8' });
      assert.match(out, /stopped/, `${how}: ${out}`);
      await Promise.race([exited, new Promise((_, no) => setTimeout(() => no(new Error(`${how}: still running`)), 8000))]);
    } finally {
      if (alive(proc.pid)) proc.kill('SIGKILL');
    }
  }
});

test('pilotage doctor says what is missing and how to fix it, without changing anything', { skip: SKIP }, () => {
  const { home, data, env } = tempEnv();
  // No Claude Code in this fake home, and nothing on a PATH that has only system folders.
  const run = (extra) => spawnSync('bash', [CLI, 'doctor'], { env: { ...env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...extra }, encoding: 'utf8' });
  const r = run({});
  assert.match(r.stdout, /✓.*Node\.js \d+/);
  assert.match(r.stdout, /Pilotage is not running/);
  assert.doesNotMatch(r.stdout, /skip permission prompts/, 'a new install asks first');
  assert.match(r.stdout, /No Claude Code sessions/);
  // A Claude Code install (a stand-in that prints a version) is found in ~/.local/bin.
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', { mode: 0o755 });
  const r2 = run({});
  assert.match(r2.stdout, /✓.*Claude Code 2\.1\.0/);
  // An old one is flagged.
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "1.0.89 (Claude Code)"\n', { mode: 0o755 });
  const r3 = run({});
  assert.match(r3.stdout, /✗.*Claude Code 1\.0\.89 is too old/);
  assert.equal(r3.status, 1);
  assert.deepEqual(fs.readdirSync(data).filter((f) => f !== 'logs'), [], 'doctor wrote nothing in the data folder');
  // A data folder that doesn't exist yet is not created by doctor.
  const missing = path.join(data, 'not-yet', 'data');
  const r4 = run({ PILOTAGE_DATA: missing });
  assert.match(r4.stdout, /created at the first start/);
  assert.equal(fs.existsSync(path.join(data, 'not-yet')), false, 'doctor created the data folder');
});

test('Linux: pilotage install sets up a systemd user service, and uninstall removes it', { skip: process.platform !== 'linux' && 'Linux only' }, async () => {
  const { home, data, port, env: base } = tempEnv();
  const log = path.join(home, 'systemctl.log');
  const fake = path.join(home, 'systemctl');
  // Records its arguments; `is-enabled` answers "enabled" once `enable` was called (like systemctl).
  fs.writeFileSync(fake, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *is-enabled*) grep -q -- '--user enable' '${log}' && ! grep -q -- 'disable' '${log}' ;; esac\n`, { mode: 0o755 });
  const env = { ...base, PILOTAGE_SYSTEMCTL: fake, XDG_CONFIG_HOME: path.join(home, '.config') };
  // A server already answering on the port, so install doesn't build or start one.
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    }
    assert.ok(up);
    const out = execFileSync('bash', [CLI, 'install'], { env: { ...env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.match(out, /starts at login \(systemd user service/);
    assert.match(out, /~\/\.local\/bin is not on your PATH yet/, 'says how to get the command on PATH');
    const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'pilotage.service'), 'utf8');
    assert.match(unit, new RegExp(`^ExecStart="${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/pilotage" run$`, 'm'));
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.match(fs.readFileSync(log, 'utf8'), /--user enable --now pilotage\.service/);
    assert.match(unit, new RegExp(`^Environment="PILOTAGE_DATA=${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'), 'the data folder is recorded');
    assert.match(unit, /^Environment="PILOTAGE_PORT=\d+"$/m, 'and the port');
    assert.match(execFileSync('bash', [CLI, 'status'], { env, encoding: 'utf8' }), /Starts automatically at login/);
    execFileSync('bash', [CLI, 'uninstall'], { env, encoding: 'utf8' });
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'pilotage.service')), false);
    assert.match(fs.readFileSync(log, 'utf8'), /--user disable --now pilotage\.service/);
  } finally {
    proc.kill('SIGKILL');
  }
});

test('CLI commands before the first start say what to do (no stack trace)', { skip: SKIP }, () => {
  const { env } = tempEnv();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'rotate-key'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hasn't been started with this data folder yet/);
  assert.doesNotMatch(r.stderr, /at Object|ENOENT/);
});
