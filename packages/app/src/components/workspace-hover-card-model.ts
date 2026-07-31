import { shortenPath } from "@/utils/shorten-path";

export function getWorkspaceHoverCardDirectoryLabel(input: {
  workspaceDirectory?: string;
  paseoWorktreeRoot: string | null;
}): string {
  if (!input.paseoWorktreeRoot) {
    return shortenPath(input.workspaceDirectory);
  }

  return getPathBasename(input.paseoWorktreeRoot);
}

function getPathBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/u, "");
  return normalized.split("/").findLast(Boolean) ?? normalized;
}
