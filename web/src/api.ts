// Tiny API client + React Query hooks + server-sent events.
import { useEffect } from 'react';
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Bootstrap,
  Overview,
  ProjectSummary,
  ProjectDetail,
  SessionSummary,
  SessionDetail,
  TurnsPage,
  TurnItem,
  Idea,
  AIStatus,
  Settings,
  Launch,
  Device,
  NetInfo,
  PortfolioProject,
  DayActivity,
  BlockView,
} from './types';
import { registerWorkspaces } from './util';

export class ApiError extends Error {
  status: number;
  /** Full JSON error body (e.g. a 409 with a suggested name). */
  data: any;
  constructor(status: number, msg: string, data?: any) {
    super(msg);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method || 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['X-Pilotage'] = '1';
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    if (res.status === 401) window.location.reload();
    throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 403)) && count < 1 },
  },
});

// ---------- queries ----------
export const useBootstrap = () => useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap'), staleTime: 60_000 });
/** WSL2 + Windows: Windows Terminal tabs, "Attach on PC" and the phone forwarder exist (true until the server says otherwise). */
export const useWsl = () => useBootstrap().data?.platform?.wsl !== false;
/**
 * Where sessions open on the PC ("Windows Terminal", "Terminal", "kitty"…), or null when they can only run in the
 * background (no graphical session, PILOTAGE_TERMINAL=none). A generic name until the server answers.
 */
export const useTerminal = (): string | null => {
  const p = useBootstrap().data?.platform;
  if (!p) return 'Terminal';
  return p.terminal !== undefined ? p.terminal : p.wsl ? 'Windows Terminal' : null;
};
/** "a Windows Terminal tab" on WSL, "a Terminal window" elsewhere ("A …" with cap). */
export const terminalPlace = (label: string | null, cap = false) =>
  `${cap ? 'A' : 'a'} ${label === 'Windows Terminal' ? 'Windows Terminal tab' : `${label || 'terminal'} window`}`;
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/api/overview') });
export const useProjects = (hidden = false) =>
  useQuery({ queryKey: ['projects', hidden], queryFn: () => api<{ projects: ProjectSummary[] }>(`/api/projects${hidden ? '?hidden=1' : ''}`).then((r) => (registerWorkspaces(r.projects.map((p) => p.workspace)), r.projects)) });
export const useProject = (id: string | undefined) =>
  useQuery({ queryKey: ['project', id], queryFn: () => api<ProjectDetail>(`/api/projects/${id}`), enabled: !!id });
export const useSessions = (params: Record<string, string | undefined> = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({ queryKey: ['sessions', qs], queryFn: () => api<{ sessions: SessionSummary[] }>(`/api/sessions${qs ? `?${qs}` : ''}`).then((r) => r.sessions) });
};
export const useSession = (id: string | undefined) => useQuery({ queryKey: ['session', id], queryFn: () => api<SessionDetail>(`/api/sessions/${id}`), enabled: !!id });
export const useTurns = (id: string | undefined, before?: number, system = false) =>
  useQuery({
    queryKey: ['turns', id, before ?? 'end', system],
    queryFn: () => api<TurnsPage>(`/api/sessions/${id}/turns?limit=40${before != null ? `&before=${before}` : ''}${system ? '&system=1' : ''}`),
    enabled: !!id,
  });
export const useTurnDetail = (id: string, i: number, enabled: boolean) =>
  useQuery({ queryKey: ['turn', id, i], queryFn: () => api<{ items: TurnItem[] }>(`/api/sessions/${id}/turns/${i}`), enabled, staleTime: 60_000 });
