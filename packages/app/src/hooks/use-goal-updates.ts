import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GoalSummary } from "@getpaseo/protocol/goal/types";
import { applyGoalPush } from "@/goals/goal-updates";
import { goalDetailQueryKey, goalListArchivedModeOfKey, goalListQueryKey } from "@/hooks/use-goals";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useGoalAttentionStore } from "@/stores/goal-attention-store";

/**
 * Applies `goal.update` pushes from one host to the cached goal list and refetches an open
 * detail, so the badge and toasts react at once. Polling stays on at a slower rate while the
 * subscription is live, since a push missed across a reconnect is not replayed.
 */
export function useGoalUpdates(serverId: string): void {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "goalUpdates");

  useEffect(() => {
    if (!client || !isConnected || !supported) {
      return;
    }
    const store = useGoalAttentionStore.getState();
    const listKey = goalListQueryKey(serverId);
    let observation: ReturnType<typeof client.observeGoalUpdates>;
    try {
      observation = client.observeGoalUpdates();
    } catch (error) {
      // The client checks the same flag; polling covers the host until it reports it.
      console.warn("[Goals] Goal updates unavailable", error);
      return;
    }
    observation.subscribe({
      // Sent on subscribe and again after every reconnect: catch up on what was missed.
      snapshot: () => {
        store.setPushLive(serverId, true);
        void queryClient.invalidateQueries({ queryKey: listKey });
      },
      update: (message) => {
        if (message.type !== "goal.update") {
          return;
        }
        const goal: GoalSummary = message.payload.goal;
        const deleted = message.payload.deleted === true;
        // Before the first list arrives there is nothing to compare with; let the fetch fill it.
        if (queryClient.getQueryData<GoalSummary[]>(listKey) === undefined) {
          void queryClient.invalidateQueries({ queryKey: listKey });
        }
        // The default list and, while the Goals screen shows them, the list with archived goals.
        for (const [queryKey, current] of queryClient.getQueriesData<GoalSummary[]>({
          queryKey: listKey,
        })) {
          if (current) {
            queryClient.setQueryData<GoalSummary[]>(
              queryKey,
              applyGoalPush(current, goal, {
                deleted,
                archived: goalListArchivedModeOfKey(queryKey),
              }),
            );
          }
        }
        const detailKey = goalDetailQueryKey(serverId, goal.id);
        if (deleted) {
          queryClient.removeQueries({ queryKey: detailKey });
        } else {
          void queryClient.invalidateQueries({ queryKey: detailKey });
        }
      },
      error: () => {
        store.setPushLive(serverId, false);
      },
    });
    return () => {
      store.setPushLive(serverId, false);
      void observation
        .release()
        .catch((error) => console.warn("[Goals] Failed to release goal updates", error));
    };
  }, [client, isConnected, queryClient, serverId, supported]);
}
