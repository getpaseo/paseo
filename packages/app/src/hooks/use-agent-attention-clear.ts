import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { shouldClearAgentAttention } from "@/utils/agent-attention";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { isWeb } from "@/constants/platform";

type AttentionReason = "finished" | "error" | "permission" | null | undefined;

interface UseAgentAttentionClearParams {
  agentId: string | null | undefined;
  client: DaemonClient | null;
  isConnected: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason: AttentionReason;
  isScreenFocused: boolean;
}

interface AgentAttentionClearController {
  clearOnInputFocus: () => void;
  clearOnPromptSend: () => void;
  clearOnAgentBlur: () => void;
}

export function useAgentAttentionClear({
  agentId,
  client,
  isConnected,
  requiresAttention,
  attentionReason,
  isScreenFocused,
}: UseAgentAttentionClearParams): AgentAttentionClearController {
  const [isAppVisible, setIsAppVisible] = useState<boolean>(() => getIsAppActivelyVisible());
  const clearAttention = useCallback(() => {
    const resolvedAgentId = agentId?.trim();
    if (!client || !resolvedAgentId) {
      return;
    }
    if (
      !shouldClearAgentAttention({
        agentId: resolvedAgentId,
        isConnected,
        requiresAttention,
        attentionReason,
      })
    ) {
      return;
    }
    client.clearAgentAttention(resolvedAgentId).catch(() => {});
  }, [agentId, attentionReason, client, isConnected, requiresAttention]);

  useEffect(() => {
    const updateVisibility = () => {
      setIsAppVisible(getIsAppActivelyVisible());
    };

    const appStateSubscription = AppState.addEventListener("change", updateVisibility);

    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", updateVisibility);
      window.addEventListener("focus", updateVisibility);
      window.addEventListener("blur", updateVisibility);

      return () => {
        appStateSubscription.remove();
        document.removeEventListener("visibilitychange", updateVisibility);
        window.removeEventListener("focus", updateVisibility);
        window.removeEventListener("blur", updateVisibility);
      };
    }

    return () => {
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (isScreenFocused && isAppVisible) {
      clearAttention();
    }
  }, [clearAttention, isAppVisible, isScreenFocused]);

  return {
    clearOnInputFocus: clearAttention,
    clearOnPromptSend: clearAttention,
    clearOnAgentBlur: clearAttention,
  };
}
