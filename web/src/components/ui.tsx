// Pilotage UI primitives. See docs/DESIGN.md for when to use each one.
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownRight, ArrowUpRight, Check, ChevronRight, Copy, Loader2, X } from 'lucide-react';
import { ago, copy, fmtDateTime, DIGEST_STATUS, wsColor, plainText, splitPath } from '../util';

type CSSVars = React.CSSProperties & Record<`--${string}`, string | number | undefined>;

// ---------- toasts ----------
type ToastT = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- status language ----------
// Two families, two looks, one color per meaning (docs/SIMPLIFY.md §2):
//  1. PROCESS state of a running session (is Claude running right now?) → <LiveStatus>: solid dot + word in a tinted pill.
//       needs you = amber (pulsing) · working = accent (pulsing) · open (idle) = grey. Never green.
//  2. WORK status (AI digest of past work / project lifecycle) → <WorkStatus>: outlined circle glyph + plain text, no fill.
//       in progress / ongoing / active = GREY half-circle · blocked = amber outlined ! · done = muted green check ·
//       dropped/archived = grey slash. Accent is reserved for a session that is working right now: a digest says how
//       the work stood when it was last summarised, which can be a year ago, so it must never look live.
//  red = error, in either family.
export type StatusTone = 'green' | 'accent' | 'amber' | 'red' | 'muted' | 'faint' | 'done';
type Shape = 'dot' | 'pulse' | 'half' | 'check' | 'alert' | 'alert-ring' | 'slash' | 'ring' | 'dashed' | 'pause' | 'x';
export const STATUS: Record<string, { label: string; tone: StatusTone; shape: Shape }> = {
  working: { label: 'Working', tone: 'accent', shape: 'pulse' },
  running: { label: 'Running', tone: 'accent', shape: 'pulse' },
  live: { label: 'Running', tone: 'muted', shape: 'dot' },
  idle_live: { label: 'Open', tone: 'muted', shape: 'dot' },
  open: { label: 'Open', tone: 'muted', shape: 'dot' },
  'needs-you': { label: 'Needs you', tone: 'amber', shape: 'pulse' },
  in_progress: { label: 'In progress', tone: 'muted', shape: 'half' },
  ongoing: { label: 'Ongoing', tone: 'muted', shape: 'half' },
  blocked: { label: 'Blocked', tone: 'amber', shape: 'alert-ring' },
  done: { label: 'Done', tone: 'done', shape: 'check' },
  abandoned: { label: 'Dropped', tone: 'faint', shape: 'slash' },
  active: { label: 'Active', tone: 'muted', shape: 'half' },
  idle: { label: 'Idle', tone: 'muted', shape: 'ring' },
  dormant: { label: 'Dormant', tone: 'faint', shape: 'dashed' },
  paused: { label: 'Paused', tone: 'muted', shape: 'pause' },
  archived: { label: 'Archived', tone: 'faint', shape: 'slash' },
  todo: { label: 'To do', tone: 'muted', shape: 'ring' },
  queued: { label: 'Queued', tone: 'muted', shape: 'dashed' },
  error: { label: 'Error', tone: 'red', shape: 'x' },
};
/** Labels for the two Claude usage meters. Sidebar, More and Settings use the same words (SIMPLIFY.md §2). */
export const USAGE_LABELS = { five: '5-hour limit', seven: 'Weekly limit' } as const;

export const statusInfo = (s: string) => STATUS[s] || { label: s, tone: 'muted' as StatusTone, shape: 'ring' as Shape };

