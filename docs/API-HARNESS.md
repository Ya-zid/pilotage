# Harness- and model-agnostic API (Codex, Gemini, AI providers, accounts)

Backend contract for the frontend. Everything here is additive: existing fields and endpoints are unchanged.
All routes need the usual auth (device cookie or `X-Pilotage-Key`). PATCH/POST need `X-Pilotage: 1` and
`Content-Type: application/json`.

## 1. Sessions from other harnesses

Codex CLI rollouts (`~/.codex/sessions/**/rollout-*.jsonl`) and Gemini CLI chats (`~/.gemini/tmp/<hash>/chats/*.json`)
are indexed next to Claude transcripts. They show up everywhere sessions do: `/api/sessions`, project pages, the
timeline, search, the AI digests, briefs and threads. They have the same shape as Claude sessions, plus two new fields.

```ts
type Harness = 'claude' | 'codex' | 'gemini';

// Added to SessionSummary (so also to SessionDetail, project.sessions, overview.live, search results)
type SessionSummary = {
  // ...existing fields...
  harness: Harness;        // 'claude' for every Claude session (WSL, Windows, history-only, extra dirs)
  account: string | null;  // first 8 chars of the Claude accountUuid; null for non-Claude or older transcripts
};

// SessionDetail.resumeCommand now depends on the harness:
//   claude: "cd DIR && claude --resume <id>"
//   codex:  "cd DIR && codex resume <uuid>"   (id without the "codex-" prefix)
//   gemini: "cd DIR && gemini --resume latest" (Gemini only resumes by list position)
```

Ids and sources:

| harness | `id` | `source` | notes |
|---|---|---|---|
| claude | `<uuid>` (or `hist-…`) | `wsl`, `win`, `history`, `win-history`, `x-<hash6>` (extra Claude dir) | unchanged |
| codex | `codex-<uuid>` | `codex` | `entrypoint` = Codex `source` (`cli`, `exec`, …). `exec` runs count as automation (`kind: 'automation'`). |
| gemini | `gemini-<start>-<id8>` (chat file name) | `gemini` | sub-agent chats (e.g. codebase_investigator) are skipped, like Claude sidechains |

- `model` is the Codex/Gemini model (e.g. `gpt-5.1-codex`, `gemini-3-pro-preview`). `title` falls back to the AI digest
  title, then to the first prompt. Codex and Gemini have no titles of their own.
- `live` is always `null` for codex/gemini: they are not live-tracked.
- Turns (`/api/sessions/:id/turns`) are identical. `hasDetail` is true for codex and gemini, and
  `/api/sessions/:id/turns/:i` returns the usual `TurnItem[]`:
  - codex: `prompt`, `text`, and `tool` items (`name`: `shell` | `apply_patch` | `update_plan` | …, `summary` = the
    command or the patched files, `result`, `error` = non-zero exit code).
  - gemini: `prompt`, `text`, `tool` (`name` is the display name, e.g. `Shell`, `WriteFile`).
- Antigravity (`~/.gemini/antigravity`) is not supported: its conversations are encrypted protobuf.

UI suggestions: a small harness badge on session cards and rows (Claude / Codex / Gemini), a harness filter chip on
Sessions, and an account filter or grouping when more than one `account` value exists. Filtering is client-side:
`/api/sessions` has no new query parameters.

## 2. Session sources: `GET /api/harnesses`, `PATCH /api/harnesses`

```ts
type HarnessInfo = {
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
type ClaudeDir = { id: string; dir: string; extra: boolean; exists: boolean };
type Account = { account: string; sessions: number; lastAt: number; sources: string[] };

// GET /api/harnesses
type HarnessesResponse = {
  harnesses: HarnessInfo[];
  claudeDirs: ClaudeDir[];       // wsl, win, and every extra dir
  extraClaudeDirs: string[];
  accounts: Account[];           // Claude accounts seen in transcripts, most recent first
};

// PATCH /api/harnesses (every key optional)
type HarnessesPatch = {
  extraClaudeDirs?: string[];    // absolute WSL paths of other Claude config dirs (each must contain projects/). Max 10. [] clears.
  enabled?: { codex?: boolean; gemini?: boolean };
};
// → HarnessesResponse & { rescanning: boolean }. The rescan runs in the background; an SSE "sessions" change follows.
// 400 { error } for a bad path ("No projects/ folder in …", "… is already indexed").
```