export const useLive = () => useQuery({ queryKey: ['live'], queryFn: () => api<{ live: SessionSummary[]; launches: Launch[] }>('/api/live'), refetchInterval: 20_000 });
export const useIdeas = () => useQuery({ queryKey: ['ideas'], queryFn: () => api<{ ideas: Idea[] }>('/api/ideas').then((r) => r.ideas) });
export const useAI = () => useQuery({ queryKey: ['ai'], queryFn: () => api<AIStatus & { usage: Bootstrap['usage'] }>('/api/ai'), refetchInterval: 15_000 });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api<{ settings: Settings; workspaces: Record<string, { name?: string }> }>('/api/settings') });
export const useDevices = () => useQuery({ queryKey: ['devices'], queryFn: () => api<{ devices: Device[]; current: string }>('/api/devices') });
export const useNet = () => useQuery({ queryKey: ['net'], queryFn: () => api<NetInfo>('/api/net'), refetchInterval: 30_000 });
/** The same data without polling (each /api/net runs Windows tools on WSL): for Home's one-time phone callout. */
export const useNetOnce = () => useQuery({ queryKey: ['net'], queryFn: () => api<NetInfo>('/api/net'), staleTime: 5 * 60_000 });
export const usePortfolio = () =>
  useQuery({ queryKey: ['portfolio'], queryFn: () => api<{ projects: PortfolioProject[]; settings: { lang: string; header: string } }>('/api/portfolio').then((r) => (registerWorkspaces(r.projects.map((p) => p.workspace)), r)) });
export const useTimeline = () =>
  useQuery({
    queryKey: ['timeline'],
    queryFn: () => api<{ days: DayActivity[]; projects: { id: string; path: string; name: string; workspace: string; workspaceName: string }[] }>('/api/timeline').then((r) => (registerWorkspaces(r.projects.map((p) => p.workspace)), r)),
    staleTime: 60_000,
  });
export const useDay = (day: string | null) =>
  useQuery({ queryKey: ['day', day], queryFn: () => api<{ day: string; blocks: (BlockView & { kind: string; title: string; project: string | null })[] }>(`/api/timeline/day/${day}`), enabled: !!day });
export const useSearch = (q: string) =>
  useQuery({ queryKey: ['search', q], queryFn: () => api<{ projects: ProjectSummary[]; sessions: SessionSummary[]; ideas: Idea[] }>(`/api/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2, staleTime: 10_000 });

// ---------- mutations ----------
export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

export function usePatchProject(id: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ProjectDetail>(`/api/projects/${id}`, { method: 'PATCH', body }),
    // names and visibility show up in task cards, session rows, Live and Timeline too
    onSuccess: () => inv('project', 'projects', 'overview', 'portfolio', 'work', 'spinoffs', 'sessions', 'session', 'live', 'timeline', 'day'),
  });
}

// ---------- live updates ----------
// Rows carry names from other entities (a task card shows its project's name and source session's title,
// session/Live/Timeline rows show project names), so a change refreshes every list that displays it.
// Only queries on screen refetch; the rest are just marked stale.
const KIND_TO_KEYS: Record<string, string[]> = {
  sessions: ['overview', 'projects', 'project', 'sessions', 'session', 'turns', 'turn', 'live', 'timeline', 'portfolio', 'work'],
  live: ['overview', 'live', 'sessions', 'session', 'projects', 'project'],
  projects: ['overview', 'projects', 'project', 'portfolio', 'work', 'spinoffs', 'sessions', 'session', 'live', 'timeline', 'day'],
  ai: ['ai', 'overview', 'scout'],
  'ai-data': ['ai', 'overview', 'projects', 'project', 'sessions', 'session', 'portfolio', 'day'],
  ideas: ['ideas', 'overview'],
  devices: ['devices'],
  net: ['net'],
  index: ['overview', 'bootstrap'],
  work: ['work', 'spinoffs', 'overview', 'project'],
  providers: ['providers', 'harnesses'],
  settings: ['settings', 'bootstrap', 'providers', 'harnesses', 'ai'],
  overview: ['overview'],
  scout: ['scout', 'overview', 'ideas', 'project'],
};

export function useServerEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let dropped = false;
    const connect = () => {
      es = new EventSource('/api/events');
      // Back after a drop (server restart, phone asleep): anything may have changed meanwhile, including the web build.
      es.onopen = () => {
        if (dropped) qc.invalidateQueries();
        dropped = false;
      };
      es.addEventListener('change', (ev) => {
        try {
          const { kinds } = JSON.parse((ev as MessageEvent).data) as { kinds: string[] };
          const keys = new Set<string>();
          for (const k of kinds) for (const q of KIND_TO_KEYS[k] || []) keys.add(q);
          keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        } catch {}
      });
      es.onerror = () => {
        dropped = true;
        es?.close();
        if (!closed) retry = setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [qc]);
}
