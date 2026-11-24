// AI providers. Every AI job (digests, briefs, daily, CV) goes through callAI(), whichever model runs it:
//   claude-cli         headless `claude -p` on the subscription (runner.js). Optional configDir pins a Claude
//                      account (CLAUDE_CONFIG_DIR). The 5h/7d usage guard (usage.js) applies to this one only.
//   codex-cli          `codex exec`, read-only sandbox, in data/ai-sandbox, --output-schema for the JSON shape.
//   openai-compatible  POST {baseUrl}/chat/completions: DeepSeek, OpenRouter, OpenAI, Groq, Ollama or custom.
// Non-Claude providers have a daily call cap (settings.ai.dailyCallCap, 0 = none).
// API keys live only in data/secrets.json (0600) → providerKeys[preset]. Never logged, never returned.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, DATA, CLAUDE_BIN, HOME } from '../config.js';
import { runWithInput, clip, redact, readJSONSync, writeJSONSync, isoDay } from '../util.js';
import { callClaude } from './runner.js';
import { getStore } from '../store.js';
import { getSecrets } from '../auth.js';
import { findBin, cliEnv } from '../sources/harness/common.js';

export const PROVIDER_IDS = ['claude-cli', 'codex-cli', 'openai-compatible'];

export const PROVIDERS = {
  'claude-cli': { label: 'Claude Code (claude -p)', kind: 'cli', bin: 'claude', usageGuard: true, description: 'Your Claude subscription through headless claude -p. No tools, no MCP, no session files.' },
  'codex-cli': { label: 'Codex CLI (codex exec)', kind: 'cli', bin: 'codex', usageGuard: false, description: 'Your ChatGPT/Codex login through codex exec, read-only sandbox, no MCP, no web search.' },
  'openai-compatible': { label: 'OpenAI-compatible API', kind: 'api', bin: null, usageGuard: false, description: 'Any /chat/completions API: DeepSeek, OpenRouter, OpenAI, Groq, local Ollama, or a custom URL. Paid per call.' },
};

/** schemaMode: 'json_schema' (strict structured output) or 'json_object' (JSON mode + schema in the prompt). */
export const PRESETS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', schemaMode: 'json_object', needsKey: true, keysUrl: 'https://platform.deepseek.com/api_keys' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', schemaMode: 'json_schema', needsKey: true, keysUrl: 'https://openrouter.ai/keys' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', schemaMode: 'json_schema', needsKey: true, keysUrl: 'https://platform.openai.com/api-keys' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', schemaMode: 'json_object', needsKey: true, keysUrl: 'https://console.groq.com/keys' },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', schemaMode: 'json_object', needsKey: false, keysUrl: null },
  custom: { label: 'Custom URL', baseUrl: '', model: '', schemaMode: 'json_object', needsKey: false, keysUrl: null },
};

export const SAFE_MODEL = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;
const CLAUDE_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable']);
const PURPOSE_MODEL = { digest: 'digestModel', brief: 'briefModel', daily: 'briefModel', cv: 'cvModel', scout: 'scoutModel' };
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

// ---------------------------------------------------------------- settings / keys / counters

function aiSettings() {
  return getStore().settings.ai || {};
}

export function currentProvider(s = aiSettings()) {
  return PROVIDER_IDS.includes(s.provider) ? s.provider : 'claude-cli';
}

export function providerConfig(id, s = aiSettings()) {
  return (s.providers && s.providers[id]) || {};
}

export function getProviderKey(preset) {
  const k = (getSecrets().data.providerKeys || {})[preset];
  return typeof k === 'string' ? k : typeof k?.key === 'string' ? k.key : null;
}

export function setProviderKey(preset, key) {
  const sec = getSecrets();
  const keys = { ...(sec.data.providerKeys || {}) };
  if (key) keys[preset] = { key, savedAt: Date.now() };
  else delete keys[preset];
  sec.data.providerKeys = keys;
  sec.save();
}

