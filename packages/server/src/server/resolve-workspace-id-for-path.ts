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
// Selected records participate only through their explicit host-visible-path
// projection. Resolution fails closed on ambiguity. Otherwise an exact path wins,
// then the deepest enclosing path, never the home directory.
export function resolveWorkspaceIdForPath(
  cwd: string,
  workspaces: Iterable<PersistedWorkspaceRecord>,
): string | null {
  const workspaceRecords = Array.from(workspaces);
  const resolvedCwd = resolve(cwd);
  const candidates = workspaceRecords.flatMap((workspace) => {
    const visiblePath = workspace.runtime ? workspace.hostVisiblePath : workspace.cwd;
    return visiblePath ? [{ workspace, visiblePath: resolve(visiblePath) }] : [];
  });
  const exactMatches = candidates.filter((candidate) => candidate.visiblePath === resolvedCwd);
  if (exactMatches.length !== 0) {
    return exactMatches.length === 1 ? (exactMatches[0]?.workspace.workspaceId ?? null) : null;
  }

  const userHome = resolve(homedir());
  let bestMatchLength = 0;
  let bestMatch: PersistedWorkspaceRecord | null = null;
  let bestMatchIsAmbiguous = false;
  for (const { workspace, visiblePath } of candidates) {
    if (workspace.archivedAt) continue;
    const workspaceCwd = visiblePath;
    if (workspaceCwd === userHome) continue;
    const prefix = workspaceCwd.endsWith(sep) ? workspaceCwd : `${workspaceCwd}${sep}`;
    if (!resolvedCwd.startsWith(prefix)) {
      continue;
    }
    if (workspaceCwd.length > bestMatchLength) {
      bestMatchLength = workspaceCwd.length;
      bestMatch = workspace;
      bestMatchIsAmbiguous = false;
    } else if (workspaceCwd.length === bestMatchLength) {
      bestMatchIsAmbiguous = true;
    }
  }

  return bestMatchIsAmbiguous ? null : (bestMatch?.workspaceId ?? null);
}
