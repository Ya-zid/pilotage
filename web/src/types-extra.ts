// Types for the work/spin-off and harness/provider APIs (copied from docs/API-WORK.md and docs/API-HARNESS.md).
/* eslint-disable */

export type WorkStatus = 'inbox' | 'todo' | 'doing' | 'done' | 'dropped';
export type WorkSourceKind = 'ai' | 'brief' | 'user' | 'idea' | 'spinoff';
/** What the AI currently thinks, even for items it is not allowed to move (user-edited ones). */
export type AiStatus = 'open' | 'done' | 'abandoned' | 'superseded' | 'removed' | 'stale' | null;

export interface WorkItem {
  id: string;                 // 'ai_…' (from sessions/briefs), 'u_…' user, 'i_…' from an idea, 'k_…' spin-off kickoff
  projectId: string;          // same 10-hex id as /api/projects (works even if the folder is not registered)
  projectPath: string;
  projectName: string;
  workspace: string | null;
  title: string;              // short imperative, ≤ 200 chars (AI titles ≤ ~96)
  detail: string;             // plain text; AI items: full next step + "From: “<block title>” — <outcome>"
  status: WorkStatus;
  priority: 0 | 1 | 2 | 3;    // 0 low, 1 normal, 2 high, 3 urgent (AI never sets 3)
  source: {
    kind: WorkSourceKind;
    sessionId?: string;       // ai: the session whose latest block raised it (link to /sessions/:id)
    blockKey?: string;        // ai: `${sessionId}:${turnIndex}`
    sessionTitle: string | null;
    step?: number;            // brief: index in brief.nextSteps
    ideaId?: string;          // idea
    spinoffId?: string;       // spinoff
  };
  ai: boolean;                // created by Pilotage (kinds ai | brief | spinoff), not typed by the user
  autoManaged: boolean;       // the extractor may still move it (ai && !userEdited)
  userEdited: boolean;        // any PATCH sets this; from then on the AI never changes status/title/detail
  aiStatus: AiStatus;
  closedBy: 'ai' | 'user' | 'expired' | null; // 'ai' / 'expired' = closed automatically (restorable)
  who?: 'you' | 'claude' | 'waiting' | null; // who does it, as the AI sees it (null = unknown)
  titleBy?: 'short' | null;   // 'short' = shortened by the one-time cleanup
  plannedFor?: string | null;   // 'YYYY-MM-DD': flagged for Home › Today (rolls over until done)
  snoozeUntil?: number | null;  // Suggested: hidden until then
  dismissReason?: 'not-a-task' | 'done' | 'duplicate' | 'old' | null;
  restoredAt?: number | null;   // restored from Dropped: expiry counts from here
  createdAt: number;          // ms epoch, all timestamps
  updatedAt: number;
  sourceAt: number;           // when the evidence was observed (block end / brief time) — use for "3 days ago"
  doneAt: number | null;
  dueAt: number | null;
  startedAt: number | null;
  launches: { launchId: string; at: number; mode: 'terminal' | 'background'; sessionId: string | null }[];
}

export interface WorkCounts { inbox: number; todo: number; doing: number; done: number; dropped: number }

export interface Spinoff {
  id: string;
  kind: 'spinoff' | 'new';    // 'new' = POST /api/projects/new (no source project)
  from: string | null;        // source project path
  to: string;                 // new folder path
  name: string;
  goal: string;
  sessionId: string | null;   // source session, if one was picked
  threadName: string | null;  // source thread, if one was picked
  ideaId?: string | null;
  createdAt: number;
  fromProjectId: string | null;
  fromName: string | null;
  toProjectId: string;
  toName: string;
  toDisplayPath: string;      // '~/whatsapp-module'
  fromRegistered: boolean;
  toRegistered: boolean;
}

export interface LaunchRecord {      // same object /api/launch returns (server/launch.js)
  id: string; mode: 'terminal' | 'background'; cwd: string; name: string;
  state: 'starting' | 'launched' | 'running' | 'ready' | 'error';
  sessionId: string | null; bgId: string | null; bridgeUrl: string | null; error: string | null;
}

export interface CreatedProject {
  ok: true;
  project: { id: string; path: string; displayPath: string; name: string; workspace: string | null; registered: boolean };
  claudeMd: { path: string; generatedBy: 'ai' | 'template'; aiError: string | null };
  git: { ok: boolean; error?: string } | null;   // null when gitInit was false
  launch: LaunchRecord | null;                   // null when launch was null; state 'error' does NOT fail the call
  items: WorkItem[];                             // starter tasks created in the new project (status 'todo')
  spinoff: Spinoff;
}

export type WorkOverview = {
  openCount: number; doingCount: number; todoCount: number; inboxCount: number; lastExtractAt: number;
  topNext: Pick<WorkItem, 'id' | 'title' | 'status' | 'priority' | 'projectId' | 'projectName' | 'ai' | 'aiStatus' | 'dueAt' | 'sourceAt'>[];
};
export type WorkList = { items: WorkItem[]; counts: WorkCounts; lastExtractAt: number };

