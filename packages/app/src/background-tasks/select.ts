import { useMemo } from "react";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import { selectBackgroundTasksForParent, useBackgroundTaskStore } from "./store";

export function useBackgroundTasksForParent(input: {
  serverId: string;
  parentAgentId: string;
}): BackgroundTaskDescriptorPayload[] {
  const tasks = useBackgroundTaskStore((state) => state.tasks);
  return useMemo(
    () => selectBackgroundTasksForParent(tasks, input.serverId, input.parentAgentId),
    [tasks, input.serverId, input.parentAgentId],
  );
}
