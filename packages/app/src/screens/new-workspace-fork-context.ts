import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { PendingWorkspaceDraftSetup } from "@/stores/workspace-draft-submission-store";

interface NewWorkspaceBaseContextInput {
  forkSetup: Pick<PendingWorkspaceDraftSetup, "sourceDirectory"> | null;
  selectedServerId: string;
  sourceServerId: string;
  selectedProject: Pick<HostProjectListItem, "viewKey"> | null;
  sourceProject: Pick<HostProjectListItem, "viewKey"> | null;
  sourceDirectory: string | null;
}

export function resolveNewWorkspaceBaseContext(input: NewWorkspaceBaseContextInput) {
  const forkSetup = input.forkSetup;
  const matchesSource =
    forkSetup !== null &&
    input.selectedProject !== null &&
    input.selectedServerId === input.sourceServerId &&
    input.selectedProject.viewKey === input.sourceProject?.viewKey;
  const forkDirectory = matchesSource ? forkSetup.sourceDirectory : null;
  return {
    checkoutSourceDirectory: forkDirectory ?? input.sourceDirectory,
    forkFromCurrentBranch: Boolean(forkDirectory),
  };
}

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

export function remapDraftCwdToWorkspace(input: {
  cwd: string;
  sourceDirectory?: string | null;
  workspaceDirectory: string;
}): string {
  const cwd = input.cwd.trim();
  const sourceDirectory = input.sourceDirectory?.trim();
  const workspaceDirectory = input.workspaceDirectory.trim();
  if (!cwd || !sourceDirectory) {
    return workspaceDirectory;
  }
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedSource = sourceDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const compareCaseInsensitively =
    isLikelyWindowsPath(normalizedCwd) || isLikelyWindowsPath(normalizedSource);
  const comparableCwd = compareCaseInsensitively ? normalizedCwd.toLowerCase() : normalizedCwd;
  const comparableSource = compareCaseInsensitively
    ? normalizedSource.toLowerCase()
    : normalizedSource;
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