/** What the client may know about a stored key. */
export function keyInfo(preset) {
  const k = getProviderKey(preset);
  return k ? { hasKey: true, last4: k.length >= 12 ? k.slice(-4) : null } : { hasKey: false, last4: null };
}

const USAGE_FILE = path.join(DATA, 'ai-provider-usage.json');
let usage = null;
function usageState() {
  const day = isoDay(Date.now());
  if (!usage) usage = readJSONSync(USAGE_FILE, null) || {};
  if (usage.day !== day || typeof usage.calls !== 'object') usage = { day, calls: {} };
  return usage;
}
export function callsToday() {
  return { ...usageState().calls };
}
function countCall(id) {
  const u = usageState();
  u.calls[id] = (u.calls[id] || 0) + 1;
  try {
    writeJSONSync(USAGE_FILE, u);
  } catch {}
}

/** Daily cap for non-Claude providers. {ok} or {ok:false, reason, until}. */
export function capStatus(id = currentProvider()) {
  if (id === 'claude-cli') return { ok: true };
  const cap = Number(aiSettings().dailyCallCap) || 0;
  const n = usageState().calls[id] || 0;
  if (cap > 0 && n >= cap) {
    const t = new Date();
    t.setHours(24, 0, 0, 0);
    return { ok: false, reason: `Daily AI call cap reached (${n}/${cap} today with ${PROVIDERS[id].label})`, until: t.getTime() };
  }
  return { ok: true };
}

/** Does the 5-hour / 7-day Claude usage guard apply? */
export function usesClaudeUsage(id = currentProvider()) {
  return id === 'claude-cli';
}

// ---------------------------------------------------------------- JSON helpers

/** Parse model output that should be JSON: tolerates code fences, <think> blocks, leading/trailing prose. */
export function parseJSONLoose(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  let t = String(s).replace(/^﻿/, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const tryParse = (x) => {
    try {
      const v = JSON.parse(x);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };
  let v = tryParse(t);
  if (v) return v;
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t);
  if (fence && (v = tryParse(fence[1].trim()))) return v;
  // First balanced {...} (string-aware)
  for (let i = t.indexOf('{'); i !== -1; i = t.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        if ((v = tryParse(t.slice(i, j + 1)))) return v;
        break;
      }
    }
  }
  return null;
}

function defaultFor(s) {
  if (!s || s.enum) return undefined;
  if (s.type === 'string') return '';
  if (s.type === 'array') return [];
  if (s.type === 'boolean') return false;
  return undefined;
}

/**
 * Check a reply against our (simple) JSON schemas and repair small slips: case-insensitive enums,
 * scalars where strings are expected, a lone string where an array of strings is expected, and missing
 * string/array/boolean keys when most required keys are present. Returns {data, errors}.
 */
export function conformToSchema(schema, value) {
  const errors = [];
  const fix = (sch, v, at) => {
    if (!sch || typeof sch !== 'object') return v;
    if (Array.isArray(sch.enum)) {
      if (sch.enum.includes(v)) return v;
      const m = typeof v === 'string' ? sch.enum.find((e) => String(e).toLowerCase() === v.trim().toLowerCase().replace(/[\s-]+/g, '_')) : undefined;
      if (m !== undefined) return m;
      errors.push(`${at} not one of ${sch.enum.join('|')}`);
      return v;
    }
    switch (sch.type) {
      case 'object': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          errors.push(`${at} should be an object`);
          return v;
        }
        const props = sch.properties || {};
        const req = sch.required || [];
        const out = { ...v };
        const present = req.filter((k) => out[k] != null).length;
        for (const k of req) {
          if (out[k] != null) continue;
          const d = defaultFor(props[k]);
          if (d !== undefined && present >= Math.ceil(req.length / 2)) out[k] = d;
          else errors.push(`${at}.${k} missing`);
        }
        for (const [k, ps] of Object.entries(props)) if (out[k] != null) out[k] = fix(ps, out[k], `${at}.${k}`);
        if (sch.additionalProperties === false) for (const k of Object.keys(out)) if (!(k in props)) delete out[k];
        return out;
      }
      case 'array':
        if (Array.isArray(v)) return v.map((x, i) => fix(sch.items, x, `${at}[${i}]`));
        if (typeof v === 'string' && sch.items?.type === 'string') return v.trim() ? [v] : [];
        errors.push(`${at} should be an array`);
        return v;
      case 'string':
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        errors.push(`${at} should be a string`);
        return v;
      case 'boolean':
        if (typeof v === 'boolean') return v;
        if (v === 'true' || v === 'false') return v === 'true';
        errors.push(`${at} should be a boolean`);
        return v;
      case 'number':
      case 'integer':
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
        errors.push(`${at} should be a number`);
        return v;
      default:
        return v;
    }
  };
  const data = fix(schema, value, '$');
  return { data, errors };
}