export type Harness = 'claude' | 'codex' | 'gemini';
export type HarnessInfo = {
  id: Harness;
  label: string;                 // 'Claude Code' | 'Codex CLI' | 'Gemini CLI'
  installed: boolean;            // Linux-side CLI found (node's bin dir, ~/.local/bin, PATH; Windows /mnt/c installs are ignored)
  bin: string | null;
  version: string | null;        // e.g. 'codex-cli 0.58.0'
  dataDir: string | null;        // ~/.claude, ~/.codex, ~/.gemini
  dataFound: boolean;
  enabled: boolean;              // claude is always true
  sessions: number;              // sessions currently indexed for this harness
  live: boolean;                 // only claude is live-tracked
  launch: { terminal: boolean; background: boolean; resume: boolean; fork: boolean };
};
export type ClaudeDir = { id: string; dir: string; extra: boolean; exists: boolean };
export type Account = { account: string; sessions: number; lastAt: number; sources: string[] };

// GET /api/harnesses
export type HarnessesResponse = {
  harnesses: HarnessInfo[];
  claudeDirs: ClaudeDir[];       // wsl, win, and every extra dir
  extraClaudeDirs: string[];
  accounts: Account[];           // Claude accounts seen in transcripts, most recent first
};

// PATCH /api/harnesses (every key optional)
export type HarnessesPatch = {
  extraClaudeDirs?: string[];    // absolute WSL paths of other Claude config dirs (each must contain projects/). Max 10. [] clears.
  enabled?: { codex?: boolean; gemini?: boolean };
};
// → HarnessesResponse & { rescanning: boolean }. The rescan runs in the background; an SSE "sessions" change follows.
// 400 { error } for a bad path ("No projects/ folder in …", "… is already indexed").

export type ProviderId = 'claude-cli' | 'codex-cli' | 'openai-compatible';
export type PresetId = 'deepseek' | 'openrouter' | 'openai' | 'groq' | 'ollama' | 'custom';

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  kind: 'cli' | 'api';
  description: string;
  installed: boolean;            // CLI found (always true for 'api')
  bin: string | null;
  version: string | null;
  usageGuard: boolean;           // true only for claude-cli (5h/7d window applies)
  callsToday: number;            // calls made today through this provider
  cap: { ok: boolean; reason?: string; until?: number };  // daily cap state (claude-cli: always ok)
};

export type Preset = {
  id: PresetId;
  label: string;
  baseUrl: string;               // '' for custom
  model: string;                 // default model
  schemaMode: 'json_schema' | 'json_object';
  needsKey: boolean;             // false for ollama / custom
  keysUrl: string | null;        // where to create a key
  hasKey: boolean;               // a key is stored for this preset
  last4: string | null;          // last 4 chars of the stored key. The key itself is never returned.
};

export type ProvidersConfig = {
  'claude-cli': { configDir: string; digestModel: string; briefModel: string; cvModel: string }; // '' = use settings.ai.*Model
  'codex-cli': { model: string };                                   // '' = Codex default (~/.codex/config.toml)
  'openai-compatible': { preset: PresetId; baseUrl: string; model: string; schemaMode?: '' | 'json_schema' | 'json_object' }; // '' = preset default
};

// GET /api/providers
export type ProvidersResponse = {
  provider: ProviderId;                       // current one
  providers: ProviderInfo[];
  config: ProvidersConfig;
  effective: { 'openai-compatible': { preset: PresetId; baseUrl: string; model: string; schemaMode: string } }; // after preset defaults
  claudeDefaults: { digestModel: string; briefModel: string; cvModel: string };                           // settings.ai.*Model
  dailyCallCap: number;                       // 0 = no cap; non-Claude providers only
  presets: Preset[];
};

// PATCH /api/providers (every key optional) → ProvidersResponse
export type ProvidersPatch = {
  provider?: ProviderId;
  providers?: {
    'claude-cli'?: Partial<ProvidersConfig['claude-cli']>;  // configDir: '' or an existing absolute folder; models: haiku|sonnet|opus|fable|claude-*
    'codex-cli'?: { model?: string };
    'openai-compatible'?: Partial<ProvidersConfig['openai-compatible']>; // baseUrl: https://…, or http:// for localhost/LAN only
  };
  dailyCallCap?: number;          // integer 0–100000
  apiKey?: string | null;         // write-only. '' or null deletes the stored key.
  apiKeyPreset?: PresetId;        // which preset the key belongs to (default: the openai-compatible preset in this patch, else the saved one)
};
// 400 { error } on bad input, and nothing is written in that case.

// POST /api/providers/test  body: { provider?: ProviderId }  (default: current provider)
// Makes one tiny structured call (expects {"ok":true,"word":"pong"}) and counts as a call.
export type ProviderTest = { ok: boolean; provider: ProviderId; model: string | null; ms: number; error: string | null; reply: unknown };
// 409 if a test is already running.
