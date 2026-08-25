import { useCallback, useMemo, useRef, useState } from "react";
import type { AgentRuntimeInfo } from "@getpaseo/protocol/agent-types";
import type { RefreshAgentResult } from "@/hooks/use-agent-initialization";
import {
  resolveCodexAccountChange,
  shouldPromptCodexAccountChange,
  type CodexAccountChange,
} from "@/utils/codex-account-change";

interface UseCodexAccountChangePromptInput {
  agentId?: string;
  provider?: string;
  status: string | null;
  runtimeInfo?: AgentRuntimeInfo;
  archived: boolean;
  isInitializing: boolean;
  isConnected: boolean;
  isPaneVisible: boolean;
  isPaneFocused: boolean;
  refreshAgent: (agentId: string) => Promise<RefreshAgentResult>;
  onReloaded: (result: RefreshAgentResult, accountChange: CodexAccountChange) => void;
  onError: (message: string) => void;
}

export interface CodexAccountChangePrompt {
  accountChange: CodexAccountChange | null;
  visible: boolean;
  isReloading: boolean;
  keepCurrentSession: () => void;
  reloadAgent: () => void;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useCodexAccountChangePrompt(
  input: UseCodexAccountChangePromptInput,
): CodexAccountChangePrompt {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [reloadingKey, setReloadingKey] = useState<string | null>(null);
  const reloadInFlightRef = useRef(false);
  const {
    agentId,
    provider,
    status,
    runtimeInfo,
    archived,
    isInitializing,
    isConnected,
    isPaneVisible,
    isPaneFocused,
    refreshAgent,
    onReloaded,
    onError,
  } = input;
  const accountChange = useMemo(() => resolveCodexAccountChange(runtimeInfo), [runtimeInfo]);
  const visible = shouldPromptCodexAccountChange({
    accountChange,
    agentId,
    provider,
    status,
    archived,
    isInitializing,
    isConnected,
    isPaneVisible,
    isPaneFocused,
    promptedKey: dismissedKey,
  });
  const isReloading = Boolean(accountChange && reloadingKey === accountChange.key);

  const keepCurrentSession = useCallback(() => {
    if (accountChange) setDismissedKey(accountChange.key);
  }, [accountChange]);

  const reloadAgent = useCallback(() => {
    if (!accountChange || !agentId || isReloading || reloadInFlightRef.current) return;
    const changeKey = accountChange.key;
    reloadInFlightRef.current = true;
    setReloadingKey(changeKey);
    void refreshAgent(agentId)
      .then((result) => {
        onReloaded(result, accountChange);
        setDismissedKey(changeKey);
        return undefined;
      })
      .catch((error) => onError(toErrorMessage(error)))
      .finally(() => {
        reloadInFlightRef.current = false;
        setReloadingKey(null);
      });
  }, [accountChange, agentId, isReloading, onError, onReloaded, refreshAgent]);

  return {
    accountChange,
    visible,
    isReloading,
    keepCurrentSession,
    reloadAgent,
  };
}
