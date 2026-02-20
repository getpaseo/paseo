import { useCallback, useMemo } from "react";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  isHostRuntimeDirectoryLoading,
  useHostRuntimeSession,
} from "@/runtime/host-runtime";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  deriveSidebarStateBucket,
  isSidebarActiveAgent,
} from "@/utils/sidebar-agent-state";
import type { ProjectPlacementPayload } from "@server/shared/messages";
import { resolveProjectPlacement } from "@/utils/project-placement";

const SIDEBAR_DONE_FILL_TARGET = 50;

export interface SidebarProjectFilterOption {
  projectKey: string;
  projectName: string;
  activeCount: number;
  totalCount: number;
  serverId: string;
  workingDir: string;
}

export interface SidebarAgentListEntry {
  agent: AggregatedAgent & { createdAt: Date };
  project: ProjectPlacementPayload;
}

export interface SidebarAgentsListResult {
  entries: SidebarAgentListEntry[];
  projectFilterOptions: SidebarProjectFilterOption[];
  hasMoreEntries: boolean;
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

function compareByLastActivityDesc(
  left: SidebarAgentListEntry,
  right: SidebarAgentListEntry
): number {
  return right.agent.lastActivityAt.getTime() - left.agent.lastActivityAt.getTime();
}

function compareByTitleAsc(
  left: SidebarAgentListEntry,
  right: SidebarAgentListEntry
): number {
  const leftTitle = (left.agent.title?.trim() || "New agent").toLocaleLowerCase();
  const rightTitle = (right.agent.title?.trim() || "New agent").toLocaleLowerCase();
  const titleCmp = leftTitle.localeCompare(rightTitle, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (titleCmp !== 0) {
    return titleCmp;
  }

  return left.agent.id.localeCompare(right.agent.id, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function applySidebarDefaultOrdering(
  entries: SidebarAgentListEntry[]
): { entries: SidebarAgentListEntry[]; hasMore: boolean } {
  const needsInput: SidebarAgentListEntry[] = [];
  const failed: SidebarAgentListEntry[] = [];
  const running: SidebarAgentListEntry[] = [];
  const attention: SidebarAgentListEntry[] = [];
  const done: SidebarAgentListEntry[] = [];

  for (const entry of entries) {
    const bucket = deriveSidebarStateBucket({
      status: entry.agent.status,
      requiresAttention: entry.agent.requiresAttention,
      attentionReason: entry.agent.attentionReason,
    });
    if (bucket === "needs_input") {
      needsInput.push(entry);
      continue;
    }
    if (bucket === "failed") {
      failed.push(entry);
      continue;
    }
    if (bucket === "running") {
      running.push(entry);
      continue;
    }
    if (bucket === "attention") {
      attention.push(entry);
      continue;
    }
    done.push(entry);
  }

  needsInput.sort(compareByLastActivityDesc);
  failed.sort(compareByLastActivityDesc);
  running.sort(compareByTitleAsc);
  attention.sort(compareByLastActivityDesc);
  done.sort(compareByLastActivityDesc);

  const active = [...needsInput, ...failed, ...running, ...attention];
  if (active.length >= SIDEBAR_DONE_FILL_TARGET) {
    return { entries: active, hasMore: done.length > 0 };
  }

  const remainingDoneSlots = SIDEBAR_DONE_FILL_TARGET - active.length;
  const shownDone = done.slice(0, remainingDoneSlots);
  return {
    entries: [...active, ...shownDone],
    hasMore: done.length > shownDone.length,
  };
}

function toAggregatedAgent(params: {
  source: Agent;
  serverId: string;
  serverLabel: string;
}): AggregatedAgent & { createdAt: Date } {
  const source = params.source;
  return {
    id: source.id,
    serverId: params.serverId,
    serverLabel: params.serverLabel,
    title: source.title ?? null,
    status: source.status,
    createdAt: source.createdAt,
    lastActivityAt: source.lastActivityAt,
    cwd: source.cwd,
    provider: source.provider,
    requiresAttention: source.requiresAttention,
    attentionReason: source.attentionReason,
    attentionTimestamp: source.attentionTimestamp ?? null,
    archivedAt: source.archivedAt ?? null,
    labels: source.labels,
  };
}

export function useSidebarAgentsList(options?: {
  isOpen?: boolean;
  serverId?: string | null;
  selectedProjectFilterKeys?: string[];
}): SidebarAgentsListResult {
  const { connectionStates } = useDaemonConnections();
  const runtime = getHostRuntimeStore();
  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }, [options?.serverId]);

  const selectedProjectFilterKeys = useMemo(
    () =>
      new Set(
        (options?.selectedProjectFilterKeys ?? [])
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      ),
    [options?.selectedProjectFilterKeys]
  );

  const session = useSessionStore((state) =>
    serverId ? state.sessions[serverId] : undefined
  );
  const liveAgents = session?.agents ?? null;
  const { snapshot } = useHostRuntimeSession(serverId ?? "");

  const { entries, projectFilterOptions, hasAnyData, hasMoreEntries } = useMemo(() => {
    if (!serverId || !liveAgents) {
      return {
        entries: [] as SidebarAgentListEntry[],
        projectFilterOptions: [] as SidebarProjectFilterOption[],
        hasAnyData: false,
        hasMoreEntries: false,
      };
    }

    const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
    const seenAgentIds = new Set<string>();
    const byProject = new Map<string, SidebarProjectFilterOption>();
    const mergedEntries: SidebarAgentListEntry[] = [];

    const pushEntry = (entry: SidebarAgentListEntry): void => {
      if (entry.agent.archivedAt) {
        return;
      }
      const dedupeKey = `${entry.agent.serverId}:${entry.agent.id}`;
      if (seenAgentIds.has(dedupeKey)) {
        return;
      }
      seenAgentIds.add(dedupeKey);
      mergedEntries.push(entry);

      const existing = byProject.get(entry.project.projectKey);
      const isActive = isSidebarActiveAgent({
        status: entry.agent.status,
        requiresAttention: entry.agent.requiresAttention,
        attentionReason: entry.agent.attentionReason,
      });
      if (existing) {
        existing.totalCount += 1;
        if (isActive) {
          existing.activeCount += 1;
        }
        return;
      }

      byProject.set(entry.project.projectKey, {
        projectKey: entry.project.projectKey,
        projectName: entry.project.projectName,
        activeCount: isActive ? 1 : 0,
        totalCount: 1,
        serverId,
        workingDir: entry.project.checkout.cwd,
      });
    };

    for (const live of liveAgents.values()) {
      if (live.archivedAt || live.labels.ui !== "true") {
        continue;
      }
      const project = resolveProjectPlacement({
        projectPlacement: live.projectPlacement ?? null,
        cwd: live.cwd,
      });
      const agent = toAggregatedAgent({
        source: live,
        serverId,
        serverLabel,
      });
      pushEntry({ agent, project });
    }

    const filteredEntries =
      selectedProjectFilterKeys.size > 0
        ? mergedEntries.filter((entry) =>
            selectedProjectFilterKeys.has(entry.project.projectKey)
          )
        : mergedEntries;

    const ordered = applySidebarDefaultOrdering(filteredEntries);
    const options = Array.from(byProject.values()).sort((left, right) => {
      if (left.activeCount !== right.activeCount) {
        return right.activeCount - left.activeCount;
      }
      return left.projectName.localeCompare(right.projectName);
    });

    return {
      entries: ordered.entries,
      projectFilterOptions: options,
      hasAnyData: ordered.entries.length > 0,
      hasMoreEntries: ordered.hasMore,
    };
  }, [connectionStates, liveAgents, selectedProjectFilterKeys, serverId]);

  const refreshAll = useCallback(() => {
    if (!serverId || snapshot?.connectionStatus !== "online") {
      return;
    }
    void runtime.refreshAgentDirectory({ serverId }).catch(() => undefined);
  }, [runtime, serverId, snapshot?.connectionStatus]);

  const isDirectoryLoading = Boolean(serverId && isHostRuntimeDirectoryLoading(snapshot));
  const isInitialLoad = isDirectoryLoading && !hasAnyData;
  const isRevalidating = isDirectoryLoading && hasAnyData;

  return {
    entries,
    projectFilterOptions,
    hasMoreEntries,
    isLoading: isDirectoryLoading,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  };
}
