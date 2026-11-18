// Shapes returned by the Pilotage server (see server/views.js).

export type Usage = {
  five: { pct: number; resetsAt: number; source: string } | null;
  seven: { pct: number; resetsAt: number } | null;
  at: number;
};

export type LiveInfo = {
  status: string | null;
  state: string | null;
  kind: 'interactive' | 'background';
  bgId: string | null;
  detail: string;
  bridgeUrl: string | null;
  name: string | null;
  pid: number | null;
};

export type Digest = {
  title: string;
  summary: string;
  outcome: string;
  status: 'done' | 'in_progress' | 'blocked' | 'abandoned' | 'ongoing';
  nextStep: string; // written for Claude
  todo?: string; // the same next step as a short to-do for the user (3-7 words)
  who?: 'you' | 'claude' | 'waiting' | null; // who does the next step
  topic: string;
  kind?: string;
  cvWorthy?: boolean;
  highlights?: string[];
};

export type SessionSummary = {
  id: string;
  title: string;
  kind: 'interactive' | 'automation' | 'archived';
  source: string;
  projectId: string | null;
  projectName: string | null;
  workspace: string | null;
  cwd: string;
  worktree: string | null;
  branch: string | null;
  startedAt: number;
  lastAt: number;
  humanPrompts: number;
  turns: number;
  lastPrompt: string;
  recap: string | null;
  recapAt: number;
  digest: Pick<Digest, 'title' | 'summary' | 'outcome' | 'status' | 'nextStep' | 'todo' | 'who' | 'topic'> | null;
  blocks: number;
  automation: string | null;
  model: string | null;
  prs: string[];
  compactions: number;
  live: LiveInfo | null;
  pinned: boolean;
  hidden: boolean;
  match?: string | null;
  harness?: 'claude' | 'codex' | 'gemini';
  account?: string | null;
};

export type BlockView = {
  key: string;
  sessionId: string;
  startAt: number;
  endAt: number;
  prompts: number;
  sdk: number;
  i0: number;
  i1: number;
  digest: Digest | null;
  stale: boolean;
  fallbackTitle: string;
  lastText: string;
  sessionTitle?: string;
  live?: boolean;
  title?: string;
  projectId?: string | null;
  projectName?: string | null;
};

export type SessionDetail = SessionSummary & {
  firstPrompt: string | null;
  blocksDetail: BlockView[];
  files: { path: string; n: number }[];
  tools: { name: string; n: number }[];
  counts: Record<string, number>;
  outTokens: number;
  models: Record<string, number>;
  version: string | null;
  entrypoint: string | null;
  archived: boolean;
  transcript: string | null;
  sizeBytes: number;
  threads: string[];
  resumeCommand: string;
};

export type Turn = { i: number; t: number; o: string; p: string; a: string; at: number; n: number; e: number; hasDetail: boolean };
export type TurnsPage = { total: number; shown: number; hasMore: boolean; turns: Turn[] };
export type TurnItem =
  | { kind: 'prompt'; origin?: string; text: string; t: number }
  | { kind: 'text'; text: string; t: number }
  | { kind: 'tool'; id: string; name: string; summary: string; t: number; error?: boolean; result?: string };

export type Signal = { kind: string; severity: 'info' | 'warn'; text: string; sessionId?: string };

export type GitInfo = {
  branch: string | null;
  dirty: number;
  untracked: number;
  ahead: number;
  behind: number;
  lastCommitAt: number;
  lastCommitMsg: string;
  webUrl: string | null;
  commits30d: number;
};

export type ProjectSummary = {
  id: string;
  path: string;
  displayPath: string;
  name: string;
  folderName: string;
  workspace: string;
  workspaceName: string;
  isGit: boolean;
  isWorkspaceRoot: boolean;
  windows: boolean;
  status: 'active' | 'idle' | 'dormant' | 'paused' | 'done' | 'archived';
  userStatus: string | null;
  pinned: boolean;
  color: string | null;
  lastAt: number;
  lastSessionAt: number;
  firstAt: number;
  sessionCount: number;
  humanPrompts: number;
  automationRuns: number;
  liveCount: number;
  worktreeCount: number;
  git: GitInfo | null;
  oneLiner: string | null;
  stack: string[];
  attention: Signal[];
  threadCount: number;
  hasBrief: boolean;
};

export type Brief = {
  oneLiner: string;
  description: string;
  currentState: string;
  nextSteps: string[];
  attention: string[];
  cv: { title: string; role: string; bullets: string[] } | null;
  threads: { name: string; summary: string; status: string; blockKeys: string[] }[];
};

export type Thread = {
  name: string;
  summary: string;
  status: string;
  loose: boolean;
  lastAt: number;
  firstAt: number;
  blocks: BlockView[];
};

export type Worktree = {
  path: string;
  name: string;
  branch: string | null;
  dirty: number;
  untracked: number;
  ahead: number;
  lastCommitAt: number;
  lastCommitMsg: string;
  missing: boolean;
  merged: boolean;
  sessions: number;
  lastAt: number;
  servers: { pid: number; ports: number[] }[];
};

export type Doc = { path: string; name: string; group: string; size: number; mtime: number };
export type Proc = { pid: number; ports: number[]; cwd: string; cmd: string; startedAt: number; deleted?: boolean; publicBind: boolean };

export type CvEntry = { title: string; tagline: string; role: string; period: string; stack: string[]; bullets: string[] };
export type PortfolioOverride = { include: boolean; title: string; tagline: string; role: string; period: string; stack: string[]; bullets: string[]; link: string };

