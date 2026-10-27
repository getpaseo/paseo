import { i18n } from "@/i18n/i18next";
import { selectIsAgentPublished, useSessionStore } from "@/stores/session-store";
import { randomUUID } from "./internal/random-id";
import { useSyncExternalStore } from "react";
import { createWorkspaceCreationModel, type CreationAttempt } from "./model";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { createUserMessage } from "@/types/stream";

export const workspaceCreations = createWorkspaceCreationModel({
  identities: () => ({
    operationKey: randomUUID(),
    workspaceId: `wks_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    agentId: randomUUID(),
    clientMessageId: randomUUID(),
  }),
  execute: async (request, serverId) => {
    const { getHostRuntimeStore } = await import("@/runtime/host-runtime");
    const runtime = getHostRuntimeStore();
    const client = runtime.getClient(serverId);
    if (!client) throw new Error(i18n.t("newWorkspace.errors.hostDisconnected"));
    const workspaceId = request.workspaceId;
    if (!workspaceId) throw new Error("Workspace creation requires a reserved identity");
    const releaseDirectory = runtime.acquireDirectoryDemand(serverId);
    // Failed and adopted creations both leave the model.
    const stop = workspaceCreations.subscribe(() => {
      if (workspaceCreations.getWorkspace(serverId, workspaceId)) return;
      stop();
      releaseDirectory();
    });
    return client.createWorkspace(request);
  },
  onSubmitted: (attempt) => {
    createMessageSubmissionWriter(attempt.serverId).begin(
      attempt.agentId,
      createUserMessage({
        ...attempt.message,
        text: attempt.text,
        timestamp: attempt.message?.timestamp ?? new Date(),
        id: attempt.clientMessageId,
        clientMessageId: attempt.clientMessageId,
      }),
    );
  },
  onFailed: (attempt) => {
    createMessageSubmissionWriter(attempt.serverId).reject(
      attempt.agentId,
      attempt.clientMessageId,
    );
  },
  onAdopted: (attempt) => {
    // Prompts queued during creation waited for this. A running agent drains them when it stops.
    // The host started the initial prompt before completing, so its local submission is not
    // evidence of a running turn; only the host's turn state is.
    const session = useSessionStore.getState().sessions[attempt.serverId];
    const agent =
      session?.agents.get(attempt.agentId) ?? session?.agentDetails.get(attempt.agentId);
    if (agent?.turn.phase !== "idle") return;
    void import("@/runtime/host-runtime").then(({ getHostRuntimeStore }) =>
      getHostRuntimeStore().drainQueuedAgentMessage(attempt.serverId, attempt.agentId),
    );
  },
  onComplete: (attempt) => {
    createMessageSubmissionWriter(attempt.serverId).accept(
      attempt.agentId,
      attempt.clientMessageId,
    );
  },
});
export function useWorkspaceCreations() {
  return useSyncExternalStore(
    workspaceCreations.subscribe,
    workspaceCreations.getSnapshot,
    workspaceCreations.getSnapshot,
  );
}
export function useWorkspaceCreation(
  serverId: string,
  workspaceId: string,
): CreationAttempt | null {
  return (
    useWorkspaceCreations().find(
      (attempt) =>
        attempt.serverId === serverId &&
        attempt.workspaceId === workspaceId &&
        (attempt.phase !== "complete" || !attempt.workspaceObserved || !attempt.agentObserved),
    ) ?? null
  );
}
export function useAgentCreation(serverId: string, agentId: string): CreationAttempt | null {
  return (
    useWorkspaceCreations().find(
      (attempt) =>
        attempt.serverId === serverId &&
        attempt.agentId === agentId &&
        (attempt.phase !== "complete" || !attempt.agentObserved),
    ) ?? null
  );
}

useSessionStore.subscribe((state, previous) => {
  for (const serverId of new Set(
    workspaceCreations
      .getSnapshot()
      .filter((attempt) => !attempt.workspaceObserved || !attempt.agentObserved)
      .map((attempt) => attempt.serverId),
  )) {
    const session = state.sessions[serverId];
    const prior = previous.sessions[serverId];
    if (
      !session ||
      (session.workspaces === prior?.workspaces &&
        session.agents === prior?.agents &&
        session.agentDetails === prior?.agentDetails)
    )
      continue;
    workspaceCreations.observeResources(
      serverId,
      new Set([...session.workspaces.values()].map((workspace) => workspace.id)),
      new Set([...session.agents.keys(), ...session.agentDetails.keys()]),
    );
  }
});

export function isAgentCreationPending(serverId: string, agentId: string): boolean {
  const attempt = workspaceCreations.getAgent(serverId, agentId);
  return attempt !== null && (attempt.phase !== "complete" || !attempt.agentObserved);
}

/**
 * Whether prompts may be sent to the agent now. The host publishes a created agent before it
 * starts the initial prompt, so a creating agent is ready only once its creation completes.
 */
export function isAgentReadyForPrompts(serverId: string, agentId: string): boolean {
  return (
    selectIsAgentPublished(useSessionStore.getState().sessions[serverId], agentId) &&
    !isAgentCreationPending(serverId, agentId)
  );
}

export function useIsAgentReadyForPrompts(serverId: string, agentId: string): boolean {
  const isPublished = useSessionStore((state) =>
    selectIsAgentPublished(state.sessions[serverId], agentId),
  );
  const creation = useAgentCreation(serverId, agentId);
  return isPublished && creation === null;
}
