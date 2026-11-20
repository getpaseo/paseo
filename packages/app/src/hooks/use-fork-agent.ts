import { useRouter } from "expo-router";
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
  | "options"
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

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    providerOptions: { ...agent.options },
  };
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

/**
 * Branches the provider session after the selected turn. In the same workspace the branch opens
 * as a new agent tab; for a new workspace the new workspace screen creates the checkout first and
 * opens the branch once it exists.
 */
async function openBranchFork(input: {
  client: DaemonClient;
  serverId: string;
  request: ForkAgentRequest;
  draftSetup: WorkspaceDraftTabSetup | undefined;
  sourceDirectory: string | undefined;
  openNewWorkspace: (draftId: string) => void;
  labels: { noMessageId: string; missingWorkspace: string };
}): Promise<void> {
  const { client, serverId, request, draftSetup, labels } = input;
  // The menu only offers a branch for a completed turn with a provider message id on a host and
  // provider that support it.
  const boundaryMessageId = request.boundary?.boundaryMessageId;
  if (!boundaryMessageId || !draftSetup) {
    throw new Error(labels.noMessageId);
  }
  if (request.target.destination === "tab") {
    if (!request.workspaceId) {
      throw new Error(labels.missingWorkspace);
    }
    const forked = await client.forkAgent(request.agentId, { boundaryMessageId });
    navigateToWorkspace({
      serverId,
      workspaceId: request.workspaceId,
      target: { kind: "agent", agentId: forked.id },
    });
    return;
  }
  const draftId = generateDraftId();
  useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
    draftId,
    setup: draftSetup,
    sourceDirectory: input.sourceDirectory,
    branch: {
      sourceAgentId: request.agentId,
      sourceCwd: request.agent.cwd,
      boundaryMessageId,
    },
  });
  input.openNewWorkspace(draftId);
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

  return useStableEvent(async ({ agentId, agent, workspaceId, target, boundary }) => {
    try {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const draftSetup = buildForkDraftSetup(agent);
      const sourceDirectory =
        agent.projectPlacement?.checkout?.cwd?.trim() || agent.cwd.trim() || undefined;
      const openNewWorkspace = (draftId: string) =>
        router.push(
          buildNewWorkspaceRoute({
            serverId,
            sourceDirectory,
            displayName: agent.projectPlacement?.projectName,
            projectId: agent.projectPlacement?.projectKey,
            draftId,
          }),
        );

      if (target.kind === "branch") {
        await openBranchFork({
          client,
          serverId,
          request: { agentId, agent, workspaceId, target, boundary },
          draftSetup,
          sourceDirectory,
          openNewWorkspace,
          labels: {
            noMessageId: t("message.actions.forkBranchNoMessageId"),
            missingWorkspace: t("message.actions.forkMissingWorkspace"),
          },
        });
        return;
      }

      if (!supportsAgentForkContext) {
        toast?.error(t("message.actions.forkUnavailable"));
        return;
      }
      const prepareForkDraft = async () => {
        const draftId = generateDraftId();
        const payload = await client.buildAgentForkContext(agentId, boundary);
        const attachment = buildChatHistoryAttachment({
          draftId,
          serverId,
          agentId,
          payload,
          missingAttachmentMessage: t("message.actions.forkFailed"),
        });
        useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
          scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
          attachments: [attachment],
        });
        return draftId;
      };

      if (target.destination === "tab") {
        if (!workspaceId) {
          throw new Error(t("message.actions.forkMissingWorkspace"));
        }
        const draftId = await prepareForkDraft();
        navigateToWorkspace({
          serverId,
          workspaceId,
          target: buildForkDraftTabTarget(draftSetup, draftId),
        });
        return;
      }

      const draftId = await prepareForkDraft();
      if (draftSetup) {
        useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
          draftId,
          setup: draftSetup,
          sourceDirectory,
        });
      }
      openNewWorkspace(draftId);
    } catch (error) {
      toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    }
  });
}
