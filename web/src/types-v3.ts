// Types for the v3 simplification (docs/SIMPLIFY.md §10) and the project scout (docs/API-SCOUT.md).
import type { WorkItem } from './types-extra';

/** Home › Pick up: a session you can resume. quietDays = 0 when active in the last 3 days, else days since. */
export interface PickupItem {
  key: string; // 's:<sessionId>'
  kind: 'session';
  sessionId: string;
  title: string;
  projectId: string;
  projectName: string;
  workspace: string | null;
  summary: string;
  nextStep: string; // written for Claude (the Resume context)
  todo?: string; // the same step as a short to-do (3-7 words), '' when the session is done
  status: string | null; // digest status: in_progress | blocked | ongoing | done | abandoned
  lastAt: number;
  quietDays: number;
  resumable: boolean;
}

/** An AI focus item for today that the user hasn't accepted or declined yet. */
export interface PlanProposal {
  index: number;
  key: string; // POST /api/plan/focus/:key
  projectId: string | null;
  projectName: string;
  workspace: string | null;
  title: string;
  why: string;
  action: string; // a first prompt to start a session with
  matchId: string | null; // an existing open task that looks the same
  matchStatus: 'inbox' | 'todo' | 'doing' | null; // where that task is: Suggested / To do / Doing
}

export interface Plan {
  day: string; // YYYY-MM-DD (local)
  today: WorkItem[]; // open tasks planned for today (or rolled over)
  proposals: PlanProposal[];
}

export type ScoutKind = 'spin-off' | 'idea' | 'reusable';
export type ScoutStatus = 'new' | 'saved' | 'dismissed' | 'accepted';

/** A possible project the scout spotted (GET /api/scout). Full contract: docs/API-SCOUT.md. */
export interface ScoutCandidate {
  id: string;
  projectId: string; // the SOURCE project it was found in
  projectName: string;
  projectPath: string;
  displayPath: string;
  workspace: string | null;
  registered: boolean;
  kind: ScoutKind;
  title: string; // proposed project name
  pitch: string; // one sentence
  why: string;
  evidence: string[];
  threadName: string; // '' or a workstream name in the source project (spin-off dialog prefill)
  firstSteps: string[];
  confidence: 'high' | 'medium' | 'low';
  at: number;
  firstAt: number;
  model: string | null;
  current: boolean;
  status: ScoutStatus;
  decidedAt: number | null;
  ideaId: string | null;
  acceptedProjectPath: string | null;
  acceptedProjectId: string | null;
}

export interface ScoutPending {
  projectId: string;
  projectName: string;
  projectPath: string;
  state: 'running' | 'queued' | 'due';
  reason: string;
}

export interface ScoutRun {
  projectId: string;
  projectName: string;
  projectPath: string;
  at: number;
  model: string | null;
  auto: boolean;
  candidates: number;
  note: string; // what else the model weighed and why it left it out (show for empty results)
  lastError: string | null;
}

export interface ScoutList {
  candidates: ScoutCandidate[];
  lastRunAt: number; // 0 = never
  pending: ScoutPending[];
  scouted: ScoutRun[];
  settings: { enabled: boolean; auto: boolean; model: string };
}
