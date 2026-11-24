// AI providers + session harnesses (Codex, Gemini, extra Claude accounts). Contract: docs/API-HARNESS.md.
//   GET   /api/providers        providers, installed CLIs + versions, config, key flags (never keys), calls today
//   PATCH /api/providers        config, daily cap, optional API key write/clear (keys → data/secrets.json only)
//   POST  /api/providers/test   one tiny structured call with a provider; latency or error
//   GET   /api/harnesses        session sources: claude / codex / gemini, extra Claude dirs, accounts
//   PATCH /api/harnesses        enable/disable adapters, set settings.sources.extraClaudeDirs
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, WIN_CLAUDE_DIR } from '../config.js';
import { clip } from '../util.js';
import { PROVIDER_IDS, PROVIDERS, PRESETS, SAFE_MODEL, currentProvider, providerConfig, keyInfo, setProviderKey, callsToday, capStatus, testProvider, providerBins, resolveEndpoint } from '../ai/providers.js';
import { findBin, cliVersion } from '../sources/harness/common.js';
import { HARNESSES } from '../launch.js';

const CLAUDE_MODEL_RX = /^(haiku|sonnet|opus|fable|claude-[a-z0-9][\w.-]{0,60})$/;
const KEY_RX = /^[\x21-\x7e]{8,400}$/;

/** Real path through symlinks, else the path as given. */
function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** https anywhere; plain http only for this machine / the LAN (Ollama, LM Studio...). No credentials in the URL. */
export function cleanBaseUrl(s) {
  const v = String(s || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol === 'https:') return v.slice(0, 300);
  if (u.protocol !== 'http:') return null;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const local = h === 'localhost' || h === '::1' || h.endsWith('.local') || h === 'host.docker.internal' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  return local ? v.slice(0, 300) : null;
}

