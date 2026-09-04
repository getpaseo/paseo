import { type Router, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import type {
  AgentForkContextOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { ToastApi } from "@/components/toast-host";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostFeature } from "@/runtime/host-features";
import { generateDraftId } from "@/stores/draft-keys";
import { resolveForkFidelity, useForkPreferencesStore } from "@/stores/fork-preferences-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { toErrorMessage } from "@/utils/error-messages";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * The subset of an agent record that a fork needs in order to seed the new
 * draft. Kept structural so both `AgentScreenAgent` (the agent-stream view's
 * live context) and the session store's `Agent` record satisfy it without a
 * projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  | "provider"
  | "cwd"
  | "currentModeId"
  | "model"
  | "thinkingOptionId"
  | "runtimeInfo"
  | "features"
  | "projectPlacement"
>;

/**
 * Boundary marking where the forked context should stop. Omit it entirely to
 * fork the whole timeline *up to now* — including a partially streamed
 * in-flight turn. `selectForkContextRows` projects the full timeline when
 * neither field is present, which is what makes mid-run forking work.
 */
export type ForkAgentBoundary = Pick<
  AgentForkContextOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkAgentRequest {
  agentId: string;
  agent: ForkAgentSource;
  workspaceId?: string;
  target: AssistantForkTarget;
  boundary?: ForkAgentBoundary;
  /**
   * The source agent reports `supportsNativeFork`. Combined with the user's
   * fidelity preference and a boundary message id, this decides whether the
   * fork branches the provider session or seeds a summary attachment.
   */
  canForkNatively?: boolean;
}

export interface UseForkAgentInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

function buildChatHistoryAttachment(input: {
  draftId: string;
  serverId: string;
  agentId: string;
  payload: Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
  missingAttachmentMessage: string;
}): WorkspaceComposerAttachment {
  if (!input.payload.attachment) {
    throw new Error(input.missingAttachmentMessage);
  }
  return {
    kind: "chat_history",
    id: `chat_history:${input.draftId}`,
    attachment: input.payload.attachment,
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.payload.boundaryMessageId,
      boundaryCursor: input.payload.boundaryCursor,
      itemCount: input.payload.itemCount,
    },
  };
}

function buildForkDraftSetup(agent: ForkAgentSource): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) {
    return undefined;
  }

  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}

/**
 * Branch the provider session and open the agent the daemon created for it.
 * Unlike the summary path there is no draft step: `importProviderSession`
 * already replayed the upstream conversation into the new agent's timeline.
 */
async function openNativeFork(input: {
  client: DaemonClient;
  serverId: string;
  agentId: string;
  workspaceId?: string;
  boundaryMessageId: string;
  missingWorkspaceMessage: string;
  failureMessage: string;
}): Promise<void> {
  const forked = await input.client.forkAgentNative(input.agentId, {
    boundaryMessageId: input.boundaryMessageId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  if (!forked.forkedAgentId) {
    throw new Error(input.failureMessage);
  }
  const workspaceId = forked.forkedWorkspaceId ?? input.workspaceId;
  if (!workspaceId) {
    throw new Error(input.missingWorkspaceMessage);
  }
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: forked.forkedAgentId },
  });
}

function stageNativeForkInNewWorkspace(input: {
  router: Router;
  serverId: string;
  agentId: string;
  agent: ForkAgentSource;
  boundaryMessageId: string;
  failureMessage: string;
}): void {
  const draftId = generateDraftId();
  const setup = buildForkDraftSetup(input.agent);
  if (!setup) {
    throw new Error(input.failureMessage);
  }
  const sourceDirectory =
    input.agent.projectPlacement?.checkout?.cwd?.trim() || input.agent.cwd.trim() || undefined;
  useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
    draftId,
    setup,
    sourceDirectory,
    nativeFork: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.boundaryMessageId,
    },
  });
  input.router.push(
    buildNewWorkspaceRoute({
      serverId: input.serverId,
      sourceDirectory,
      displayName: input.agent.projectPlacement?.projectName,
      projectId: input.agent.projectPlacement?.projectKey,
      draftId,
    }),
  );
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

