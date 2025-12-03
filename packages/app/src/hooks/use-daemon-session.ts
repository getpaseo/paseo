import { useCallback, useMemo, useRef } from "react";
import { Alert } from "react-native";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore, type SessionState } from "@/stores/session-store";

export class DaemonSessionUnavailableError extends Error {
  serverId: string;

  constructor(serverId: string) {
    super(`Host session "${serverId}" is unavailable`);
    this.name = "DaemonSessionUnavailableError";
    this.serverId = serverId;
  }
}

type UseDaemonSessionOptions = {
  suppressUnavailableAlert?: boolean;
  allowUnavailable?: boolean;
};

// Combined type: SessionState (from store) + imperative APIs (from context)
export type DaemonSession = SessionState & {
  // Imperative APIs from context
  setVoiceDetectionFlags: (isDetecting: boolean, isSpeaking: boolean) => void;
  requestGitDiff: (agentId: string) => void;
  requestDirectoryListing: (agentId: string, path: string, options?: { recordHistory?: boolean }) => void;
  requestFilePreview: (agentId: string, path: string) => void;
  navigateExplorerBack: (agentId: string) => string | null;
  requestProviderModels: (provider: any, options?: { cwd?: string }) => void;
  restartServer: (reason?: string) => void;
  initializeAgent: (params: { agentId: string; requestId?: string }) => void;
  refreshAgent: (params: { agentId: string; requestId?: string }) => void;
  refreshSession: () => void;
  cancelAgentRun: (agentId: string) => void;
  sendAgentMessage: (
    agentId: string,
    message: string,
    images?: Array<{ uri: string; mimeType?: string }>
  ) => Promise<void>;
  sendAgentAudio: (
    agentId: string,
    audioBlob: Blob,
    requestId?: string,
    options?: { mode?: "transcribe_only" | "auto_run" }
  ) => Promise<void>;
  deleteAgent: (agentId: string) => void;
  createAgent: (options: {
    config: any;
    initialPrompt: string;
    git?: any;
    worktreeName?: string;
    requestId?: string;
  }) => void;
  resumeAgent: (options: { handle: any; overrides?: any; requestId?: string }) => void;
  setAgentMode: (agentId: string, modeId: string) => void;
  respondToPermission: (agentId: string, requestId: string, response: any) => void;
  // State getters/setters that components might use directly
  getDraftInput: (agentId: string) => any;
  saveDraftInput: (agentId: string, draft: any) => void;
  setFocusedAgentId: (agentId: string | null) => void;
  setMessages: (messages: any[] | ((prev: any[]) => any[])) => void;
  setQueuedMessages: (value: any) => void;
};

export function useDaemonSession(
  serverId?: string | null,
  options?: UseDaemonSessionOptions & { allowUnavailable?: false }
): DaemonSession | null;
export function useDaemonSession(
  serverId: string | null | undefined,
  options: UseDaemonSessionOptions & { allowUnavailable: true }
): DaemonSession | null;
export function useDaemonSession(serverId?: string | null, options?: UseDaemonSessionOptions) {

  const selectSession = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) => {
      if (!serverId) {
        return null;
      }
      return state.sessions[serverId] ?? null;
    },
    [serverId]
  );
  const sessionState = useSessionStore(selectSession);
  const { connectionStates } = useDaemonConnections();
  const alertedDaemonsRef = useRef<Set<string>>(new Set());
  const loggedDaemonsRef = useRef<Set<string>>(new Set());
  const { suppressUnavailableAlert = false, allowUnavailable = false } = options ?? {};

  // Get store actions (these are already stable from Zustand)
  const getDraftInputAction = useSessionStore((state) => state.getDraftInput);
  const saveDraftInputAction = useSessionStore((state) => state.saveDraftInput);
  const setFocusedAgentIdAction = useSessionStore((state) => state.setFocusedAgentId);
  const setMessagesAction = useSessionStore((state) => state.setMessages);
  const setQueuedMessagesAction = useSessionStore((state) => state.setQueuedMessages);

  // Create stable wrapper functions (must be before conditional returns)
  const boundGetDraftInput = useCallback(
    (agentId: string) => getDraftInputAction(agentId),
    [getDraftInputAction]
  );
  const boundSaveDraftInput = useCallback(
    (agentId: string, draft: any) => { saveDraftInputAction(agentId, draft); },
    [saveDraftInputAction]
  );
  const boundSetFocusedAgentId = useCallback(
    (agentId: string | null) => { if (serverId) setFocusedAgentIdAction(serverId, agentId); },
    [serverId, setFocusedAgentIdAction]
  );
  const boundSetMessages = useCallback(
    (messages: any) => { if (serverId) setMessagesAction(serverId, messages); },
    [serverId, setMessagesAction]
  );
  const boundSetQueuedMessages = useCallback(
    (value: any) => { if (serverId) setQueuedMessagesAction(serverId, value); },
    [serverId, setQueuedMessagesAction]
  );

  // Memoize the combined object to prevent infinite re-renders
  const combined = useMemo<DaemonSession | null>(() => {
    if (!serverId || !sessionState || !sessionState.methods) {
      return null;
    }

    return {
      ...sessionState,
      ...sessionState.methods,
      getDraftInput: boundGetDraftInput,
      saveDraftInput: boundSaveDraftInput,
      setFocusedAgentId: boundSetFocusedAgentId,
      setMessages: boundSetMessages,
      setQueuedMessages: boundSetQueuedMessages,
    };
  }, [
    serverId,
    sessionState,
    boundGetDraftInput,
    boundSaveDraftInput,
    boundSetFocusedAgentId,
    boundSetMessages,
    boundSetQueuedMessages,
  ]);

  if (!serverId) {
    return null;
  }

  if (combined) {
    console.log("[useDaemonSession] Debug", {
      serverId,
      hasSessionState: !!sessionState,
      hasMethods: !!sessionState?.methods,
      sessionStateKeys: sessionState ? Object.keys(sessionState).slice(0, 5) : [],
    });
    return combined;
  }

  // Handle unavailable session
  const connection = connectionStates.get(serverId);
  const label = connection?.daemon.label ?? serverId;
  const status = connection?.status ?? "unknown";
  const lastError = connection?.lastError ? `\n${connection.lastError}` : "";
  const message = `${label} isn't connected yet (${status}). Paseo reconnects automatically and will enable actions once it's back.${lastError}`;

  if (!suppressUnavailableAlert && !alertedDaemonsRef.current.has(serverId)) {
    alertedDaemonsRef.current.add(serverId);
    Alert.alert("Host unavailable", message.trim());
  }

  if (!loggedDaemonsRef.current.has(serverId)) {
    loggedDaemonsRef.current.add(serverId);
    console.warn(`[useDaemonSession] Session unavailable for daemon "${label}" (${status}).`);
  }

  if (allowUnavailable) {
    return null;
  }

  throw new DaemonSessionUnavailableError(serverId);
}
