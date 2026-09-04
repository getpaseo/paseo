import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { userAttachmentsOnly } from "@/attachments/workspace-attachment-utils";

function isLikelyWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path);
}

function isChatHistoryTextAttachment(attachment: AgentAttachment): boolean {
  return attachment.type === "text" && attachment.contextKind === "chat_history";
}

export function getWorkspaceNamingAttachments(
  attachments: readonly AgentAttachment[],
): AgentAttachment[] {
  return attachments.filter((attachment) => !isChatHistoryTextAttachment(attachment));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function comparablePaths(left: string, right: string): [string, string] {
  const compareCaseInsensitively = isLikelyWindowsPath(left) || isLikelyWindowsPath(right);
  return compareCaseInsensitively ? [left.toLowerCase(), right.toLowerCase()] : [left, right];
}

/**
 * Rebase the source agent's cwd onto the destination workspace, keeping the
 * subdirectory it ran in. `destinationSourceDirectory` is the checkout the
 * destination was actually created from: when the user retargets the draft at a
 * different project the old relative suffix means nothing there, so the fork
 * lands at the workspace root instead of a path that does not exist.
 */
export function remapDraftCwdToWorkspace(input: {
  cwd: string;
  sourceDirectory?: string | null;
  destinationSourceDirectory?: string | null;
  workspaceDirectory: string;
}): string {
  const cwd = input.cwd.trim();
  const sourceDirectory = input.sourceDirectory?.trim();
  const workspaceDirectory = input.workspaceDirectory.trim();
  if (!cwd || !sourceDirectory) {
    return workspaceDirectory;
  }
  const normalizedCwd = normalizePath(cwd);
  const normalizedSource = normalizePath(sourceDirectory);
  const destinationSourceDirectory = input.destinationSourceDirectory?.trim();
  if (destinationSourceDirectory) {
    const [comparableDestination, comparableOrigin] = comparablePaths(
      normalizePath(destinationSourceDirectory),
      normalizedSource,
    );
    if (comparableDestination !== comparableOrigin) {
      return workspaceDirectory;
    }
  }
  const [comparableCwd, comparableSource] = comparablePaths(normalizedCwd, normalizedSource);
  if (comparableCwd === comparableSource) {
    return workspaceDirectory;
  }
  const relativePath = comparableCwd.startsWith(`${comparableSource}/`)
    ? normalizedCwd.slice(normalizedSource.length + 1)
    : "";
  if (!relativePath) {
    return workspaceDirectory;
  }
  const separator =
    workspaceDirectory.includes("\\") && !workspaceDirectory.includes("/") ? "\\" : "/";
  return [workspaceDirectory.replace(/[\\/]+$/, ""), ...relativePath.split("/")]
    .filter(Boolean)
    .join(separator);
}

export async function createNativeForkInWorkspace(input: {
  client: Pick<DaemonClient, "forkAgentNative">;
  agentId: string;
  boundaryMessageId: string;
  sourceCwd: string;
  sourceDirectory?: string | null;
  destinationSourceDirectory?: string | null;
  prompt?: string;
  namingAttachments?: AgentAttachment[];
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
  }) => Promise<{ id: string; workspaceDirectory: string }>;
  failureMessage: string;
}): Promise<{ agentId: string; workspaceId: string }> {
  const workspace = await input.ensureWorkspace({
    cwd: input.sourceCwd,
    prompt: input.prompt ?? "",
    attachments: input.namingAttachments ?? [],
    withInitialAgent: false,
  });
  const forked = await input.client.forkAgentNative(input.agentId, {
    boundaryMessageId: input.boundaryMessageId,
    workspaceId: workspace.id,
    cwd: remapDraftCwdToWorkspace({
      cwd: input.sourceCwd,
      sourceDirectory: input.sourceDirectory,
      destinationSourceDirectory: input.destinationSourceDirectory,
      workspaceDirectory: workspace.workspaceDirectory,
    }),
  });
  if (!forked.forkedAgentId) {
    throw new Error(input.failureMessage);
  }
  return {
    agentId: forked.forkedAgentId,
    workspaceId: forked.forkedWorkspaceId ?? workspace.id,
  };
}

/**
 * A native fork lands on an agent that already exists, so anything the user
 * typed while staging it is sent as that agent's first message rather than
 * riding along with a draft submission.
 *
 * The fork itself is not retryable — repeating it would branch the session
 * twice — so a failed send hands the content to the forked agent's own
 * composer, the way `submitAgentInput` restores it into the composer that
 * failed. Without that the draft is already cleared and the optimistic row is
 * rolled back, and the prompt is gone.
 */
export async function sendNativeForkPrompt(input: {
  text: string;
  attachments: ComposerAttachment[];
  send: (message: { text: string; attachments: ComposerAttachment[] }) => Promise<void>;
  restoreDraft: (draft: { text: string; attachments: UserComposerAttachment[] }) => void;
}): Promise<void> {
  const text = input.text.trim();
  if (!text && input.attachments.length === 0) {
    return;
  }
  try {
    await input.send({ text, attachments: input.attachments });
  } catch (error) {
    input.restoreDraft({ text, attachments: userAttachmentsOnly(input.attachments) });
    throw error;
  }
}