A second Claude account usually lives in its own config dir (`CLAUDE_CONFIG_DIR=~/.claude-work claude …`). Adding that
dir here indexes its sessions (source `x-<hash>`), and `account` tells the accounts apart.

## 3. AI providers: `GET/PATCH /api/providers`, `POST /api/providers/test`

PC-only: on the phone listener `PATCH /api/providers`, `POST /api/providers/test` and `PATCH /api/harnesses` answer
`403 Only possible from the PC` (a stored key follows its preset, so changing the address from a phone could send
the key elsewhere). The `GET`s work from phones.

All AI work (digests, briefs, daily brief, CV) goes through one provider:

| id | what | usage guard |
|---|---|---|
| `claude-cli` (default) | headless `claude -p` on the subscription. Optional `configDir` pins a Claude account (`CLAUDE_CONFIG_DIR`). | 5h/7d usage % (Settings → AI) |
| `codex-cli` | `codex exec`, read-only sandbox, no MCP, no web search, `--output-schema` | daily call cap |
| `openai-compatible` | `POST {baseUrl}/chat/completions` with a model and API key (DeepSeek, OpenRouter, OpenAI, Groq, Ollama, custom) | daily call cap |

```ts
type ProviderId = 'claude-cli' | 'codex-cli' | 'openai-compatible';
type PresetId = 'deepseek' | 'openrouter' | 'openai' | 'groq' | 'ollama' | 'custom';

type ProviderInfo = {
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

type Preset = {
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

type ProvidersConfig = {
  'claude-cli': { configDir: string; digestModel: string; briefModel: string; cvModel: string; scoutModel: string }; // '' = use settings.ai.*Model
  'codex-cli': { model: string };                                   // '' = Codex default (~/.codex/config.toml)
  'openai-compatible': { preset: PresetId; baseUrl: string; model: string; schemaMode?: '' | 'json_schema' | 'json_object' }; // '' = preset default
};

// GET /api/providers
type ProvidersResponse = {
  provider: ProviderId;                       // current one
  providers: ProviderInfo[];
  config: ProvidersConfig;
  effective: { 'openai-compatible': { preset: PresetId; baseUrl: string; model: string; schemaMode: string } }; // after preset defaults
  claudeDefaults: { digestModel: string; briefModel: string; cvModel: string; scoutModel: string };       // settings.ai.*Model
  dailyCallCap: number;                       // 0 = no cap; non-Claude providers only
  presets: Preset[];
};

// PATCH /api/providers (every key optional) → ProvidersResponse
type ProvidersPatch = {
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
type ProviderTest = { ok: boolean; provider: ProviderId; model: string | null; ms: number; error: string | null; reply: unknown };
// 409 if a test is already running.
```

Keys are stored only in `data/secrets.json` (mode 0600) under `providerKeys[preset]`. They are never sent back, logged
or put in `settings`. Each preset has its own key, so a DeepSeek key and an OpenRouter key can both be stored.

### Settings shape (in `/api/bootstrap` and `/api/settings`; read-only there, edit through the endpoints above)

```ts
type Settings = {
  ai: {
    // ...existing...
    provider: ProviderId;
    providers: ProvidersConfig;
    dailyCallCap: number;
  };
  sources: {
    extraClaudeDirs: string[];
    harnesses: { codex: boolean; gemini: boolean };
  };
  // ...launch, scan, ui unchanged
};
```

### Provider settings UX notes

- **Settings → AI → Provider**: three radio cards built from `providers[]`. Show `version`, or "not installed" when
  `installed` is false (disable the card). Show "uses your Claude 5-hour window" when `usageGuard` is true, else
  "N calls today / cap M" from `callsToday` and `dailyCallCap`.
- **claude-cli**: the per-purpose model pickers keep editing `settings.ai.digestModel/briefModel/cvModel/scoutModel` through
  `PATCH /api/settings`, as today. The override fields in `providers['claude-cli']` can stay hidden behind "Advanced".
  "Claude account folder" (`configDir`) is a text field with a hint like `~/.claude-work`; leave it empty for the default account.
