// "Needs you" signals for people with many sessions running: the tab title counts the sessions waiting for an answer
// (permission prompt, question), and, if this device opted in, a desktop notification says when a new one starts
// waiting while Pilotage is in the background. Per device (localStorage); nothing leaves the browser.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLive } from './api';
import { runState } from './components/session/shared';

export const NOTIFY_PREF = 'pilotage.notify.needsYou';

export function notifyEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_PREF) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

/** Ask the browser once; returns whether notifications can be shown now. */
export async function enableNotifications(on: boolean): Promise<boolean> {
  try {
    if (!on) {
      localStorage.setItem(NOTIFY_PREF, '0');
      return false;
    }
    if (typeof Notification === 'undefined') return false;
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    localStorage.setItem(NOTIFY_PREF, p === 'granted' ? '1' : '0');
    return p === 'granted';
  } catch {
    return false;
  }
}

/** Mounted once (App): keeps the title count and sends notifications for sessions that newly need you. */
export function useNeedsYouSignals() {
  const { data } = useLive();
  const navigate = useNavigate();
  const seen = useRef<Set<string> | null>(null);
  const base = useRef<string>(typeof document !== 'undefined' ? document.title.replace(/^\(\d+\) /, '') : 'Pilotage');
  useEffect(() => {
    if (!data) return;
    const waiting = data.live.filter((s) => runState(s) === 'needs-you');
    document.title = waiting.length ? `(${waiting.length}) ${base.current}` : base.current;
    const ids = new Set(waiting.map((s) => s.id));
    const before = seen.current;
    seen.current = ids;
    if (!before || !document.hidden || !notifyEnabled()) return; // the first load and a visible tab never notify
    for (const s of waiting) {
      if (before.has(s.id)) continue;
      try {
        const n = new Notification('Claude needs you', { body: s.title || s.projectName || 'A session is waiting for your answer', tag: `pilotage-${s.id}` });
        n.onclick = () => {
          window.focus();
          navigate(`/sessions/${s.id}`);
          n.close();
        };
      } catch {}
    }
  }, [data, navigate]);
}
