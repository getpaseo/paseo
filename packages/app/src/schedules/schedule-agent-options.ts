import type { AggregateLoadState } from "@/schedules/aggregated-schedules";
import type {
  HostRuntimeAgentDirectoryStatus,
  HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { shortenPath } from "@/utils/shorten-path";

export const UNTITLED_AGENT_LABEL = "Untitled agent";

/** The agent-directory facts the schedule form needs to name and offer a target. */
export interface ScheduleFormAgent {
  id: string;
  serverId: string;
  title: string | null;
  cwd: string;
  archived: boolean;
}

export interface ScheduleFormAgentOption {
  id: string;
  value: string;
  label: string;
  description: string;
  testID: string;
}

export interface ScheduleAgentDirectoryInput {
  serverId: string;
  /** Every known agent across hosts, archived included; scoped here. */
  agents: readonly ScheduleFormAgent[];
  connectionStatus: HostRuntimeConnectionStatus | null;
  directoryStatus: HostRuntimeAgentDirectoryStatus | null;
  hasEverLoadedAgentDirectory: boolean;
}

export function scheduleAgentLabel(agent: Pick<ScheduleFormAgent, "title">): string {
  return agent.title?.trim() || UNTITLED_AGENT_LABEL;
}

/**
 * The pickable agents for one host: archived entries are dropped because the
 * daemon fails an archived target outright (ScheduleTargetGoneError), so
 * offering one would create a schedule that can only ever fail. Input order is
 * preserved — callers pass the directory's own running-first, most-recent-next
 * order, which is the right default for "message this agent".
 */
export function buildScheduleAgentOptions(
  agents: readonly ScheduleFormAgent[],
): ScheduleFormAgentOption[] {
  return agents
    .filter((agent) => !agent.archived)
    .map((agent) => ({
      id: agent.id,
      value: agent.id,
      label: scheduleAgentLabel(agent),
      description: shortenPath(agent.cwd),
      testID: `schedule-agent-option-${agent.id}`,
    }));
}

/**
 * Turn one host's runtime directory status into the load state the form
 * renders. The distinction that matters: "no agents" is only claimable once
 * that host has actually answered. A cold cache, a connecting host, or a first
 * fetch that failed all read as still-resolving, never as empty — otherwise the
 * picker tells the user a busy host has nothing on it.
 */
export function buildScheduleAgentDirectoryState(
  input: ScheduleAgentDirectoryInput,
): AggregateLoadState<ScheduleFormAgent> {
  const { agents, connectionStatus, directoryStatus, hasEverLoadedAgentDirectory } = input;
  const hostAgents = agents.filter((agent) => agent.serverId === input.serverId);

  if (directoryStatus === null || connectionStatus === null) {
    return { status: "connecting" };
  }
  if (directoryStatus === "initial_loading") {
    return { status: "loading" };
  }
  if (directoryStatus === "error_before_first_success") {
    return { status: "connecting" };
  }
  if (!hasEverLoadedAgentDirectory) {
    // Never answered: connecting hosts are still on their way, and an idle host
    // has not been asked yet. Either way this is not an empty directory.
    return { status: "connecting" };
  }
  // ready, revalidating, or error_after_ready: serve what the host last gave us
  // rather than blanking a populated list while it refreshes.
  return { status: "loaded", data: hostAgents };
}
