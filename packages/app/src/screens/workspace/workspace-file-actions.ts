import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { getFileNameFromPath } from "@/attachments/utils";

export interface WorkspaceFileShareInput {
  fileName: string;
  path: string;
  root: string;
}

export function resolveWorkspaceFileShareInput(input: {
  path: string;
  workspaceRoot?: string;
}): WorkspaceFileShareInput | null {
  const target = resolveFilePreviewReadTarget(input);
  if (!target) {
    return null;
  }
  return {
    fileName: getFileNameFromPath(input.path) ?? "file",
    path: target.path,
    root: target.cwd,
  };
}
