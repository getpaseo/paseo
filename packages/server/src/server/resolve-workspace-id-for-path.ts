import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

// external path→workspace adapter, not ownership.
//
// Resolves a raw filesystem path to a single workspace id ONLY at the boundary
// where a client hands the daemon a bare worktree path with no id:
// archive-by-path (old client / CLI), auto-archive-after-merge, and the MCP
// `archive_worktree` tool. It is NEVER used to attribute agent status or place
// agents under a workspace — those are keyed by `workspaceId`, and git facts
// derive from a workspace's OWN cwd (id → cwd).
//
// Resolution: an exact directory match wins; otherwise the deepest enclosing
// workspace directory, never the home directory; null when nothing encloses it.
export function resolveWorkspaceIdForPath(
  cwd: string,
  workspaces: Iterable<PersistedWorkspaceRecord>,
): string | null {
  const workspaceRecords = Array.from(workspaces);
  const resolvedCwd = resolve(cwd);
  const exactMatch = workspaceRecords.find((workspace) => resolve(workspace.cwd) === resolvedCwd);
  if (exactMatch) {
    return exactMatch.workspaceId;
  }

  const userHome = resolve(homedir());
  let bestMatchLength = 0;
  let bestMatch: PersistedWorkspaceRecord | null = null;
  for (const workspace of workspaceRecords) {
    if (workspace.archivedAt) continue;
    const workspaceCwd = resolve(workspace.cwd);
    if (workspaceCwd === userHome) continue;
    const prefix = workspaceCwd.endsWith(sep) ? workspaceCwd : `${workspaceCwd}${sep}`;
    if (!resolvedCwd.startsWith(prefix)) {
      continue;
    }
    if (workspaceCwd.length > bestMatchLength) {
      bestMatchLength = workspaceCwd.length;
      bestMatch = workspace;
    }
  }

  return bestMatch?.workspaceId ?? null;
}
