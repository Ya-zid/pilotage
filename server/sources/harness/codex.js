// Codex CLI sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (append-only JSONL).
//
// Records (Codex 0.39 → 0.58):
//   {timestamp, type:'session_meta', payload:{id, cwd, cli_version, originator, source:'cli'|'exec'|..., git:{branch,...}}}
//   {type:'turn_context', payload:{cwd, model, effort, ...}}                     one per model request
//   {type:'event_msg', payload:{type:'user_message', message, images, kind}}     the clean user prompt
//   {type:'event_msg', payload:{type:'agent_message', message}}                  assistant text (dup of response_item)
//   {type:'event_msg', payload:{type:'token_count', info:{total_token_usage:{output_tokens}}}}
//   {type:'event_msg', payload:{type:'entered_review_mode', prompt}}             /review
//   {type:'response_item', payload:{type:'message', role:'assistant', content:[{type:'output_text', text}]}}
//   {type:'response_item', payload:{type:'message', role:'user', ...}}           env context / duplicates → ignored
//   {type:'response_item', payload:{type:'function_call', name:'shell'|'update_plan', arguments, call_id}}
//   {type:'response_item', payload:{type:'custom_tool_call', name:'apply_patch', input, call_id}}
//   {type:'response_item', payload:{type:'function_call_output'|'custom_tool_call_output', call_id, output}}
//   {type:'compacted', payload:{message}}                                        context compaction summary
// Turn offsets are real byte offsets of the user_message line, so turn detail reads the file slice.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HOME, isInternalPath } from '../../config.js';
import { yieldNow } from '../../util.js';
import { clip, baseMeta, TurnBuilder, eachLine, tsOf, cleanCwd, pruneFiles, addPrLinks } from './common.js';

export const CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');
const MAX_LINE_PARSE = 4 * 1024 * 1024;
const ROLLOUT_RX = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const PATCH_FILE_RX = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

export const codexId = (uuid) => `codex-${uuid}`;
export const codexUuid = (id) => String(id || '').replace(/^codex-/, '');

function patchFiles(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('*** ')) return out;
  for (const m of text.matchAll(PATCH_FILE_RX)) out.push(m[1].trim());
  return out;
}

function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function shellCommand(args) {
  const c = args?.command;
  if (Array.isArray(c)) {
    // ["bash","-lc","<script>"] → the script
    if (c.length >= 3 && /^(ba|z)?sh$/.test(path.basename(String(c[0]))) && /^-\w*c$/.test(c[1])) return String(c.slice(2).join(' '));
    return c.join(' ');
  }
  return typeof c === 'string' ? c : '';
}

/** Short label for a tool call (shown in turn detail). */
export function codexToolSummary(name, rawArgs) {
  if (name === 'apply_patch') {
    const files = patchFiles(typeof rawArgs === 'string' ? rawArgs : '');
    return clip(files.length ? files.join(', ') : 'patch', 220);
  }
  const a = parseArgs(rawArgs) || {};
  if (name === 'shell' || name === 'exec_command' || name === 'shell_command') {
    const cmd = shellCommand(a) || a.cmd || '';
    const pf = patchFiles(cmd);
    if (pf.length) return clip(`apply_patch ${pf.join(', ')}`, 220);
    return clip(String(cmd).replace(/\s+/g, ' '), 220);
  }
  if (name === 'update_plan') return clip(a.explanation || `${(a.plan || []).length} steps`, 220);
  const s = Object.values(a).find((v) => typeof v === 'string');
  return clip(s || '', 160);
}

function outputText(o) {
  if (typeof o !== 'string') return o == null ? '' : JSON.stringify(o);
  const j = o.startsWith('{') ? parseArgs(o) : null;
  if (j && typeof j.output === 'string') return { text: j.output, error: typeof j.metadata?.exit_code === 'number' && j.metadata.exit_code !== 0 };
  return o;
}

function lineHead(buf) {
  return buf.toString('latin1', 0, Math.min(buf.length, 200));
}