export default function ({ route, ctx }) {
  const { store, json, fail, index, registry, broadcast, log } = ctx;

  async function providersPayload() {
    const s = store.settings.ai || {};
    const bins = providerBins();
    const versions = await Promise.all(PROVIDER_IDS.map((id) => (bins[id] ? cliVersion(bins[id]) : null)));
    const today = callsToday();
    return {
      provider: currentProvider(s),
      providers: PROVIDER_IDS.map((id, i) => ({
        id,
        label: PROVIDERS[id].label,
        kind: PROVIDERS[id].kind,
        description: PROVIDERS[id].description,
        installed: PROVIDERS[id].kind === 'api' ? true : !!bins[id],
        bin: bins[id] || null,
        version: versions[i],
        usageGuard: PROVIDERS[id].usageGuard,
        callsToday: today[id] || 0,
        cap: capStatus(id),
      })),
      config: {
        'claude-cli': { configDir: '', digestModel: '', briefModel: '', cvModel: '', scoutModel: '', ...providerConfig('claude-cli', s) },
        'codex-cli': { model: '', ...providerConfig('codex-cli', s) },
        'openai-compatible': { preset: 'deepseek', baseUrl: '', model: '', ...providerConfig('openai-compatible', s) },
      },
      effective: { 'openai-compatible': (({ preset, baseUrl, model, schemaMode }) => ({ preset, baseUrl, model, schemaMode }))(resolveEndpoint(providerConfig('openai-compatible', s))) },
      claudeDefaults: { digestModel: s.digestModel, briefModel: s.briefModel, cvModel: s.cvModel, scoutModel: s.scoutModel },
      dailyCallCap: Number(s.dailyCallCap) || 0,
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model, schemaMode: p.schemaMode, needsKey: p.needsKey, keysUrl: p.keysUrl, ...keyInfo(id) })),
    };
  }

  route('GET', '/api/providers', async (req, res) => json(res, await providersPayload()));

  route('PATCH', '/api/providers', async (req, res, { body }) => {
    const ai = {};
    if (body.provider !== undefined) {
      if (!PROVIDER_IDS.includes(body.provider)) return fail(res, 400, 'Unknown provider');
      ai.provider = body.provider;
    }
    const p = body.providers && typeof body.providers === 'object' ? body.providers : {};
    const out = {};
    if (p['claude-cli'] && typeof p['claude-cli'] === 'object') {
      const c = p['claude-cli'];
      const o = {};
      if (c.configDir !== undefined) {
        const d = String(c.configDir || '').trim().replace(/\/+$/, '');
        if (d && (!path.isAbsolute(d) || !isDir(d))) return fail(res, 400, 'Claude config folder must be an existing absolute folder (WSL path)');
        o.configDir = d;
      }
      for (const k of ['digestModel', 'briefModel', 'cvModel', 'scoutModel']) {
        if (c[k] === undefined) continue;
        const m = String(c[k] || '').trim();
        if (m && !CLAUDE_MODEL_RX.test(m)) return fail(res, 400, `Bad Claude model for ${k}`);
        o[k] = m;
      }
      out['claude-cli'] = o;
    }
    if (p['codex-cli'] && typeof p['codex-cli'] === 'object' && p['codex-cli'].model !== undefined) {
      const m = String(p['codex-cli'].model || '').trim();
      if (m && !SAFE_MODEL.test(m)) return fail(res, 400, 'Bad Codex model name');
      out['codex-cli'] = { model: m };
    }
    if (p['openai-compatible'] && typeof p['openai-compatible'] === 'object') {
      const c = p['openai-compatible'];
      const o = {};
      if (c.preset !== undefined) {
        if (!PRESETS[c.preset]) return fail(res, 400, 'Unknown preset');
        o.preset = c.preset;
      }
      if (c.baseUrl !== undefined) {
        const u = cleanBaseUrl(c.baseUrl);
        if (u === null) return fail(res, 400, 'Base URL must be https:// (plain http only for localhost / LAN), without credentials or query');
        o.baseUrl = u;
      }
      if (c.model !== undefined) {
        const m = String(c.model || '').trim();
        if (m && !SAFE_MODEL.test(m)) return fail(res, 400, 'Bad model name');
        o.model = m;
      }
      if (c.schemaMode !== undefined) {
        if (!['', 'json_schema', 'json_object'].includes(c.schemaMode)) return fail(res, 400, 'schemaMode must be json_schema or json_object');
        o.schemaMode = c.schemaMode;
      }
      out['openai-compatible'] = o;
    }
    if (Object.keys(out).length) ai.providers = out;
    if (body.dailyCallCap !== undefined) {
      const n = Number(body.dailyCallCap);
      if (!Number.isInteger(n) || n < 0 || n > 100000) return fail(res, 400, 'dailyCallCap must be an integer 0–100000 (0 = no cap)');
      ai.dailyCallCap = n;
    }
    // Key handling: validate before writing anything.
    let keyOp = null;
    if (body.apiKey !== undefined) {
      const preset = body.apiKeyPreset || out['openai-compatible']?.preset || providerConfig('openai-compatible', store.settings.ai).preset || 'deepseek';
      if (!PRESETS[preset]) return fail(res, 400, 'Unknown preset for apiKey');
      const k = body.apiKey == null ? '' : String(body.apiKey).trim();
      if (k && !KEY_RX.test(k)) return fail(res, 400, 'API key looks wrong (8–400 printable characters, no spaces)');
      keyOp = { preset, key: k };
    }
    if (Object.keys(ai).length) store.patchSettings({ ai });
    if (keyOp) setProviderKey(keyOp.preset, keyOp.key);
    broadcast('settings');
    json(res, await providersPayload());
  });

  let testing = false;
  route('POST', '/api/providers/test', async (req, res, { body }) => {
    const id = body.provider === undefined ? currentProvider(store.settings.ai) : body.provider;
    if (!PROVIDER_IDS.includes(id)) return fail(res, 400, 'Unknown provider');
    if (testing) return fail(res, 409, 'A test is already running');
    testing = true;
    try {
      json(res, await testProvider(id));
    } catch (e) {
      json(res, { ok: false, provider: id, model: null, ms: 0, error: clip(e.message, 300), reply: null });
    } finally {
      testing = false;
    }
  });

  // ------------------------------------------------------------ harnesses (session sources)

  async function harnessesPayload() {
    const src = store.settings.sources || {};
    const enabled = src.harnesses || {};
    const sessions = index.list();
    const count = (h) => sessions.filter((m) => (m.harness || 'claude') === h).length;
    const bins = { claude: providerBins()['claude-cli'], codex: findBin('codex'), gemini: findBin('gemini') };
    const versions = await Promise.all(Object.values(bins).map((b) => (b ? cliVersion(b) : null)));
    const adapters = Object.fromEntries((index.adapters || []).map((a) => [a.id, a]));
    const accounts = new Map();
    for (const m of sessions) {
      if ((m.harness || 'claude') !== 'claude' || !m.accountUuid) continue;
      const k = String(m.accountUuid).slice(0, 8);
      const a = accounts.get(k) || { account: k, sessions: 0, lastAt: 0, sources: [] };
      a.sessions++;
      a.lastAt = Math.max(a.lastAt, m.lastAt || 0);
      if (!a.sources.includes(m.source)) a.sources.push(m.source);
      accounts.set(k, a);
    }
    const claudeDirs = (index.allSources ? index.allSources() : []).map((s) => ({ id: s.id, dir: s.dir, extra: !!s.extra, exists: isDir(path.join(s.dir, 'projects')) }));
    return {
      harnesses: Object.keys(HARNESSES).map((id, i) => ({
        id,
        label: HARNESSES[id],
        installed: !!bins[id],
        bin: bins[id] || null,
        version: versions[i],
        dataDir: id === 'claude' ? CLAUDE_DIR : adapters[id]?.dir || null,
        dataFound: id === 'claude' ? true : !!adapters[id]?.dir && isDir(adapters[id].dir),
        enabled: id === 'claude' ? true : enabled[id] !== false,
        sessions: count(id),
        live: id === 'claude',
        launch: { terminal: !!bins[id], background: id === 'claude', resume: id !== 'gemini', fork: id === 'claude' },
      })),
      claudeDirs,
      extraClaudeDirs: src.extraClaudeDirs || [],
      accounts: [...accounts.values()].sort((a, b) => b.lastAt - a.lastAt),
    };
  }

  const rescan = () =>
    index
      .scan()
      .then(async (c) => {
        if (c.length) {
          await registry.rebuild();
          broadcast('sessions');
        }
      })
      .catch((e) => log.warn('harness rescan', e.message));

  route('GET', '/api/harnesses', async (req, res) => json(res, await harnessesPayload()));

  route('PATCH', '/api/harnesses', async (req, res, { body }) => {
    const sources = {};
    if (body.extraClaudeDirs !== undefined) {
      if (!Array.isArray(body.extraClaudeDirs)) return fail(res, 400, 'extraClaudeDirs must be a list of folders');
      const dirs = [];
      for (const raw of body.extraClaudeDirs.slice(0, 10)) {
        const d = String(raw || '').trim().replace(/\/+$/, '');
        if (!d) continue;
        if (!path.isAbsolute(d)) return fail(res, 400, `Not an absolute WSL path: ${clip(d, 120)}`);
        // Compared by real path: a link to ~/.claude (or to another extra dir) would index every transcript twice.
        const real = realOr(d);
        if ([CLAUDE_DIR, WIN_CLAUDE_DIR].some((x) => x && realOr(x) === real)) return fail(res, 400, `${clip(d, 120)} is already indexed`);
        if (!isDir(path.join(d, 'projects'))) return fail(res, 400, `No projects/ folder in ${clip(d, 120)} (expected a Claude config dir)`);
        if (!dirs.some((x) => realOr(x) === real)) dirs.push(d);
      }
      sources.extraClaudeDirs = dirs;
    }
    if (body.enabled && typeof body.enabled === 'object') {
      const h = {};
      for (const id of ['codex', 'gemini']) if (typeof body.enabled[id] === 'boolean') h[id] = body.enabled[id];
      if (Object.keys(h).length) sources.harnesses = h;
    }
    if (Object.keys(sources).length) {
      store.patchSettings({ sources });
      rescan();
    }
    broadcast('settings'); // other open devices refresh their agent list and filters
    json(res, { ...(await harnessesPayload()), rescanning: Object.keys(sources).length > 0 });
  });
}
