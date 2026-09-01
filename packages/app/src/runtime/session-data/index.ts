import {
  useSessionStore,
  selectAgentTimelineState,
  selectAgentTurnPresentation,
  type Agent,
  type DaemonServerInfo,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import type { DirectorySync } from "@/runtime/directory-sync";
import type { TurnLivenessTransition } from "@/timeline/turn-liveness";
import type { PendingPermission } from "@/types/shared";
import { QueuedMessageDrainer } from "./internal/queued-message-drainer";

export class SessionDataOwner {
  private readonly directories = new Map<string, DirectorySync>();
  private readonly queuedMessages = new QueuedMessageDrainer();
  private nextCancellationRequestId = 0;

  registerDirectory(serverId: string, directory: DirectorySync): void {
    this.directories.get(serverId)?.dispose();
    this.directories.set(serverId, directory);
  }

  removeDirectory(serverId: string): void {
    this.directories.get(serverId)?.dispose();
    this.directories.delete(serverId);
  }

  directory(serverId: string): DirectorySync | null {
    return this.directories.get(serverId) ?? null;
  }

  acceptAgent(serverId: string, agent: Agent): Agent {
    const directory = this.requireDirectory(serverId);
    return directory.acceptAgent(agent);
  }

  applyTurn(
    serverId: string,
    agentId: string,
    transition: TurnLivenessTransition | readonly TurnLivenessTransition[],
  ): void {
    this.requireDirectory(serverId).applyAgentTurnLiveness(agentId, transition);
  }

  beginCancellation(serverId: string, agentId: string): number {
    this.nextCancellationRequestId += 1;
    const requestId = this.nextCancellationRequestId;
    this.applyTurn(serverId, agentId, { type: "cancellation_started", requestId });
    return requestId;
  }

  settleCancellation(serverId: string, agentId: string, requestId: number): void {
    this.applyTurn(serverId, agentId, { type: "cancellation_settled", requestId });
  }

  acceptWorkspaces(serverId: string, workspaces: readonly WorkspaceDescriptor[]): void {
    this.requireDirectory(serverId).acceptWorkspaces(workspaces);
  }

  acceptProject(serverId: string, project: ProjectDescriptor): void {
    this.requireDirectory(serverId).acceptProject(project);
  }

  removeWorkspace(serverId: string, workspaceId: string): void {
    this.requireDirectory(serverId).removeWorkspace(workspaceId);
  }

  markWorkspacesHydrated(serverId: string, hydrated: boolean): void {
    this.requireDirectory(serverId).markWorkspacesHydrated(hydrated);
  }

  archiveAgent(serverId: string, agentId: string, archivedAt: string): void {
    this.requireDirectory(serverId).archiveAgent(agentId, archivedAt);
  }

  restoreAgent(serverId: string, agentId: string, agent: Agent | null | undefined): void {
    const directory = this.requireDirectory(serverId);
    if (agent) directory.acceptAgent(agent);
    else directory.removeAgent(agentId);
  }

  drainQueuedAgentMessage(serverId: string, agentId: string): void {
    this.queuedMessages.drain(serverId, agentId);
  }

  private requireDirectory(serverId: string): DirectorySync {
    const directory = this.directories.get(serverId);
    if (!directory) throw new Error(`Session data is unavailable for host ${serverId}`);
    return directory;
  }
}

let defaultOwner: SessionDataOwner | null = null;

export function registerDefaultSessionDataOwner(owner: SessionDataOwner): void {
  defaultOwner = owner;
}

function getDefaultOwner(): SessionDataOwner {
  if (!defaultOwner) throw new Error("Session data owner is unavailable");
  return defaultOwner;
}

export function acceptAgentSnapshot(serverId: string, agent: Agent): Agent {
  return getDefaultOwner().acceptAgent(serverId, agent);
}

export function applyAgentTurn(
  serverId: string,
  agentId: string,
  transition: TurnLivenessTransition | readonly TurnLivenessTransition[],
): void {
  getDefaultOwner().applyTurn(serverId, agentId, transition);
}

export function beginAgentCancellation(serverId: string, agentId: string): number {
  return getDefaultOwner().beginCancellation(serverId, agentId);
}

export function settleAgentCancellation(
  serverId: string,
  agentId: string,
  requestId: number,
): void {
  getDefaultOwner().settleCancellation(serverId, agentId, requestId);
}

export function drainQueuedAgentMessage(serverId: string, agentId: string): void {
  getDefaultOwner().drainQueuedAgentMessage(serverId, agentId);
}

const store = () => useSessionStore.getState();

export function readServerInfo(serverId: string): DaemonServerInfo | null {
  return useSessionStore.getState().sessions[serverId]?.serverInfo ?? null;
}

export function hostSupports(
  serverId: string,
  feature: keyof NonNullable<DaemonServerInfo["features"]>,
): boolean {
  return store().sessions[serverId]?.serverInfo?.features?.[feature] === true;
}

export function getAgentSnapshot(serverId: string, agentId: string): Agent | null {
  const session = store().sessions[serverId];
  return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
}

export function getActiveAgentSnapshot(serverId: string, agentId: string): Agent | null {
  return store().sessions[serverId]?.agents.get(agentId) ?? null;
}

export function getWorkspaceDirectorySnapshot(serverId: string) {
  const session = store().sessions[serverId];
  return {
    workspaces: session?.workspaces ?? new Map(),
    projects: session?.projects ?? new Map(),
  };
}

export function getAgentTimelineSnapshot(serverId: string, agentId: string) {
  return selectAgentTimelineState(store().sessions[serverId], agentId);
}

export function getAgentTimelineLoadSnapshot(serverId: string, agentId: string) {
  const session = store().sessions[serverId];
  return {
    timeline: selectAgentTimelineState(session, agentId),
    isLoadingOlder: session?.agentTimelineOlderFetchInFlight.get(agentId) === true,
  };
}

export function getAgentStreamSnapshot(serverId: string, agentId: string) {
  const session = store().sessions[serverId];
  return {
    tail: session?.agentStreamTail.get(agentId) ?? [],
    head: session?.agentStreamHead.get(agentId) ?? [],
  };
}

export function getAgentConversationSnapshot(serverId: string, agentId: string) {
  const session = store().sessions[serverId];
  return {
    pendingPermissions: Array.from(session?.pendingPermissions.values() ?? []).filter(
      (permission) => permission.agentId === agentId,
    ),
  };
}

export function getQueuedMessagesSnapshot(serverId: string, agentId: string) {
  return store().sessions[serverId]?.queuedMessages.get(agentId) ?? [];
}

export function getAgentTurnSnapshot(serverId: string, agentId: string) {
  return selectAgentTurnPresentation(store().sessions[serverId], agentId);
}

export function getSessionFocusSnapshot(serverId: string) {
  const session = store().sessions[serverId];
  return {
    focusedAgentId: session?.focusedAgentId ?? null,
    focusedTerminalId: session?.focusedTerminalId ?? null,
  };
}

export function archiveAgentSnapshot(serverId: string, agentId: string, archivedAt: string): void {
  getDefaultOwner().archiveAgent(serverId, agentId, archivedAt);
}

export function restoreAgentSnapshot(
  serverId: string,
  agentId: string,
  agent: Agent | null | undefined,
): void {
  getDefaultOwner().restoreAgent(serverId, agentId, agent);
}

export const publishAudioPlayback = (
  ...args: Parameters<ReturnType<typeof store>["setIsPlayingAudio"]>
) => store().setIsPlayingAudio(...args);
export const publishAgentInitialization = (
  ...args: Parameters<ReturnType<typeof store>["setInitializingAgents"]>
) => store().setInitializingAgents(...args);
export const advanceHistorySyncGeneration = (
  ...args: Parameters<ReturnType<typeof store>["bumpHistorySyncGeneration"]>
) => store().bumpHistorySyncGeneration(...args);
export const flushAgentActivity = (
  ...args: Parameters<ReturnType<typeof store>["flushAgentLastActivity"]>
) => store().flushAgentLastActivity(...args);
export const publishPendingPermissions = (
  ...args: Parameters<ReturnType<typeof store>["setPendingPermissions"]>
) => store().setPendingPermissions(...args);
export const publishServerInfo = (
  ...args: Parameters<ReturnType<typeof store>["updateSessionServerInfo"]>
) => store().updateSessionServerInfo(...args);
export const publishViewedTimeline = (
  ...args: Parameters<ReturnType<typeof store>["setViewedTimelineSync"]>
) => store().setViewedTimelineSync(...args);

export function publishAgentDetails(
  ...args: Parameters<ReturnType<typeof store>["setAgentDetails"]>
): void {
  store().setAgentDetails(...args);
}

export function replaceAgentPendingPermissions(
  serverId: string,
  agentId: string,
  pendingPermissions: readonly PendingPermission[],
): void {
  store().setPendingPermissions(serverId, (previous) => {
    const next = new Map(previous);
    for (const [key, pending] of next) if (pending.agentId === agentId) next.delete(key);
    for (const permission of pendingPermissions) next.set(permission.key, permission);
    return next;
  });
}

export const publishAgentStreamState = (
  ...args: Parameters<ReturnType<typeof store>["setAgentStreamState"]>
) => store().setAgentStreamState(...args);
export const beginMessageSubmission = (
  ...args: Parameters<ReturnType<typeof store>["beginAgentMessageSubmission"]>
) => store().beginAgentMessageSubmission(...args);
export const acceptMessageSubmission = (
  ...args: Parameters<ReturnType<typeof store>["acceptAgentMessageSubmission"]>
) => store().acceptAgentMessageSubmission(...args);
export const rejectMessageSubmission = (
  ...args: Parameters<ReturnType<typeof store>["rejectAgentMessageSubmission"]>
) => store().rejectAgentMessageSubmission(...args);
export const handoffCreatedAgentSubmission = (
  ...args: Parameters<ReturnType<typeof store>["handoffCreatedAgentUserMessage"]>
) => store().handoffCreatedAgentUserMessage(...args);

export const publishFocusedAgent = (
  ...args: Parameters<ReturnType<typeof store>["setFocusedAgentId"]>
) => store().setFocusedAgentId(...args);
export const publishFocusedTerminal = (
  ...args: Parameters<ReturnType<typeof store>["setFocusedTerminalId"]>
) => store().setFocusedTerminalId(...args);
export const publishOlderTimelineFetch = (
  ...args: Parameters<ReturnType<typeof store>["setAgentTimelineOlderFetchInFlight"]>
) => store().setAgentTimelineOlderFetchInFlight(...args);
export const publishFileExplorer = (
  ...args: Parameters<ReturnType<typeof store>["setFileExplorer"]>
) => store().setFileExplorer(...args);
export const publishQueuedMessages = (
  ...args: Parameters<ReturnType<typeof store>["setQueuedMessages"]>
) => store().setQueuedMessages(...args);

export function acceptWorkspaceSnapshots(
  serverId: string,
  workspaces: readonly WorkspaceDescriptor[],
): void {
  getDefaultOwner().acceptWorkspaces(serverId, workspaces);
}
export function removeWorkspaceSnapshot(serverId: string, workspaceId: string): void {
  getDefaultOwner().removeWorkspace(serverId, workspaceId);
}
export function acceptProjectSnapshot(serverId: string, project: ProjectDescriptor): void {
  getDefaultOwner().acceptProject(serverId, project);
}
export function publishWorkspaceHydration(serverId: string, hydrated: boolean): void {
  getDefaultOwner().markWorkspacesHydrated(serverId, hydrated);
}
