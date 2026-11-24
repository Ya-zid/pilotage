import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cloud, GitFork, Monitor, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useHarnesses } from '../api-extra';
import { api, terminalPlace, useBootstrap, useInvalidate, useProjects, useSession, useTerminal } from '../api';
import { useApp } from './AppContext';
import { LaunchStatus } from './project/LaunchStatus';
import { Disclosure, Modal, Spinner, useToast, ProjectGlyph, SegmentedControl, Field } from './ui';
import './NewSession.css';
import type { Launch } from '../types';
import { ago, isPhone } from '../util';

const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
const PERM_LABEL: Record<string, string> = { bypassPermissions: 'Skip all prompts', default: 'Ask every time', manual: 'Ask every time', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan first', dontAsk: 'Pre-approved only' };

/** Said out loud, not folded away: in this mode the agent runs commands and edits files without asking. */
export function SkipPromptsNote() {
  return (
    <div className="row small" role="note" style={{ alignItems: 'flex-start', gap: 6 }}>
      <TriangleAlert size={14} className="tone-amber" style={{ flex: 'none', marginTop: 2 }} />
      <span className="faint">Runs commands and edits files without asking first. Only for code you trust (Settings → New sessions → Permissions).</span>
    </div>
  );
}

const MODELS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
];

export function NewSessionModal() {
  const { newSession: pre, closeNewSession } = useApp();
  const { data: projects } = useProjects();
  const { data: boot } = useBootstrap();
  const { data: resumeSession } = useSession(pre?.resumeId);
  const toast = useToast();
  const inv = useInvalidate();
  const phone = boot?.device.isPhone ?? isPhone();
  // No terminal on this PC (headless, over SSH): every session starts in the background.
  const term = useTerminal();
  const defaultMode = !term ? 'background' : (phone ? boot?.settings.launch.phoneMode : boot?.settings.launch.pcMode) || (phone ? 'background' : 'terminal');
  const [projectId, setProjectId] = useState(pre?.projectId || '');
  const [filter, setFilter] = useState('');
  const [name, setName] = useState(pre?.name || '');
  const [prompt, setPrompt] = useState(pre?.prompt || '');
  const [mode, setMode] = useState<'terminal' | 'background'>(defaultMode);
  const [model, setModel] = useState(boot?.settings.launch.model || '');
  const [fork, setFork] = useState(!!pre?.fork);
  const [harness, setHarness] = useState<'claude' | 'codex' | 'gemini'>('claude');
  const { data: harnesses } = useHarnesses();
  const effHarness = (resumeSession?.harness as 'claude' | 'codex' | 'gemini' | undefined) || harness;
  const claudeOnly = effHarness === 'claude';
  useEffect(() => {
    // Codex/Gemini run in a terminal tab only (no background mode, no fork, no Claude model names).
    if (!claudeOnly) {
      setMode('terminal');
      setFork(false);
    }
  }, [claudeOnly]);
  const [busy, setBusy] = useState(false);
  const [launch, setLaunch] = useState<Launch | null>(null);
  // Claude Code asks "trust this folder?" once per folder, at the PC. Offer to answer it from here.
  const trustTarget = claudeOnly && (projectId || pre?.resumeId) ? { projectId: projectId || '', worktree: pre?.worktree || '', resumeId: pre?.resumeId || '' } : null;
  const { data: trust } = useQuery({
    queryKey: ['trust', trustTarget],
    queryFn: () => api<{ trusted: boolean; home: boolean; auto: boolean }>(`/api/trust?${new URLSearchParams(trustTarget!)}`),
    enabled: !!trustTarget,
    staleTime: 10_000,
  });
  const askTrust = !!trust && !trust.trusted && !trust.home && !trust.auto;
  // Never pre-ticked, on the phone either: trusting a folder of code you didn't write must be a choice.
  const [trustTick, setTrustTick] = useState(false);

  const resuming = !!pre?.resumeId;
  const project = projects?.find((p) => p.id === (projectId || resumeSession?.projectId));
  // Most recently active first.
  const list = useMemo(() => {
    const ps = (projects || []).filter((p) => p.status !== 'archived').sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    const f = filter.toLowerCase();
    const filtered = f ? ps.filter((p) => `${p.name} ${p.displayPath} ${p.workspaceName}`.toLowerCase().includes(f)) : ps;
    return filtered.slice(0, f ? 30 : 10);
  }, [projects, filter]);
  const agents = (harnesses?.harnesses || []).filter((h) => h.installed && h.enabled && (!!term || h.id === 'claude'));
  // One line that says what Options holds right now ("Terminal · Default model · Skip all prompts").
  const perm = boot?.settings.launch.permissionMode;
  const optionsLine = [
    !claudeOnly ? AGENT_LABEL[effHarness] : '',
    claudeOnly ? (mode === 'background' ? 'Background' : 'Terminal') : 'Terminal',
    claudeOnly ? (model ? MODELS.find((m) => m.value === model)?.label || model : 'Default model') : '',
    claudeOnly && perm ? PERM_LABEL[perm] || perm : '',
    name.trim() ? `“${name.trim()}”` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  async function start() {
    setBusy(true);
    try {
      const rec = await api<Launch>('/api/launch', {
        method: 'POST',
        body: { projectId: projectId || undefined, worktree: pre?.worktree, resumeId: pre?.resumeId, fork: claudeOnly && fork, trust: askTrust && trustTick, name: name || undefined, prompt, mode: claudeOnly ? mode : 'terminal', model: claudeOnly ? model : '', harness: effHarness, ideaId: pre?.ideaId },
      });
      setLaunch(rec);
      inv('live', 'overview', 'ideas');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const title = launch ? 'Session' : resuming ? (fork ? 'Fork session' : 'Resume session') : pre?.title || 'New session';
  return (
    <Modal
      title={title}
      onClose={closeNewSession}
      footer={
        launch ? (
          <button className="btn" onClick={closeNewSession}>
            Close
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={closeNewSession}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || (!resuming && !projectId)} onClick={start}>
              {busy && <Spinner size={14} />}
              {resuming ? (fork ? 'Fork and start' : 'Resume') : 'Start session'}
            </button>
          </>
        )
      }
    >
      {launch ? (
        <div className="modal-body" style={{ paddingTop: 10 }}>
          <LaunchStatus launch={launch} onNavigate={closeNewSession} />
        </div>
      ) : (
        <div className="modal-body ns-body">
          {resuming ? (
            <div className="focus-card ns-resume">
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                {resumeSession?.projectName && <ProjectGlyph name={resumeSession.projectName} ws={resumeSession.workspace} size={32} />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="bold truncate">{resumeSession?.title || '…'}</div>
                  <div className="tiny faint truncate">
                    {[resumeSession?.projectName, resumeSession ? `last active ${ago(resumeSession.lastAt)}` : ''].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              {claudeOnly && (
                <label className="row small check-row">
                  <input type="checkbox" checked={fork} onChange={(e) => setFork(e.target.checked)} />
                  <GitFork size={14} className="faint" /> Fork instead (keep the original untouched)
                </label>
              )}
            </div>
          ) : project && projectId ? (
            <div className="focus-card ns-project">
              <ProjectGlyph name={project.name} ws={project.workspace} color={project.color} size={32} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="bold truncate">{project.name}</div>
                <div className="tiny faint truncate">{pre?.worktree ? `worktree ${pre.worktree.split('/').pop()}` : project.displayPath}</div>
              </div>
              <button className="btn sm ghost" onClick={() => setProjectId('')}>
                Change
              </button>
            </div>
          ) : (
            <div className="picker">
              <div className="picker-search">
                <Search size={15} />
                <input placeholder="Pick a project…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus={!phone} aria-label="Search projects" />
              </div>
              <div className="picker-list">
                {list.map((p) => (
                  <button type="button" key={p.id} className="picker-item" onClick={() => setProjectId(p.id)}>
                    <ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={26} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="truncate medium">{p.name}</div>
                      {p.workspaceName && p.workspaceName.toLowerCase() !== p.name.toLowerCase() && <div className="tiny faint truncate">{p.workspaceName}</div>}
                    </div>
                    <span className="tiny faint num">{ago(p.lastAt)}</span>
                  </button>
                ))}
                {!list.length && <div className="empty compact">No project matches</div>}
              </div>
            </div>
          )}
          <textarea
            className="textarea ns-prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={resuming ? 'Message to continue with (optional)' : 'What should Claude work on? (optional)'}
            aria-label={resuming ? 'Message to continue with' : 'First prompt'}
            autoFocus={!phone && (resuming || !!pre?.projectId)}
          />
          {askTrust && (
            <label className="row small check-row" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={trustTick} onChange={(e) => setTrustTick(e.target.checked)} style={{ marginTop: 3 }} />
              <ShieldCheck size={14} className="faint" style={{ flex: 'none', marginTop: 2 }} />
              <span>
                Trust this folder in Claude Code
                <span className="hint" style={{ display: 'block' }}>
                  Claude asks this once per folder, on the PC, and waits until someone answers. Untick it for code you didn't write.
                </span>
              </span>
            </label>
          )}
          {perm === 'bypassPermissions' && <SkipPromptsNote />}
          <Disclosure
            className="ns-options"
            summary={
              <span className="ns-options-sum">
                <span className="ns-options-h">Options</span>
                <span className="ns-options-line truncate">{optionsLine}</span>
              </span>
            }
          >
            <div className="ns-options-body">
              <div className="field">
                <label htmlFor="ns-name">Name</label>
                <input id="ns-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={project ? `${project.name} – …` : 'Shown in Claude app and terminal tab'} maxLength={60} />
              </div>
              {!resuming && agents.length > 1 && (
                <Field label="Agent">
                  <SegmentedControl
                    value={harness}
                    onChange={(v) => setHarness(v as 'claude' | 'codex' | 'gemini')}
                    options={agents.map((h) => ({ value: h.id, label: h.id === 'claude' ? 'Claude Code' : h.id === 'codex' ? 'Codex' : 'Gemini' }))}
                    label="Agent"
                  />
                </Field>
              )}
              {claudeOnly && term && (
                <div className="field">
                  <label>Where</label>
                  <div className="choice-grid" role="radiogroup" aria-label="Where">
                    {([
                      { value: 'terminal', icon: <Monitor size={17} />, title: 'Terminal on PC', hint: `${terminalPlace(term, true)} with Remote Control, so it also shows on your phone.` },
                      { value: 'background', icon: <Cloud size={17} />, title: 'Background', hint: 'No window on the PC. Continue it in the Claude app.' },
                    ] as const).map((o) => (
                      <button type="button" key={o.value} role="radio" aria-checked={mode === o.value} className={`choice${mode === o.value ? ' on' : ''}`} onClick={() => setMode(o.value)}>
                        <span className="choice-icon">{o.icon}</span>
                        <span className="choice-title">{o.title}</span>
                        <span className="choice-hint">{o.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {claudeOnly ? (
                <Field label="Model">
                  <SegmentedControl value={model} onChange={setModel} options={MODELS} label="Model" />
                </Field>
              ) : (
                <div className="hint">{effHarness === 'codex' ? 'Codex' : 'Gemini'} opens in {terminalPlace(term)} on your PC (no phone link: only Claude Code has Remote Control).</div>
              )}
              <div className="hint">Permissions: {(perm && PERM_LABEL[perm]) || perm}. Change in Settings.</div>
            </div>
          </Disclosure>
        </div>
      )}
    </Modal>
  );
}
