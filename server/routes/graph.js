// The Map (a graph of all your work). Logic: server/graph.js. Contract: docs/API-GRAPH.md.
//   GET /api/graph?days=90&project=<id>   { nodes, links, truncated?, days, at }   read-only
// Memo-cached per (days, project); any broadcast clears the memo, so the next request rebuilds it.
import { buildGraph } from '../graph.js';
import { getWorkStore } from '../work/store.js';

export const DAY_CHOICES = [7, 30, 90, 365, 0];

export default function ({ route, ctx }) {
  const { index, registry, store, ai, views, live, json, fail, cached, log } = ctx;
  const work = getWorkStore();

  route('GET', '/api/graph', async (req, res, { url }) => {
    const rawDays = url.searchParams.get('days');
    const days = rawDays == null || rawDays === '' ? 90 : Number(rawDays);
    if (!DAY_CHOICES.includes(days)) return fail(res, 400, `days must be one of ${DAY_CHOICES.join(', ')} (0 = all time)`);
    const projectId = url.searchParams.get('project') || null;
    if (projectId && !/^[a-f0-9]{10}$/.test(projectId)) return fail(res, 400, 'Invalid project id');
    if (projectId && !registry.byId(projectId)) return fail(res, 404, 'Project not found');
    const t0 = Date.now();
    const out = cached(`graph:${days}:${projectId || ''}`, () => {
      const g = buildGraph(
        {
          index,
          registry,
          store,
          ai,
          views,
          live,
          workItems: work.items,
          spinoffs: work.data.spinoffs,
          // routes/scout.js and routes/chats.js attach these to ctx when they load (any order)
          candidates: ctx.scout ? ctx.scout.list() : [],
          chats: ctx.chats ? ctx.chats.forGraph() : [],
        },
        { days, projectId },
      );
      const ms = Date.now() - t0;
      if (ms > 300) log.info(`graph: ${g.nodes.length} nodes, ${g.links.length} links in ${ms} ms`);
      return g;
    });
    json(res, out);
  });
}
