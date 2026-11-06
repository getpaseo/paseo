import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createAgentAttentionController } from "@/utils/agent-attention";
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
  requiresAttention,
  attentionReason,
  isScreenFocused,
  focusRequest,
  onError,
}: UseAgentAttentionClearParams): AgentAttentionClearController {
  const [isAppVisible, setIsAppVisible] = useState<boolean>(() => getIsAppActivelyVisible());
  const controller = useMemo(
    () =>
      createAgentAttentionController({
        clear: async () => {
          if (client && agentId) await client.clearAgentAttention(agentId);
        },
        onError,
      }),
    [agentId, client, onError],
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
      ready: Boolean(client && agentId && isConnected && requiresAttention != null),
      requiresAttention: Boolean(requiresAttention),
      attentionReason,
      focusRequest,
    });
  }, [
    controller,
    client,
    agentId,
    isConnected,
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
