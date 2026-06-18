// COMPAT(workspaceIdBackfill): one-time legacy backfill, delete after 2026-12-16
// once floor >= the release that always stamps workspaceId at create time.
//
// This is the ONLY place in the codebase that maps a cwd to a workspaceId.
// Every other code path treats a record's `workspaceId` field as authoritative
// ownership. Legacy agent records persisted before workspaceId stamping have no
// owner, so this migration stamps each one with the workspace that owned its
// directory at the time it was written. It runs once at startup and writes the
// id back to storage, after which all runtime code can assume the field exists.
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import type { Logger } from "pino";

import type { AgentStorage } from "../agent/agent-storage.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";

// Picks the workspace that owned `cwd` for a legacy, unstamped agent record.
// Prefers an exact-cwd workspace (oldest wins) and otherwise attributes to the
// deepest enclosing workspace directory, never letting the home directory own
// descendants. Used only by the one-time backfill below.
function resolveLegacyWorkspaceOwner(
  cwd: string,
  workspaces: Iterable<PersistedWorkspaceRecord>,
): string | null {
  const normalizedCwd = resolve(cwd);
  const userHome = resolve(homedir());
  const activeWorkspaces = Array.from(workspaces).filter((workspace) => !workspace.archivedAt);
  const exactMatches = activeWorkspaces.filter(
    (workspace) => resolve(workspace.cwd) === normalizedCwd,
  );
  if (exactMatches.length > 0) {
    return oldestWorkspace(exactMatches).workspaceId;
  }

  const prefixMatches = activeWorkspaces.filter((workspace) => {
    const workspaceCwd = resolve(workspace.cwd);
    if (workspaceCwd === userHome) {
      return false;
    }
    return normalizedCwd === workspaceCwd || normalizedCwd.startsWith(`${workspaceCwd}${sep}`);
  });
  if (prefixMatches.length === 0) {
    return null;
  }

  const deepestPrefixLength = Math.max(
    ...prefixMatches.map((workspace) => resolve(workspace.cwd).length),
  );
  return oldestWorkspace(
    prefixMatches.filter((workspace) => resolve(workspace.cwd).length === deepestPrefixLength),
  ).workspaceId;
}

function oldestWorkspace(workspaces: PersistedWorkspaceRecord[]): PersistedWorkspaceRecord {
  return workspaces.reduce((oldest, candidate) =>
    candidate.createdAt < oldest.createdAt ? candidate : oldest,
  );
}

export async function backfillWorkspaceIdForLegacyAgents(options: {
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<number> {
  const workspaceRecords = await options.workspaceRegistry.list();
  const records = await options.agentStorage.list();
  let migrated = 0;

  for (const record of records) {
    if (record.workspaceId) {
      continue;
    }

    const workspaceId = resolveLegacyWorkspaceOwner(record.cwd, workspaceRecords);
    if (!workspaceId) {
      continue;
    }

    await options.agentStorage.upsert({ ...record, workspaceId });
    migrated += 1;
  }

  if (migrated > 0) {
    options.logger.info({ migrated }, "Backfilled workspaceId for legacy agent records");
  }
  return migrated;
}
