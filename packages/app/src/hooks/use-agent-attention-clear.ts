import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createAgentAttentionController } from "@/utils/agent-attention";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";

type AttentionReason = "finished" | "error" | "permission" | null | undefined;

interface UseAgentAttentionClearParams {
  agentId: string | null | undefined;
  client: DaemonClient | null;
  isConnected: boolean;
  isAgentDataReady: boolean;
  requiresAttention: boolean;
  attentionReason: AttentionReason;
  isScreenFocused: boolean;
  focusRequest: object | null;
  onError: (error: unknown) => void;
}

interface AgentAttentionClearController {
  clearOnInputFocus: () => void;
  clearOnPromptSend: () => void;
}

export function useAgentAttentionClear({
  agentId,
  client,
  isConnected,
  isAgentDataReady,
  requiresAttention,
  attentionReason,
  isScreenFocused,
  focusRequest,
  onError,
}: UseAgentAttentionClearParams): AgentAttentionClearController {
  const [isAppVisible, setIsAppVisible] = useState<boolean>(() => getIsAppActivelyVisible());
  const clearAttention = useStableEvent(async (id: string) => {
    if (client) await client.clearAgentAttention(id);
  });
  const reportError = useStableEvent((error: unknown) => {
    // The timeline's reconnect status already explains a lost connection.
    if (error instanceof DaemonConnectionError && error.code === "DAEMON_CONNECTION_LOST") return;
    onError(error);
  });
  const controller = useMemo(
    () =>
      createAgentAttentionController({
        clear: async () => {
          if (agentId) await clearAttention(agentId);
        },
        onError: reportError,
      }),
    [agentId, clearAttention, reportError],
  );

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
    controller.update({
      focused: isScreenFocused && isAppVisible,
      ready: Boolean(client && agentId && isConnected && isAgentDataReady),
      requiresAttention,
      attentionReason,
      focusRequest,
    });
  }, [
    controller,
    client,
    agentId,
    isConnected,
    isAgentDataReady,
    isScreenFocused,
    isAppVisible,
    requiresAttention,
    attentionReason,
    focusRequest,
  ]);

  return {
    clearOnInputFocus: controller.focus,
    clearOnPromptSend: controller.focus,
  };
}
