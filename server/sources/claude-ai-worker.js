// One claude.ai import in its own Node process (see inChild() in claude-ai.js), started with a capped heap: reading
// and parsing a big export can't freeze the server, and an export too big for memory ends this process, not the
// server. Gets {input, linkable} over IPC, answers once, exits.
import { buildChats, ImportError } from './claude-ai.js';

process.once('message', ({ input, linkable }) => {
  let out;
  try {
    out = { ok: true, result: buildChats(input, linkable) };
  } catch (e) {
    // Only Pilotage's own messages (ImportError) reach the user; others are logged by the server as a failed import.
    out = { ok: false, importError: e instanceof ImportError, status: e?.status, message: String(e?.message || e) };
  }
  process.send(out, () => process.exit(0));
});
