// Headless `claude -p` calls with structured output. No tools, no MCP, no user hooks,
// no session persistence: a pure text-in / JSON-out call on the user's subscription.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_CMD, paths } from '../config.js';
import { runWithInput, clip, log } from '../util.js';

const BASE_ARGS = [
  '-p',
  '--output-format', 'json',
  '--no-session-persistence',
  '--tools', '',
  '--strict-mcp-config',
  '--setting-sources', 'project',
  '--disable-slash-commands',
];

/**
 * The environment for Pilotage's own `claude -p` calls (pure; tested). No PILOTAGE_* variables, and no API key
 * picked up from the shell that started Pilotage: with ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) set, Claude Code
 * bills the API account instead of the subscription the summaries are meant to use, and the usage guard (which reads
 * the subscription's numbers) never notices. PILOTAGE_USE_ANTHROPIC_API_KEY=1 keeps them, for API-key-only setups.
 */
export function claudeEnv(parent) {
  const env = { ...parent };
  // Node last on PATH, for claude's own children (wrapper shims call `node` from PATH; the autostart has no nvm).
  const nodeDir = path.dirname(process.execPath);
  if (!String(env.PATH || '').split(':').includes(nodeDir)) env.PATH = env.PATH ? `${env.PATH}:${nodeDir}` : nodeDir;
  const keepKey = parent.PILOTAGE_USE_ANTHROPIC_API_KEY === '1';
  for (const k of Object.keys(env)) if (k.startsWith('PILOTAGE_')) delete env[k];
  if (!keepKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

/**
 * configDir (optional): run the child with CLAUDE_CONFIG_DIR=<dir>, i.e. as the Claude account/config
 * stored there instead of ~/.claude. Usually called through ai/providers.js → callAI().
 */
export async function callClaude({ instruction, input, schema, model = 'haiku', effort = 'low', timeout = 240000, configDir = '' }) {
  const args = [...BASE_ARGS, '--model', model, '--effort', effort];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  args.push('--', instruction);
  const env = claudeEnv(process.env);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  // A missing working folder makes the spawn fail with ENOENT, which reads as "Claude is not installed".
  fs.mkdirSync(paths.aiSandbox, { recursive: true });
  const t0 = Date.now();
  const r = await runWithInput(CLAUDE_CMD[0], [...CLAUDE_CMD.slice(1), ...args], input, { cwd: paths.aiSandbox, env, timeout });
  const ms = Date.now() - t0;
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    // output-format json prints one object; tolerate leading noise
    const i = r.stdout.indexOf('{"');
    if (i >= 0) {
      try {
        j = JSON.parse(r.stdout.slice(i));
      } catch {}
    }
  }
  if (!j) {
    // A timeout note sits at the end of stderr, after whatever the CLI printed: put it first so it survives the clip.
    const err = clip(r.timedOut ? `Timed out after ${Math.round(timeout / 1000)} s` : r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`, 400);
    log.warn('claude -p failed', err);
    return { ok: false, error: err, ms, ...(r.timedOut ? { timedOut: true } : {}) };
  }
  if (j.is_error || j.subtype !== 'success') {
    return { ok: false, error: clip(j.result || j.subtype || 'error', 400), ms, cost: j.total_cost_usd || 0, apiStatus: j.api_error_status };
  }
  let out = j.structured_output;
  if (!out && schema && typeof j.result === 'string') {
    try {
      out = JSON.parse(j.result.replace(/^```(json)?\s*|\s*```$/g, ''));
    } catch {}
  }
  if (schema && !out) return { ok: false, error: 'no structured output', ms, cost: j.total_cost_usd || 0 };
  return { ok: true, data: out ?? j.result, cost: j.total_cost_usd || 0, ms, model: Object.keys(j.modelUsage || {})[0] || model };
}
