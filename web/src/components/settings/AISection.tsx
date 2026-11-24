// Settings → AI: background activity, provider (Claude Code CLI / Codex CLI / OpenAI-compatible API), models and limits.
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, CircleAlert, CircleCheck, Cloud, ExternalLink, FlaskConical, Gauge, KeyRound, Pause, Play, Rocket, Sparkles, SquareTerminal, TriangleAlert } from 'lucide-react';
import { api, useAI, useInvalidate } from '../../api';
import { useProviders } from '../../api-extra';
import type { Settings as SettingsT } from '../../types';
import type { Preset, PresetId, ProviderId, ProviderInfo, ProvidersPatch, ProvidersResponse, ProviderTest } from '../../types-extra';
import { Button, Callout, Disclosure, ErrorBox, LoadingCard, Meter, SegmentedControl, Skeleton, Spinner, StatTile, StatusIcon, Switch, USAGE_LABELS, useToast } from '../ui';
import { aiHold, ago, fmtDateTime, fmtTime, plural, type AiHold } from '../../util';
import { NumberInput, PatchFn, PcOnly, SettingRow, SettingRows, SettingsCard, cap, errMsg, fmtCost, friendlyAiError, jobLabel, jobPhrase, untilText, useNow, useViaLan } from './common';

/** The status title while the guard holds AI work back, by what holds it (util.ts aiHold). */
const HOLD_TITLE: Record<AiHold, string> = {
  provider: 'AI provider problem',
  error: 'Paused after an error',
  cap: 'Paused at your AI call limit',
  usage: 'Waiting for room in your usage',
};

const CLAUDE_MODELS = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
];

const PROVIDER_ICON: Record<ProviderId, React.ReactNode> = {
  'claude-cli': <Sparkles size={17} />,
  'codex-cli': <SquareTerminal size={17} />,
  'openai-compatible': <Cloud size={17} />,
};
const PROVIDER_NAME: Record<ProviderId, string> = {
  'claude-cli': 'Claude Code CLI',
  'codex-cli': 'Codex CLI',
  'openai-compatible': 'OpenAI-compatible API',
};

/** PATCH /api/providers and keep the cache in sync. */
function usePatchProviders() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  const toast = useToast();
  return async (body: ProvidersPatch, okMsg: string | null = 'Saved'): Promise<ProvidersResponse | null> => {
    try {
      const r = await api<ProvidersResponse>('/api/providers', { method: 'PATCH', body });
      qc.setQueryData(['providers'], r);
      inv('settings', 'bootstrap', 'ai');
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(`Couldn't save: ${errMsg(e)}`, true);
      inv('providers');
      return null;
    }
  };
}

