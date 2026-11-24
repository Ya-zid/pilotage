// One server per data folder. Two at once (a double-click on the first start, the Startup entry plus a click, a shell
// with another PILOTAGE_PORT) would each write their own desktop key into secrets.json ("Bad key" for the CLI), run
// every AI job twice and overwrite each other's state.json / work.json. Taken before anything in the folder is read.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function commandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {}
  try {
    return execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Who a pid is, exactly: Linux `<boot id>:<start tick>` (/proc), elsewhere the start time `ps` prints. Both stay the
 * same for the life of a process and differ for one that reused the pid, whatever the clock does (WSL's clock jumps
 * after the PC sleeps). null when unknown. */
export function processStartId(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; // field 22: starttime
    let boot = '';
    try {
      boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {}
    if (/^\d+$/.test(ticks || '')) return `linux:${boot}:${ticks}`;
  } catch {}
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }).trim();
    return out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

// The lock is stale unless its pid is still the Pilotage server that wrote it. Pids are reused after a crash or a
// reboot, and another app's `node server/index.js` matches the command line too: the lock records the holder's
// start identity, and a process that took the pid over has another one.
function holderAlive(held) {
  const pid = held?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  if (!/server[/\\]index\.js/.test(commandLine(pid))) return false;
  if (typeof held.start === 'string' && held.start) {
    const now = processStartId(pid);
    if (now && now !== held.start) return false;
  }
  return true;
}

function readLock(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? null : '';
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// -> { ok: true } once this process holds the lock (released at exit), or { ok: false, pid, port } for the holder.
export function acquireInstanceLock(file, { port }) {
  const mine = JSON.stringify({ pid: process.pid, port, startedAt: Date.now(), start: processStartId(process.pid) });
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, mine);
      fs.closeSync(fd);
      process.on('exit', () => {
        if (readLock(file) === mine) fs.rmSync(file, { force: true });
      });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const text = readLock(file);
    if (text === null) continue; // released meanwhile
    let held = null;
    try {
      held = JSON.parse(text);
    } catch {}
    if (!held) {
      // Just created by another server that hasn't written its pid yet; empty for good only after a crash right there.
      if (attempt < 10) {
        sleep(100);
        continue;
      }
    } else if (holderAlive(held)) return { ok: false, pid: held.pid, port: held.port };
    // Stale: remove it, unless it changed hands since we read it.
    if (readLock(file) === text) fs.rmSync(file, { force: true });
  }
  throw new Error(`could not take the lock ${file}`);
}
