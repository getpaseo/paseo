import type { CreateTerminalResponse, ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import type { ServerDataQueryMeta } from "@/data/push-router";
import { upsertTerminalListEntry } from "@/utils/terminal-list";

export const TERMINALS_QUERY_STALE_TIME = 5_000;

export type ListTerminalsPayload = ListTerminalsResponse["payload"];
type TerminalEntry = ListTerminalsPayload["terminals"][number];
type CreatedTerminal = NonNullable<CreateTerminalResponse["payload"]["terminal"]>;

export function buildTerminalsQueryKey(
  serverId: string,
  workspaceDirectory: string | null,
  workspaceId?: string | null,
) {
  return ["terminals", serverId, workspaceDirectory, workspaceId ?? null] as const;
}

export function canCreateWorkspaceTerminal(input: {
  isRouteFocused: boolean;
  client: unknown;
  isConnected: boolean;
  workspaceDirectory: string | null;
}): boolean {
  return Boolean(
    input.isRouteFocused && input.client && input.isConnected && input.workspaceDirectory,
  );
}

/**
 * Builds the push route a terminal replica subscribes to. Returns undefined
 * when the workspace directory is not known yet, so an empty directory never
 * reaches the daemon as an empty `cwd` — the terminal manager rejects that on
 * every snapshot with "cwd must be absolute path".
 */
export function resolveWorkspaceTerminalsPushRoute(input: {
  enabled: boolean;
  serverId: string;
  workspaceDirectory: string | null;
  workspaceId?: string;
}): ServerDataQueryMeta | undefined {
  if (!input.workspaceDirectory) return undefined;
  return workspaceTerminalsPushRoute({
    enabled: input.enabled,
    serverId: input.serverId,
    cwd: input.workspaceDirectory,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
}

export function reconcilePendingScriptTerminals(liveTerminalIds: string[], dataUpdatedAt: number) {
  return function update(pendingTerminalIds: Map<string, number>): Map<string, number> {
    if (pendingTerminalIds.size === 0) {
      return pendingTerminalIds;
    }
    const liveIds = new Set(liveTerminalIds);
    let changed = false;
    const nextTerminalIds = new Map<string, number>();
    for (const [terminalId, listedAt] of pendingTerminalIds) {
      if (liveIds.has(terminalId) || dataUpdatedAt > listedAt) {
        changed = true;
        continue;
      }
      nextTerminalIds.set(terminalId, listedAt);
    }
    return changed ? nextTerminalIds : pendingTerminalIds;
  };
}

export function collectKnownTerminalIds(input: {
  liveTerminalIds: string[];
  pendingScriptTerminalIds: Map<string, number>;
}): string[] {
  const terminalIds = new Set(input.liveTerminalIds);
  for (const terminalId of input.pendingScriptTerminalIds.keys()) {
    terminalIds.add(terminalId);
  }
  return Array.from(terminalIds);
}

export function collectScriptTerminalIds(input: {
  pendingScriptTerminalIds: Map<string, number>;
  scripts: Array<{ terminalId?: string | null }>;
}): Set<string> {
  const terminalIds = new Set(input.pendingScriptTerminalIds.keys());
  for (const script of input.scripts) {
    if (script.terminalId) {
      terminalIds.add(script.terminalId);
    }
  }
  return terminalIds;
}

export function collectStandaloneTerminalIds(input: {
  terminals: TerminalEntry[];
  scriptTerminalIds: Set<string>;
}): string[] {
  return input.terminals
    .filter((terminal) => !input.scriptTerminalIds.has(terminal.id))
    .map((terminal) => terminal.id);
}

export function removeTerminalFromPayload(terminalId: string) {
  return function updatePayload(
    current: ListTerminalsPayload | undefined,
  ): ListTerminalsPayload | undefined {
    if (!current) {
      return current;
    }
    return {
      ...current,
      terminals: current.terminals.filter((terminal) => terminal.id !== terminalId),
    };
  };
}

export function upsertCreatedTerminalPayload(input: {
  current: ListTerminalsPayload | undefined;
  terminal: CreatedTerminal;
  workspaceDirectory: string | null;
}): ListTerminalsPayload {
  const nextTerminals = upsertTerminalListEntry({
    terminals: input.current?.terminals ?? [],
    terminal: input.terminal,
  });
  const cwd = input.current?.cwd ?? input.workspaceDirectory;
  return {
    ...(cwd ? { cwd } : {}),
    terminals: nextTerminals,
    requestId: input.current?.requestId ?? `terminal-create-${input.terminal.id}`,
  };
}