/** Parse a whole rollout buffer. Returns {meta, turns}. */
export function parseCodexBuffer(buf, { id, file } = {}) {
  const meta = baseMeta(id || 'codex-unknown', 'codex', file || null);
  const turns = [];
  const tb = new TurnBuilder(meta, turns);
  let exec = false;
  let turnCwd = null;
  const end = eachLine(buf, (line, off) => {
    const head = lineHead(line);
    // Encrypted reasoning blobs and ghost snapshots carry nothing we show.
    if (head.includes('"type":"response_item"') && (head.includes('"payload":{"type":"reasoning"') || head.includes('"payload":{"type":"ghost_snapshot"'))) return;
    if (line.length > MAX_LINE_PARSE) return;
    let o;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    const ts = tsOf(o.timestamp);
    const p = o.payload || {};
    switch (o.type) {
      case 'session_meta': {
        if (p.id && !id) meta.id = codexId(p.id);
        if (!meta.cwd) meta.cwd = cleanCwd(p.cwd);
        meta.version = p.cli_version || meta.version;
        meta.entrypoint = p.source || meta.entrypoint || 'cli';
        exec = p.source === 'exec' || p.originator === 'codex_exec';
        if (p.git?.branch && p.git.branch !== 'HEAD') meta.gitBranch = p.git.branch;
        if (p.model_provider) meta.modelProvider = p.model_provider;
        tb.touch(ts || tsOf(p.timestamp));
        return;
      }
      case 'turn_context':
        if (p.model) meta.models[p.model] = (meta.models[p.model] || 0) + 1;
        if (p.cwd) turnCwd = cleanCwd(p.cwd);
        tb.touch(ts);
        return;
      case 'compacted':
        if (p.message) tb.prompt('x', p.message, ts, off);
        return;
      case 'event_msg': {
        const t = p.type;
        if (t === 'user_message') {
          let text = typeof p.message === 'string' ? p.message.trim() : '';
          const imgs = Array.isArray(p.images) ? p.images.length : 0;
          if (!text && !imgs) return tb.touch(ts);
          if (imgs) text = text ? `[image] ${text}` : '[image]';
          tb.prompt(exec ? 's' : 'h', text, ts, off);
        } else if (t === 'entered_review_mode' && p.prompt) {
          tb.prompt(exec ? 's' : 'h', `/review ${p.prompt}`, ts, off);
        } else if (t === 'agent_message' && p.message) {
          // Same text as the response_item message (older builds sometimes only log this one).
          tb.reply(p.message, ts, off);
        } else if (t === 'token_count') {
          const out = p.info?.total_token_usage?.output_tokens;
          if (typeof out === 'number' && out > meta.outTokens) meta.outTokens = out;
          tb.touch(ts);
        } else tb.touch(ts);
        return;
      }
      case 'response_item': {
        const t = p.type;
        if (t === 'message' && p.role === 'assistant') {
          const text = (Array.isArray(p.content) ? p.content : [])
            .filter((c) => c && typeof c.text === 'string')
            .map((c) => c.text)
            .join('\n')
            .trim();
          if (text) {
            meta.counts.assistantText++;
            tb.reply(text, ts, off);
          } else tb.touch(ts);
        } else if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') {
          const name = p.name || (t === 'local_shell_call' ? 'shell' : '?');
          tb.tool(name, ts);
          const raw = t === 'custom_tool_call' ? p.input : p.arguments;
          if (name === 'apply_patch') for (const f of patchFiles(raw)) tb.file(f, turnCwd || meta.cwd);
          else if (typeof raw === 'string' && raw.includes('*** ')) {
            const a = parseArgs(raw);
            const cmd = shellCommand(a);
            for (const f of patchFiles(cmd)) tb.file(f, cleanCwd(a?.workdir) || turnCwd || meta.cwd);
          }
        } else if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'local_shell_call_output') {
          meta.counts.toolResult++;
          if (typeof p.output === 'string' && p.output.length < 1_500_000) addPrLinks(meta, p.output);
          tb.touch(ts);
        } else tb.touch(ts);
        return;
      }
      default:
        tb.touch(ts);
    }
  });
  meta.offset = end;
  meta.turnCount = turns.length;
  if (meta.cwd) meta.projectKey = meta.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  pruneFiles(meta);
  return { meta, turns };
}

export async function parseCodexFile(file, id) {
  const buf = await fsp.readFile(file);
  const st = await fsp.stat(file);
  const r = parseCodexBuffer(buf, { id, file });
  r.meta.size = st.size;
  r.meta.mtimeMs = st.mtimeMs;
  return r;
}

