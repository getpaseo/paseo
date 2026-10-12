import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
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
  agentId?: string;
  workspaceRoot?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  getDirectorySuggestions: GetDirectorySuggestions;
  chooseOption(input: {
    title: string;
    options: Array<{ value: string; label: string }>;
  }): Promise<string | null>;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  agentId,
  workspaceRoot,
  onOpenWorkspaceFile,
  toast,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const configRef = useRef<AssistantFileLinkResolverConfig>({
    client,
    serverId,
    agentId,
    workspaceRoot,
    onOpenWorkspaceFile,
    toast,
  });
  configRef.current = { client, serverId, agentId, workspaceRoot, onOpenWorkspaceFile, toast };

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  const [selection, setSelection] = useState<{
    title: string;
    options: Array<{ value: string; label: string }>;
    resolve(value: string | null): void;
  } | null>(null);
  const selectionRef = useRef<typeof selection>(null);
  const chooseOption = useCallback<AssistantFileLinkResolverContextValue["chooseOption"]>(
    (input) =>
      new Promise((resolve) => {
        selectionRef.current?.resolve(null);
        selectionRef.current = { ...input, resolve };
        setSelection(selectionRef.current);
      }),
    [],
  );
  const finishSelection = useCallback((value: string | null) => {
    selectionRef.current?.resolve(value);
    selectionRef.current = null;
    setSelection(null);
  }, []);
  useEffect(() => {
    setSelection(null);
    return () => {
      selectionRef.current?.resolve(null);
      selectionRef.current = null;
    };
  }, [serverId, agentId, workspaceRoot]);
  const closeSelection = useCallback(() => finishSelection(null), [finishSelection]);

  const selectionHeader = useMemo(() => ({ title: selection?.title ?? "" }), [selection?.title]);
  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({ configRef, getDirectorySuggestions, chooseOption }),
    [getDirectorySuggestions, chooseOption],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
      <AdaptiveModalSheet
        visible={selection !== null}
        onClose={closeSelection}
        header={selectionHeader}
        testID="file-link-choice"
      >
        <View style={selectionStyles.options}>
          {selection?.options.map((option) => (
            <FileChoice key={option.value} option={option} onSelect={finishSelection} />
          ))}
        </View>
      </AdaptiveModalSheet>
    </AssistantFileLinkResolverContext.Provider>
  );
}

function FileChoice({
  option,
  onSelect,
}: {
  option: { value: string; label: string };
  onSelect(value: string): void;
}) {
  const select = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  return (
    <Button variant="ghost" onPress={select}>
      <Text numberOfLines={3}>{option.label}</Text>
    </Button>
  );
}
const selectionStyles = StyleSheet.create((theme) => ({ options: { gap: theme.spacing[2] } }));

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  if (!context) {
    throw new Error("AssistantFileLinkResolverProvider is required for assistant file links.");
  }
  return context;
}

export type { AssistantFileLinkContext };