// ---------------------------------------------------------------- codex-cli

export function codexExecArgs({ model = '', effort = '', schemaFile = null, outFile = null, cwd }) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--color', 'never',
    '--json',
    '--disable', 'web_search_request',
    '--disable', 'view_image_tool',
    '--disable', 'ghost_commit',
    '-c', 'approval_policy="never"',
    '-c', 'mcp_servers={}',
    '-C', cwd,
  ];
  if (model && SAFE_MODEL.test(model)) args.push('-m', model);
  if (EFFORTS.has(effort)) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (outFile) args.push('-o', outFile);
  args.push('-'); // prompt on stdin
  return args;
}

export function codexPrompt(instruction, input) {
  return `${instruction}\n\nAnswer with the JSON object only. Do not run commands, read files or use any tool: everything you need is in the input below.\n\n<input>\n${input || ''}\n</input>\n`;
}

/** `codex exec --json` stdout → {text, error, usage}. Handles the 0.4x+ event names and the older {msg:{type}} form. */
export function parseCodexEvents(stdout) {
  let text = '';
  let error = '';
  let usage = null;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = e.msg && typeof e.msg === 'object' ? e.msg : null;
    if (e.type === 'item.completed' && e.item && /agent_message|assistant_message/.test(e.item.type || '') && typeof e.item.text === 'string') text = e.item.text;
    else if (msg?.type === 'agent_message' && typeof msg.message === 'string') text = msg.message;
    else if (e.type === 'turn.completed' && e.usage) usage = e.usage;
    else if (e.type === 'turn.failed') error = e.error?.message || 'turn failed';
    else if (e.type === 'error' && e.message) error = e.message;
    else if (msg?.type === 'error' && msg.message) error = msg.message;
  }
  return { text, error, usage };
}

function codexDefaultModel() {
  try {
    const toml = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml'), 'utf8');
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] || null;
  } catch {
    return null;
  }
}

async function callCodex({ instruction, input, schema, model, effort, timeout }) {
  const bin = findBin('codex');
  if (!bin) return { ok: false, error: 'Codex CLI not found (npm i -g @openai/codex, then codex login)', ms: 0, notSent: true };
  const dir = paths.aiSandbox;
  fs.mkdirSync(dir, { recursive: true });
  const tag = crypto.randomBytes(6).toString('hex');
  const schemaFile = schema ? path.join(dir, `.codex-schema-${tag}.json`) : null;
  const outFile = path.join(dir, `.codex-out-${tag}.txt`);
  const t0 = Date.now();
  try {
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    const r = await runWithInput(bin, codexExecArgs({ model, effort, schemaFile, outFile, cwd: dir }), codexPrompt(instruction, input), { cwd: dir, env: cliEnv(), timeout });
    const ms = Date.now() - t0;
    const ev = parseCodexEvents(r.stdout);
    let text = '';
    try {
      text = fs.readFileSync(outFile, 'utf8');
    } catch {}
    if (!text.trim()) text = ev.text;
    const usedModel = model || codexDefaultModel() || 'codex default';
    if (!text.trim()) return { ok: false, error: clip(redact(ev.error || r.stderr.trim().split('\n').slice(-3).join(' ') || `codex exited with ${r.code}`), 400), ms };
    if (!schema) return { ok: true, data: text.trim(), ms, cost: 0, model: usedModel, usage: ev.usage };
    const data = parseJSONLoose(text);
    if (!data) return { ok: false, error: 'Codex did not return JSON', ms };
    return { ok: true, data, ms, cost: 0, model: usedModel, usage: ev.usage };
  } finally {
    for (const f of [schemaFile, outFile]) if (f) fs.rm(f, { force: true }, () => {});
  }
}