/** Status glyph only (16px; 10–11 as a glyph corner badge, 12–13 inside pills and tags). */
export function StatusIcon({ status, size = 16, title }: { status: string; size?: number; title?: string }) {
  const st = statusInfo(status);
  const knock = { fill: 'none', stroke: 'var(--surface)', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as React.CSSProperties;
  let body: React.ReactNode;
  switch (st.shape) {
    case 'dot':
      body = (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" opacity="0.18" />
          <circle cx="7" cy="7" r="3.5" fill="currentColor" />
        </>
      );
      break;
    case 'pulse':
      body = (
        <>
          <circle className="halo" cx="7" cy="7" r="5.5" fill="currentColor" />
          <circle cx="7" cy="7" r="3.5" fill="currentColor" />
        </>
      );
      break;
    case 'half':
      body = (
        <>
          <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.6a3.4 3.4 0 0 1 0 6.8z" fill="currentColor" />
        </>
      );
      break;
    case 'check':
      body = (
        <>
          <circle cx="7" cy="7" r="6.3" fill="currentColor" />
          <path d="M4.4 7.2l1.8 1.8 3.5-3.7" style={knock} />
        </>
      );
      break;
    case 'alert':
      body = (
        <>
          <circle cx="7" cy="7" r="6.3" fill="currentColor" />
          <path d="M7 4v3.3M7 9.7v.1" style={{ ...knock, strokeWidth: 1.8 }} />
        </>
      );
      break;
    case 'alert-ring':
      body = (
        <>
          <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 4.3v3.1M7 9.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
      break;
    case 'x':
      body = (
        <>
          <circle cx="7" cy="7" r="6.3" fill="currentColor" />
          <path d="M5 5l4 4M9 5l-4 4" style={knock} />
        </>
      );
      break;
    case 'slash':
      body = (
        <>
          <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4.6 9.4l4.8-4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
      break;
    case 'dashed':
      body = <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" />;
      break;
    case 'pause':
      body = (
        <>
          <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.8 5.2v3.6M8.2 5.2v3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
      break;
    default:
      body = <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />;
  }
  return (
    <svg className={`sicon t-${st.tone}`} width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={title || st.label}>
      <title>{title || st.label}</title>
      {body}
    </svg>
  );
}

/** PROCESS state of a running session: dot + word in a tinted pill. `state`: needs-you (amber) | working (accent) | idle_live / open (grey) | live (grey, state unknown). */
export function LiveStatus({ state, label, size = 'md' }: { state: string; label?: React.ReactNode; size?: 'sm' | 'md' }) {
  return <StatusPill status={state} label={label} size={size} />;
}

/** WORK status (digest / project lifecycle): outlined glyph + plain text, no background. */
export function WorkStatus({ status, label, iconOnly = false }: { status: string; label?: React.ReactNode; iconOnly?: boolean }) {
  const st = statusInfo(status);
  if (iconOnly) return <StatusIcon status={status} />;
  return (
    <span className={`wstatus t-${st.tone}`}>
      <StatusIcon status={status} size={13} />
      {label ?? st.label}
    </span>
  );
}

/** Glyph + word in a soft tinted pill (generic; prefer LiveStatus / WorkStatus). At most one per card/row. */
export function StatusPill({ status, label, size = 'md', bare = false, title }: { status: string; label?: React.ReactNode; size?: 'sm' | 'md'; bare?: boolean; title?: string }) {
  const st = statusInfo(status);
  return (
    <span className={`status t-${st.tone}${size === 'sm' ? ' sm' : ''}${bare ? ' bare' : ''}`} title={title}>
      <StatusIcon status={status} size={size === 'sm' ? 11 : 12} />
      {label ?? st.label}
    </span>
  );
}

// ---------- small bits ----------
export function Badge({ tone = '', children, title }: { tone?: string; children: React.ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ kind = '' }: { kind?: string }) {
  return <span className={`dot ${kind}`} />;
}

export function Time({ t, prefix = '' }: { t: number | null | undefined; prefix?: string }) {
  return (
    <span title={t ? fmtDateTime(t) : ''} className="num">
      {prefix}
      {ago(t)}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Hover hint (desktop only). Prefer a visible label; use this for icon-only controls. */
export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="tip" data-tip={label}>
      {children}
    </span>
  );
}

/** Inline metadata separated by middots: <Meta items={[project, '3 prompts', ago]} />.
 *  `line`: one line, never wraps; the first item shrinks with an ellipsis (automatic inside a ListRow body). */
export function Meta({ items, children, className = '', line = false }: { items?: React.ReactNode[]; children?: React.ReactNode; className?: string; line?: boolean }) {
  const list = (items || React.Children.toArray(children)).filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return (
    <div className={`meta${line ? ' line' : ''} ${className}`}>
      {list.map((x, i) => (
        <span key={i}>{x}</span>
      ))}
    </div>
  );
}

/** One-line plain-text snippet from possibly-Markdown text (AI summaries, prompts). Clamped, never renders markup. */
export function Snippet({ text, lines = 1, className = '', quote = false }: { text: string | null | undefined; lines?: number; className?: string; quote?: boolean }) {
  const t = plainText(text);
  if (!t) return null;
  return (
    <div className={`clamp-${Math.min(4, Math.max(1, lines))} ${className}`} title={t.length > 140 ? undefined : t}>
      {quote ? `“${t}”` : t}
    </div>
  );
}

/** File path shown as name + short folder tail; full path in the tooltip. Use for docs, memory files, worktrees. */
export function PathLabel({ path, mono = false, inline = false }: { path: string; mono?: boolean; inline?: boolean }) {
  const { name, dir, full } = splitPath(path);
  return (
    <span className={`path-label${inline ? ' inline' : ''}${mono ? ' mono' : ''}`} title={full}>
      <span className="pl-name">{name}</span>
      {dir && <span className="pl-dir">{dir}</span>}
    </span>
  );
}

// ---------- identity ----------
function initialOf(name: string) {
  const m = /[\p{L}\p{N}]/u.exec(name || '');
  return m ? m[0].toUpperCase() : '·';
}

/**
 * Tinted initial tile. Color comes from the workspace (ws key) or an explicit color.
 * `status` adds the state as a corner badge (any STATUS key: working, needs-you, open, blocked, done…), so a row can
 * lead with the project's identity and still show its state: <ProjectGlyph name ws size={24} status="working" />.
 * The badge ring takes `--badge-bg` (default `--surface`); set it when the row sits on another background.
 */
export function ProjectGlyph({ name, ws, color, size = 20, solid = false, round = false, title, status, statusTitle }: { name: string; ws?: string | null; color?: string | null; size?: number; solid?: boolean; round?: boolean; title?: string; status?: string | null; statusTitle?: string }) {
  const c = color || (ws ? wsColor(ws) : undefined);
  const style: CSSVars = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.48)), borderRadius: round ? 999 : Math.round(size * 0.3) };
  if (c) style['--ws'] = c;
  const tile = (
    <span className={`glyph${solid ? ' solid' : ''}${round ? ' round' : ''}`} style={style} title={title ?? name} aria-hidden="true">
      {initialOf(name)}
    </span>
  );
  if (!status) return tile;
  return (
    <span className="glyph-wrap">
      {tile}
      <span className="glyph-badge">
        <StatusIcon status={status} size={size >= 28 ? 12 : size >= 20 ? 11 : 9} title={statusTitle} />
      </span>
    </span>
  );
}

/** A number in a small rounded pill (section / card headings, menus). `tone`: amber = needs you, accent = working. */
export function CountPill({ n, tone, title }: { n: React.ReactNode; tone?: 'amber' | 'accent'; title?: string }) {
  return (
    <span className={`count-pill num${tone ? ` ${tone}` : ''}`} title={title}>
      {n}
    </span>
  );
}

/** Workspace identity tile (same shape as ProjectGlyph, keyed by workspace). */
export function WorkspaceAvatar({ ws, name, color, size = 20, solid = false }: { ws: string; name: string; color?: string | null; size?: number; solid?: boolean }) {
  return <ProjectGlyph name={name} ws={ws} color={color} size={size} solid={solid} />;
}

export function AvatarStack({ items, max = 4, size = 20 }: { items: { key?: string; name: string; ws?: string | null; color?: string | null }[]; max?: number; size?: number }) {
  const shown = items.slice(0, max);
  return (
    <span className="avatars">
      {shown.map((it, i) => (
        <ProjectGlyph key={it.key || `${it.name}${i}`} name={it.name} ws={it.ws} color={it.color} size={size} />
      ))}
      {items.length > max && <span className="more">+{items.length - max}</span>}
    </span>
  );
}

// ---------- buttons ----------
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'accent' | 'danger';
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  block = false,
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; icon?: React.ReactNode; iconRight?: React.ReactNode; loading?: boolean; block?: boolean }) {
  const cls = ['btn', variant !== 'secondary' && variant, size !== 'md' && size, block && 'block', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Spinner size={size === 'sm' ? 13 : 15} /> : icon}
      {children}
      {iconRight}
    </button>
  );
}

