import type { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import type { MessagePayload } from "@/composer/types";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { MaterializedAgentProfile } from "@/agent-profiles";
import type { DraftInput } from "@/stores/draft-store";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";

export const ROUTER_LAUNCH_PROFILE_ID = "paseo-workflow-router";

export function isEmptyWorkspaceSubmission(payload: MessagePayload): boolean {
  return !payload.text.trim() && payload.attachments.length === 0;
}

export interface CreateEmptyWorkspaceInput {
  payload: MessagePayload;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
    intent?: string;
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  serverId: string;
  navigate: (serverId: string, workspaceId: string) => void;
}

export async function runCreateIntentionWorkspace(input: {
  payload: MessagePayload;
  ensureWorkspace: CreateEmptyWorkspaceInput["ensureWorkspace"];
  draftId: string;
  profile: (MaterializedAgentProfile & { id: string }) | undefined;
  saveDraft: (draft: DraftInput) => void;
  openDraft: (workspaceId: string, target: WorkspaceTabTarget) => void;
}): Promise<void> {
  if (!input.profile || input.profile.id !== ROUTER_LAUNCH_PROFILE_ID) {
    throw new Error("Router profile is unavailable");
  }
  if (!input.payload.text.trim()) throw new Error("Intention is required");
  const profile = input.profile;
  const workspace = await input.ensureWorkspace({
    cwd: input.payload.cwd,
    prompt: "",
    attachments: [],
    withInitialAgent: false,
    intent: input.payload.text,
  });
  input.saveDraft({
    text: input.payload.text,
    attachments: composerWorkspaceAttachment.userAttachmentsOnly(input.payload.attachments),
  });
  input.openDraft(workspace.id, {
    kind: "draft",
    draftId: input.draftId,
    setup: {
      launchProfileId: ROUTER_LAUNCH_PROFILE_ID,
      cwd: workspace.workspaceDirectory,
      provider: profile.provider,
      model: profile.modelId || null,
      modeId: profile.modeId || null,
      thinkingOptionId: profile.thinkingOptionId || null,
      featureValues: profile.featureValues,
    },
  });
}

export async function runCreateEmptyWorkspace(input: CreateEmptyWorkspaceInput): Promise<void> {
  const { payload, ensureWorkspace, serverId, navigate } = input;
  const ensuredWorkspace = await ensureWorkspace({
    cwd: payload.cwd,
    prompt: "",
    attachments: [],
    withInitialAgent: false,
  });
  navigate(serverId, ensuredWorkspace.id);
}