// ---------------------------------------------------------------- openai-compatible

export function resolveEndpoint(cfg = {}) {
  const preset = PRESETS[cfg.preset] ? cfg.preset : 'custom';
  const p = PRESETS[preset];
  return {
    preset,
    label: p.label,
    baseUrl: String(cfg.baseUrl || p.baseUrl || '').replace(/\/+$/, ''),
    model: cfg.model || p.model,
    schemaMode: cfg.schemaMode === 'json_schema' || cfg.schemaMode === 'json_object' ? cfg.schemaMode : p.schemaMode,
    needsKey: p.needsKey,
  };
}

/** Body for POST /chat/completions. JSON mode puts the schema in the system prompt. */
export function buildChatRequest({ model, instruction, input, schema, mode = 'json_object' }) {
  let system = instruction;
  if (schema && mode === 'json_schema') system += '\n\nReply with the JSON object only.';
  else if (schema) system += `\n\nReply with one JSON object only (no prose, no code fences). It must match this JSON Schema, with every required key present:\n${JSON.stringify(schema)}`;
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: input || '' }], stream: false };
  if (schema) body.response_format = mode === 'json_schema' ? { type: 'json_schema', json_schema: { name: 'pilotage_result', strict: true, schema } } : { type: 'json_object' };
  return body;
}

function apiErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error ?? j;
    return String(typeof e === 'string' ? e : e.message || e.msg || JSON.stringify(e));
  } catch {
    return String(text || '').slice(0, 300);
  }
}