export function IconButton({ icon, label, size = 'sm', variant = 'ghost', className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode; label: string; size?: 'sm' | 'md'; variant?: BtnVariant }) {
  const cls = ['btn', 'icon', variant !== 'secondary' && variant, size === 'sm' && 'sm', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  );
}

export function CopyButton({ text, label = 'Copy', small = true }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${small ? 'sm' : ''}`}
      onClick={() => {
        copy(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label}
    </button>
  );
}

// ---------- feedback ----------
/** Friendly empty state: icon tile, one-line title, optional body and action. */
export function EmptyState({ icon, title, body, action, compact = false }: { icon?: React.ReactNode; title: React.ReactNode; body?: React.ReactNode; action?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return <EmptyState icon={icon} title={title} body={children} compact={!icon} />;
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

export function LoadingCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card pad stack" style={{ gap: 12 }} aria-busy="true">
      <Skeleton h={18} w="40%" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} h={12} w={`${92 - i * 13}%`} />
      ))}
    </div>
  );
}

export function Callout({ tone = 'info', icon, title, children, action }: { tone?: 'info' | 'warn' | 'danger' | 'ok' | 'neutral'; icon?: React.ReactNode; title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`callout ${tone === 'info' ? '' : tone}`}>
      {icon}
      <div className="grow stack-sm">
        {title && <div className="callout-title">{title}</div>}
        {children && <div className={title ? 'callout-body' : ''}>{children}</div>}
      </div>
      {action && <div className="callout-action">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="callout warn">
      <span>Something went wrong: {msg}</span>
    </div>
  );
}

// ---------- form controls ----------
export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} />;
}

export function SegmentedControl<T extends string>({ value, options, onChange, size = 'md', block = false, label }: { value: T; options: { value: T; label: React.ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; block?: boolean; label?: string }) {
  return (
    <div className={`seg${size === 'sm' ? ' sm' : ''}${block ? ' block' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value} title={o.title} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return <SegmentedControl value={value} options={options} onChange={onChange} />;
}