async function listRollouts(dir) {
  const out = [];
  const walk = async (d, depth) => {
    let ents;
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile()) {
        const m = ROLLOUT_RX.exec(e.name);
        if (!m) continue;
        try {
          const st = await fsp.stat(p);
          out.push({ id: codexId(m[1]), file: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Items of one turn, read from the rollout slice [turn.off, next turn.off). */
async function turnDetail(meta, turns, index) {
  const turn = turns[index];
  if (!turn) return { items: [] };
  if (!meta.file || turn.off < 0) return { items: [{ kind: 'prompt', text: turn.p, t: turn.t }, ...(turn.a ? [{ kind: 'text', text: turn.a, t: turn.at }] : [])] };
  const next = turns.slice(index + 1).find((x) => x.off > turn.off);
  let end = next ? next.off : meta.offset || meta.size;
  end = Math.min(end, turn.off + 40 * 1024 * 1024);
  const len = Math.max(0, end - turn.off);
  const buf = Buffer.alloc(len);
  const fh = await fsp.open(meta.file, 'r');
  try {
    await fh.read(buf, 0, len, turn.off);
  } finally {
    await fh.close();
  }
  const items = [];
  const byCall = new Map();
  // agent_message events duplicate the response_item message (either order): keep one.
  const pushText = (raw, t) => {
    const text = clip(String(raw || '').trim(), 30000);
    if (!text) return;
    const prev = [...items].reverse().find((x) => x.kind === 'text');
    if (prev && prev.text === text) return;
    items.push({ kind: 'text', text, t });
  };
  eachLine(Buffer.concat([buf, Buffer.from('\n')]), (line) => {
    if (items.length > 1500) return;
    const head = lineHead(line);
    if (head.includes('"payload":{"type":"reasoning"') || head.includes('"payload":{"type":"token_count"') || head.includes('"type":"turn_context"')) return;
    if (line.length > MAX_LINE_PARSE) return;
    let o;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    const p = o.payload || {};
    const t = tsOf(o.timestamp);
    if (o.type === 'event_msg' && p.type === 'user_message') {
      items.push({ kind: 'prompt', origin: meta.entrypoint === 'exec' ? 's' : 'h', text: clip(p.message || '', 20000), t });
    } else if (o.type === 'event_msg' && p.type === 'entered_review_mode') {
      items.push({ kind: 'prompt', origin: 'h', text: clip(`/review ${p.prompt || ''}`, 20000), t });
    } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      pushText((p.content || []).filter((c) => typeof c?.text === 'string').map((c) => c.text).join('\n'), t);
    } else if (o.type === 'event_msg' && p.type === 'agent_message' && p.message) {
      pushText(p.message, t);
    } else if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const raw = p.type === 'custom_tool_call' ? p.input : p.arguments;
      const it = { kind: 'tool', id: p.call_id || `c${items.length}`, name: p.name || '?', summary: codexToolSummary(p.name, raw), t };
      items.push(it);
      if (p.call_id) byCall.set(p.call_id, it);
    } else if (o.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const it = byCall.get(p.call_id);
      if (it) {
        const out = outputText(p.output);
        it.result = clip(typeof out === 'string' ? out : out.text, 1200);
        it.error = typeof out === 'object' ? !!out.error : false;
      }
    }
  });
  return { items };
}

/** cwd from the session_meta line (first line) without parsing the whole rollout. */
async function headCwd(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const m = /"type":"session_meta".*?"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, bytesRead));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Adapter: incremental by file size + mtime (unchanged rollouts keep their cached meta/turns). */
export const codexAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  dir: CODEX_DIR,
  empty: new Map(), // file -> "size:mtime" of rollouts without any prompt, or 'internal' (Pilotage's own AI calls)
  async scan({ known }) {
    const files = await listRollouts(path.join(CODEX_DIR, 'sessions'));
    const metas = [];
    const turns = new Map();
    for (const f of files) {
      const prev = known.get(f.id);
      if (prev && prev.file === f.file && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
        metas.push(prev);
        continue;
      }
      const sig = `${f.size}:${f.mtimeMs}`;
      if (this.empty.get(f.file) === sig || this.empty.get(f.file) === 'internal') continue;
      // Pilotage's own `codex exec` AI calls (cwd = config.aiWorkDir(), data/ai-sandbox before) are not sessions.
      const cwd = await headCwd(f.file);
      if (cwd && isInternalPath(cleanCwd(cwd))) {
        this.empty.set(f.file, 'internal');
        continue;
      }
      try {
        const r = await parseCodexFile(f.file, f.id);
        if (!r.turns.length) {
          this.empty.set(f.file, sig);
          continue;
        }
        metas.push(r.meta);
        turns.set(f.id, r.turns);
      } catch {
        if (prev) metas.push(prev); // unreadable for now: keep the last good meta, retried next scan
      }
      await yieldNow();
    }
    return { metas, turns };
  },
  turnDetail,
};
