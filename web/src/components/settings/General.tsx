// Settings → New sessions, Projects & scanning, Name & appearance, About.
import React, { useEffect, useMemo, useState } from 'react';
import { Bell, Check, Cloud, Copy, FolderSearch, Laptop, Monitor, Moon, Palette, Rocket, Smartphone, Sun, Tag, Terminal, Info, ShieldCheck, UserRound } from 'lucide-react';
import { enableNotifications, notifyEnabled } from '../../needsYou';
import { terminalPlace, useBootstrap, useInvalidate, useProjects, useTerminal } from '../../api';
import type { Settings as SettingsT } from '../../types';
import { Button, IconButton, SegmentedControl, Skeleton, Switch, WorkspaceAvatar, useToast } from '../ui';
import { copy, plural } from '../../util';
import { PatchFn, PathList, SettingRow, SettingRows, SettingsCard, cap } from './common';

// ---------------------------------------------------------------- new sessions
const PERMISSION_OPTS: { value: string; label: string; hint: string }[] = [
  { value: 'bypassPermissions', label: 'Skip all prompts', hint: 'Claude runs commands and edits files without asking. Only for code you trust.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits go through on their own; commands still ask.' },
  { value: 'auto', label: 'Auto', hint: 'Routine actions run on their own; risky ones ask first.' },
  { value: 'plan', label: 'Plan first', hint: 'Claude proposes a plan before changing anything.' },
  { value: 'default', label: 'Ask every time', hint: 'Claude asks before edits and commands. The default for new installs.' },
];

const LAUNCH_MODELS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
];

const MODE_OPTS: { value: 'terminal' | 'background'; label: React.ReactNode }[] = [
  {
    value: 'terminal',
    label: (
      <>
        <Terminal size={14} aria-hidden="true" />
        Terminal
      </>
    ),
  },
  {
    value: 'background',
    label: (
      <>
        <Cloud size={14} aria-hidden="true" />
        Background
      </>
    ),
  },
];

export function sessionsSummary(s: SettingsT | undefined) {
  if (!s) return '';
  const perm = PERMISSION_OPTS.find((o) => o.value === s.launch.permissionMode)?.label || s.launch.permissionMode;
  return [perm, s.launch.model ? cap(s.launch.model) : 'default model'].join(' · ');
}

