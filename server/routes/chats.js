// claude.ai chats from the official data export. Logic: server/sources/claude-ai.js. Contract: docs/API-CHATS.md.
//   GET    /api/chats?q=&project=&limit=   { chats, status }            (any paired device)
//   POST   /api/chats/import {path}        replace the import            (PC only)
//   DELETE /api/chats                      forget the import             (PC only)
// /api/search adds `chats` (index.js), the Map adds chat nodes (routes/graph.js), both through ctx.chats.
// SSE kind: 'chats'.
import { ClaudeAiChats, ImportError } from '../sources/claude-ai.js';

export default function ({ route, ctx }) {
  const { registry, store, json, fail, broadcast, log } = ctx;
  const chats = new ClaudeAiChats({ registry, store });
  ctx.chats = chats;
  if (chats.data) log.info(`claude.ai chats: ${chats.chats.length} from the last import`);

  route('GET', '/api/chats', async (req, res, { url }) => {
    const q = url.searchParams.get('q') || '';
    const project = url.searchParams.get('project') || null;
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 200, 2000));
    json(res, { chats: chats.list({ q, projectId: project, limit }), status: chats.status() });
  });

  route(
    'POST',
    '/api/chats/import',
    async (req, res, { body }) => {
      if (chats.importing) return fail(res, 409, 'An import is already running');
      const t0 = Date.now();
      let r;
      chats.importing = true;
      try {
        r = await chats.import(body.path);
      } catch (e) {
        if (e instanceof ImportError) return fail(res, e.status, e.message);
        log.error('claude.ai import failed', e.message);
        return fail(res, 500, 'The import failed: see the server log');
      } finally {
        chats.importing = false;
      }
      log.info(`claude.ai chats: imported ${r.count} (${r.linked} linked to a project, ${r.skipped} skipped) in ${Date.now() - t0} ms`);
      broadcast('chats');
      json(res, { ok: true, ...r, status: chats.status() });
    },
    { localOnly: true },
  );

  route(
    'DELETE',
    '/api/chats',
    async (req, res) => {
      chats.remove();
      log.info('claude.ai chats: import removed');
      broadcast('chats');
      json(res, { ok: true, status: chats.status() });
    },
    { localOnly: true },
  );
}
