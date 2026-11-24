// Reads the usage numbers a Claude Code statusline script can write to ~/.claude/rate_limits.json
// ({saved_at, five_hour: {used_percentage, resets_at}, seven_day: {…}}, times in seconds; see README → AI usage).
// Without that file the 5-hour / weekly guard has no reading and only Pilotage's own call caps apply.
//
// ~/.claude/rate_limits.json is last-writer-wins: every Claude session's statusline rewrites it, and sessions on
// different models report different weekly limits (all models vs one model), so the file flips between e.g. 69% and
// 48%. Pilotage keeps the highest reading per limit window (keyed by its reset time) and shows the highest open one:
// that's the limit that will stop the user first, and it no longer jumps around between page loads.
import path from 'node:path';
import { CLAUDE_DIR, paths } from '../config.js';
import { readJSONSync, writeJSONSync } from '../util.js';

const SEEN_FILE = path.join(path.dirname(paths.ai), 'usage-seen.json');
// A weekly reading stays valid until its window resets: Pilotage's own `claude -p` calls never refresh the statusline
// file, so dropping it after hours without an interactive session would switch the weekly guard off.
const SEVEN_KEEP = Infinity;
// The same for the 5-hour window: usage only rises inside a window, so an older reading is a safe lower bound until
// its reset. Dropping it after 30 minutes reopened the guard exactly when the user stopped working and Pilotage ran
// alone, which could use up the rest of the window.
const FIVE_KEEP = Infinity;

let seen = null;
let lastSaved = 0;

function loadSeen() {
  if (seen) return seen;
  const d = readJSONSync(SEEN_FILE, null);
  seen = d && typeof d === 'object' ? { five: d.five || {}, seven: d.seven || {} } : { five: {}, seven: {} };
  return seen;
}

/** Remember a reading; returns the highest still-open reading of that kind. */
export function recordReading(store, { pct, resetsAt, at }, keepMs, now = Date.now()) {
  if (typeof pct === 'number' && resetsAt) {
    // Usage only goes up inside a window, so the max per window is right (a reset is a new window, a new key).
    const k = String(resetsAt);
    const prev = store[k];
    const live = prev && (!Number.isFinite(keepMs) || Math.abs(at - prev.at) < keepMs);
    store[k] = { pct: live ? Math.max(prev.pct, pct) : pct, resetsAt, at: Math.max(at, prev?.at || 0) };
  }
  let best = null;
  for (const [k, r] of Object.entries(store)) {
    if (r.resetsAt <= now || (Number.isFinite(keepMs) && now - r.at > keepMs)) {
      delete store[k];
      continue;
    }
    if (!best || r.pct > best.pct) best = r;
  }
  return best ? { pct: best.pct, resetsAt: best.resetsAt } : null;
}

export function usageNow() {
  const rl = readJSONSync(path.join(CLAUDE_DIR, 'rate_limits.json'), {}) || {};
  const est = readJSONSync(path.join(CLAUDE_DIR, 'usage_estimate.json'), {}) || {};
  const nowMs = Date.now();
  const now = nowMs / 1000;
  const fresh = (o) => o && o.saved_at && now - o.saved_at < 30 * 60;
  const s = loadSeen();
  const before = JSON.stringify(s);
  const savedAt = (rl.saved_at || 0) * 1000;

  let five = null;
  if (rl.five_hour && typeof rl.five_hour.used_percentage === 'number' && (rl.five_hour.resets_at || 0) > now) {
    const r = recordReading(s.five, { pct: rl.five_hour.used_percentage, resetsAt: (rl.five_hour.resets_at || 0) * 1000, at: savedAt }, FIVE_KEEP, nowMs);
    if (r) five = { ...r, source: 'claude' };
  } else {
    const r = recordReading(s.five, {}, FIVE_KEEP, nowMs);
    if (r) five = { ...r, source: 'claude' };
    else if (fresh(est) && est.five_hour && typeof est.five_hour.used_percentage === 'number') {
      const resets = (est.five_hour.resets_at || 0) * 1000;
      // A fresh estimate whose window already reset means usage restarted from ~0.
      five = { pct: resets && resets < nowMs ? 0 : est.five_hour.used_percentage, resetsAt: resets, source: 'estimate' };
    }
  } // else: nothing fresh → unknown (null); Pilotage's own call caps still apply

  const seven = recordReading(
    s.seven,
    rl.seven_day && typeof rl.seven_day.used_percentage === 'number' ? { pct: rl.seven_day.used_percentage, resetsAt: (rl.seven_day.resets_at || 0) * 1000, at: savedAt || nowMs } : {},
    SEVEN_KEEP,
    nowMs,
  );

  if (JSON.stringify(s) !== before && nowMs - lastSaved > 5000) {
    lastSaved = nowMs;
    try {
      writeJSONSync(SEEN_FILE, s);
    } catch {}
  }
  return { five, seven, at: nowMs };
}
