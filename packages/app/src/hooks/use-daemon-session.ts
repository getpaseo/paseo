import { useCallback, useRef, useContext } from "react";
import { Alert } from "react-native";
import { SessionContext } from "@/contexts/session-context";
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
  const context = useContext(SessionContext);
  const { connectionStates } = useDaemonConnections();
  const alertedDaemonsRef = useRef<Set<string>>(new Set());
  const loggedDaemonsRef = useRef<Set<string>>(new Set());
  const { suppressUnavailableAlert = false, allowUnavailable = false } = options ?? {};

  // Get store actions
  const getDraftInput = useSessionStore((state) => state.getDraftInput);
  const saveDraftInput = useSessionStore((state) => state.saveDraftInput);
  const setFocusedAgentId = useSessionStore((state) => state.setFocusedAgentId);
  const setMessages = useSessionStore((state) => state.setMessages);
  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);

  if (!serverId) {
    return null;
  }

  try {
    if (!sessionState || !context) {
      throw new DaemonSessionUnavailableError(serverId);
    }

    // Combine session state with imperative APIs from context and store actions
    const combined: DaemonSession = {
      ...sessionState,
      ...context,
      // Wrap store actions to bind serverId
      getDraftInput: (agentId: string) => getDraftInput(serverId, agentId),
      saveDraftInput: (agentId: string, draft: any) => saveDraftInput(serverId, agentId, draft),
      setFocusedAgentId: (agentId: string | null) => setFocusedAgentId(serverId, agentId),
      setMessages: (messages: any) => setMessages(serverId, messages),
      setQueuedMessages: (value: any) => setQueuedMessages(serverId, value),
    };

    return combined;
  } catch (error) {
    if (error instanceof DaemonSessionUnavailableError) {
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
    }
    throw error;
  }
}
