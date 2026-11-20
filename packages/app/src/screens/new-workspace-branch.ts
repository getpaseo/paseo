import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { MessagePayload } from "@/composer/types";
import type { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceDraftBranch } from "@/stores/workspace-draft-submission-store";

/**
 * The branch keeps every absolute path of the source conversation. When the new workspace is a
 * separate checkout, without the source's uncommitted changes, the first message says so.
 */
export function buildBranchedWorkspacePrompt(input: {
  sourceCwd: string;
  cwd: string;
  text: string;
}): string {
  if (input.cwd === input.sourceCwd) {
    return input.text;
  }
  return [
    `This conversation was forked from \`${input.sourceCwd}\`. You are now working in \`${input.cwd}\`, a separate checkout. Paths in the earlier conversation point to the old one, and its uncommitted changes are not here, so re-read files before editing them.`,
    input.text,
  ].join("\n\n");
}

export interface CreateBranchedWorkspaceInput {
  payload: MessagePayload;
  branch: WorkspaceDraftBranch;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  client: Pick<DaemonClient, "forkAgent" | "sendAgentMessage">;
  serverId: string;
  navigate: (serverId: string, workspaceId: string, agentId: string) => void;
}

/** Creates the workspace, branches the source agent's session into it, then sends the prompt. */
export async function runCreateBranchedWorkspace(
  input: CreateBranchedWorkspaceInput,
): Promise<void> {
  const { payload, branch, client, serverId } = input;
  const workspace = await input.ensureWorkspace({
    cwd: payload.cwd,
    prompt: payload.text,
    attachments: [],
    withInitialAgent: false,
  });
  const agent = await client.forkAgent(branch.sourceAgentId, {
    boundaryMessageId: branch.boundaryMessageId,
    cwd: workspace.workspaceDirectory,
    workspaceId: workspace.id,
  });
  if (payload.text.trim()) {
    await client.sendAgentMessage(
      agent.id,
      buildBranchedWorkspacePrompt({
        sourceCwd: branch.sourceCwd,
        cwd: workspace.workspaceDirectory,
        text: payload.text,
      }),
    );
  }
  input.navigate(serverId, workspace.id, agent.id);
}