/**
 * Seed a draft with a curated `chat_history` attachment. This is the fork that
 * works everywhere: it crosses providers, and with no boundary it captures a
 * turn that is still streaming.
 */
async function openSummaryFork(input: {
  client: DaemonClient;
  router: Router;
  serverId: string;
  agentId: string;
  agent: ForkAgentSource;
  workspaceId?: string;
  target: AssistantForkTarget;
  boundary?: ForkAgentBoundary;
  missingWorkspaceMessage: string;
  failureMessage: string;
}): Promise<void> {
  const { client, serverId, agentId, agent } = input;
  const draftSetup = buildForkDraftSetup(agent);
  const prepareForkDraft = async () => {
    const draftId = generateDraftId();
    const payload = await client.buildAgentForkContext(agentId, input.boundary);
    const attachment = buildChatHistoryAttachment({
      draftId,
      serverId,
      agentId,
      payload,
      missingAttachmentMessage: input.failureMessage,
    });
    useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
      scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
      attachments: [attachment],
    });
    return draftId;
  };

  if (input.target === "tab") {
    if (!input.workspaceId) {
      throw new Error(input.missingWorkspaceMessage);
    }
    const draftId = await prepareForkDraft();
    navigateToWorkspace({
      serverId,
      workspaceId: input.workspaceId,
      target: buildForkDraftTabTarget(draftSetup, draftId),
    });
    return;
  }

  const draftId = await prepareForkDraft();
  const sourceDirectory =
    agent.projectPlacement?.checkout?.cwd?.trim() || agent.cwd.trim() || undefined;
  if (draftSetup) {
    useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
      draftId,
      setup: draftSetup,
      sourceDirectory,
    });
  }
  input.router.push(
    buildNewWorkspaceRoute({
      serverId,
      sourceDirectory,
      displayName: agent.projectPlacement?.projectName,
      projectId: agent.projectPlacement?.projectKey,
      draftId,
    }),
  );
}

/**
 * Shared fork driver behind both turn-footer fork affordances: the completed
 * turn's footer (which supplies a boundary pinned to that turn) and the
 * in-flight turn's footer next to the progress loader (which omits the boundary
 * so the fork captures the still-streaming response).
 */
export function useForkAgent(
  input: UseForkAgentInput,
): (request: ForkAgentRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext") && !readOnly;
  const supportsAgentForkNative = useHostFeature(serverId, "agentForkNative") && !readOnly;

  return useStableEvent(
    async ({ agentId, agent, workspaceId, target, boundary, canForkNatively = false }) => {
      try {
        if (!supportsAgentForkContext) {
          toast?.error(t("message.actions.forkUnavailable"));
          return;
        }
        if (!client) {
          throw new Error(t("workspace.terminal.hostDisconnected"));
        }

        // A native fork needs a committed turn to branch from. The in-flight
        // footer supplies no boundary on purpose, so it always takes the
        // summary path — which is the one that captures the streaming turn.
        const boundaryMessageId = boundary?.boundaryMessageId;
        const useNativeFork =
          Boolean(boundaryMessageId) &&
          resolveForkFidelity({
            preferred: useForkPreferencesStore.getState().fidelity,
            canForkNatively: canForkNatively && supportsAgentForkNative,
          }) === "native";

        if (useNativeFork && boundaryMessageId) {
          if (target === "workspace") {
            stageNativeForkInNewWorkspace({
              router,
              serverId,
              agentId,
              agent,
              boundaryMessageId,
              failureMessage: t("message.actions.forkFailed"),
            });
            return;
          }
          await openNativeFork({
            client,
            serverId,
            agentId,
            workspaceId,
            boundaryMessageId,
            missingWorkspaceMessage: t("message.actions.forkMissingWorkspace"),
            failureMessage: t("message.actions.forkFailed"),
          });
          return;
        }

        await openSummaryFork({
          client,
          router,
          serverId,
          agentId,
          agent,
          workspaceId,
          target,
          boundary,
          missingWorkspaceMessage: t("message.actions.forkMissingWorkspace"),
          failureMessage: t("message.actions.forkFailed"),
        });
      } catch (error) {
        toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
      }
    },
  );
}