export function Field({ label, hint, children, htmlFor }: { label?: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items, className = '' }: { value: T; onChange: (v: T) => void; items: { value: T; label: React.ReactNode; count?: number; icon?: React.ReactNode }[]; className?: string }) {
  return (
    <div className={`tabs ${className}`} role="tablist">
      {items.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.icon}
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Toolbar({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`toolbar ${className}`}>{children}</div>;
}
export const ToolbarSpacer = () => <div className="toolbar-spacer" />;

// ---------- text ----------
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`prose ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Clamp long text to N lines with a "Show more" toggle that only appears when it overflows.
 * `fade` clamps by height with a soft fade instead (use for Markdown / multi-paragraph content).
 */
export function ClampText({ children, lines = 3, fade = false, className = '', moreLabel = 'Show more', lessLabel = 'Show less' }: { children: React.ReactNode; lines?: number; fade?: boolean; className?: string; moreLabel?: string; lessLabel?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOver(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [children, lines, open, fade]);
  const style: React.CSSProperties = open
    ? {}
    : fade
      ? { maxHeight: `${lines * 1.6}em`, overflow: 'hidden', ...(over ? { WebkitMaskImage: 'linear-gradient(#000 60%, transparent)', maskImage: 'linear-gradient(#000 60%, transparent)' } : {}) }
      : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
  return (
    <div className="clamp-wrap">
      <div ref={ref} className={className} style={style}>
        {children}
      </div>
      {(over || open) && (
        <button
          type="button"
          className="more-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}

/** Collapsible group (native <details>). Use for tool calls, raw data, secondary sections. */
export function Disclosure({ summary, children, defaultOpen = false, right, className = '' }: { summary: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; right?: React.ReactNode; className?: string }) {
  return (
    <details className={`disclosure ${className}`} open={defaultOpen || undefined}>
      <summary>
        <ChevronRight size={14} className="chev" />
        {summary}
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

// ---------- layout ----------
type Crumb = { label: React.ReactNode; to?: string };
/** Page title block. One per page. Subtitle is one calm sentence, never a list of counts. */
export function PageHeader({ title, subtitle, eyebrow, crumbs, glyph, status, actions, children, className = '' }: { title: React.ReactNode; subtitle?: React.ReactNode; eyebrow?: React.ReactNode; crumbs?: Crumb[]; glyph?: React.ReactNode; status?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <header className={`ph ${className}`}>
      {crumbs && crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight size={13} className="fainter" />}
              {c.to ? <Link to={c.to} className="row" style={{ gap: 6 }}>{c.label}</Link> : <span className="row" style={{ gap: 6 }}>{c.label}</span>}
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="ph-row">
        <div className="ph-main">
          {glyph}
          <div className="ph-text">
            {eyebrow && <div className="ph-eyebrow">{eyebrow}</div>}
            <div className="ph-title-row">
              <h1 className="break">{title}</h1>
              {status}
            </div>
            {subtitle && <div className="ph-sub">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** Surface with optional header. `flush` drops body padding (for lists of ListRow). */
export function Card({ title, icon, count, actions, footer, children, flush = false, pad = true, className = '', style, id }: { title?: React.ReactNode; icon?: React.ReactNode; count?: React.ReactNode; actions?: React.ReactNode; footer?: React.ReactNode; children?: React.ReactNode; flush?: boolean; pad?: boolean; className?: string; style?: React.CSSProperties; id?: string }) {
  if (title === undefined && !footer)
    return (
      <div className={`card${pad && !flush ? ' pad' : ''} ${className}`} style={style} id={id}>
        {children}
      </div>
    );
  return (
    <div className={`card ${className}`} style={style} id={id}>
      {title !== undefined && (
        <div className="card-head">
          <h2>
            {icon}
            <span className="truncate">{title}</span>
            {count !== undefined && <span className="count">{count}</span>}
          </h2>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {flush ? <div className="list" style={title !== undefined ? { marginTop: 6, borderTop: '1px solid var(--border)' } : undefined}>{children}</div> : <div className="card-body">{children}</div>}
      {footer && <div className="card-foot">{footer}</div>}
    </div>
  );
}
export const Panel = Card;

/** A page section: heading (15/650, count pill) + content. Consecutive sections get --section-gap between them.
 *  `countTone`: amber for "needs you", accent for "working"; leave it out for plain counts. */
export function Section({ title, icon, actions, count, countTone, children, className = '', id }: { title: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; count?: React.ReactNode; countTone?: 'amber' | 'accent'; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section className={`section ${className}`} id={id}>
      <div className="section-title">
        <h2>
          {icon}
          {title}
          {count !== undefined && count !== null && <span className={`count num${countTone ? ` ${countTone}` : ''}`}>{count}</span>}
        </h2>
        {actions && <div className="cluster">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The standard row: lead (status icon / glyph) · title + one-line sub · meta · trailing (time).
 * With `to`, the whole row is a link; buttons/links inside `trail`/`actions` stay clickable.
 */
export function ListRow({
  to,
  onClick,
  lead,
  title,
  titleExtra,
  sub,
  subLines = 1,
  meta,
  trail,
  actions,
  dense = false,
  className = '',
  children,
  label,
}: {
  to?: string;
  onClick?: () => void;
  lead?: React.ReactNode;
  title: React.ReactNode;
  titleExtra?: React.ReactNode;
  sub?: React.ReactNode;
  subLines?: number;
  meta?: React.ReactNode;
  trail?: React.ReactNode;
  actions?: React.ReactNode;
  dense?: boolean;
  className?: string;
  children?: React.ReactNode;
  label?: string;
}) {
  const cls = `lrow${dense ? ' dense' : ''}${to || onClick ? ' clickable' : ''} ${className}`;
  return (
    <div className={cls}>
      {to && <Link to={to} className="lrow-link" aria-label={label || (typeof title === 'string' ? title : undefined)} />}
      {!to && onClick && <button type="button" className="lrow-link" onClick={onClick} aria-label={label || (typeof title === 'string' ? title : 'Open')} />}
      {lead && <div className="lrow-lead">{lead}</div>}
      <div className="lrow-body">
        <div className="lrow-title">
          <span className="t">{title}</span>
          {titleExtra}
        </div>
        {sub && <div className={`lrow-sub clamp-${Math.min(4, Math.max(1, subLines))}`}>{sub}</div>}
        {meta}
        {children}
      </div>
      {(trail || actions) && (
        <div className="lrow-trail">
          {actions && <div className="row on-hover" style={{ gap: 4 }}>{actions}</div>}
          {trail}
        </div>
      )}
    </div>
  );
}

// ---------- data display ----------
export function compactNum(n: number) {
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Tiny trend line. Latest point is marked. No axes, ever. */
export function Sparkline({ data, width = 96, height = 28, color = 'var(--accent)', fill = true, dot = true, label }: { data: number[]; width?: number; height?: number; color?: string; fill?: boolean; dot?: boolean; label?: string }) {
  if (!data.length) return null;
  const max = Math.max(...data);
  const min = Math.min(0, ...data);
  const n = data.length;
  const p = 2.5;
  const x = (i: number) => (n === 1 ? width / 2 : p + (i * (width - 2 * p)) / (n - 1));
  const y = (v: number) => p + (height - 2 * p) * (1 - (v - min) / (max - min || 1));
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M${x(0).toFixed(1)},${height} L${pts.join(' L')} L${x(n - 1).toFixed(1)},${height} Z`;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label || 'trend'}>
      {fill && <path d={area} style={{ fill: color, opacity: 0.12 }} />}
      <polyline points={pts.join(' ')} style={{ fill: 'none', stroke: color }} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {dot && <circle cx={x(n - 1)} cy={y(data[n - 1])} r={2.4} style={{ fill: color }} />}
    </svg>
  );
}

