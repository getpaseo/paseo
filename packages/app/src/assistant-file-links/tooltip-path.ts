import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";

interface FormatFileLinkTooltipPathInput {
  target: WorkspaceFileLocation;
  workspaceRoot?: string;
}

export function formatFileLinkTooltipPath({
  target,
  workspaceRoot,
}: FormatFileLinkTooltipPathInput): string {
  const resolvedPaths = workspaceRoot
    ? resolveWorkspaceFilePaths({ path: target.path, workspaceRoot })
    : null;
  let result = resolvedPaths?.relativePath ?? target.path;
  if (target.lineStart) {
    result += `:${target.lineStart}`;
    if (target.lineEnd && target.lineEnd !== target.lineStart) {
      result += `-${target.lineEnd}`;
    }
  }
  return result;
}
