// Shared pieces for the Settings page: setting rows, section shell, the PATCH hook and small formatters.
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleDashed, Monitor, Plus, X } from 'lucide-react';
import { api, useBootstrap, useInvalidate } from '../../api';
import type { Bootstrap, Settings as SettingsT } from '../../types';
import { useToast } from '../ui';

export type SettingsResp = { settings: SettingsT; workspaces: Record<string, { name?: string }> };
export type SettingsPatch = {
  settings?: {
    profile?: { name: string };
    ai?: Partial<SettingsT['ai']>;
    launch?: Partial<SettingsT['launch']>;
    scan?: Partial<SettingsT['scan']>;
    ui?: Partial<SettingsT['ui']>;
  };
  workspaces?: Record<string, { name: string }>;
};
/** okMsg: toast text on success; null = no toast (caller handles it). */
export type PatchFn = (body: SettingsPatch, okMsg?: string | null) => Promise<SettingsResp | null>;

/** GET /api/net as the server sends it today (types.ts lags behind). */
export type NetStatus = {
  addresses: { adapter: string; ip: string; kind: string; mask?: string | null }[];
  forwarder: {
    installed?: boolean;
    running?: boolean;
    port?: number;
    pid?: number | null;
    lastSeen?: number;
    error?: string | null;
    connections?: number;
    refused?: number;
    ssidTrusted?: boolean;
    onWifi?: boolean;
    outdated?: boolean;
  };
  firewallRule: boolean;
  currentSsid?: string | null;
  trustedSsids?: string[];
  vpnCidrs?: string[];
  lanPort: number;
  port: number;
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function useNow(ms: number, on = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

/** True on phone-width layouts (≤ 860px), live. */
export function useIsPhone() {
  const q = '(max-width: 860px)';
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** "in 2 h 10 min" for a future timestamp. */
export function untilText(t: number, now: number) {
  const s = Math.max(0, Math.round((t - now) / 1000));
  if (s < 60) return 'in under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `in ${h} h${mm ? ` ${mm} min` : ''}`;
  const d = Math.round(h / 24);
  return `in ${d} day${d > 1 ? 's' : ''}`;
}

export function fmtCost(n: number | undefined) {
  if (!n) return '$0.00';
  if (n < 0.01) return '< $0.01';
  return `$${n.toFixed(2)}`;
}

/** Turn engine / provider errors into a sentence the user can act on. Never shows raw codes. */
export function friendlyAiError(msg: string | null | undefined): string {
  const m = String(msg || '').trim();
  if (!m) return 'Something went wrong; it will be retried.';
  const low = m.toLowerCase();
  if (/max_structured_output|invalid summary|structured output|json/.test(low)) return 'Some summaries failed and will be retried.';
  if (/rate.?limit|429|too many requests|overloaded|529/.test(low)) return 'The AI service is busy or rate-limiting. Pilotage will try again later.';
  if (/401|403|unauthori[sz]ed|invalid api key|incorrect api key|authentication/.test(low)) return 'The AI service refused the credentials. Check the API key or log in again.';
  if (/timed? ?out|etimedout|timeout/.test(low)) return 'An AI call took too long and will be retried.';
  if (/enoent|not found|command not found|no such file/.test(low)) return 'The AI command could not be found on this PC.';
  if (/econnrefused|enotfound|network|fetch failed|socket/.test(low)) return "Couldn't reach the AI service. Check the address or your connection.";
  if (/cap|daily limit|limit reached/.test(low)) return m.length < 140 ? m : 'The daily call limit was reached. It resets at midnight.';
  if (/^[a-z0-9_.:-]+$/i.test(m) || /^error[_ ]/i.test(m)) return 'Some AI work failed and will be retried.';
  return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}

/** What a queued AI job is, in words. */
export function jobLabel(kind: string, label?: string) {
  const k: Record<string, string> = { block: 'Session summary', brief: 'Project summary', daily: 'Today’s plan', cv: 'CV entry', work: 'Suggested tasks', handoff: 'Project setup', scout: 'Possible projects' };
  const what = k[kind] || cap(kind);
  return label ? `${what} · ${label}` : what;
}

/** "a session summary" etc. for the last-error line. */
export function jobPhrase(job: string | undefined) {
  const k = (job || '').split(':')[0];
  return ({ block: 'a session summary', brief: 'a project summary', daily: "today's plan", cv: 'a CV entry', test: 'a provider test', scout: 'the possible-projects scan' } as Record<string, string>)[k] || null;
}

/** PATCH /api/settings with an optimistic update; sends only the changed sub-object. */
export function usePatchSettings(): PatchFn {
  const qc = useQueryClient();
  const inv = useInvalidate();
  const toast = useToast();
  return async (body, okMsg = 'Saved') => {
    const prev = qc.getQueryData<SettingsResp>(['settings']);
    if (prev && body.settings) {
      const s = body.settings;
      qc.setQueryData<SettingsResp>(['settings'], {
        ...prev,
        settings: {
          ...prev.settings,
          profile: { name: '', ...prev.settings.profile, ...s.profile },
          ai: { ...prev.settings.ai, ...s.ai },
          launch: { ...prev.settings.launch, ...s.launch },
          scan: { ...prev.settings.scan, ...s.scan },
          ui: { ...prev.settings.ui, ...s.ui },
        },
      });
    }
    try {
      const r = await api<SettingsResp>('/api/settings', { method: 'PATCH', body });
      qc.setQueryData<SettingsResp>(['settings'], r);
      // Layout applies data-theme from bootstrap settings: update it right away.
      qc.setQueryData<Bootstrap>(['bootstrap'], (b) => (b ? { ...b, settings: r.settings } : b));
      inv('settings', 'bootstrap', 'ai', 'providers');
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      if (prev) qc.setQueryData(['settings'], prev);
      inv('settings');
      toast(`Couldn't save: ${errMsg(e)}`, true);
      return null;
    }
  };
}

/** True when this browser reaches Pilotage through the phone forwarder (pairing, devices, firewall, keys are PC-only). */
export function useViaLan() {
  const { data } = useBootstrap();
  return !!data?.device.viaLan;
}

// ---------------------------------------------------------------- layout pieces

/** Label + hint on the left, control on the right. Rows are separated by hairlines. */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
  stack = false,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children?: React.ReactNode;
  /** put the control under the label (wide controls: lists, inputs) */
  stack?: boolean;
}) {
  return (
    <div className={`srow${stack ? ' stacked' : ''}`}>
      <div className="srow-text">
        {htmlFor ? (
          <label className="srow-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="srow-label">{label}</div>
        )}
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children !== undefined && <div className="srow-control">{children}</div>}
    </div>
  );
}

