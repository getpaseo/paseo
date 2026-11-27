import { router } from "expo-router";
import type {
  PluginAgentLaunchOpenResult,
  PluginAgentLaunchRequest,
} from "@getpaseo/plugin/client";
import {
  buildNewWorkspaceDraftKey,
  buildDraftStoreKey,
  generateDraftId,
} from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { getOrCreateClientId } from "@/utils/client-id";
import { openAgentLaunchJournal } from "./journal";

/** Same-project, non-archived workspaces only; an invalid default is ignored with a diagnostic. */
export function resolveExistingLaunchWorkspace(input: {
  serverId: string;
  projectId: string;
  defaultWorkspaceId?: string;
}): string | undefined {
  const workspaces = useSessionStore.getState().sessions[input.serverId]?.workspaces;
  if (!workspaces) return undefined;
  const eligible = (workspaceId: string) => {
    const workspace = workspaces.get(workspaceId);
    return Boolean(workspace && workspace.projectId === input.projectId && !workspace.archivingAt);
  };
  const requested = input.defaultWorkspaceId?.trim();
  if (requested) {
    if (eligible(requested)) return requested;
    console.warn("[Plugins] Ignoring invalid default agent launch workspace", {
      serverId: input.serverId,
      workspaceId: requested,
    });
  }
  return Array.from(workspaces.values()).find((workspace) => eligible(workspace.id))?.id;
}

export async function openPluginAgentLaunch(input: {
  serverId: string;
  pluginId: string;
  request: PluginAgentLaunchRequest;
}): Promise<PluginAgentLaunchOpenResult> {
  const clientInstanceId = await getOrCreateClientId();
  const existingWorkspaceId = input.request.workspace.allowExisting
    ? resolveExistingLaunchWorkspace({
        serverId: input.serverId,
        projectId: input.request.projectId,
        defaultWorkspaceId: input.request.defaultWorkspaceId,
      })
    : undefined;
  if (!existingWorkspaceId && !input.request.workspace.allowCreate) {
    const message = "No eligible workspace is available for this project.";
    input.request.onEvent?.({ type: "failed", stage: "open", certainty: "not_submitted", message });
    return { status: "rejected", code: "no_eligible_workspace", message };
  }

  const opened = await openAgentLaunchJournal({
    serverId: input.serverId,
    pluginId: input.pluginId,
    clientInstanceId,
    request: input.request,
    ...(existingWorkspaceId ? { initialWorkspaceId: existingWorkspaceId } : {}),
    createDraftId: generateDraftId,
    prepareDraft: ({ draftId, metadata, prompt, workspaceId }) => {
      const draftKey = workspaceId
        ? buildDraftStoreKey({ serverId: input.serverId, agentId: draftId, draftId })
        : buildNewWorkspaceDraftKey(draftId);
      const store = useDraftStore.getState();
      const existing = store.drafts[draftKey];
      // A restored draft keeps the user's later edits and attachments; only a fresh or cleared
      // draft is seeded again from the journal.
      const keepExisting =
        existing?.lifecycle === "active" &&
        (existing.input.text.length > 0 || existing.input.attachments.length > 0);
      store.setAgentLaunchMetadata({
        draftKey,
        draft: keepExisting ? existing.input : { text: prompt, attachments: [] },
        metadata,
      });
    },
  });
  const journal = opened.journal;
  if (!journal || opened.result.status === "rejected" || opened.result.status === "completed") {
    return opened.result;
  }
  const workspaceId = journal.workspaceId ?? existingWorkspaceId;
  if (workspaceId) {
    navigateToWorkspace({
      serverId: input.serverId,
      workspaceId,
      target: { kind: "draft", draftId: journal.draftId },
    });
  } else {
    router.push(
      buildNewWorkspaceRoute({
        serverId: input.serverId,
        projectId: input.request.projectId,
        draftId: journal.draftId,
      }),
    );
  }
  return opened.result;
}

export * from "./identity";
export * from "./journal";
