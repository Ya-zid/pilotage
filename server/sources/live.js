// Live Claude sessions: interactive (terminal) and background (daemon) ones.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, CLAUDE_CMD } from '../config.js';
import { run, readJSONSync, clip } from '../util.js';

export function bridgeUrl(id) {
  if (!id) return null;
  const bare = String(id).replace(/^(cse_|session_)/, '');
  if (!/^[A-Za-z0-9]+$/.test(bare)) return null;
  return `https://claude.ai/code/session_${bare}`;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Process start time in clock ticks since boot (field 22 of /proc/<pid>/stat), or null. */
function procStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch {
    return null;
  }
}

/** Alive AND the same process (a stale session file's pid may have been reused after a WSL restart). */
function sameProcessAlive(pid, procStart) {
  if (!pidAlive(pid)) return false;
  if (!procStart) return true;
  const now = procStartTicks(pid);
  return now === null || String(now) === String(procStart);
}

/** Read ~/.claude/sessions/<pid>.json files for bridge ids/status (fast, no process spawn). */
function readSessionFiles() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const n of names) {
    const j = readJSONSync(path.join(dir, n), null);
    if (!j || !j.sessionId || !sameProcessAlive(j.pid, j.procStart)) continue;
    out.set(j.sessionId, j);
  }
  return out;
}

/** "input needed" → "Waiting for your input"; anything else is shown as Claude Code wrote it. */
function waitingText(w) {
  const t = String(w || '').trim();
  if (!t || /^input needed$/i.test(t)) return 'Waiting for your input';
  if (/^permission/i.test(t)) return 'Waiting for your permission';
  return `Waiting: ${t}`;
}

function readJob(short) {
  const j = readJSONSync(path.join(CLAUDE_DIR, 'jobs', short, 'state.json'), null);
  return j;
}

export class LiveTracker {
  constructor() {
    this.list = [];
    this.bySession = new Map();
    this.lastSig = '';
    this.at = 0;
  }
  async refresh({ full = true } = {}) {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      return await this._refresh(full);
    } finally {
      this.inFlight = false;
    }
  }
  async _refresh(full) {
    // `claude agents` costs a process spawn: run it at most every 30 s; in between, re-read the cheap state files.
    if (full || !this.agentsCache || Date.now() - this.agentsAt > 30_000) {
      const r = await run(CLAUDE_CMD[0], [...CLAUDE_CMD.slice(1), 'agents', '--json', '--all'], { timeout: 20000 });
      if (r.code === 0) {
        try {
          this.agentsCache = JSON.parse(r.stdout);
          this.agentsAt = Date.now();
        } catch {}
      }
    }
    return this.build(this.agentsCache || []);
  }
  build(agents) {
    const files = readSessionFiles();
    const list = [];
    const seen = new Set();
    for (const a of agents) {
      const f = files.get(a.sessionId);
      const job = a.kind === 'background' ? readJob(a.id) : null;
      const state = a.state || null; // background: working | blocked | done | failed ...
      const fileInfo = files.get(a.sessionId);
      const live = (a.kind === 'interactive' ? !!fileInfo || sameProcessAlive(a.pid, null) : pidAlive(a.pid)) && (a.kind === 'interactive' || !['done', 'failed', 'stopped'].includes(state));
      const bridgeId = f?.bridgeSessionId || job?.bridgeSessionId || null;
      list.push({
        sessionId: a.sessionId,
        bgId: a.kind === 'background' ? a.id : null,
        pid: a.pid || null,
        kind: a.kind,
        name: a.name || job?.name || null,
        cwd: a.cwd,
        // interactive: busy | idle | waiting (its own status file is fresher than the agents listing; waiting = needs the user)
        status: (a.kind === 'interactive' && f?.status) || a.status || null,
        state,
        detail: clip(job?.detail || (f?.status === 'waiting' ? waitingText(f.waitingFor) : ''), 300),
        result: clip(job?.output?.result || '', 600),
        startedAt: a.startedAt || 0,
        updatedAt: job?.updatedAt ? Date.parse(job.updatedAt) : f?.statusUpdatedAt || 0,
        bridgeUrl: bridgeUrl(bridgeId),
        live,
      });
      seen.add(a.sessionId);
    }
    // Interactive sessions the agents listing missed (older CLI versions)
    for (const [sid, f] of files) {
      if (seen.has(sid)) continue;
      list.push({
        sessionId: sid,
        bgId: null,
        pid: f.pid,
        kind: f.kind || 'interactive',
        name: f.name || null,
        cwd: f.cwd,
        status: f.status || null,
        state: null,
        detail: f.status === 'waiting' ? waitingText(f.waitingFor) : '',
        result: '',
        startedAt: f.startedAt || 0,
        updatedAt: f.statusUpdatedAt || 0,
        bridgeUrl: bridgeUrl(f.bridgeSessionId),
        live: true,
      });
    }
    this.list = list;
    this.bySession = new Map(list.map((x) => [x.sessionId, x]));
    this.at = Date.now();
    const sig = JSON.stringify(list.map((x) => [x.sessionId, x.status, x.state, x.live, x.bridgeUrl, x.detail]));
    const changed = sig !== this.lastSig;
    this.lastSig = sig;
    return changed;
  }
  get(sessionId) {
    return this.bySession.get(sessionId) || null;
  }
  liveOnly() {
    return this.list.filter((x) => x.live);
  }
}

let tracker = null;
export function getLive() {
  if (!tracker) tracker = new LiveTracker();
  return tracker;
}