export function SettingRows({ children }: { children: React.ReactNode }) {
  return <div className="srows">{children}</div>;
}

/** Card with a title row, optional one-line description and actions. */
export function SettingsCard({
  title,
  icon,
  description,
  actions,
  children,
  flush = false,
  className = '',
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <div className={`card scard ${className}`}>
      <div className="scard-head">
        <div className="scard-titles">
          <h3>
            {icon}
            <span>{title}</span>
          </h3>
          {description && <p className="scard-desc">{description}</p>}
        </div>
        {actions && <div className="scard-actions">{actions}</div>}
      </div>
      <div className={flush ? 'scard-flush' : 'scard-body'}>{children}</div>
    </div>
  );
}

/** Quiet note shown instead of a PC-only control when this browser came in through the phone forwarder. */
export function PcOnly({ text = 'Do this on the PC' }: { text?: string }) {
  return (
    <span className="pc-only" title="Pairing, devices, the firewall, keys and AI providers can only be changed from the PC itself">
      <Monitor size={13} aria-hidden="true" />
      {text}
    </span>
  );
}

/** Checklist line: ✓ ok (green), ! needs you (amber), ○ not applicable (grey). */
export function CheckLine({ state, title, children, action }: { state: 'ok' | 'warn' | 'off'; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  const icon =
    state === 'ok' ? (
      <CircleCheck size={18} className="tone-green" aria-label="OK" />
    ) : state === 'warn' ? (
      <CircleAlert size={18} className="tone-amber" aria-label="Needs attention" />
    ) : (
      <CircleDashed size={18} className="faint" aria-label="Not in use" />
    );
  return (
    <div className="check-line" role="listitem">
      <span className="check-icon">{icon}</span>
      <div className="check-text">
        <div className="check-title">{title}</div>
        {children && <div className="check-sub">{children}</div>}
      </div>
      {action && <div className="check-action">{action}</div>}
    </div>
  );
}

/** Integer input that commits on blur / Enter, clamped to [min, max]. */
export function NumberInput({
  id,
  value,
  min,
  max,
  label,
  suffix,
  onCommit,
  width = 76,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  label: string;
  suffix?: React.ReactNode;
  onCommit: (v: number) => void;
  width?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const c = Math.max(min, Math.min(max, n));
    setDraft(String(c));
    if (c !== value) onCommit(c);
  };
  return (
    <div className="num-input">
      <input
        id={id}
        className="input num"
        style={{ width }}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {suffix && <span className="faint small">{suffix}</span>}
    </div>
  );
}

/** Editable list of absolute paths (add / remove). */
export function PathList({
  id,
  label,
  paths,
  placeholder,
  onSave,
  disabled = false,
  empty = 'None yet.',
}: {
  id: string;
  label: string;
  paths: string[];
  placeholder: string;
  onSave: (next: string[], added: string | null) => Promise<boolean>;
  disabled?: boolean;
  empty?: React.ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const norm = (v: string) => {
    const t = v.trim();
    return t.length > 1 ? t.replace(/\/+$/, '') : t;
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = norm(draft);
    if (!p) return;
    if (!p.startsWith('/')) {
      setErr('Use a full path that starts with “/”.');
      return;
    }
    if (paths.includes(p)) {
      setErr('That path is already in the list.');
      return;
    }
    setErr('');
    setBusy(true);
    const ok = await onSave([...paths, p], p);
    setBusy(false);
    if (ok) setDraft('');
  };
  const remove = async (p: string) => {
    setBusy(true);
    await onSave(
      paths.filter((x) => x !== p),
      null,
    );
    setBusy(false);
  };
  return (
    <div className="path-list">
      {paths.length > 0 ? (
        <ul className="path-items" aria-label={label}>
          {paths.map((p) => (
            <li key={p}>
              <span className="mono small break grow">{p}</span>
              <button type="button" className="btn sm ghost icon" aria-label={`Remove ${p}`} title="Remove" onClick={() => remove(p)} disabled={busy || disabled}>
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="small faint">{empty}</div>
      )}
      <form className="inline-form" onSubmit={add}>
        <input
          id={id}
          className="input mono"
          value={draft}
          placeholder={placeholder}
          aria-label={`Add to ${label.toLowerCase()}`}
          aria-invalid={err ? true : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            if (err) setErr('');
          }}
        />
        <button type="submit" className="btn" disabled={busy || disabled || !draft.trim()}>
          <Plus size={15} />
          Add
        </button>
      </form>
      {err && (
        <div className="small tone-red" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
