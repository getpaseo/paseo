import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import type { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import type { MessagePayload } from "@/components/message-input";
import type { AgentAttachment } from "@server/shared/messages";

export function isEmptyWorkspaceSubmission(payload: MessagePayload): boolean {
  return !payload.text.trim() && payload.attachments.length === 0;
}

export interface CreateEmptyWorkspaceInput {
  payload: MessagePayload;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  serverId: string;
}

export async function runCreateEmptyWorkspace(input: CreateEmptyWorkspaceInput): Promise<void> {
  const { payload, ensureWorkspace, serverId } = input;
  const ensuredWorkspace = await ensureWorkspace({
    cwd: payload.cwd,
    prompt: "",
    attachments: [],
  });
  navigateToWorkspace(serverId, ensuredWorkspace.id);
}
