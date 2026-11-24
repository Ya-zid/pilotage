// Persistent user state (overrides, ideas, settings) with atomic writes and daily backups. A state.json that can't be
// read (a hand edit, a crash mid-write) is kept aside and the newest readable backup is loaded (util.loadJSONObjectSync).
import { paths } from './config.js';
import { loadJSONObjectSync, backupDailySync, writeJSONSync, debounce, log } from './util.js';

export const DEFAULT_SETTINGS = {
  /** Your name, as AI prompts and the Home greeting use it. Empty = detected (server/profile.js). */
  profile: {
    name: '',
  },
  ai: {
    enabled: true,
    autoDigest: true,
    /** Automatic summaries cover work from the last N days; older work only on "Summarize now". */
    backfillDays: 30,
    /** Paused by the user (Settings → AI): nothing automatic runs until resumed, across restarts. */
    paused: false,
    digestModel: 'haiku',
    briefModel: 'haiku',
    cvModel: 'sonnet',
    /** Project scout (ai/scout.js): judgment-heavy, one call per project every few days at most. */
    scoutModel: 'sonnet',
    /** Pause automatic AI work above this 5-hour usage %. */
    maxFiveHourPct: 60,
    /** Pause automatic AI work above this 7-day usage %. */
    maxSevenDayPct: 92,
    concurrency: 2,
    dailyBrief: true,
    /** Pilotage's own call budget (headless calls are invisible to the usage files). 0 = no cap. */
    maxCallsPer5h: 500,
    maxCallsPerDay: 1500,
    /** Who runs AI jobs: 'claude-cli' | 'codex-cli' | 'openai-compatible' (see ai/providers.js). */
    provider: 'claude-cli',
    providers: {
      // Empty model = use digestModel/briefModel/cvModel/scoutModel above. configDir pins a Claude account (CLAUDE_CONFIG_DIR).
      'claude-cli': { configDir: '', digestModel: '', briefModel: '', cvModel: '', scoutModel: '' },
      // Empty model = Codex's own default (~/.codex/config.toml).
      'codex-cli': { model: '' },
      // API keys never live here: data/secrets.json → providerKeys[preset].
      'openai-compatible': { preset: 'deepseek', baseUrl: '', model: '' },
    },
    /** Max AI calls per day for non-Claude providers (0 = no cap). The 5h/7d usage guard only applies to claude-cli. */
    dailyCallCap: 300,
  },
  /** Session sources besides ~/.claude (WSL) and the Windows-side ~/.claude. */
  sources: {
    /** More Claude config dirs (e.g. a second account's CLAUDE_CONFIG_DIR); their projects/*.jsonl get indexed. */
    extraClaudeDirs: [],
    /** Other harness adapters (sources/harness/*). */
    harnesses: { codex: true, gemini: true },
  },
  launch: {
    /** New installs ask before commands and edits ("default", Claude Code's ask mode). "Skip all prompts"
     * (bypassPermissions) is one click away in Settings → New sessions; installs from before 0.4.0 keep it. */
    permissionMode: 'default',
    model: '',
    pcMode: 'terminal',
    phoneMode: 'background',
    /** Answer Claude Code's "trust this folder?" for folders started from Pilotage (writes ~/.claude.json; see claude-trust.js). */
    trustFolders: false,
  },
  scan: {
    extraRoots: [],
    hiddenPaths: [],
    depth: 3,
  },
  ui: {
    theme: 'system',
  },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

const EMPTY_STATE = {
  version: 1,
  projects: {}, // path -> {name, status, pinned, workspace, notes, links, hidden, color, cv}
  workspaces: {}, // key -> {name, color, order, mergeInto} (mergeInto: fold this top folder into another workspace)
  sessions: {}, // sessionId -> {title, hidden, pinned, thread}
  ideas: [], // {id, text, projectPath, createdAt, doneAt, source}
  pickupHidden: {}, // 's:<sessionId>' -> ms: Home › Pick up "Not now" (comes back on new activity)
  planAccepted: {}, // 'YYYY-MM-DD' -> [focus key]: proposals the user added to today (never proposed again that day)
  planDismissed: {}, // 'YYYY-MM-DD' -> [focus text hash]: Today's-plan proposals the user said "Not today" to
  scout: {}, // project-scout candidate id -> {status, at, from, title, candidate, ideaId?, projectPath?} (ai/scout.js)
  migrations: {}, // one-time startup imports already done (name -> ms)
  settings: DEFAULT_SETTINGS,
  portfolio: { lang: 'en', header: '' },
};

class StateStore {
  constructor(file) {
    this.file = file;
    const loaded = loadJSONObjectSync(file, paths.backups, 'state');
    // Installs from before 0.4.0 defaulted to "Skip all prompts": keep that for them, so an upgrade never changes how
    // their sessions start. Only new installs get the new "ask first" default.
    if (loaded && loaded.settings && !loaded.settings.launch?.permissionMode) loaded.settings.launch = { ...(loaded.settings.launch || {}), permissionMode: 'bypassPermissions' };
    if (loaded?.settings?.launch?.permissionMode === 'manual') loaded.settings.launch.permissionMode = 'default'; // older name of "Ask every time"
    this.data = deepMerge(EMPTY_STATE, loaded || {});
    this.data.settings = deepMerge(DEFAULT_SETTINGS, this.data.settings || {});
    this._save = debounce(() => this.saveNow(), 400);
  }
  save() {
    this._save();
  }
  saveNow() {
    try {
      backupDailySync(this.file, paths.backups, 'state', 21);
      writeJSONSync(this.file, this.data);
    } catch (e) {
      log.error('state save failed', e);
    }
  }
  get settings() {
    return this.data.settings;
  }
  project(p) {
    return this.data.projects[p] || {};
  }
  patchProject(p, patch) {
    const cur = this.data.projects[p] || {};
    this.data.projects[p] = { ...cur, ...patch };
    this.save();
    return this.data.projects[p];
  }
  session(id) {
    return this.data.sessions[id] || {};
  }
  patchSession(id, patch) {
    const cur = this.data.sessions[id] || {};
    this.data.sessions[id] = { ...cur, ...patch };
    this.save();
    return this.data.sessions[id];
  }
  patchSettings(patch) {
    this.data.settings = deepMerge(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }
}

let store = null;
export function getStore() {
  if (!store) store = new StateStore(paths.state);
  return store;
}
