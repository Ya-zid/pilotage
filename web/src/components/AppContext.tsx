import React, { createContext, useContext, useState } from 'react';

export type NewSessionPrefill = {
  projectId?: string;
  prompt?: string;
  name?: string;
  resumeId?: string;
  fork?: boolean;
  ideaId?: string;
  title?: string;
  worktree?: string;
  /** The prompt (or the CLAUDE.md it points to) was written by Pilotage's AI: the session asks before acting. */
  aiPrompt?: boolean;
};

type Ctx = {
  openNewSession: (p?: NewSessionPrefill) => void;
  openPalette: () => void;
  newSession: NewSessionPrefill | null;
  closeNewSession: () => void;
  paletteOpen: boolean;
  closePalette: () => void;
};

const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [newSession, setNewSession] = useState<NewSessionPrefill | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <AppCtx.Provider
      value={{
        openNewSession: (p = {}) => setNewSession(p),
        closeNewSession: () => setNewSession(null),
        newSession,
        openPalette: () => setPaletteOpen(true),
        closePalette: () => setPaletteOpen(false),
        paletteOpen,
      }}
    >
      {children}
    </AppCtx.Provider>
  );
}
