import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, CircleHelp, CornerDownLeft, FolderKanban, History, Inbox, Lightbulb, ListChecks, ListPlus, MessageCircle, MessagesSquare, Network, PenLine, Plus, Search, Settings, Home, Sparkles } from 'lucide-react';
import { useProjects, useSearch } from '../api';
import { useWork } from '../api-extra';
import { TASK_STATUS } from './tasks/model';
import { useApp } from './AppContext';
import { Modal, Spinner, Kbd, ProjectGlyph, StatusIcon } from './ui';
import { liveLabel, liveState } from './cards';
import { ago, plainText } from '../util';

type Item = { key: string; icon: React.ReactNode; title: string; sub?: string; right?: string; run: () => void; group: string };

export function CommandPalette() {
  const { closePalette, openNewSession } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 180);
    return () => clearTimeout(t);
  }, [q]);
  const { data: projects } = useProjects();
  const { data: results, isFetching } = useSearch(dq);
  const { data: work } = useWork();
  const go = (to: string) => {
    closePalette();
    navigate(to);
  };
  // Tasks are matched locally against the cached board list (the same query the Tasks page uses).
  const tasks = useMemo(() => {
    const ql = dq.trim().toLowerCase();
    if (ql.length < 2 || !work) return [];
    const rank = (st: string) => (st === 'doing' ? 0 : st === 'todo' ? 1 : st === 'inbox' ? 2 : 3);
    return work.items
      .filter((t) => t.title.toLowerCase().includes(ql))
      .sort((a, b) => rank(a.status) - rank(b.status))
      .slice(0, 5);
  }, [dq, work]);
  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const ql = q.trim().toLowerCase();
    // `also` = other words people may type for the same place (old names included, so muscle memory still works)
    const actions: (Item & { also?: string })[] = [
      { key: 'new', icon: <Plus size={16} />, title: 'New session', group: 'Actions', run: () => (closePalette(), openNewSession({})) },
      { key: 'new-task', icon: <ListPlus size={16} />, title: 'Add task', group: 'Actions', run: () => go('/tasks?new=1') },
      { key: 'new-idea', icon: <PenLine size={16} />, title: 'Capture idea', group: 'Actions', run: () => go('/ideas?new=1') },
      { key: 'home', icon: <Home size={16} />, title: 'Home', also: 'today dashboard', group: 'Go to', run: () => go('/') },
      { key: 'sessions', icon: <MessagesSquare size={16} />, title: 'Sessions', also: 'running live needs you working open conversations', group: 'Go to', run: () => go('/sessions') },
      { key: 'tasks', icon: <ListChecks size={16} />, title: 'Tasks', also: 'to do doing board', group: 'Go to', run: () => go('/tasks') },
      { key: 'suggested', icon: <Inbox size={16} />, title: 'Suggested tasks', also: 'inbox ai triage', group: 'Go to', run: () => go('/tasks?tab=suggested') },
      { key: 'projects', icon: <FolderKanban size={16} />, title: 'Projects', also: 'repos folders workspaces', group: 'Go to', run: () => go('/projects') },
      { key: 'ideas', icon: <Lightbulb size={16} />, title: 'Ideas', group: 'Go to', run: () => go('/ideas') },
      { key: 'possible', icon: <Sparkles size={16} />, title: 'Possible projects', also: 'scout spin-off spinoff candidates', group: 'Go to', run: () => go('/ideas') },
      { key: 'map', icon: <Network size={16} />, title: 'Map', also: 'mind map graph links connections obsidian', group: 'Go to', run: () => go('/map') },
      { key: 'history', icon: <History size={16} />, title: 'History', also: 'timeline activity heatmap streak', group: 'Go to', run: () => go('/history') },
      { key: 'portfolio', icon: <Briefcase size={16} />, title: 'Portfolio & CV', group: 'Go to', run: () => go('/portfolio') },
      { key: 'settings', icon: <Settings size={16} />, title: 'Settings', also: 'phone pairing devices ai usage limits', group: 'Go to', run: () => go('/settings') },
      { key: 'guide', icon: <CircleHelp size={16} />, title: 'How Pilotage works', also: 'help guide about', group: 'Go to', run: () => go('/guide') },
    ];
    out.push(...actions.filter((a) => !ql || `${a.title} ${a.also || ''}`.toLowerCase().includes(ql)));
    if (ql.length < 2) {
      for (const p of (projects || []).slice(0, 8))
        out.push({ key: `p${p.id}`, group: 'Recent projects', icon: <ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={20} />, title: p.name, sub: `${p.workspaceName} · ${p.displayPath}`, right: ago(p.lastAt), run: () => go(`/projects/${p.id}`) });
    } else if (results) {
      // same "workspace · path" line as the New session picker, so two copies of a project can be told apart
      for (const p of results.projects)
        out.push({ key: `p${p.id}`, group: 'Projects', icon: <ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={20} />, title: p.name, sub: `${p.workspaceName} · ${p.displayPath}`, right: ago(p.lastAt), run: () => go(`/projects/${p.id}`) });
      for (const t of tasks)
        out.push({ key: `t${t.id}`, group: 'Tasks', icon: <StatusIcon status={TASK_STATUS[t.status]?.glyph || 'todo'} size={15} />, title: t.title, sub: `${t.projectName} · ${TASK_STATUS[t.status]?.label || t.status}`, right: ago(t.sourceAt || t.updatedAt), run: () => go(`/tasks?open=${encodeURIComponent(t.id)}`) });
      for (const s of results.sessions)
        out.push({ key: `s${s.id}`, group: 'Sessions', icon: s.live ? <StatusIcon status={liveState(s) || 'live'} title={liveLabel(s)} /> : <MessagesSquare size={15} />, title: s.title, sub: plainText(s.match) || `${s.projectName || ''} · ${plainText(s.lastPrompt)}`, right: ago(s.lastAt), run: () => go(`/sessions/${s.id}`) });
      for (const c of results.chats || [])
        out.push({ key: `c${c.uuid}`, group: 'claude.ai chats', icon: <MessageCircle size={15} />, title: c.name, sub: [c.projects.map((p) => p.name).join(', '), 'opens in claude.ai'].filter(Boolean).join(' · '), right: ago(c.updatedAt), run: () => (closePalette(), window.open(c.url, '_blank', 'noopener,noreferrer')) });
      for (const i of results.ideas) out.push({ key: `i${i.id}`, group: 'Ideas', icon: <Lightbulb size={15} />, title: i.text.slice(0, 90), run: () => go('/ideas') });
    }
    return out;
  }, [q, projects, results, tasks]);
  useEffect(() => setSel(0), [dq, q]);
  let lastGroup = '';
  return (
    <Modal onClose={closePalette} className="palette">
      <div className="palette-input">
      <Search />
      <input
        className="input"
        autoFocus
        placeholder="Search projects, sessions, tasks, ideas…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === 'Enter') {
            items[sel]?.run();
          }
        }}
      />
      {isFetching && dq.length >= 2 && <Spinner size={15} />}
      <button type="button" className="palette-cancel hide-desktop" onClick={closePalette}>
        Cancel
      </button>
      </div>
      <div className="palette-results">
        {items.map((it, i) => {
          const head = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
          lastGroup = it.group;
          return (
            <React.Fragment key={it.key}>
              {head}
              <div className={`palette-item${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={it.run}>
                <span className="pi-icon">{it.icon}</span>
                <div className="grow">
                  <div className="truncate">{it.title}</div>
                  {it.sub && <div className="tiny faint truncate">{it.sub}</div>}
                </div>
                {it.right && <span className="pi-right">{it.right}</span>}
                <span className="pi-enter">
                  <Kbd>
                    <CornerDownLeft size={11} />
                  </Kbd>
                </span>
              </div>
            </React.Fragment>
          );
        })}
        {dq.length >= 2 && !isFetching && items.length <= 1 && <div className="empty compact">Nothing found for “{dq}”</div>}
      </div>
      <div className="palette-foot">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>Esc</Kbd> close
        </span>
      </div>
    </Modal>
  );
}
