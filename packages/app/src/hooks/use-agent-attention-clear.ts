import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@server/client/daemon-client";
import {
  shouldClearAgentAttention,
  type AgentAttentionClearTrigger,
} from "@/utils/agent-attention";
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
  const deferredFocusEntryClearRef = useRef(false);
  const prevRequiresAttentionRef = useRef(Boolean(requiresAttention));
  const prevActivelyViewedRef = useRef(isScreenFocused && getIsAppActivelyVisible());
  const prevScreenFocusedRef = useRef(false);
  const prevAppVisibleRef = useRef(getIsAppActivelyVisible());

  const clearAttention = useCallback(
    (trigger: AgentAttentionClearTrigger) => {
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
          trigger,
          hasDeferredFocusEntryClear: deferredFocusEntryClearRef.current,
        })
      ) {
        return;
      }
      deferredFocusEntryClearRef.current = false;
      client.clearAgentAttention(resolvedAgentId).catch(() => {});
    },
    [agentId, attentionReason, client, isConnected, requiresAttention],
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
    if (!requiresAttention) {
      deferredFocusEntryClearRef.current = false;
    }
  }, [requiresAttention]);

  useEffect(() => {
    const isActivelyViewed = isScreenFocused && isAppVisible;
    if (
      !prevRequiresAttentionRef.current &&
      Boolean(requiresAttention) &&
      prevActivelyViewedRef.current &&
      isActivelyViewed
    ) {
      deferredFocusEntryClearRef.current = true;
    }
    prevRequiresAttentionRef.current = Boolean(requiresAttention);
    prevActivelyViewedRef.current = isActivelyViewed;
  }, [isAppVisible, isScreenFocused, requiresAttention]);

  useEffect(() => {
    const enteredScreenFocus = !prevScreenFocusedRef.current && isScreenFocused && isAppVisible;
    const resumedIntoFocusedAgent = !prevAppVisibleRef.current && isAppVisible && isScreenFocused;

    if (enteredScreenFocus || resumedIntoFocusedAgent) {
      clearAttention("focus-entry");
    }

    prevScreenFocusedRef.current = isScreenFocused;
    prevAppVisibleRef.current = isAppVisible;
  }, [clearAttention, isAppVisible, isScreenFocused]);

  return {
    clearOnInputFocus: useCallback(() => {
      clearAttention("input-focus");
    }, [clearAttention]),
    clearOnPromptSend: useCallback(() => {
      clearAttention("prompt-send");
    }, [clearAttention]),
    clearOnAgentBlur: useCallback(() => {
      clearAttention("agent-blur");
    }, [clearAttention]),
  };
}
