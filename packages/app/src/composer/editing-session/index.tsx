import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ComposerInputMode } from "@/composer/input-mode";

export interface ComposerSelection {
  start: number;
  end: number;
}

/** What an unmounting editor leaves for the next mount of the same session. */
export interface ComposerRetainedEditor {
  selection: ComposerSelection;
  /** The editor was focused, or meant to regain focus once its pane became active. */
  focused: boolean;
}

/**
 * Editing state that outlives the editor's mount. Draft text belongs to its draft
 * owner; the editor keeps its own live buffer across layout modes. Switching between
 * the compact and desktop screens remounts the editor, so the session carries the
 * caret and focus intent across that remount while the draft owner carries the text.
 */
export class ComposerEditingSession {
  private fullscreen = false;
  private retained: ComposerRetainedEditor | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly onChange?: () => void) {}
  getFullscreen = () => this.fullscreen;
  /** Called by the unmounting editor; the next mount of this session takes it. */
  retainEditor(retained: ComposerRetainedEditor) {
    this.retained = retained;
  }
  takeEditor(): ComposerRetainedEditor | null {
    const retained = this.retained;
    this.retained = null;
    return retained;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setFullscreen(fullscreen: boolean) {
    if (fullscreen === this.fullscreen) return;
    this.fullscreen = fullscreen;
    for (const listener of this.listeners) listener();
    this.onChange?.();
  }
}

interface TabSessions {
  targetKey: string;
  sessions: Map<ComposerInputMode, ComposerEditingSession>;
}

export class ComposerEditingSessions {
  private workspaces = new Map<string, Map<string, TabSessions>>();
  private listeners = new Set<() => void>();
  private notify = () => {
    for (const listener of this.listeners) listener();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get(workspaceKey: string, tabId: string, targetKey: string, purpose: ComposerInputMode) {
    let workspace = this.workspaces.get(workspaceKey);
    if (!workspace) {
      workspace = new Map();
      this.workspaces.set(workspaceKey, workspace);
    }
    let tab = workspace.get(tabId);
    if (!tab || tab.targetKey !== targetKey) {
      tab = { targetKey, sessions: new Map() };
      workspace.set(tabId, tab);
    }
    let session = tab.sessions.get(purpose);
    if (!session) {
      session = new ComposerEditingSession(this.notify);
      tab.sessions.set(purpose, session);
    }
    return session;
  }
  /** A tab is fullscreen when any of its composers is; the screen hides its chrome for it. */
  isTabFullscreen(workspaceKey: string, tabId: string | null): boolean {
    if (tabId === null) return false;
    const tab = this.workspaces.get(workspaceKey)?.get(tabId);
    if (!tab) return false;
    for (const session of tab.sessions.values()) if (session.getFullscreen()) return true;
    return false;
  }
  retain(workspaceKey: string, tabIds: readonly string[]) {
    const workspace = this.workspaces.get(workspaceKey);
    if (!workspace) return;
    const retained = new Set(tabIds);
    let changed = false;
    for (const tabId of workspace.keys()) {
      if (retained.has(tabId)) continue;
      workspace.delete(tabId);
      changed = true;
    }
    if (workspace.size === 0) this.workspaces.delete(workspaceKey);
    if (changed) this.notify();
  }
}

const SessionsContext = createContext<ComposerEditingSessions | null>(null);
const WorkspaceContext = createContext<string | null>(null);
const ScopeContext = createContext<{ tabId: string; targetKey: string } | null>(null);

/** App-container ownership survives replacement of both the gesture shell and tab layout. */
export function ComposerEditingSessionsProvider({ children }: { children: ReactNode }) {
  const [sessions] = useState(() => new ComposerEditingSessions());
  return <SessionsContext.Provider value={sessions}>{children}</SessionsContext.Provider>;
}
export function WorkspaceComposerEditingSessionsProvider({
  workspaceKey,
  tabIds,
  children,
}: {
  workspaceKey: string;
  tabIds: readonly string[];
  children: ReactNode;
}) {
  const sessions = useContext(SessionsContext);
  useEffect(() => sessions?.retain(workspaceKey, tabIds), [sessions, workspaceKey, tabIds]);
  return <WorkspaceContext.Provider value={workspaceKey}>{children}</WorkspaceContext.Provider>;
}
export function ComposerEditingScope({
  tabId,
  targetKey,
  children,
}: {
  tabId: string;
  targetKey: string;
  children: ReactNode;
}) {
  const scope = useMemo(() => ({ tabId, targetKey }), [tabId, targetKey]);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}
export function useComposerEditingSession(
  purpose: ComposerInputMode,
  provided?: ComposerEditingSession,
): ComposerEditingSession {
  const sessions = useContext(SessionsContext);
  const scope = useContext(ScopeContext);
  const workspaceKey = useContext(WorkspaceContext);
  const [local] = useState(() => provided ?? new ComposerEditingSession());
  if (provided) return provided;
  return sessions && scope && workspaceKey
    ? sessions.get(workspaceKey, scope.tabId, scope.targetKey, purpose)
    : local;
}
export function useComposerFullscreen(session: ComposerEditingSession): boolean {
  return useSyncExternalStore(session.subscribe, session.getFullscreen, session.getFullscreen);
}
/** Whether the composer of a workspace tab is fullscreen, for the chrome that tab sits under. */
export function useComposerTabFullscreen(workspaceKey: string, tabId: string | null): boolean {
  const sessions = useContext(SessionsContext);
  const subscribe = useCallback(
    (listener: () => void) => sessions?.subscribe(listener) ?? (() => {}),
    [sessions],
  );
  const read = useCallback(
    () => sessions?.isTabFullscreen(workspaceKey, tabId) ?? false,
    [sessions, workspaceKey, tabId],
  );
  return useSyncExternalStore(subscribe, read, read);
}
