// What you can do with a session right now: continue it (live), resume / fork it (not live), or copy the
// resume command (Codex / Gemini). One primary button in the header (a floating pill on the phone); the rest in ⋯.
import React from 'react';
import { Copy, GitFork, Monitor, MoreHorizontal, Play, Smartphone, Square, Terminal } from 'lucide-react';
import { api, useInvalidate, useWsl } from '../../api';
import { useApp } from '../AppContext';
import { IconButton, useToast } from '../ui';
import { Menu, type MenuEntry } from '../project/Menu';
import { copy } from '../../util';
import type { SessionDetail } from '../../types';
import { harnessOf, useMedia } from './shared';

export type SessionAction = {
  key: string;
  label: string;
  /** Shorter label for the phone bar. */
  short?: string;
  icon: React.ReactNode;
  onClick?: () => void;
  href?: string;
  desktopOnly?: boolean;
  danger?: boolean;
  title?: string;
};

export type ActionSet = { primary: SessionAction | null; secondary: SessionAction[]; note: string | null };

export function useSessionActions(s: SessionDetail): ActionSet {
  const { openNewSession } = useApp();
  const toast = useToast();
  const inv = useInvalidate();
  const wsl = useWsl();
  const harness = harnessOf(s);
  const copyResume: SessionAction = {
    key: 'copy',
    label: 'Copy resume command',
    short: 'Copy command',
    icon: <Copy />,
    title: s.resumeCommand,
    onClick: () => copy(s.resumeCommand).then(() => toast('Resume command copied')),
  };

  const l = s.live;
  if (l) {
    const secondary: SessionAction[] = [];
    if (l.kind === 'background' && l.bgId && wsl) {
      secondary.push({
        key: 'attach',
        label: 'Attach on PC',
        icon: <Monitor />,
        desktopOnly: true,
        title: 'Open this background session in a Windows Terminal tab',
        onClick: () =>
          api(`/api/sessions/${s.id}/attach`, { method: 'POST' })
            .then(() => toast('Opened in Windows Terminal'))
            .catch((e) => toast(e.message, true)),
      });
    }
    if (l.kind === 'background' && l.bgId) {
      secondary.push({
        key: 'stop',
        label: 'Stop',
        icon: <Square />,
        danger: true,
        title: 'Stop this background session (the conversation is kept)',
        onClick: () => {
          if (!confirm(`Stop “${s.title}”? The conversation is kept and can be resumed.`)) return;
          api(`/api/sessions/${s.id}/stop`, { method: 'POST' })
            .then(() => {
              toast('Stopped');
              inv('session', 'live', 'overview', 'sessions');
            })
            .catch((e) => toast(e.message, true));
        },
      });
    }
    return {
      primary: l.bridgeUrl ? { key: 'open', label: 'Open in Claude app', short: 'Open in Claude app', icon: <Smartphone />, href: l.bridgeUrl } : null,
      secondary,
      note: l.bridgeUrl ? null : l.kind === 'background' ? 'Running in the background on your PC' : 'Running in a terminal on your PC',
    };
  }

  if (s.kind === 'archived') {
    return {
      primary: {
        key: 'topic',
        label: 'New session on this topic',
        short: 'New session',
        icon: <Play />,
        title: 'The transcript is gone, so this starts a fresh session with a pointer to this one',
        onClick: () => openNewSession({ projectId: s.projectId || undefined, prompt: `Context: an earlier session about “${s.title}”. ` }),
      },
      secondary: [],
      note: null,
    };
  }

  if (harness === 'codex' && !wsl) {
    // No Windows Terminal to open it in: the resume command is the way back in.
    return { primary: { ...copyResume, short: 'Copy command' }, secondary: [], note: 'Resume it with this command in a terminal' };
  }

  if (harness === 'codex') {
    return {
      primary: {
        key: 'resume-codex',
        label: 'Resume on PC',
        icon: <Terminal />,
        title: 'Opens Codex in a Windows Terminal tab on your PC and resumes this session',
        onClick: () => {
          if (!confirm('Open Codex in a Windows Terminal tab on your PC and resume this session?')) return;
          api<{ note?: string; error?: string | null }>('/api/launch', { method: 'POST', body: { resumeId: s.id, mode: 'terminal', harness: 'codex' } })
            .then((r) => {
              toast(r?.note || 'Codex opened in Windows Terminal');
              inv('live', 'overview');
            })
            .catch((e) => toast(e.message, true));
        },
      },
      secondary: [copyResume],
      note: null,
    };
  }

  if (harness === 'gemini') {
    return { primary: { ...copyResume, short: 'Copy command' }, secondary: [], note: 'Gemini resumes the latest chat in that folder' };
  }

  return {
    primary: {
      key: 'resume',
      label: 'Resume',
      icon: <Play />,
      title: 'Continue this conversation',
      onClick: () => openNewSession({ resumeId: s.id }),
    },
    secondary: [
      {
        key: 'fork',
        label: 'Fork',
        icon: <GitFork />,
        title: 'Start a new session from this conversation, keeping the original untouched',
        onClick: () => openNewSession({ resumeId: s.id, fork: true }),
      },
    ],
    note: null,
  };
}

