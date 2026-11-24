# claude.ai chats: API contract

Your conversations on claude.ai ("online sessions"), from claude.ai's official data export (Settings → Privacy →
Export data: an e-mail with a zip). Pilotage reads the export once, keeps a compact index, and shows the chats on the
Map, in Sessions (assistant "claude.ai") and in search. Read-only: nothing is ever sent to claude.ai, and a chat opens
there (`https://claude.ai/chat/<uuid>`); it can't be resumed in Pilotage.

Server: `server/routes/chats.js` (logic in `server/sources/claude-ai.js`, index in `data/claude-ai.json`, mode 0600).
Auth/CSRF as every `/api/*` route. Errors are `{ error: string }` with a 4xx status.

## What is read

The zip (any name), the folder it was unzipped to (or one level above), or `conversations.json` itself. In the zip,
the entry named `conversations.json` (the shortest path if there are several) is inflated with `node:zlib` by a minimal
zip directory reader (stored or deflated entries, ZIP64 aware, no encryption); no other entry is read. At most 400 MB
of JSON. The file is an array of conversations (or `{ conversations: [...] }`), read tolerantly:

| Field | Also accepted |
|---|---|
| `uuid` | `id` (8–64 letters, digits, dashes; others are skipped and counted) |
| `name` | `title` |
| `created_at`, `updated_at` | `createdAt`, `updatedAt`, epoch seconds or ms; missing `updated_at` = the last message |
| `chat_messages[]` | `messages[]` |
| message `sender: 'human' \| 'assistant'` | `role: 'user' \| 'assistant'` |
| message `text` | `content: [{ type: 'text', text }]` (other parts, files and tool calls, are skipped) |

## What is kept

Per chat: uuid, title, dates, message counts, the first and last of your prompts (400 characters), your prompts as one
search text (3,000 characters), and the projects it mentions. Every string goes through `redact()`. Claude's answers
are read (for linking) but not kept. The log only gets counts. A newer import replaces the old one entirely.

**Linking to projects**: a chat is linked to a project when its title or any message names the project's display name
or folder name, as whole words, case-insensitive, accents folded, and `-`/`_`/spaces interchangeable ("Pilotage web"
names `pilotage-web`). Names shorter than 4 characters, numbers and generic folder names (`api`, `app`, `web`, `docs`,
`test`, `server`, ...) never link; hidden projects and the home folder neither. Projects found after the import are
linked from the kept text.

## Routes

| Route | Where | What |
|---|---|---|
| `GET /api/chats?q=&project=<id>&limit=200` | any paired device | `{ chats: ChatSummary[], status: ChatsStatus }`, newest first; `q` matches title and prompts (every word) |
| `POST /api/chats/import { path }` | **PC only** (403 on the phone listener) | `{ ok, count, linked, skipped, importedAt, status }`; 400 with a plain message for a bad path or file; 409 while another import runs |
| `DELETE /api/chats` | **PC only** | forgets the import (`data/claude-ai.json` removed), `{ ok, status }` |

`path` must be absolute or start with `~`. Errors name the problem: "Nothing at ~/x.zip", "This file is not a zip
archive", "No conversations.json in this zip: is it the claude.ai export?", "conversations.json is not valid JSON (...)",
"conversations.json should hold a list of conversations...", "This zip archive is damaged (...)".

`GET /api/search?q=` adds `chats: ChatSummary[]` (at most 12). `GET /api/graph` adds `chat` nodes and `chat` links
([API-GRAPH.md](API-GRAPH.md)).

```ts
interface ChatSummary {
  uuid: string;
  name: string;              // 'Untitled chat' when the export has none
  createdAt: number;         // ms
  updatedAt: number;
  messages: number;
  humanMessages: number;
  firstPrompt: string;
  lastPrompt: string;        // '' with a single prompt
  projects: { id: string; name: string }[];
  url: string;               // https://claude.ai/chat/<uuid>
}
interface ChatsStatus {
  imported: boolean;
  count: number;
  importedAt?: number;
  source?: { kind: 'zip' | 'folder' | 'file'; from: string };  // `from` with ~ for the home folder
  skipped?: number;
  linked?: number;
}
```

## Live updates (SSE)

Import and remove broadcast the kind **`chats`**; `KIND_TO_KEYS` maps it to `chats`, `graph` and `search`.