export function NewSessionsSection({ s, patch }: { s: SettingsT; patch: PatchFn }) {
  const l = s.launch;
  // No terminal on this PC (headless, over SSH): every session starts in the background.
  const term = useTerminal();
  const setLaunch = (p: Partial<SettingsT['launch']>, msg: string) => patch({ settings: { launch: p } }, msg);
  const perm = PERMISSION_OPTS.find((o) => o.value === l.permissionMode);
  const permOpts = perm ? PERMISSION_OPTS : [...PERMISSION_OPTS, { value: l.permissionMode, label: l.permissionMode, hint: '' }];
  const modeName = (m: string) => (m === 'terminal' ? 'Terminal' : 'Background');
  return (
    <SettingsCard title="Defaults for new sessions" icon={<Rocket />} description="Used when you start a session from Pilotage. You can still change them each time.">
      <SettingRows>
        <SettingRow label="Permissions" htmlFor="launch-perm" hint={perm?.hint || 'How Claude asks before acting.'}>
          <select
            id="launch-perm"
            className="select perm-select"
            value={l.permissionMode}
            onChange={(e) => setLaunch({ permissionMode: e.target.value }, `Permissions: ${permOpts.find((o) => o.value === e.target.value)?.label || e.target.value}`)}
          >
            {permOpts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Model" hint="Default uses whatever Claude Code is set to.">
          <SegmentedControl
            size="sm"
            label="Model"
            value={l.model || ''}
            options={LAUNCH_MODELS}
            onChange={(v) => setLaunch({ model: v }, `Model: ${LAUNCH_MODELS.find((o) => o.value === v)?.label || v}`)}
          />
        </SettingRow>
        {term ? (
          <SettingRow
            label={
              <span className="row" style={{ gap: 8 }}>
                <Monitor size={15} className="faint" aria-hidden="true" /> Started from the PC
              </span>
            }
            hint={`Terminal opens ${terminalPlace(term)} you can type in.`}
          >
            <SegmentedControl size="sm" label="Default for sessions started from the PC" value={l.pcMode} options={MODE_OPTS} onChange={(v) => setLaunch({ pcMode: v }, `PC sessions: ${modeName(v)}`)} />
          </SettingRow>
        ) : (
          <SettingRow
            label={
              <span className="row" style={{ gap: 8 }}>
                <Monitor size={15} className="faint" aria-hidden="true" /> Started from this computer
              </span>
            }
            hint="Sessions run in the background (claude --bg): no terminal window can be opened here (no graphical session, or PILOTAGE_TERMINAL=none)."
          >
            <span className="small muted">Background</span>
          </SettingRow>
        )}
        {term && (
          <SettingRow
            label={
              <span className="row" style={{ gap: 8 }}>
                <Smartphone size={15} className="faint" aria-hidden="true" /> Started from the phone
              </span>
            }
            hint="Background keeps running with no window; follow it in the Claude app."
          >
            <SegmentedControl
              size="sm"
              label="Default for sessions started from the phone"
              value={l.phoneMode}
              options={MODE_OPTS}
              onChange={(v) => setLaunch({ phoneMode: v }, `Phone sessions: ${modeName(v)}`)}
            />
          </SettingRow>
        )}
        <SettingRow
          label={
            <span className="row" style={{ gap: 8 }}>
              <ShieldCheck size={15} className="faint" aria-hidden="true" /> Trust folders
            </span>
          }
          hint="Claude Code asks “trust this folder?” once per folder, on the PC. On: Pilotage answers yes for folders you start sessions in and for projects it creates, so phone launches don't wait. Leave it off if you open code you didn't write."
        >
          <Switch on={!!l.trustFolders} onChange={(v) => setLaunch({ trustFolders: v }, v ? 'Folders you start in are trusted automatically' : 'Claude asks about new folders again')} label="Trust folders automatically" />
        </SettingRow>
      </SettingRows>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- projects & scanning
export function ProjectsSection({ s, workspaces, patch }: { s: SettingsT; workspaces: Record<string, { name?: string }>; patch: PatchFn }) {
  const { data: projects, isLoading } = useProjects();
  const { data: boot } = useBootstrap();
  const inv = useInvalidate();
  const toast = useToast();
  const [allWs, setAllWs] = useState(false);
  const home = boot?.home || '/home/you';

  const wsList = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const p of projects || []) {
      const w = m.get(p.workspace) || { name: p.workspaceName, n: 0 };
      w.n++;
      m.set(p.workspace, w);
    }
    for (const [k, v] of Object.entries(workspaces)) if (v?.name && !m.has(k)) m.set(k, { name: v.name, n: 0 });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name));
  }, [projects, workspaces]);

  const saveHidden = async (next: string[], added: string | null) => {
    const r = await patch({ settings: { scan: { hiddenPaths: next } } }, added ? 'Hidden. Projects in that folder are left out.' : 'No longer hidden');
    inv('projects', 'overview');
    return !!r;
  };
  const saveRoots = async (next: string[], added: string | null) => {
    const r = await patch({ settings: { scan: { extraRoots: next } } }, null);
    inv('projects', 'overview');
    if (!r) return false;
    if (added && !r.settings.scan.extraRoots.includes(added)) {
      toast(`Folder not found: ${added}`, true);
      return false;
    }
    toast(added ? 'Folder added. Looking for projects in it.' : 'Folder removed');
    return true;
  };
  const saveWs = async (k: string, name: string) => {
    const r = await patch({ workspaces: { [k]: { name } } }, name ? `Workspace renamed to “${name}”` : 'Workspace name reset');
    if (r) inv('projects', 'overview', 'timeline', 'portfolio');
  };

  return (
    <>
      <SettingsCard title="Where Pilotage looks" icon={<FolderSearch />} description="Your home folder and Claude's history are always scanned.">
        <SettingRows>
          <SettingRow stack label="Extra folders to scan" htmlFor="scan-roots" hint="Other places with projects. Use WSL paths, e.g. /mnt/c/Users/you/code.">
            <PathList id="scan-roots" label="Extra folders to scan" paths={s.scan.extraRoots || []} placeholder="/mnt/c/Users/you/code" onSave={saveRoots} />
          </SettingRow>
          <SettingRow stack label="Hidden folders" htmlFor="scan-hidden" hint="Projects inside these folders are left out everywhere.">
            <PathList id="scan-hidden" label="Hidden folders" paths={s.scan.hiddenPaths || []} placeholder={`${home}/old-stuff`} onSave={saveHidden} />
          </SettingRow>
        </SettingRows>
      </SettingsCard>
      <SettingsCard title="Workspace names" icon={<Tag />} description="Workspaces are the top-level folders your projects live in. Press Enter or click away to save." flush>
        {isLoading ? (
          <div className="scard-pad stack">
            <Skeleton h={36} />
            <Skeleton h={36} />
          </div>
        ) : wsList.length === 0 ? (
          <div className="scard-pad small faint">No workspaces yet.</div>
        ) : (
          <div className="list">
            {(allWs ? wsList : wsList.slice(0, 6)).map(([k, w]) => (
              <WorkspaceRow key={k || '(none)'} k={k} name={w.name} n={w.n} custom={!!workspaces[k]?.name} onSave={saveWs} />
            ))}
            {wsList.length > 6 && (
              <div className="lrow dense ws-more">
                <button type="button" className="more-link" onClick={() => setAllWs(!allWs)} aria-expanded={allWs}>
                  {allWs ? 'Show fewer' : `Show ${wsList.length - 6} more`}
                </button>
              </div>
            )}
          </div>
        )}
      </SettingsCard>
    </>
  );
}