function ActionButton({ a, variant, size }: { a: SessionAction; variant: 'primary' | 'secondary' | 'ghost'; size: 'sm' | 'md' }) {
  const cls = ['btn', variant !== 'secondary' && variant, size === 'sm' && 'sm', a.danger && variant !== 'primary' && 'danger'].filter(Boolean).join(' ');
  if (a.href)
    return (
      <a className={cls} href={a.href} target="_blank" rel="noreferrer" title={a.title}>
        {a.icon}
        {a.label}
      </a>
    );
  return (
    <button type="button" className={cls} onClick={a.onClick} title={a.title}>
      {a.icon}
      {a.label}
    </button>
  );
}

/** Everything that isn't the one primary action: the set's secondary actions, then page-level extras. */
export function menuOf(set: ActionSet, extras: MenuEntry[], phone: boolean): MenuEntry[] {
  const own: MenuEntry[] = set.secondary
    .filter((a) => !(phone && a.desktopOnly))
    .map((a) => ({ label: a.label, icon: a.icon, danger: a.danger, hint: a.key === 'copy' ? undefined : a.title, onSelect: a.href ? () => window.open(a.href, '_blank', 'noreferrer') : a.onClick || (() => {}) }));
  return [...own, ...(own.length && extras.length ? [{ kind: 'sep' } as MenuEntry] : []), ...extras];
}

/** Header (and the compact sticky header): the one primary action, then ⋯ with the rest. */
export function HeaderActions({ set, extras, size = 'md', title, primary = true }: { set: ActionSet; extras: MenuEntry[]; size?: 'sm' | 'md'; title: string; primary?: boolean }) {
  const phone = useMedia();
  const items = menuOf(set, extras, phone);
  return (
    <div className="sx-actions">
      {primary && set.note && !set.primary && <span className="small faint hide-mobile">{set.note}</span>}
      {primary && set.primary && <ActionButton a={set.primary} variant="primary" size={size} />}
      {items.length > 0 && <Menu label="Session actions" sheetTitle={title} items={items} trigger={(t) => <IconButton {...t} icon={<MoreHorizontal />} label="More actions" variant={size === 'sm' ? 'ghost' : 'secondary'} size={size} />} />}
    </div>
  );
}

/** Phone: the primary action as a compact floating pill, bottom right above the tab bar. */
export function PhoneFab({ set }: { set: ActionSet }) {
  const a = set.primary;
  if (!a) return null;
  const label = a.short || a.label;
  return (
    <div className="sx-fab-dock hide-desktop">
      {a.href ? (
        <a className="btn primary sx-fab" href={a.href} target="_blank" rel="noreferrer">
          {a.icon}
          {label}
        </a>
      ) : (
        <button type="button" className="btn primary sx-fab" onClick={a.onClick} title={a.title}>
          {a.icon}
          {label}
        </button>
      )}
    </div>
  );
}
