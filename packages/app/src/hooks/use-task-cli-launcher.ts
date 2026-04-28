// useTaskCliLauncher — launches a CLI agent terminal for a kanban task
// Wires the kanban task creation flow to the terminal system

import { useCallback } from "react";
import { useKanbanStore } from "@/stores/kanban-store";
import { useCliAgentLaunch } from "./use-cli-agent-launch";
import type { KanbanTask } from "@/types/kanban";
import type { CliProviderId } from "@server/shared/cli-provider-registry";

export function useTaskCliLauncher(serverId: string | null) {
  const updateTask = useKanbanStore((s) => s.updateTask);
  const setStatus = useKanbanStore((s) => s.setStatus);
  const { launch, isLaunching } = useCliAgentLaunch(serverId);

  /**
   * Launch a CLI agent in a terminal for the given task.
   * Updates the task with the terminal ID and moves it to "in-progress".
   */
  const launchForTask = useCallback(
    async (task: KanbanTask) => {
      if (task.agentMode !== "cli" || !task.agentProvider) {
        return null;
      }

      const cwd = task.path || process.cwd?.() || "/";

      const result = await launch({
        providerId: task.agentProvider as CliProviderId,
        cwd,
        autoApprove: task.autoApprove,
        initialPrompt: task.prompt,
        name: `${task.name} — ${task.agentProvider}`,
      });

      // Update the task with terminal reference
      updateTask(task.id, { terminalId: result.terminalId });

      // Move task to in-progress
      setStatus(task.id, "in-progress");

      return result;
    },
    [launch, updateTask, setStatus],
  );

  return { launchForTask, isLaunching };
}
