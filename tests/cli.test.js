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
    assert.match(out, /\/auth\/login\?c=[\w-]+/, 'no login link printed');
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

test('pilotage doctor names a port held by a program that is not an HTTP server', { skip: SKIP }, async () => {
  const net = await import('node:net');
  const { env } = tempEnv();
  // Something that accepts connections and never answers HTTP (a database, an SSH tunnel, a stuck process).
  const held = net.createServer(() => {});
  await new Promise((resolve) => held.listen(0, '127.0.0.1', resolve));
  try {
    const port = String(held.address().port);
    const r = spawnSync('bash', [CLI, 'doctor'], { env: { ...env, PILOTAGE_PORT: port, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.match(r.stdout, new RegExp(`✗.*Port ${port} is used by another program`), r.stdout);
    assert.doesNotMatch(r.stdout, /Pilotage is not running/);
  } finally {
    held.close();
  }
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

// Stand-ins for the service managers, first on PATH: no test ever reaches the real systemctl or launchctl.
function fakeServiceManagers(home) {
  const bin = path.join(home, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['systemctl', 'launchctl']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${path.join(home, 'service-manager.log')}'\nexit 1\n`, { mode: 0o755 });
  return { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, PILOTAGE_SYSTEMCTL: path.join(bin, 'systemctl'), XDG_CONFIG_HOME: path.join(home, '.config') };
}

test('pilotage uninstall --purge stops the `pilotage run` supervisor: Pilotage does not come back', { skip: SKIP }, async () => {
  const { data, home, port, env: base } = tempEnv();
  const env = { ...base, ...fakeServiceManagers(home) };
  const sup = spawn('bash', [CLI, 'run'], { env, stdio: 'ignore', detached: true });
  const up = () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  try {
    let ok = false;
    for (let i = 0; i < 80 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ok = await up();
    }
    assert.ok(ok, 'the supervisor did not start the server');
    const out = execFileSync('bash', [CLI, 'uninstall', '--purge'], { env, encoding: 'utf8' });
    assert.match(out, /Deleted /);
    // The supervisor waits 5 s after its server exits, then starts a new one: wait past that.
    await new Promise((r) => setTimeout(r, 7000));
    assert.equal(alive(sup.pid), false, 'the supervisor is still running');
    assert.equal(await up(), false, 'Pilotage is running again');
    assert.equal(fs.existsSync(data), false, 'the data folder came back');
  } finally {
    try {
      process.kill(-sup.pid, 'SIGKILL');
    } catch {}
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(path.join(data, 'pilotage.pid'), 'utf8').trim());
    } catch {}
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('one server per data folder: a second one (another port) refuses to start; a stale lock does not block', { skip: SKIP }, async () => {
  const { data, port, env } = tempEnv();
  const up = (p) => fetch(`http://127.0.0.1:${p}/healthz`).then((r) => r.ok, () => false);
  const server = (extra = {}) => spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = server();
  let second, third;
  try {
    let ok = false;
    for (let i = 0; i < 80 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ok = await up(port);
    }
    assert.ok(ok, 'server did not start');
    const key = JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')).desktopKey;
    // A shell with another PILOTAGE_PORT, same data folder.
    const port2 = 5101 + 2 * Math.floor(Math.random() * 30);
    second = server({ PILOTAGE_PORT: String(port2), PILOTAGE_LAN_INTERNAL_PORT: String(port2 - 1) });
    let err = '';
    second.stderr.on('data', (d) => (err += d));
    second.stdout.on('data', (d) => (err += d));
    const code = await Promise.race([new Promise((r) => second.once('exit', r)), new Promise((r) => setTimeout(() => r('still running'), 8000))]);
    assert.notEqual(code, 'still running', 'a second server started on the same data folder');
    assert.notEqual(code, 0);
    assert.match(err, new RegExp(`already running on port ${port}`));
    assert.equal(await up(port2), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')).desktopKey, key, 'the desktop key changed');
    // A server killed outright leaves its lock behind: the next start takes it over.
    const exited = new Promise((r) => first.once('exit', r));
    first.kill('SIGKILL');
    await exited;
    third = server();
    ok = false;
    for (let i = 0; i < 80 && !ok && third.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ok = await up(port);
    }
    assert.ok(ok, 'a stale lock kept the server from starting');
  } finally {
    for (const p of [first, second, third]) if (p && p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  }
});

// `pilotage install` on WSL, with nothing from Windows: a temp Windows profile, a System32 folder that holds only a
// stand-in powershell.exe recording its arguments, a stand-in wslpath, and a server already answering on the port.
// `root` is a copy of bin/, server/ and windows/ (to install from a path with spaces and quotes).
async function wslInstall(t, root = ROOT) {
  const { home, port, env: base } = tempEnv();
  const winHome = path.join(home, 'win', 'Users', 'someone');
  const startup = path.join(winHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  fs.mkdirSync(startup, { recursive: true });
  fs.mkdirSync(path.join(winHome, 'Desktop'));
  const sys32 = path.join(home, 'sys32');
  const psLog = path.join(home, 'powershell.log');
  fs.mkdirSync(path.join(sys32, 'WindowsPowerShell', 'v1.0'), { recursive: true });
  fs.writeFileSync(path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${psLog}'\necho ---- >> '${psLog}'\n`, { mode: 0o755 });
  const fakes = fakeServiceManagers(home);
  fs.writeFileSync(path.join(home, 'fake-bin', 'wslpath'), `#!/bin/sh\n[ "$1" = -w ] && shift\nprintf 'C:%s\\n' "$(printf '%s' "$1" | tr / '\\\\')"\n`, { mode: 0o755 });
  const env = { ...base, ...fakes, PILOTAGE_WSL: '1', PILOTAGE_WIN_HOME: winHome, PILOTAGE_WIN_SYSTEM32: sys32, WSL_DISTRO_NAME: 'TestDistro' };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...base, PILOTAGE_WSL: '0' }, stdio: 'ignore' });
  t.after(() => proc.kill('SIGKILL'));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  }
  assert.ok(up, 'server did not start');
  const out = execFileSync('bash', [path.join(root, 'bin', 'pilotage'), 'install'], { env, encoding: 'utf8' });
  return { out, env, home, winHome, startupVbs: path.join(startup, 'Pilotage.vbs'), openVbs: path.join(winHome, 'AppData', 'Local', 'Pilotage', 'open.vbs'), psLog };
}

// A copy of the parts of the repo `pilotage install` uses, in a folder named like a user's ("My Code", an apostrophe).
function copyRepo(t, dirName) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-cli-copy-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, dirName, 'pilotage');
  for (const d of ['bin', 'server', 'windows']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  return root;
}

test('WSL autostart and the Desktop shortcut work from a folder with spaces or quotes in its path', { skip: process.platform !== 'linux' && 'Linux only' }, async (t) => {
  const root = copyRepo(t, "My Code's");
  const { out, env, startupVbs, openVbs } = await wslInstall(t, root);
  assert.match(out, /Autostart:/);
  for (const file of [startupVbs, openVbs]) {
    const vbs = fs.readFileSync(file, 'utf8');
    // What wsl.exe hands the Linux shell, minus VBScript's doubled quotes; run with `version` in place of run/open.
    const m = vbs.match(/-- (bash -lc "".*) (?:run|open)""", 0, False/);
    assert.ok(m, `${path.basename(file)}: ${vbs}`);
    const cmd = `${m[1].replace(/""/g, '"')} version"`;
    const r = spawnSync('bash', ['-c', cmd], { env, encoding: 'utf8' });
    assert.match(r.stdout, /^Pilotage \d/, `${path.basename(file)} runs: ${cmd}\n${r.stderr}`);
  }
});

test('WSL: the Desktop shortcut goes on the Desktop Windows shows (OneDrive), for install and uninstall', { skip: process.platform !== 'linux' && 'Linux only' }, async (t) => {
  const { env, psLog } = await wslInstall(t);
  const calls = () => fs.readFileSync(psLog, 'utf8').split('----\n').filter(Boolean);
  const [create] = calls();
  // The Desktop folder is asked from Windows in the same PowerShell call, never assumed to be <profile>\Desktop.
  assert.match(create, /\[Environment\]::GetFolderPath\('Desktop'\)/);
  assert.match(create, /CreateShortcut\(\(Join-Path \$d 'Pilotage\.lnk'\)\)/);
  assert.doesNotMatch(create, /\\Desktop\\Pilotage\.lnk/);
  execFileSync('bash', [CLI, 'uninstall'], { env, encoding: 'utf8' });
  const remove = calls().find((c) => /Remove-Item/.test(c));
  assert.ok(remove, 'uninstall did not remove the shortcut from the Desktop Windows shows');
  assert.match(remove, /Join-Path \(\[Environment\]::GetFolderPath\('Desktop'\)\) 'Pilotage\.lnk'/);
});

test('Windows itself (PowerShell, cmd, Git Bash) is refused with a pointer to WSL', { skip: SKIP }, (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // npm then stops `npx pilotage-cli` in PowerShell / cmd with EBADPLATFORM instead of a cryptic bash error.
  assert.deepEqual([...(pkg.os || [])].sort(), ['darwin', 'linux']);
  const { home, env } = tempEnv();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const kernel of ['MINGW64_NT-10.0-22631', 'MSYS_NT-10.0-22631', 'CYGWIN_NT-10.0-22631']) {
    const bin = path.join(home, kernel);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${kernel}\n`, { mode: 0o755 });
    const r = spawnSync('bash', [CLI, 'start'], { env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.equal(r.status, 1, kernel);
    assert.match(r.stdout + r.stderr, /WSL/, kernel);
    assert.doesNotMatch(r.stdout + r.stderr, /Pilotage started|Node\.js 22\+ not found/, kernel);
  }
});

test('WSL without autostart: start and open say to keep the window open or run pilotage install', { skip: SKIP }, async (t) => {
  const { home, port, env: base } = tempEnv();
  const sys32 = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-cli-sys32-')); // empty: nothing from Windows runs
  const winHome = path.join(home, 'win');
  const startup = path.join(winHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  fs.mkdirSync(startup, { recursive: true });
  const env = { ...base, PILOTAGE_WSL: '1', PILOTAGE_WIN_SYSTEM32: sys32, PILOTAGE_WIN_HOME: winHome };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...base, PILOTAGE_WSL: '0' }, stdio: 'ignore' });
  t.after(() => proc.kill('SIGKILL'));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  }
  assert.ok(up, 'server did not start');
  const hint = /Keep this window open, or run pilotage install so it keeps running/;
  for (const cmd of ['start', 'open']) assert.match(execFileSync('bash', [CLI, cmd], { env, encoding: 'utf8' }), hint, cmd);
  // Autostart installed (the Startup entry keeps WSL running): no hint.
  fs.writeFileSync(path.join(startup, 'Pilotage.vbs'), "' test\r\n");
  for (const cmd of ['start', 'open']) assert.doesNotMatch(execFileSync('bash', [CLI, cmd], { env, encoding: 'utf8' }), hint, cmd);
  // Plain Linux: no hint either.
  assert.doesNotMatch(execFileSync('bash', [CLI, 'start'], { env: base, encoding: 'utf8' }), /Keep this window open/);
});

// A server on a temp home with one project (acme/shop) and a stand-in `claude` (first in ~/.local/bin there): it
// records its arguments; `--bg` answers like Claude Code and writes the job's state with a Remote Control id, so a
// background launch completes at once. Nothing real is started.
async function serverWithFakeClaude(t) {
  const { home, data, port, env } = tempEnv();
  fs.mkdirSync(path.join(home, 'acme', 'shop'), { recursive: true });
  fs.writeFileSync(path.join(home, 'acme', 'shop', 'CLAUDE.md'), '# Shop\n');
  const argsLog = path.join(home, 'claude-args.log');
  const job = path.join(home, '.claude', 'jobs', 'abc1234');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.local', 'bin', 'claude'),
    `#!/bin/sh\necho "$*" >> '${argsLog}'\ncase " $* " in *" --bg "*) mkdir -p '${job}'; echo '{"sessionId":"s1","bridgeSessionId":"b1"}' > '${job}/state.json'; echo 'backgrounded · abc1234' ;; *) echo '[]' ;; esac\n`,
    { mode: 0o755 },
  );
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' });
  t.after(() => proc.kill('SIGKILL'));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  }
  assert.ok(up, 'server did not start');
  const key = JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')).desktopKey;
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-Pilotage-Key': key, ...(body ? { 'X-Pilotage': '1', 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const bgCalls = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').split('\n').filter((l) => l.includes('--bg')) : []);
  return { home, data, port, env, api, bgCalls };
}

test('pilotage new uses the Settings model unless --model is given, and refuses an unknown model', { skip: SKIP }, async (t) => {
  const { env, api, bgCalls } = await serverWithFakeClaude(t);
  assert.equal((await api('PATCH', '/api/settings', { settings: { launch: { model: 'sonnet' } } })).status, 200);
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'new', ...args], { env, encoding: 'utf8', timeout: 30000 });
  let r = cli('shop', '--bg', 'hello');
  assert.equal(r.status, 0, r.stderr);
  assert.match(bgCalls().at(-1), /--model sonnet/, 'the Settings model was not used');
  r = cli('shop', '--bg', '--model', 'opus', 'hello');
  assert.equal(r.status, 0, r.stderr);
  assert.match(bgCalls().at(-1), /--model opus/);
  const before = bgCalls().length;
  r = cli('shop', '--bg', '--model', 'opsu', 'hello');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown model "opsu"/);
  assert.equal(bgCalls().length, before, 'started a session with a mistyped model');
});

test('leak-scan also checks file names, npm/Groq/Hugging Face/GitLab tokens, and a package\'s web/dist', { skip: SKIP }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-leak-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const patterns = path.join(dir, 'patterns.txt');
  fs.writeFileSync(patterns, 'zorblax\n'); // a made-up private name
  const env = { ...process.env, PILOTAGE_LEAK_PATTERNS: patterns, PILOTAGE_LEAK_ALLOWLIST: path.join(dir, 'no-allowlist') };
  const scan = (...args) => spawnSync('bash', [path.join(ROOT, 'scripts', 'leak-scan.sh'), ...args], { env, encoding: 'utf8' });
  const folder = (name, files) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, name, f), text);
    }
    return path.join(dir, name);
  };
  assert.equal(scan(folder('clean', { 'docs/notes.md': 'nothing to see\n' })).status, 0);
  // A private name that only appears in a file name is published all the same.
  let r = scan(folder('named', { 'docs/zorblax-invoice-notes.md': 'nothing to see\n' }));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /zorblax-invoice-notes\.md/);
  // Token families the redaction knows about (built here, so this file holds none).
  const tokens = { 'npm-token': `npm_${'a1B2'.repeat(9)}`, 'groq-key': `gsk_${'a1B2'.repeat(13)}`, 'huggingface-token': `hf_${'a1B2'.repeat(8)}xy`, 'gitlab-token': `glpat-${'a1B2'.repeat(5)}` };
  for (const [label, token] of Object.entries(tokens)) {
    r = scan(folder(label, { 'config.txt': `TOKEN=${token}\n` }));
    assert.equal(r.status, 1, `${label} not caught`);
    assert.match(r.stdout, new RegExp(`\\[${label}\\]`));
  }
  // An unpacked npm package publishes web/dist: --package scans it (a checkout's build output is skipped otherwise).
  const pkg = folder('pkg', { 'web/dist/assets/app.js': `const k="${tokens['npm-token']}";\n`, 'README.md': 'hi\n' });
  assert.equal(scan(pkg).status, 0);
  r = scan('--package', pkg);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /web\/dist\/assets\/app\.js/);
});

test('leak-scan uses only portable regex and sed (macOS has BSD grep and sed: \\b, \\s and \\t silently match nothing there)', { skip: SKIP }, () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'leak-scan.sh'), 'utf8');
  const table = /GENERIC=\$\(cat <<'EOF'\n([\s\S]*?)\nEOF/.exec(script)[1];
  assert.doesNotMatch(table, /\\[bswdBSWD]/, 'a GNU-only escape in the pattern table');
  assert.doesNotMatch(script, /grep[^\n]*'[^'\n]*\\s/, 'a GNU-only \\s in a grep expression');
  assert.doesNotMatch(script, /sed 's\/\^\/[^']*\\t/, "BSD sed writes \\t as a plain t");
  // bash 3.2 (macOS) treats "${a[@]}" of an empty array as unbound under set -u: the grep never ran there.
  assert.doesNotMatch(script.replace(/\$\{(\w+)\[@\]\+"\$\{\1\[@\]\}"\}/g, ''), /"\$\{case_flag\[@\]\}"/, 'an empty array expanded the bash 4.4 way');
  // And it still catches a token right after `=` or at the start of a line, but not inside a longer word.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotage-leak-b-'));
  const scan = (text) => {
    fs.writeFileSync(path.join(dir, 'x.txt'), text);
    return spawnSync('bash', [path.join(ROOT, 'scripts', 'leak-scan.sh'), dir], { env: { ...process.env, PILOTAGE_LEAK_PATTERNS: path.join(dir, 'none'), PILOTAGE_LEAK_ALLOWLIST: path.join(dir, 'none') }, encoding: 'utf8' }).status;
  };
  const key = `npm_${'a1B2'.repeat(9)}`;
  assert.equal(scan(`TOKEN=${key}\n`), 1);
  assert.equal(scan(`${key}\n`), 1);
  assert.equal(scan(`x${key}\n`), 0, 'inside a longer word');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sessions seeded by AI-written text ask before acting, whatever Settings says (tasks, kickoffs, Home focus)', { skip: SKIP }, async (t) => {
  const { api, bgCalls } = await serverWithFakeClaude(t);
  assert.equal((await api('PATCH', '/api/settings', { settings: { launch: { permissionMode: 'bypassPermissions' } } })).status, 200);
  const shop = (await api('GET', '/api/projects?hidden=1')).body.projects.find((p) => p.name === 'shop');
  const last = () => bgCalls().at(-1) || '';
  const asks = (what) => {
    assert.match(last(), /--permission-mode default/, what);
    assert.doesNotMatch(last(), /--dangerously-skip-permissions/, what);
  };
  // A new project's kickoff session reads a CLAUDE.md assembled from AI summaries.
  const made = await api('POST', '/api/projects/new', { name: 'Side tool', goal: 'A small side tool.', useAI: false, launch: 'background' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  asks('kickoff');
  // Its starter task is a suggested one (kind spinoff): its text came from the AI.
  assert.equal((await api('POST', `/api/work/${made.body.items[0].id}/start`, { mode: 'background' })).status, 200);
  asks('suggested task');
  // A task the user typed keeps the mode from Settings.
  const mine = await api('POST', '/api/work', { projectId: shop.id, title: 'Fix the footer' });
  assert.equal((await api('POST', `/api/work/${mine.body.id}/start`, { mode: 'background' })).status, 200);
  assert.match(last(), /--dangerously-skip-permissions/, 'a typed task follows Settings');
  // New session filled with AI text (Home's focus "Start") says so with aiPrompt.
  assert.equal((await api('POST', '/api/launch', { projectId: shop.id, prompt: 'Run the release checklist', mode: 'background', aiPrompt: true })).status, 200);
  asks('Home focus');
  assert.equal((await api('POST', '/api/launch', { projectId: shop.id, prompt: 'My own prompt', mode: 'background' })).status, 200);
  assert.match(last(), /--dangerously-skip-permissions/, 'a typed prompt follows Settings');
  // "Plan first" is stricter than asking: kept.
  assert.equal((await api('PATCH', '/api/settings', { settings: { launch: { permissionMode: 'plan' } } })).status, 200);
  assert.equal((await api('POST', '/api/launch', { projectId: shop.id, prompt: 'Run the release checklist', mode: 'background', aiPrompt: true })).status, 200);
  assert.match(last(), /--permission-mode plan/);
});
