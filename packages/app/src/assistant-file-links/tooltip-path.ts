import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

interface FormatFileLinkTooltipPathInput {
  target: WorkspaceFileLocation;
  workspaceRoot?: string;
}

export function formatFileLinkTooltipPath({
  target,
  workspaceRoot,
}: FormatFileLinkTooltipPathInput): string {
  const normalizedTargetPath = normalizeWorkspacePath(target.path);
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  let isWorkspaceRoot = false;
  if (normalizedTargetPath && normalizedWorkspaceRoot) {
    isWorkspaceRoot = normalizedTargetPath === normalizedWorkspaceRoot;
    if (/^[A-Za-z]:\//.test(normalizedTargetPath)) {
      isWorkspaceRoot =
        normalizedTargetPath.toLowerCase() === normalizedWorkspaceRoot.toLowerCase();
    }
  }

  const resolvedPaths = workspaceRoot
    ? resolveWorkspaceFilePaths({ path: target.path, workspaceRoot })
    : null;
  let result = isWorkspaceRoot ? "." : (resolvedPaths?.relativePath ?? target.path);
  if (target.lineStart) {
    result += `:${target.lineStart}`;
    if (target.lineEnd && target.lineEnd !== target.lineStart) {
      result += `-${target.lineEnd}`;
    }
  }
  return result;
}
