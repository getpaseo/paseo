import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkContext, GetDirectorySuggestions } from "./resolver";

export interface AssistantFileLinkDaemonClient {
  getDirectorySuggestions: GetDirectorySuggestions;
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  // Recognizes a leading-slash inline-code token (bare command name, no slash)
  // as a known slash command / skill for the current agent, so the code_inline
  // rule can render it as a command chip instead of a file link.
  isSlashCommand?: (name: string) => boolean;
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  getDirectorySuggestions: GetDirectorySuggestions;
  // Carried by value, unlike the rest of the config, because it decides what a
  // token *renders as* rather than what a press *does*. The per-agent command
  // list arrives from the network after the transcript first renders, and
  // AssistantMessage is memoized, so a configRef mutation would never reach an
  // already-rendered history message. A context value change re-renders every
  // consumer even behind memo, which is what makes late-arriving commands show
  // up as chips.
  isSlashCommand?: (name: string) => boolean;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  onOpenWorkspaceFile,
  toast,
  isSlashCommand,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const configRef = useRef<AssistantFileLinkResolverConfig>({
    client,
    serverId,
    workspaceRoot,
    onOpenWorkspaceFile,
    toast,
  });
  configRef.current = {
    client,
    serverId,
    workspaceRoot,
    onOpenWorkspaceFile,
    toast,
  };

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({ configRef, getDirectorySuggestions, isSlashCommand }),
    [getDirectorySuggestions, isSlashCommand],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  if (!context) {
    throw new Error("AssistantFileLinkResolverProvider is required for assistant file links.");
  }
  return context;
}

export type { AssistantFileLinkContext };