export function useAiSummary(s: SettingsT | undefined) {
  const { data: ai } = useAI();
  const { data: pv } = useProviders();
  if (!s) return '';
  const name = pv ? PROVIDER_NAME[pv.provider] : '';
  const state = !s.ai.enabled ? 'Off' : !ai ? '' : ai.pausedByUser ? 'Paused' : !ai.guard.ok ? (aiHold(ai.guard.reason) === 'provider' ? 'Provider problem' : 'Waiting') : ai.running.length ? 'Working' : 'Up to date';
  return [name, state].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- section
export function AISection({ s, patch }: { s: SettingsT; patch: PatchFn }) {
  return (
    <>
      <ActivityCard s={s} />
      <ProviderCard s={s} patch={patch} />
      <AutomationCard s={s} patch={patch} />
    </>
  );
}

// ---------------------------------------------------------------- activity
function ActivityCard({ s }: { s: SettingsT }) {
  const { data: ai, error } = useAI();
  const inv = useInvalidate();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(30_000);
  const on = s.ai.enabled;

  const post = async (key: string, path: string, body: unknown, ok: string) => {
    setBusy(key);
    try {
      await api(path, { method: 'POST', body });
      toast(ok);
      inv('ai', 'overview', 'bootstrap');
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(null);
    }
  };

  let status: { glyph: string; title: string; sub?: string };
  if (!on) status = { glyph: 'idle', title: 'AI is off', sub: 'Turn it on below to get summaries, today’s plan, suggested tasks and CV entries.' };
  else if (!ai) status = { glyph: 'queued', title: 'Checking…' };
  else if (ai.pausedByUser) status = { glyph: 'paused', title: 'Paused by you', sub: 'Nothing runs in the background until you resume.' };
  else if (ai.running.length) status = { glyph: 'working', title: `Working on ${plural(ai.running.length, 'job')}`, sub: ai.queueLength ? `${ai.queueLength} more waiting` : undefined };
  else if (!ai.guard.ok) {
    const hold = aiHold(ai.guard.reason);
    // A provider problem keeps its detail ("Claude is logged out…"); the title already says what kind it is.
    const why = (ai.guard.reason || 'Usage limit reached').replace(/^AI provider problem:\s*/, '').replace(/[.\s]+$/, '');
    const again = ai.guard.until && ai.guard.until > now ? untilText(ai.guard.until, now) : '';
    status = {
      glyph: 'blocked',
      title: HOLD_TITLE[hold],
      sub:
        hold === 'provider'
          ? `${why}. Pilotage tries again ${again || 'later'}, or as soon as you change the provider below.`
          : `${why}.${again ? ` Picks up again ${again}.` : ''}`,
    };
  }
  else if (ai.queueLength || ai.pendingBlocks) status = { glyph: 'in_progress', title: `${ai.queueLength || ai.pendingBlocks} waiting`, sub: 'Summaries are written a few at a time.' };
  else status = { glyph: 'done', title: 'Up to date', sub: ai.stats.lastRunAt ? `Last run ${ago(ai.stats.lastRunAt)}` : undefined };

  const st = ai?.stats;
  const lastErr = st?.lastError && now - st.lastError.at < 3 * 86400e3 ? st.lastError : null;

  return (
    <SettingsCard title="Background AI" icon={<Bot />} description="Pilotage summarizes your sessions and projects in the background with the provider below.">
      {error ? (
        <ErrorBox error={error} />
      ) : !ai ? (
        <div className="stack" aria-busy="true">
          <Skeleton h={20} w="40%" />
          <Skeleton h={48} />
        </div>
      ) : (
        <div className="stack-lg">
          <div className="ai-status">
            <StatusIcon status={status.glyph} size={18} />
            <div className="grow">
              <div className="ai-status-title">{status.title}</div>
              {status.sub && <div className="small muted">{status.sub}</div>}
            </div>
            {on && (
              <div className="cluster ai-status-actions">
                <Button
                  size="sm"
                  icon={ai.pausedByUser ? <Play /> : <Pause />}
                  loading={busy === 'pause'}
                  onClick={() => post('pause', '/api/ai/pause', { paused: !ai.pausedByUser }, ai.pausedByUser ? 'AI work resumed' : 'AI work paused')}
                >
                  {ai.pausedByUser ? 'Resume' : 'Pause'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Rocket />}
                  loading={busy === 'all'}
                  onClick={() => post('all', '/api/ai/run', { scope: 'all' }, 'Catching up now')}
                  title={`Summarize pending work from the last ${s.ai.backfillDays ?? 30} days now (older work: Summarize now on its project)`}
                >
                  Run now
                </Button>
                <Button size="sm" variant="ghost" icon={<Sparkles />} loading={busy === 'daily'} onClick={() => post('daily', '/api/ai/run', { scope: 'daily' }, 'Writing today’s plan…')}>
                  Write today’s plan
                </Button>
              </div>
            )}
          </div>

          {st && (
            <div className="ai-stats">
              <StatTile
                bare
                size="sm"
                label="Summaries"
                value={<span className="num">{ai.digested.toLocaleString('en-GB')}</span>}
                hint={ai.pendingBlocks ? `${ai.pendingBlocks} waiting` : 'none waiting'}
              />
              <StatTile bare size="sm" label="Project summaries" value={<span className="num">{ai.briefs}</span>} hint={ai.daily ? `today’s plan ${fmtTime(ai.daily.at)}` : 'no plan for today yet'} />
              <StatTile bare size="sm" label="AI calls" value={<span className="num">{st.calls.toLocaleString('en-GB')}</span>} hint={st.errors ? `${st.errors} failed` : 'none failed'} />
              <StatTile bare size="sm" label="Cost" value={<span className="num">{fmtCost(st.cost)}</span>} hint="≈ API-price equivalent" />
            </div>
          )}

          {(ai.running.length > 0 || ai.queue.length > 0) && (
            <div className="ai-queue">
              {ai.running.map((j) => (
                <div key={j.id} className="mini-row">
                  <Spinner size={14} />
                  <span className="grow truncate">{jobLabel(j.kind, j.label)}</span>
                  <span className="tiny faint num" title={fmtDateTime(j.startedAt)}>
                    {ago(j.startedAt)}
                  </span>
                </div>
              ))}
              {ai.queue.slice(0, 4).map((j) => (
                <div key={j.id} className="mini-row">
                  <StatusIcon status="queued" />
                  <span className="grow truncate muted">{jobLabel(j.kind, j.label)}</span>
                  <span className="tiny faint">next</span>
                </div>
              ))}
              {ai.queueLength > 4 && <div className="tiny faint ai-more">and {plural(ai.queueLength - 4, 'more job')}</div>}
            </div>
          )}

          {lastErr && (
            <Callout tone="neutral" icon={<CircleAlert />} title={friendlyAiError(lastErr.msg)}>
              <span title={fmtDateTime(lastErr.at)}>
                Last seen {ago(lastErr.at)}
                {jobPhrase(lastErr.job) ? ` while writing ${jobPhrase(lastErr.job)}` : ''}.
              </span>
            </Callout>
          )}
        </div>
      )}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- provider
function ProviderCard({ s, patch }: { s: SettingsT; patch: PatchFn }) {
  const { data: pv, error, isLoading } = useProviders();
  const patchP = usePatchProviders();
  const [saving, setSaving] = useState<ProviderId | null>(null);
  const viaLan = useViaLan();
  const choose = async (id: ProviderId) => {
    if (!pv || id === pv.provider) return;
    setSaving(id);
    await patchP({ provider: id }, `AI now uses ${PROVIDER_NAME[id]}`);
    setSaving(null);
  };
  return (
    <SettingsCard title="Provider" icon={<Sparkles />} description="Who writes the summaries. Switching doesn't redo existing ones; new work uses the new provider." actions={viaLan ? <PcOnly text="Change on the PC" /> : null}>
      {error ? (
        <ErrorBox error={error} />
      ) : isLoading || !pv ? (
        <LoadingCard lines={2} />
      ) : (
        <div className="stack-lg">
          {/* Provider, its address and key, the account folder and Test are PC-only (server LOCAL_ONLY); the model
              choices are plain settings and stay usable on the phone. */}
          <fieldset className="bare-fieldset" disabled={viaLan}>
            <div className="provider-grid" role="radiogroup" aria-label="AI provider">
              {pv.providers.map((p) => (
                <ProviderChoice key={p.id} p={p} on={pv.provider === p.id} cap={pv.dailyCallCap} busy={saving === p.id} onPick={() => choose(p.id)} />
              ))}
            </div>
          </fieldset>
          <div className="provider-config">
            {pv.provider === 'claude-cli' && <ClaudeConfig s={s} patch={patch} pv={pv} pcOnly={viaLan} />}
            {pv.provider === 'codex-cli' && (
              <fieldset className="bare-fieldset" disabled={viaLan}>
                <CodexConfig pv={pv} />
              </fieldset>
            )}
            {pv.provider === 'openai-compatible' && (
              <fieldset className="bare-fieldset" disabled={viaLan}>
                <ApiConfig pv={pv} />
              </fieldset>
            )}
            <fieldset className="bare-fieldset" disabled={viaLan}>
              <TestRow provider={pv.provider} />
            </fieldset>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

function ProviderChoice({ p, on, cap: dailyCap, busy, onPick }: { p: ProviderInfo; on: boolean; cap: number; busy: boolean; onPick: () => void }) {
  const usage = p.usageGuard ? 'Uses your Claude 5-hour limit' : `${plural(p.callsToday, 'call')} today${dailyCap ? ` of ${dailyCap}` : ''}`;
  const sub = !p.installed ? 'Not installed on this PC' : p.kind === 'api' ? 'Pay per call with an API key' : p.version ? p.version.replace(/\s*\(.*\)$/, '') : 'Installed';
  return (
    <button type="button" role="radio" aria-checked={on} className={`choice provider-choice${on ? ' on' : ''}`} disabled={!p.installed || busy} onClick={onPick}>
      <span className="choice-icon">{busy ? <Spinner size={17} /> : PROVIDER_ICON[p.id]}</span>
      <span className="choice-title">{PROVIDER_NAME[p.id] || p.label}</span>
      <span className="choice-hint">
        <span className="block">{sub}</span>
        <span className="block">{p.installed ? usage : ''}</span>
        {!p.cap.ok && <span className="block tone-amber">{p.cap.reason || 'Daily cap reached'}</span>}
      </span>
    </button>
  );
}

function ModelSeg({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  const opts = CLAUDE_MODELS.some((o) => o.value === value) ? CLAUDE_MODELS : [...CLAUDE_MODELS, { value, label: cap(value) }];
  return <SegmentedControl size="sm" label={label} value={value} options={opts} onChange={onChange} />;
}

function ClaudeConfig({ s, patch, pv, pcOnly }: { s: SettingsT; patch: PatchFn; pv: ProvidersResponse; pcOnly: boolean }) {
  const patchP = usePatchProviders();
  const a = s.ai;
  const setAi = (p: Partial<SettingsT['ai']>, msg: string) => patch({ settings: { ai: p } }, msg);
  return (
    <SettingRows>
      <SettingRow label="Session summaries" hint="A short summary of each stretch of work in a session. Haiku is quick and light on usage.">
        <ModelSeg value={a.digestModel} label="Model for session summaries" onChange={(v) => setAi({ digestModel: v }, `Summaries: ${cap(v)}`)} />
      </SettingRow>
      <SettingRow label="Project summaries and today’s plan" hint="Where each project stands, and the plan for your day.">
        <ModelSeg value={a.briefModel} label="Model for project summaries and today’s plan" onChange={(v) => setAi({ briefModel: v }, `Summaries and plan: ${cap(v)}`)} />
      </SettingRow>
      <SettingRow label="CV entries" hint="Portfolio text. Sonnet writes better prose.">
        <ModelSeg value={a.cvModel} label="Model for CV entries" onChange={(v) => setAi({ cvModel: v }, `CV entries: ${cap(v)}`)} />
      </SettingRow>
      <div className="srow-extra">
        <Disclosure summary="Use another Claude account">
          <fieldset className="stack bare-fieldset" disabled={pcOnly}>
            <TextSetting
              id="claude-config-dir"
              label="Claude account folder"
              hint="Leave empty for your default account. For a second account, its config folder, e.g. ~/.claude-work (WSL path)."
              value={pv.config['claude-cli'].configDir}
              placeholder="/home/you/.claude-work"
              mono
              onCommit={(v) => patchP({ providers: { 'claude-cli': { configDir: v } } }, v ? 'Claude account folder saved' : 'Using your default Claude account')}
            />
          </fieldset>
        </Disclosure>
      </div>
    </SettingRows>
  );
}

function CodexConfig({ pv }: { pv: ProvidersResponse }) {
  const patchP = usePatchProviders();
  return (
    <SettingRows>
      <TextSetting
        id="codex-model"
        label="Model"
        hint="Uses your ChatGPT plan through “codex login”. Each call leaves a small file in ~/.codex/sessions, which Pilotage ignores."
        value={pv.config['codex-cli'].model}
        placeholder="Default from ~/.codex/config.toml"
        mono
        onCommit={(v) => patchP({ providers: { 'codex-cli': { model: v } } }, v ? `Codex model: ${v}` : 'Using the Codex default model')}
      />
    </SettingRows>
  );
}

function ApiConfig({ pv }: { pv: ProvidersResponse }) {
  const patchP = usePatchProviders();
  const cfg = pv.config['openai-compatible'];
  const eff = pv.effective['openai-compatible'];
  const preset = pv.presets.find((p) => p.id === cfg.preset) || pv.presets[0];
  const custom = preset?.id === 'custom';
  return (
    <SettingRows>
      <SettingRow label="Service" htmlFor="api-preset" hint={custom ? 'Any service with an OpenAI-style /chat/completions endpoint.' : `Endpoint ${eff.baseUrl}`}>
        <select
          id="api-preset"
          className="select api-select"
          value={cfg.preset}
          onChange={(e) => {
            const id = e.target.value as PresetId;
            const label = pv.presets.find((p) => p.id === id)?.label || id;
            patchP({ providers: { 'openai-compatible': { preset: id, baseUrl: '', model: '' } } }, `Service: ${label}`);
          }}
        >
          {pv.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingRow>
      {custom && (
        <TextSetting
          id="api-base"
          label="Base URL"
          hint="https:// anywhere. Plain http:// only for this PC or your home network (Ollama, LM Studio)."
          value={cfg.baseUrl}
          placeholder="https://api.example.com/v1"
          mono
          onCommit={(v) => patchP({ providers: { 'openai-compatible': { baseUrl: v } } }, 'Base URL saved')}
        />
      )}
      <TextSetting
        id="api-model"
        label="Model"
        hint={preset?.model ? `Leave empty for ${preset.model}.` : 'The model name your service expects.'}
        value={cfg.model}
        placeholder={preset?.model || 'model-name'}
        mono
        onCommit={(v) => patchP({ providers: { 'openai-compatible': { model: v } } }, v ? `Model: ${v}` : 'Using the default model')}
      />
      {preset && (preset.needsKey || preset.hasKey || custom) && <ApiKeyRow preset={preset} />}
      {preset?.id === 'ollama' && (
        <div className="srow-extra hint">From WSL, localhost:11434 only reaches a Windows Ollama with WSL mirrored networking. Otherwise pick Custom and use the Windows host address.</div>
      )}
      <div className="srow-extra">
        <Disclosure summary="Advanced">
          <div className="stack">
            {!custom && (
              <TextSetting
                id="api-base-adv"
                label="Base URL override"
                hint={`Leave empty for ${preset?.baseUrl || 'the preset address'}.`}
                value={cfg.baseUrl}
                placeholder={preset?.baseUrl || ''}
                mono
                onCommit={(v) => patchP({ providers: { 'openai-compatible': { baseUrl: v } } }, v ? 'Base URL saved' : 'Using the preset address')}
              />
            )}
            <SettingRow label="Structured output" htmlFor="api-schema" hint="How the service is asked for JSON. Change it only if summaries keep failing.">
              <select
                id="api-schema"
                className="select api-select"
                value={cfg.schemaMode || ''}
                onChange={(e) => patchP({ providers: { 'openai-compatible': { schemaMode: e.target.value as '' | 'json_schema' | 'json_object' } } }, 'Saved')}
              >
                <option value="">Default ({eff.schemaMode === 'json_schema' ? 'JSON schema' : 'JSON object'})</option>
                <option value="json_schema">JSON schema</option>
                <option value="json_object">JSON object</option>
              </select>
            </SettingRow>
          </div>
        </Disclosure>
      </div>
    </SettingRows>
  );
}

/** Write-only key field: shows "•••• last4" when stored; the key itself never comes back from the server. */
function ApiKeyRow({ preset }: { preset: Preset }) {
  const patchP = usePatchProviders();
  const [editing, setEditing] = useState(!preset.hasKey);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEditing(!preset.hasKey);
    setVal('');
  }, [preset.id, preset.hasKey]);
  const save = async () => {
    const k = val.trim();
    if (!k) return;
    setBusy(true);
    const r = await patchP({ apiKey: k, apiKeyPreset: preset.id }, `${preset.label} key saved`);
    setBusy(false);
    setVal('');
    if (r) setEditing(false);
  };
  const remove = async () => {
    if (!window.confirm(`Remove the stored ${preset.label} key?`)) return;
    setBusy(true);
    await patchP({ apiKey: '', apiKeyPreset: preset.id }, `${preset.label} key removed`);
    setBusy(false);
  };
  return (
    <SettingRow
      label="API key"
      htmlFor={editing ? 'api-key' : undefined}
      stack={editing}
      hint={
        <>
          Stored only on this PC and never shown again.
          {preset.keysUrl && (
            <>
              {' '}
              <a className="link" href={preset.keysUrl} target="_blank" rel="noreferrer noopener">
                Get a {preset.label} key <ExternalLink size={11} aria-hidden="true" />
              </a>
            </>
          )}
        </>
      }
    >
      {editing ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            id="api-key"
            className="input mono"
            type="password"
            name="pilotage-api-key"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            value={val}
            placeholder={`Paste your ${preset.label} key`}
            onChange={(e) => setVal(e.target.value)}
          />
          <Button type="submit" icon={<KeyRound />} loading={busy} disabled={!val.trim()}>
            Save key
          </Button>
          {preset.hasKey && (
            <Button variant="ghost" onClick={() => (setEditing(false), setVal(''))}>
              Cancel
            </Button>
          )}
        </form>
      ) : (
        <div className="cluster key-stored">
          <span className="mono small key-mask" aria-label={`Key ending in ${preset.last4}`}>
            •••• {preset.last4}
          </span>
          <Button size="sm" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={remove}>
            Remove
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

function TestRow({ provider }: { provider: ProviderId }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<(ProviderTest & { at: number }) | null>(null);
  const toast = useToast();
  const inv = useInvalidate();
  useEffect(() => setRes(null), [provider]);
  const test = async () => {
    setBusy(true);
    try {
      const r = await api<ProviderTest>('/api/providers/test', { method: 'POST', body: { provider } });
      setRes({ ...r, at: Date.now() });
      inv('providers');
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="test-row">
      <div className="grow stack-sm">
        <div className="srow-label">Check the connection</div>
        {busy ? (
          <div className="small muted row">
            <Spinner size={13} /> Asking for a one-word reply…
          </div>
        ) : res ? (
          res.ok ? (
            <div className="small row tone-green" role="status">
              <CircleCheck size={14} aria-hidden="true" />
              <span>
                Works
                {res.model ? (
                  <>
                    {' '}
                    with <span className="mono">{res.model}</span>
                  </>
                ) : (
                  ''
                )}{' '}
                · <span className="num">{(res.ms / 1000).toFixed(1)} s</span>
              </span>
            </div>
          ) : (
            <div className="small row tone-amber" role="status" title={res.error || undefined}>
              <TriangleAlert size={14} aria-hidden="true" />
              <span>{friendlyAiError(res.error)}</span>
            </div>
          )
        ) : (
          <div className="hint">Makes one tiny call. It counts toward today's calls.</div>
        )}
      </div>
      <Button icon={<FlaskConical />} loading={busy} onClick={test}>
        Test
      </Button>
    </div>
  );
}

/** Text setting that saves on blur / Enter. */
function TextSetting({
  id,
  label,
  hint,
  value,
  placeholder,
  mono = false,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v !== value) onCommit(v);
  };
  return (
    <SettingRow label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        className={`input text-setting${mono ? ' mono' : ''}`}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') setDraft(value);
        }}
      />
    </SettingRow>
  );
}

// ---------------------------------------------------------------- automation & limits
function UsageLine({ label, pct, limit, resetsAt, estimate, now }: { label: string; pct: number; limit: number; resetsAt?: number; estimate?: boolean; now: number }) {
  return (
    <div className="usage-line">
      <div className="spread small">
        <span className="muted">{label}</span>
        <span className="num faint">
          {Math.round(pct)}% used{resetsAt && resetsAt > now ? ` · resets ${fmtTime(resetsAt)}` : ''}
          {estimate ? ' · estimate' : ''}
        </span>
      </div>
      <div className="usage-track">
        <Meter pct={pct} label={`${label}: ${Math.round(pct)}% used`} size="sm" />
        <span className="usage-limit" style={{ left: `${Math.max(0, Math.min(100, limit))}%` }} title={`AI pauses at ${limit}%`} aria-hidden="true" />
      </div>
    </div>
  );
}

function AutomationCard({ s, patch }: { s: SettingsT; patch: PatchFn }) {
  const { data: ai } = useAI();
  const { data: pv } = useProviders();
  const patchP = usePatchProviders();
  const viaLan = useViaLan();
  const now = useNow(60_000);
  const a = s.ai;
  const setAi = (p: Partial<SettingsT['ai']>, msg: string) => patch({ settings: { ai: p } }, msg);
  const claude = !pv || pv.provider === 'claude-cli';
  const usage = ai?.usage;
  return (
    <SettingsCard title="Automation and limits" icon={<Gauge />}>
      <SettingRows>
        <SettingRow label="AI work" hint="Master switch for everything Pilotage asks the AI to do.">
          <Switch on={a.enabled} label="AI work" onChange={(v) => setAi({ enabled: v }, v ? 'AI turned on' : 'AI turned off')} />
        </SettingRow>
        <SettingRow label="Summarize new work automatically" hint="Write a summary as soon as you pause a session for a while.">
          <Switch on={a.autoDigest} label="Summarize new work automatically" onChange={(v) => setAi({ autoDigest: v }, v ? 'Automatic summaries on' : 'Automatic summaries off')} />
        </SettingRow>
        <SettingRow
          label="Summarize automatically: the last"
          htmlFor="ai-window"
          hint="Work older than this is only summarized when you ask (Summarize now on a project). A longer window spends more of your plan the first time."
        >
          <NumberInput id="ai-window" value={a.backfillDays ?? 30} min={1} max={3650} suffix="days" label="Summarize automatically, the last how many days" onCommit={(v) => setAi({ backfillDays: v }, `Summarizes the last ${v} days automatically`)} />
        </SettingRow>
        <SettingRow label="Today’s plan" hint="Each morning the AI proposes up to three things for today on Home. You add them or not.">
          <Switch on={a.dailyBrief} label="Today’s plan" onChange={(v) => setAi({ dailyBrief: v }, v ? 'Today’s plan on' : 'Today’s plan off')} />
        </SettingRow>
        {claude ? (
          <>
            <SettingRow label="Pause above the 5-hour limit" htmlFor="ai-max-five" hint="Background AI work waits when your Claude 5-hour limit passes this.">
              <NumberInput
                id="ai-max-five"
                value={a.maxFiveHourPct}
                min={5}
                max={100}
                suffix="%"
                label="Pause above the 5-hour limit, percent"
                onCommit={(v) => setAi({ maxFiveHourPct: v }, `Pauses above ${v}% of the 5-hour limit`)}
              />
            </SettingRow>
            <SettingRow label="Pause above the weekly limit" htmlFor="ai-max-seven" hint="The same for your weekly limit.">
              <NumberInput
                id="ai-max-seven"
                value={a.maxSevenDayPct}
                min={5}
                max={100}
                suffix="%"
                label="Pause above the weekly limit, percent"
                onCommit={(v) => setAi({ maxSevenDayPct: v }, `Pauses above ${v}% of the weekly limit`)}
              />
            </SettingRow>
            {usage && (usage.five || usage.seven) && (
              <div className="srow-extra usage-lines">
                {usage.five && <UsageLine label={USAGE_LABELS.five} pct={usage.five.pct} limit={a.maxFiveHourPct} resetsAt={usage.five.resetsAt} estimate={usage.five.source === 'estimate'} now={now} />}
                {usage.seven && <UsageLine label={USAGE_LABELS.seven} pct={usage.seven.pct} limit={a.maxSevenDayPct} resetsAt={usage.seven.resetsAt} now={now} />}
              </div>
            )}
          </>
        ) : (
          pv && (
            <SettingRow label="Daily call limit" htmlFor="ai-cap" hint={`For Codex and API providers. Background work stops when it's reached and resets at midnight. 0 means no limit.${viaLan ? ' Change it on the PC.' : ''}`}>
              <fieldset className="bare-fieldset" disabled={viaLan}>
              <NumberInput
                id="ai-cap"
                value={pv.dailyCallCap}
                min={0}
                max={100000}
                width={96}
                suffix="calls"
                label="Daily call limit"
                onCommit={(v) => patchP({ dailyCallCap: v }, v ? `Limit: ${v} calls a day` : 'No daily limit')}
              />
              </fieldset>
            </SettingRow>
          )
        )}
        <SettingRow label="Jobs at once" hint="How many AI jobs may run in parallel.">
          <SegmentedControl
            size="sm"
            label="Jobs at once"
            value={String(a.concurrency || 2)}
            options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))}
            onChange={(v) => setAi({ concurrency: Number(v) }, `${plural(Number(v), 'job')} at once`)}
          />
        </SettingRow>
      </SettingRows>
    </SettingsCard>
  );
}
