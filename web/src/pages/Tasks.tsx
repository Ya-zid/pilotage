// Tasks (SIMPLIFY §6): things you've decided to do (To do · Doing · Done), and the AI's suggestions kept apart in
// their own tab until you keep or dismiss them. The UI itself is components/tasks/TasksView (shared with Project › Tasks).
// No subtitle: how suggestions work is in a fold under the Suggested list and in /guide.
import React, { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWork } from '../api-extra';
import { PageHeader } from '../components/ui';
import { taskCounts, TasksTabs, TasksView, useTasksTab } from '../components/tasks/TasksView';
import './Tasks.css';

export default function Tasks() {
  const { data } = useWork();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useTasksTab('tab');
  const addRef = useRef<HTMLInputElement>(null);
  const counts = data ? taskCounts(data.items) : undefined;

  // ?new=1 (phone "+" sheet, palette) focuses quick add on the To do tab.
  const wantsNew = params.get('new') === '1';
  useEffect(() => {
    if (!wantsNew || !data) return;
    if (tab !== 'todo') setTab('todo');
    const t = setTimeout(() => {
      addRef.current?.focus();
      addRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.delete('new');
          return n;
        },
        { replace: true },
      );
    }, 60);
    return () => clearTimeout(t);
  }, [wantsNew, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const openParam = params.get('open');
  const closeSheet = useCallback(() => {
    if (!new URLSearchParams(window.location.search).get('open')) return;
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete('open');
        return n;
      },
      { replace: true },
    );
  }, [setParams]);

  return (
    <div className="tasks-page">
      <PageHeader title="Tasks">
        <TasksTabs value={tab} onChange={setTab} counts={counts} />
      </PageHeader>
      <TasksView
        tab={tab}
        onTab={setTab}
        addRef={addRef}
        initialOpenId={openParam}
        onSheetClose={closeSheet}
        initialProject={params.get('project') || ''}
        initialWorkspace={params.get('ws') || ''}
      />
    </div>
  );
}
