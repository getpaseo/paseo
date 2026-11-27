import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import {
  countGoalsBlockedOnUser,
  findNewGoalAttention,
  snapshotGoalAttention,
  type GoalAttentionSnapshot,
} from "@/goals/goal-attention";
import { goalWaitingOnText } from "@/goals/goal-waiting-on";
import { useGoalUpdates } from "@/hooks/use-goal-updates";
import { GOALS_BACKGROUND_POLL_MS, useGoalList } from "@/hooks/use-goals";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { useGoalAttentionStore } from "@/stores/goal-attention-store";

const TOAST_DURATION_MS = 5_000;

/**
 * Watches every host that runs goals, counts the goals blocked on you for the sidebar badge, and
 * shows a toast when one starts waiting. Hosts with `goalUpdates` push each change, which lands in
 * the same list query, so the toast fires at once; others are polled.
 */
export function GoalAttentionWatcher() {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportsGoals = useHostFeatureMap(serverIds, "goals");
  return (
    <>
      {serverIds
        .filter((serverId) => supportsGoals.get(serverId))
        .map((serverId) => (
          <HostGoalAttentionWatcher key={serverId} serverId={serverId} />
        ))}
    </>
  );
}

function HostGoalAttentionWatcher({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  useGoalUpdates(serverId);
  const { loadState } = useGoalList({
    serverId,
    enabled: true,
    pollMs: GOALS_BACKGROUND_POLL_MS,
  });
  const goals = loadState.status === "loaded" ? loadState.data : null;
  // The previous list, compared with the next; not rendered.
  const previousRef = useRef<GoalAttentionSnapshot | null>(null);

  useEffect(() => {
    if (!goals) {
      return;
    }
    useGoalAttentionStore.getState().setBlocked(serverId, countGoalsBlockedOnUser(goals));
    const transitions = findNewGoalAttention(previousRef.current, goals);
    previousRef.current = snapshotGoalAttention(goals);
    const [first] = transitions;
    if (!first) {
      return;
    }
    let message: string;
    if (transitions.length > 1) {
      message = t("goals.toasts.several", { n: transitions.length });
    } else {
      // A goal held on you says what it waits on; a failure has nothing left to wait on.
      const waiting = goalWaitingOnText(t, first.goal);
      message = waiting
        ? t("goals.toasts.waiting", { title: first.goal.title, waiting })
        : t(`goals.toasts.${first.kind}`, { title: first.goal.title });
    }
    toast.show(message, {
      variant: first.kind === "failed" ? "error" : "info",
      durationMs: TOAST_DURATION_MS,
      testID: "goal-attention-toast",
    });
  }, [goals, serverId, t, toast]);

  useEffect(() => {
    return () => {
      useGoalAttentionStore.getState().clear(serverId);
    };
  }, [serverId]);

  return null;
}
