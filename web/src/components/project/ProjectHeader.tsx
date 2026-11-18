// Project detail header: crumbs, identity, status, one primary action (New session) and ⋯ (status, pin, edit, spin off…).
// Open-in buttons (VS Code / Terminal / Folder) live in the Overview's Details card; running sessions in the strip below.
import React from 'react';
import { Copy, Eye, GitFork, MoreHorizontal, Pencil, Pin, PinOff, Plus } from 'lucide-react';
import { usePatchProject } from '../../api';
import { useApp } from '../AppContext';
import type { ProjectDetail } from '../../types';
import { Button, IconButton, PageHeader, ProjectGlyph, Snippet, useToast, WorkspaceAvatar, WorkStatus } from '../ui';
import { copy } from '../../util';
import { Menu, type MenuEntry } from './Menu';
import { errMsg } from './lib';

const STATUS_CHOICES: { value: string | null; label: string; hint?: string }[] = [
  { value: null, label: 'Automatic', hint: 'From recent activity' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
];

export function ProjectHeader({ p, onEdit, onSpinoff, children }: { p: ProjectDetail; onEdit: () => void; onSpinoff: () => void; children?: React.ReactNode }) {
  const { openNewSession } = useApp();
  const patch = usePatchProject(p.id);
  const toast = useToast();
  const set = (body: Record<string, unknown>, done: string) => patch.mutate(body, { onSuccess: () => toast(done), onError: (e) => toast(errMsg(e), true) });

  const items: MenuEntry[] = [
    { kind: 'section', label: 'Status' },
    ...STATUS_CHOICES.map((c) => ({
      label: c.value === null ? `Automatic${!p.userStatus ? ` (${p.status})` : ''}` : c.label,
      hint: c.hint,
      checked: (p.userStatus || null) === c.value,
      onSelect: () => set({ status: c.value }, c.value ? `Marked ${c.label.toLowerCase()}` : 'Status follows activity again'),
    })),
    { kind: 'sep' },
    { label: p.pinned ? 'Unpin' : 'Pin to the top', icon: p.pinned ? <PinOff /> : <Pin />, onSelect: () => set({ pinned: !p.pinned }, p.pinned ? 'Unpinned' : 'Pinned to the top') },
    { label: 'Edit project…', icon: <Pencil />, onSelect: onEdit },
    { label: 'Spin off…', icon: <GitFork />, hint: 'Move some of this work into a new project', onSelect: onSpinoff },
    { label: 'Copy folder path', icon: <Copy />, hint: p.displayPath, onSelect: () => copy(p.path).then(() => toast('Path copied')) },
    ...(p.hidden ? [{ label: 'Show in lists again', icon: <Eye />, onSelect: () => set({ hidden: false }, 'Visible again') } as MenuEntry] : []),
  ];

  // Running sessions show in the strip under the header; here only a lifecycle that isn't the normal one.
  const status = p.status !== 'active' ? <WorkStatus status={p.status} /> : null;
  return (
    <PageHeader
      className="pj-ph pj-head"
      crumbs={[
        { label: 'Projects', to: '/projects' },
        {
          label: (
            <>
              <WorkspaceAvatar ws={p.workspace} name={p.workspaceName} size={16} />
              {p.workspaceName}
            </>
          ),
          to: `/projects?ws=${encodeURIComponent(p.workspace)}`,
        },
      ]}
      glyph={<ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={40} title={p.workspaceName} />}
      title={
        <>
          {p.name}
          {p.pinned && <Pin className="pj-title-pin" aria-label="Pinned" />}
        </>
      }
      status={
        <>
          {status}
          {p.hidden && <span className="pj-hidden-word">Hidden</span>}
        </>
      }
      subtitle={p.oneLiner ? <Snippet text={p.oneLiner} lines={1} className="pj-oneliner" /> : undefined}
      actions={
        <>
          <Button variant="primary" icon={<Plus />} onClick={() => openNewSession({ projectId: p.id })} className="pj-new-session">
            New session
          </Button>
          <Menu label="Project actions" sheetTitle={p.name} items={items} trigger={(t) => <IconButton {...t} icon={<MoreHorizontal />} label="Project actions" variant="secondary" size="md" />} />
        </>
      }
    >
      {children}
    </PageHeader>
  );
}