async function callOpenAICompatible({ instruction, input, schema, cfg, timeout }) {
  const ep = resolveEndpoint(cfg);
  if (!/^https?:\/\//.test(ep.baseUrl)) return { ok: false, error: 'No API base URL configured', ms: 0, notSent: true };
  if (!ep.model) return { ok: false, error: 'No model configured', ms: 0, notSent: true };
  const key = getProviderKey(ep.preset);
  if (ep.needsKey && !key) return { ok: false, error: `No API key saved for ${ep.label}`, ms: 0, notSent: true };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (ep.preset === 'openrouter') headers['X-Title'] = 'Pilotage';
  const t0 = Date.now();
  let mode = schema ? ep.schemaMode : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    let text;
    try {
      res = await fetch(`${ep.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(buildChatRequest({ model: ep.model, instruction, input, schema, mode })), signal: AbortSignal.timeout(timeout) });
      text = await res.text();
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? `timed out after ${Math.round(timeout / 1000)}s` : e?.cause?.code || e?.message || 'network error';
      return { ok: false, error: clip(redact(`Request to ${ep.label} failed: ${why}`), 300), ms: Date.now() - t0 };
    }
    const ms = Date.now() - t0;
    if (!res.ok) {
      const msg = apiErrorMessage(text);
      if (attempt === 0 && mode === 'json_schema' && res.status === 400 && /response_format|json_schema|schema|structured/i.test(msg)) {
        mode = 'json_object'; // model without structured outputs: fall back to JSON mode
        continue;
      }
      const hint = res.status === 401 || res.status === 403 ? ' (API key rejected)' : res.status === 402 ? ' (out of credit)' : res.status === 429 ? ' (rate limited)' : '';
      return { ok: false, error: clip(redact(`HTTP ${res.status}${hint}: ${msg}`), 400), ms, apiStatus: res.status };
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return { ok: false, error: 'API reply was not JSON', ms };
    }
    const choice = j.choices?.[0];
    const content = choice?.message?.content ?? '';
    const model = j.model || ep.model;
    if (!schema) return { ok: true, data: String(content), ms, cost: 0, model, usage: j.usage || null };
    const data = parseJSONLoose(content);
    if (!data) return { ok: false, error: choice?.finish_reason === 'length' ? 'Reply was cut off (token limit)' : 'Reply was not valid JSON', ms };
    return { ok: true, data, ms, cost: 0, model, usage: j.usage || null };
  }
  return { ok: false, error: 'unreachable', ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- entry point

/**
 * One structured AI call with the configured provider.
 * purpose: 'digest' | 'brief' | 'daily' | 'cv' | 'scout' | 'test' (picks the per-purpose Claude model).
 * Returns {ok, data, error, ms, cost, model, provider}.
 */
export async function callAI({ instruction, input = '', schema = null, model, effort = 'low', timeout = 240000, purpose = 'digest', provider } = {}) {
  const s = aiSettings();
  const id = PROVIDER_IDS.includes(provider) ? provider : currentProvider(s);
  const cfg = providerConfig(id, s);
  // Every AI call passes here, so this is where PILOTAGE_NO_AI=1 ("never call an AI provider") holds for all of them,
  // the Settings → AI → Test button included (demo worlds and experiments must not use the user's account).
  if (process.env.PILOTAGE_NO_AI === '1') return { ok: false, error: 'AI is off for this server (PILOTAGE_NO_AI=1)', ms: 0, provider: id, notSent: true };
  const cap = capStatus(id);
  if (!cap.ok) return { ok: false, error: cap.reason, ms: 0, provider: id, capped: true };
  // The one choke point for every job: inputs also carry CLAUDE.md and memory files, READMEs, commit messages, notes
  // and ideas, which were never redacted (only transcripts are, at indexing). Mask secrets before anything leaves.
  if (typeof input === 'string') input = redact(input);
  if (typeof instruction === 'string') instruction = redact(instruction); // templates today; cheap insurance
  let r;
  try {
    if (id === 'codex-cli') r = await callCodex({ instruction, input, schema, model: cfg.model || '', effort, timeout });
    else if (id === 'openai-compatible') r = await callOpenAICompatible({ instruction, input, schema, cfg, timeout });
    else {
      const m = cfg[PURPOSE_MODEL[purpose]] || model || 'haiku';
      r = await callClaude({ instruction, input, schema, model: m, effort, timeout, configDir: cfg.configDir || '' });
    }
  } catch (e) {
    r = { ok: false, error: clip(redact(String(e?.message || e)), 400), ms: 0 };
  }
  if (!r.notSent) countCall(id); // configuration errors (no key, no CLI) don't use up the daily cap
  if (r.ok && schema && id !== 'claude-cli') {
    const { data, errors } = conformToSchema(schema, r.data);
    if (errors.length) return { ok: false, error: clip(`Reply did not match the schema: ${errors.slice(0, 6).join('; ')}`, 400), ms: r.ms, model: r.model, provider: id };
    r = { ...r, data };
  }
  return { ...r, provider: id };
}

export const TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
  required: ['ok', 'word'],
};

/** One tiny structured call, for Settings → AI → Test. */
export async function testProvider(id) {
  const r = await callAI({ provider: id, instruction: 'Connectivity test. Reply with ok set to true and word set to "pong".', input: 'ping', schema: TEST_SCHEMA, model: 'haiku', effort: 'low', timeout: 120000, purpose: 'test' });
  const good = r.ok && r.data?.ok === true;
  return { ok: good, provider: r.provider, model: r.model || null, ms: r.ms || 0, error: good ? null : r.error || 'Unexpected reply', reply: r.ok ? r.data : null };
}

/** Installed CLIs (path) for the provider list. */
export function providerBins() {
  const claude = path.isAbsolute(CLAUDE_BIN) && fs.existsSync(CLAUDE_BIN) ? CLAUDE_BIN : findBin('claude');
  return { 'claude-cli': claude, 'codex-cli': findBin('codex'), 'openai-compatible': null };
}

export { CLAUDE_MODELS };