export type ProjectDetail = ProjectSummary & {
  notes: string;
  links: { title: string; url: string }[];
  hidden: boolean;
  brief: Brief | null;
  briefAt: number;
  briefError: string | null;
  threads: Thread[];
  automations: { name: string; runs: number; lastAt: number; lastResult: string; lastSessionId: string | null }[];
  sessions: SessionSummary[];
  worktrees: Worktree[];
  docs: Doc[];
  gitExtras: { defaultBranch: string | null; recentLog: { d: string; s: string }[]; firstCommitAt: number } | null;
  gitFull: (GitInfo & { ok: boolean; upstream: string | null; remoteUrl: string | null }) | null;
  processes: Proc[];
  cv: { lang: string; at: number; model: string; entry: CvEntry } | null;
  portfolio: PortfolioOverride | null;
};

export type AttentionItem = Signal & { projectId: string; projectPath: string; projectName: string; lastAt: number };

export type DailyBrief = {
  headline: string;
  focus: { project: string; projectPath: string | null; projectId: string | null; title: string; why: string; action: string }[];
  forgotten: { project: string; projectPath: string | null; projectId: string | null; note: string }[];
  ideas: string[];
  day: string;
  at: number;
};

export type Idea = { id: string; text: string; projectPath: string | null; createdAt: number; doneAt: number | null; source: string; launchedAt?: number; workItemId?: string | null };

export type AIStatus = {
  enabled: boolean;
  autoDigest: boolean;
  pausedByUser: boolean;
  guard: { ok: boolean; reason?: string; until?: number };
  queue: { id: string; kind: string; label: string }[];
  queueLength: number;
  running: { id: string; kind: string; label: string; startedAt: number }[];
  pendingBlocks: number;
  digested: number;
  briefs: number;
  stats: { calls: number; cost: number; errors: number; lastError: { at: number; msg: string; job: string } | null; lastRunAt: number; byKind: Record<string, number> };
  daily: { day: string; at: number } | null;
};

export type IndexProgress = { total: number; done: number; bytes: number; running: boolean; firstDone: boolean };

export type DayActivity = { day: string; prompts: number; commits: number; sessions: number; projects: Record<string, { prompts: number; commits: number }> };

export type Overview = {
  now: number;
  live: SessionSummary[];
  recent: BlockView[];
  attention: AttentionItem[];
  activity: DayActivity[];
  daily: DailyBrief | null;
  ideas: Idea[];
  counts: { projects: number; activeProjects: number; sessions: number; automationRuns48h: number; interactive?: number; automated?: number; archived?: number };
  automationsRecent: { id: string; name: string; lastAt: number; projectId: string | null; result: string }[];
  usage: Usage;
  index: IndexProgress;
  ai: AIStatus;
  gen: number;
  work?: import('./types-extra').WorkOverview;
  /** v3 (SIMPLIFY.md §4, §10) */
  pickup?: import('./types-v3').PickupItem[];
  plan?: import('./types-v3').Plan;
  suggestedCount?: number;
  scout?: { newCount: number; top: Pick<import('./types-v3').ScoutCandidate, 'id' | 'title' | 'pitch' | 'kind' | 'confidence' | 'projectId' | 'projectName' | 'at'>[]; lastRunAt?: number };
};

export type Settings = {
  /** Your name for the greeting and AI prompts; '' = detected (Bootstrap.user.detectedName). */
  profile?: { name: string };
  ai: { enabled: boolean; autoDigest: boolean; digestModel: string; briefModel: string; cvModel: string; maxFiveHourPct: number; maxSevenDayPct: number; concurrency: number; dailyBrief: boolean };
  launch: { permissionMode: string; model: string; pcMode: 'terminal' | 'background'; phoneMode: 'terminal' | 'background'; trustFolders?: boolean };
  scan: { extraRoots: string[]; hiddenPaths: string[]; depth: number };
  ui: { theme: 'system' | 'light' | 'dark' };
};

export type Bootstrap = {
  version: string;
  build?: string; // id of the web build on disk; differs from the loaded one after a deploy
  device: { id: string; name: string; isPhone: boolean; viaLan?: boolean };
  settings: Settings;
  /** The name in use (settings.profile.name, else detected from git config / $USER). */
  user?: { name: string; detectedName: string };
  /** wsl: WSL2 + Windows, where Windows Terminal, VS Code / Explorer on the PC and the phone forwarder work. */
  platform?: { wsl: boolean; os: string };
  home: string;
  usage: Usage;
  index: IndexProgress;
  ai: AIStatus;
  gen: number;
};

export type Launch = {
  id: string;
  mode: 'terminal' | 'background';
  cwd: string;
  name: string;
  state: 'starting' | 'launched' | 'running' | 'ready' | 'error';
  sessionId: string | null;
  bgId: string | null;
  bridgeUrl: string | null;
  error: string | null;
  note?: string;
  detail?: string;
  createdAt: number;
};

export type Device = { id: string; name: string; createdAt: number; lastSeenAt: number; ua: string; via: string };
export type NetInfo = {
  firewallRule: boolean;
  addresses: { adapter: string; ip: string; kind: string; mask?: string | null }[];
  forwarder: { installed: boolean; running: boolean; port: number; pid: number | null; lastSeen: number; error: string | null; connections: number; refused?: number; ssidTrusted?: boolean; onWifi?: boolean; outdated?: boolean };
  lanPort: number;
  port: number;
  currentSsid?: string | null;
  trustedSsids?: string[];
  vpnCidrs?: string[];
};

export type PortfolioProject = ProjectSummary & {
  periodStart: number;
  periodEnd: number;
  briefCv: Brief['cv'];
  description: string | null;
  generated: ProjectDetail['cv'];
  portfolio: PortfolioOverride | null;
  highlights: string[];
  commits: number;
};
