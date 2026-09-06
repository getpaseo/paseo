import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { buildScheduleAgentDirectoryState } from "./schedule-agent-options";
import type { ScheduleFormModel, ScheduleFormState } from "./schedule-form-model";

/**
 * Feeds the open form the agent directory of the host it is targeting, and
 * keeps that host's directory synced for as long as the form is open. Purely
 * input plumbing: every decision about what the picker shows lives in the
 * model.
 */
export function useScheduleFormAgentDirectory(
  model: ScheduleFormModel,
  state: ScheduleFormState,
): void {
  const serverId = state.agentDirectoryRequest?.serverId ?? null;
  const runtime = getHostRuntimeStore();
  useEffect(() => {
    if (!serverId) {
      return;
    }
    return runtime.acquireDirectoryDemand(serverId);
  }, [runtime, serverId]);

  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const { agents } = useAggregatedAgents({ includeArchived: true, demand: false });

  const directory = useMemo(() => {
    if (!serverId) {
      return null;
    }
    // runtimeVersion is the subscription's change token: host status moves are
    // what make this recompute.
    void runtimeVersion;
    const snapshot = runtime.getSnapshot(serverId) ?? null;
    return buildScheduleAgentDirectoryState({
      serverId,
      agents: agents.map((agent) => ({
        id: agent.id,
        serverId: agent.serverId,
        title: agent.title,
        cwd: agent.cwd,
        archived: Boolean(agent.archivedAt),
      })),
      connectionStatus: snapshot?.connectionStatus ?? null,
      directoryStatus: snapshot?.agentDirectoryStatus ?? null,
      hasEverLoadedAgentDirectory: snapshot?.hasEverLoadedAgentDirectory ?? false,
    });
  }, [agents, runtime, runtimeVersion, serverId]);

  useEffect(() => {
    if (!serverId || !directory) {
      return;
    }
    model.applyAgentDirectory(serverId, directory);
  }, [directory, model, serverId]);
}