/** Mini bar strip (e.g. activity per day). */
export function MiniBars({ data, height = 48, titles }: { data: number[]; height?: number; titles?: string[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="bars" style={{ height }}>
      {data.map((v, i) => (
        <div key={i} className={v ? '' : 'zero'} style={{ height: `${v ? Math.max(8, (v / max) * 100) : 4}%` }} title={titles?.[i] ?? String(v)} />
      ))}
    </div>
  );
}

/** Big number + label (+ delta, sparkline, hint). The number is the hero; keep labels short. */
export function StatTile({ label, value, unit, delta, deltaLabel, invertDelta = false, hint, icon, spark, sparkColor, to, size = 'md', bare = false, className = '' }: { label: React.ReactNode; value: React.ReactNode; unit?: React.ReactNode; delta?: number | null; deltaLabel?: React.ReactNode; invertDelta?: boolean; hint?: React.ReactNode; icon?: React.ReactNode; spark?: number[]; sparkColor?: string; to?: string; size?: 'sm' | 'md'; bare?: boolean; className?: string }) {
  const good = delta == null || delta === 0 ? null : invertDelta ? delta < 0 : delta > 0;
  const inner = (
    <>
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-row">
        <span className="stat-value">{value}</span>
        {unit && <span className="stat-unit">{unit}</span>}
        {delta != null && (
          <span className={`stat-delta${good === null ? '' : good ? ' up' : ' down'}`}>
            {delta > 0 ? <ArrowUpRight size={13} /> : delta < 0 ? <ArrowDownRight size={13} /> : null}
            {deltaLabel ?? `${delta > 0 ? '+' : ''}${delta}`}
          </span>
        )}
      </div>
      {spark && spark.length > 1 && <Sparkline data={spark} width={160} height={30} color={sparkColor} />}
      {hint && <div className="stat-hint">{hint}</div>}
    </>
  );
  const cls = `stat${size === 'sm' ? ' sm' : ''}${bare ? ' bare' : ''} ${className}`;
  return to ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function Meter({ pct, label, tone, size }: { pct: number; label?: string; tone?: 'accent' | 'green' | 'warn' | 'danger' | 'neutral'; size?: 'sm' | 'md' }) {
  const t = tone ? (tone === 'neutral' ? '' : tone) : pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : '';
  return (
    <div className={`meter ${t}${size === 'sm' ? ' sm' : ''}`} title={label} aria-label={label} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
}

/** Meter + value label: <Progress value={3} max={8} /> renders "3/8". */
export function Progress({ value, max = 100, tone = 'accent', label, showValue = true, format }: { value: number; max?: number; tone?: 'accent' | 'green' | 'warn' | 'danger' | 'neutral'; label?: string; showValue?: boolean; format?: (v: number, max: number) => React.ReactNode }) {
  const pct = max ? (value / max) * 100 : 0;
  return (
    <div className="progress">
      <Meter pct={pct} label={label} tone={tone} size="sm" />
      {showValue && <span className="v">{format ? format(value, max) : max === 100 ? `${Math.round(value)}%` : `${value}/${max}`}</span>}
    </div>
  );
}

export function DigestStatus({ status }: { status?: string | null }) {
  if (!status) return null;
  const s = DIGEST_STATUS[status];
  return <WorkStatus status={status} label={s?.label} />;
}

// ---------- board ----------
export function Board({ children }: { children: React.ReactNode }) {
  return <div className="board">{children}</div>;
}
export function BoardColumn({ title, status, count, actions, children, empty = 'Nothing here' }: { title: React.ReactNode; status?: string; count?: number; actions?: React.ReactNode; children?: React.ReactNode; empty?: React.ReactNode }) {
  const has = React.Children.toArray(children).length > 0;
  return (
    <div className="board-col">
      <div className="board-col-head">
        {status && <StatusIcon status={status} />}
        {title}
        {count !== undefined && <span className="count">{count}</span>}
        {actions && <span className="actions">{actions}</span>}
      </div>
      {has ? children : <div className="board-empty">{empty}</div>}
    </div>
  );
}

// ---------- modal ----------
// On phones a modal is a bottom sheet, and Android's back gesture must close it rather than leave the page.
// While any sheet is open we keep ONE extra history entry (same URL, state marked with SHEET_KEY):
//  - back pops that entry → the top sheet closes (a sheet under it gets a fresh entry);
//  - closing with X / backdrop / Esc / drag removes the entry with history.back();
//  - a router navigation from inside a sheet (palette result, "Open session") replaces the entry instead of
//    stacking on top of it, so no dead "same page" step is left behind.
// Sync runs a tick later so StrictMode's mount → unmount → mount and "close one sheet, open another" settle first.
const SHEET_KEY = '__pilotageSheet';
type HistState = Record<string, unknown> | null;
const sheetStack: { id: number; close: () => void }[] = [];
let sheetOwnsEntry = false; // our marked entry is the current history entry
let sheetUnder: { state: HistState; url: string } | null = null; // a router replace() that landed on our entry
let sheetSyncTimer: ReturnType<typeof setTimeout> | null = null;
let sheetSeq = 0;
const origPushState: History['pushState'] = typeof window !== 'undefined' ? window.history.pushState.bind(window.history) : () => {};
const origReplaceState: History['replaceState'] = typeof window !== 'undefined' ? window.history.replaceState.bind(window.history) : () => {};
const phoneSheets = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
const histState = (): HistState => (window.history.state && typeof window.history.state === 'object' ? window.history.state : null);
const onSheetEntry = () => !!histState()?.[SHEET_KEY];

function syncSheetEntry() {
  sheetSyncTimer = null;
  if (sheetStack.length && !sheetOwnsEntry && phoneSheets()) {
    // already on a marked entry (after a reload or a forward step): adopt it instead of stacking another
    if (!onSheetEntry()) origPushState({ ...(histState() || {}), [SHEET_KEY]: 1 }, '');
    sheetOwnsEntry = true;
  } else if (!sheetStack.length && sheetOwnsEntry) {
    sheetOwnsEntry = false;
    if (onSheetEntry()) window.history.back();
  }
}
function scheduleSheetSync() {
  if (sheetSyncTimer) clearTimeout(sheetSyncTimer);
  sheetSyncTimer = setTimeout(syncSheetEntry, 0);
}
if (typeof window !== 'undefined') {
  window.history.pushState = (state: HistState, unused: string, url?: string | URL | null) => {
    if (sheetOwnsEntry && onSheetEntry()) {
      // navigating away from an open sheet: take over its entry
      sheetOwnsEntry = false;
      sheetUnder = null;
      origReplaceState(state, unused, url);
      scheduleSheetSync(); // a sheet that stays open gets a new entry on the new page
      return;
    }
    origPushState(state, unused, url);
  };
  window.history.replaceState = (state: HistState, unused: string, url?: string | URL | null) => {
    if (sheetOwnsEntry && onSheetEntry()) {
      // e.g. a page dropping ?open=<id> as its sheet closes: keep our entry, and fix the page entry under it once we pop
      sheetUnder = { state, url: url == null ? window.location.href : new URL(String(url), window.location.href).href };
      origReplaceState({ ...(state || {}), [SHEET_KEY]: 1 }, unused, url);
      return;
    }
    origReplaceState(state, unused, url);
  };
  // Registered at import, before the router's own listener, so the router reads the fixed-up entry.
  window.addEventListener('popstate', () => {
    if (onSheetEntry()) return; // moved forward onto a sheet entry: nothing is open there, ignore
    if (sheetUnder) {
      const st = histState();
      if ((st?.idx ?? null) === (sheetUnder.state?.idx ?? null)) origReplaceState(sheetUnder.state, '', sheetUnder.url);
      sheetUnder = null;
    }
    if (!sheetOwnsEntry) return;
    sheetOwnsEntry = false;
    sheetStack[sheetStack.length - 1]?.close();
    scheduleSheetSync(); // the sheet below (or one that refused to close) gets its entry back
  });
}

export function Modal({ title, onClose, children, footer, wide = false, className = '' }: { title?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const idRef = useRef(0);
  if (!idRef.current) idRef.current = ++sheetSeq;
  useEffect(() => {
    const id = idRef.current;
    sheetStack.push({ id, close: () => closeRef.current() });
    scheduleSheetSync();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sheetStack[sheetStack.length - 1]?.id === id) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      const at = sheetStack.findIndex((x) => x.id === id);
      if (at >= 0) sheetStack.splice(at, 1);
      scheduleSheetSync();
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  // Drag the grab handle (or the header) down to dismiss the sheet.
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const endDrag = () => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el) return;
    el.style.transition = 'transform var(--dur-2) var(--ease)';
    if (d.dy > 80) {
      el.style.transform = 'translateY(100%)';
      setTimeout(() => {
        closeRef.current();
        if (ref.current) ref.current.style.transform = ''; // still mounted: the owner kept it open
      }, 160);
    } else el.style.transform = '';
  };
  const dragProps = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!phoneSheets() || e.button !== 0 || (e.target as Element).closest('button, a, input, select, textarea, [contenteditable]')) return;
      drag.current = { y: e.clientY, dy: 0 };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el) return;
      d.dy = Math.max(0, e.clientY - d.y);
      el.style.transition = 'none';
      el.style.transform = d.dy ? `translateY(${d.dy}px)` : '';
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };
  // Rendered at the document root so sticky/animated ancestors can't box the overlay in.
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''} ${className}`} ref={ref} role="dialog" aria-modal="true">
        <div className="sheet-grab" aria-hidden="true" {...dragProps} />
        {title !== undefined && (
          <div className="modal-head" {...dragProps}>
            <h2>{title}</h2>
            <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        )}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