function WorkspaceRow({ k, name, n, custom, onSave }: { k: string; name: string; n: number; custom: boolean; onSave: (k: string, name: string) => void }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const v = draft.trim();
    if (!v) return setDraft(name);
    if (v !== name) onSave(k, v);
  };
  return (
    <div className="lrow ws-row">
      <div className="lrow-lead">
        <WorkspaceAvatar ws={k} name={name} size={24} />
      </div>
      <div className="ws-key">
        <span className="mono small truncate" title={k}>
          {k || '(none)'}
        </span>
        <span className="tiny faint num">{plural(n, 'project')}</span>
      </div>
      <input
        className="input ws-input"
        value={draft}
        maxLength={60}
        aria-label={`Display name for workspace ${k || '(none)'}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') setDraft(name);
        }}
      />
      <div className="ws-reset">
        {custom && (
          <Button size="sm" variant="ghost" title="Go back to the folder's name" onClick={() => onSave(k, '')}>
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- appearance
const THEME_OPTS: { value: SettingsT['ui']['theme']; label: React.ReactNode }[] = [
  {
    value: 'system',
    label: (
      <>
        <Laptop size={14} aria-hidden="true" />
        System
      </>
    ),
  },
  {
    value: 'light',
    label: (
      <>
        <Sun size={14} aria-hidden="true" />
        Light
      </>
    ),
  },
  {
    value: 'dark',
    label: (
      <>
        <Moon size={14} aria-hidden="true" />
        Dark
      </>
    ),
  },
];

/** Settings → "Your name": the Home greeting and AI prompts use it. Empty = the detected default. */
function NameRow({ s, patch }: { s: SettingsT; patch: PatchFn }) {
  const { data: boot } = useBootstrap();
  const inv = useInvalidate();
  const saved = s.profile?.name || '';
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = async () => {
    const v = draft.trim();
    if (v === saved) return;
    const r = await patch({ settings: { profile: { name: v } } }, v ? `Name: ${v}` : 'Name reset');
    if (r) inv('bootstrap');
    else setDraft(saved);
  };
  return (
    <SettingRow label="Your name" htmlFor="profile-name" hint="Used in the Home greeting and in what the AI writes about your work. Leave empty to use your git name (or login name).">
      <input
        id="profile-name"
        className="input"
        value={draft}
        maxLength={40}
        placeholder={boot?.user?.detectedName || ''}
        autoComplete="given-name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') setDraft(saved);
        }}
      />
    </SettingRow>
  );
}

export function AppearanceSection({ s, patch }: { s: SettingsT; patch: PatchFn }) {
  return (
    <>
      <SettingsCard title="You" icon={<UserRound />}>
        <SettingRows>
          <NameRow s={s} patch={patch} />
        </SettingRows>
      </SettingsCard>
      <SettingsCard title="Theme" icon={<Palette />}>
        <SettingRows>
          <SettingRow label="Theme" hint="System follows each device's light or dark setting. Applies to all your devices.">
            <SegmentedControl label="Theme" value={s.ui.theme} options={THEME_OPTS} onChange={(v) => patch({ settings: { ui: { theme: v } } }, `Theme: ${cap(v)}`)} />
          </SettingRow>
        </SettingRows>
      </SettingsCard>
      <NotifyCard />
    </>
  );
}

/** Per device: a desktop notification when a session starts waiting for you while Pilotage is in the background. */
function NotifyCard() {
  const toast = useToast();
  const [on, setOn] = useState(notifyEnabled());
  const supported = typeof Notification !== 'undefined' && window.isSecureContext;
  return (
    <SettingsCard title="Notifications" icon={<Bell />}>
      <SettingRows>
        <SettingRow
          label="When a session needs you"
          hint={
            supported
              ? 'This device shows a notification when a session starts waiting for an answer (a permission prompt, a question) while Pilotage is in the background. The tab title always counts them.'
              : 'Notifications need https or the PC itself (http://pilotage.localhost). The tab title still counts the sessions waiting for you.'
          }
        >
          <Switch
            on={on}
            label="Notify me when a session needs me"
            onChange={async (v) => {
              const ok = await enableNotifications(v);
              setOn(ok);
              if (v && !ok) toast(supported ? 'Notifications are blocked for this site in the browser settings' : 'Notifications need https on this device', true);
              else toast(ok ? 'Notifications on for this device' : 'Notifications off');
            }}
          />
        </SettingRow>
      </SettingRows>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- about
const CLI: [string, string][] = [
  ['pilotage status', 'Is it running? Addresses, forwarder, autostart.'],
  ['pilotage open', 'Open Pilotage in the PC browser.'],
  ['pilotage pair', 'Pair a phone from the terminal (QR code).'],
  ['pilotage phone', 'Turn on phone access (one Windows admin prompt).'],
  ['pilotage projects', 'List projects; add a word to filter.'],
  ['pilotage new <project>', 'Start a session; --bg for background.'],
  ['pilotage live', 'What is running right now.'],
  ['pilotage logs', 'Follow the server log.'],
  ['pilotage restart', 'Restart the server.'],
  ['pilotage rotate-key', 'Replace the desktop key.'],
  ['pilotage uninstall', 'Remove Pilotage from this PC (keeps your data).'],
];

function CopyIcon({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      icon={done ? <Check /> : <Copy />}
      label={done ? 'Copied' : `Copy “${text.trim()}”`}
      onClick={() =>
        copy(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        })
      }
    />
  );
}

export function AboutSection() {
  const { data: boot } = useBootstrap();
  return (
    <>
      <SettingsCard title="Pilotage" icon={<Info />}>
        <div className="stack-lg">
          <dl className="kv">
            <dt>Version</dt>
            <dd className="mono">{boot?.version || '…'}</dd>
            <dt>Data folder</dt>
            <dd className="mono">{boot?.dataDir || '…'}</dd>
            {boot?.device && (
              <>
                <dt>This browser</dt>
                <dd>
                  {boot.device.name}
                  {boot.device.viaLan ? <span className="faint"> · through the phone forwarder</span> : null}
                </dd>
              </>
            )}
          </dl>
          <div className="promise">
            <ShieldCheck size={16} className="tone-green" aria-hidden="true" />
            <p className="small">
              Pilotage never changes your projects or Claude's files. It only creates folders when you spin off or start a new project, and writes one thing for Claude Code when you ask it to: "Trust this folder" (or the automatic setting) records Claude's folder-trust answer in ~/.claude.json.
            </p>
          </div>
        </div>
      </SettingsCard>
      <SettingsCard title="Commands" icon={<Terminal />} description={boot?.platform?.wsl === false ? 'Run these in a terminal (bin/pilotage, or pilotage once linked on your PATH).' : 'Run these in WSL.'} flush>
        <div className="list">
          {CLI.map(([cmd, what]) => (
            <div key={cmd} className="lrow dense cli-row">
              <div className="lrow-body cli-body">
                <code className="cli-cmd">{cmd}</code>
                <span className="small muted">{what}</span>
              </div>
              <div className="lrow-trail hide-mobile">
                <CopyIcon text={cmd.replace(/ <.*$/, ' ')} />
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>
    </>
  );
}