- **codex-cli**: one model field. Placeholder: "default (gpt-5.1-codex from ~/.codex/config.toml)".
  Note: "Uses your ChatGPT plan through `codex login`. Each call leaves a small rollout in ~/.codex/sessions, which Pilotage ignores."
- **openai-compatible**: a preset dropdown (`presets[]`). Selecting one fills the base URL and model placeholders from
  the preset. Base URL is only editable for `custom` (or behind "Advanced"). The API key field is write-only: show
  "•••• last4" when `hasKey`, with Replace and Remove buttons. Send `{apiKey, apiKeyPreset}`, then clear the input.
  Link to `keysUrl`. Ollama note: from WSL, `localhost:11434` reaches a Windows Ollama only with WSL mirrored networking.
  Otherwise use the Windows host IP.
- **Test** button → `POST /api/providers/test`. Show `✓ model · 1.2 s` or the `error`. It counts as one call.
- **Daily cap** number input ("0 = no limit") applies to codex-cli and openai-compatible. When it is reached, automatic
  work pauses and `/api/ai`'s `guard.reason` says so (resets at local midnight). Manual runs also fail with that reason.
- Switching providers doesn't redo existing digests. New and changed blocks use the new provider. `digest.model` records who wrote each one.

## 4. Launching Codex / Gemini: `POST /api/launch`

New optional body field:

```ts
type LaunchBody = {
  // ...existing: projectId, worktree, name, prompt, mode, resumeId, fork, model, permissionMode, ideaId
  harness?: Harness;   // default 'claude'. A resumeId starting with 'codex-' / 'gemini-' implies its harness.
};
// The Launch record gains: harness: Harness; note?: string
```

Rules:
- `codex` and `gemini` launch **in a Windows Terminal tab only**. `mode: 'background'` → 500 `{error: "Background mode is
  Claude-only. Start Codex CLI in a terminal instead."}`. Phones default to background, so send `mode: 'terminal'`
  explicitly when the user picks Codex or Gemini.
- Resume: codex yes (`resumeId: 'codex-<uuid>'` → `codex resume <uuid>`). Gemini cannot be resumed (error).
  `fork` is Claude-only (error).
- `model`: any model name for codex/gemini (e.g. `gpt-5.1-codex`, `gemini-2.5-pro`). Claude aliases (`opus`, …) and the
  Claude default from settings are ignored, and the CLI's own default is used.
- `permissionMode` mapping:

  | Pilotage | codex | gemini |
  |---|---|---|
  | `bypassPermissions` ("Skip all prompts") | `--dangerously-bypass-approvals-and-sandbox` | `--approval-mode yolo` |
  | `acceptEdits`, `auto` | `--full-auto` | `--approval-mode auto_edit` |
  | `default` (the default for new installs), `manual`, `plan`, `dontAsk`, and anything else | (none: Codex asks) | `--approval-mode default` |

  Claude: `bypassPermissions` → `--dangerously-skip-permissions`; `manual` and any unknown value →
  `--permission-mode default` (asks first; every Claude Code version accepts it); other known modes pass through.
  Only the exact value `bypassPermissions` skips approvals. `POST /api/launch` answers 400 `Unknown permission mode`
  for a value outside `bypassPermissions, acceptEdits, auto, manual, default, plan, dontAsk`.

- The prompt goes through a 0600 file, as with Claude (`codex … -- "$PROMPT"`, `gemini --prompt-interactive="$PROMPT"`).
- After launch, the record is `state: 'launched'` with a `note`. There is no session id, phone link or live state. The session
  appears in the list once the CLI writes its file (Codex after the first prompt).
- Any launch, shell or attach whose folder path contains `;` or `"` fails with `Folder path contains ";" or '"' which Windows Terminal
  cannot handle safely`. Show that message as is.

UI: in New Session, add a harness segmented control (Claude · Codex · Gemini) driven by `GET /api/harnesses`
(`installed`, `launch.*`). For non-Claude harnesses, hide Background / Fork / Remote-control hints and swap the model
list for a free-text field. On a codex session page, Resume sends `{resumeId: id, mode: 'terminal'}`. On a gemini
session, disable Resume and show `resumeCommand` instead.
