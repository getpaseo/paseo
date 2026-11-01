import { useCallback } from "react";
import { router } from "expo-router";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { GoalFormSheet } from "@/components/goals/goal-form-sheet";
import { useGoalLaunchStore } from "@/stores/goal-launch-store";
import { buildGoalsRoute } from "@/utils/host-routes";

/** The goal form opened from a chat. Creating the goal opens it on the Goals screen. */
export function GoalLaunchHost() {
  const request = useGoalLaunchStore((state) => state.request);
  const close = useGoalLaunchStore((state) => state.close);
  const handleCreated = useCallback((goal: Goal, serverId: string) => {
    router.push(buildGoalsRoute({ serverId, goalId: goal.id }));
  }, []);

  if (!request) {
    return null;
  }

  return (
    <GoalFormSheet
      key={request.openId}
      serverId={request.serverId}
      prefill={request.prefill}
      onClose={close}
      onCreated={handleCreated}
    />
  );
}
