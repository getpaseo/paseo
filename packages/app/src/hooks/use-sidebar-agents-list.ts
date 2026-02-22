import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  getHostRuntimeStore,
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
  lastActivityAt: Date;
}): AggregatedAgent & { createdAt: Date } {
  const source = params.source;
  return {
    id: source.id,
    serverId: params.serverId,
    serverLabel: params.serverLabel,
    title: source.title ?? null,
    status: source.status,
    createdAt: source.createdAt,
    lastActivityAt: params.lastActivityAt,
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
  serverId?: string | null;
  selectedProjectFilterKeys?: string[];
}): SidebarAgentsListResult {
  const { daemons } = useDaemonRegistry();
  const runtime = getHostRuntimeStore();
  const daemonLabelSignature = useMemo(
    () =>
      daemons
        .map((daemon) => `${daemon.serverId}:${daemon.label ?? ""}`)
        .join("|"),
    [daemons]
  );
  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }, [options?.serverId]);
  const serverLabel = useMemo(() => {
    if (!serverId) {
      return "";
    }
    return daemons.find((daemon) => daemon.serverId === serverId)?.label ?? serverId;
  }, [daemonLabelSignature, serverId]);

  const selectedProjectFilterKeys = useMemo(
    () =>
      new Set(
        (options?.selectedProjectFilterKeys ?? [])
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      ),
    [options?.selectedProjectFilterKeys]
  );

  const isActive = Boolean(serverId);
  const liveAgents = useSessionStore((state) =>
    isActive && serverId ? state.sessions[serverId]?.agents ?? null : null
  );
  const agentLastActivity = useSessionStore((state) =>
    isActive ? state.agentLastActivity : null
  );
  const runtimeStatusSignature = useSyncExternalStore(
    (onStoreChange) =>
      isActive && serverId ? runtime.subscribe(serverId, onStoreChange) : () => {},
    () => {
      if (!isActive || !serverId) {
        return "idle:idle";
      }
      const snapshot = runtime.getSnapshot(serverId);
      const connectionStatus = snapshot?.connectionStatus ?? "idle";
      const directoryStatus = snapshot?.agentDirectoryStatus ?? "idle";
      return `${connectionStatus}:${directoryStatus}`;
    },
    () => {
      if (!isActive || !serverId) {
        return "idle:idle";
      }
      const snapshot = runtime.getSnapshot(serverId);
      const connectionStatus = snapshot?.connectionStatus ?? "idle";
      const directoryStatus = snapshot?.agentDirectoryStatus ?? "idle";
      return `${connectionStatus}:${directoryStatus}`;
    }
  );
  const [connectionStatus = "idle", directoryStatus = "idle"] =
    runtimeStatusSignature.split(":", 2);

  const { entries, projectFilterOptions, hasAnyData, hasMoreEntries } = useMemo(() => {
    if (!isActive || !serverId || !liveAgents) {
      return {
        entries: [] as SidebarAgentListEntry[],
        projectFilterOptions: [] as SidebarProjectFilterOption[],
        hasAnyData: false,
        hasMoreEntries: false,
      };
    }

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
      const effectiveLastActivity =
        agentLastActivity?.get(live.id) ?? live.lastActivityAt;
      const agent = toAggregatedAgent({
        source: live,
        serverId,
        serverLabel,
        lastActivityAt: effectiveLastActivity,
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

    const result = {
      entries: ordered.entries,
      projectFilterOptions: options,
      hasAnyData: ordered.entries.length > 0,
      hasMoreEntries: ordered.hasMore,
    };
    return result;
  }, [agentLastActivity, isActive, liveAgents, selectedProjectFilterKeys, serverId, serverLabel]);

  const refreshAll = useCallback(() => {
    if (!isActive || !serverId || connectionStatus !== "online") {
      return;
    }
    void runtime.refreshAgentDirectory({ serverId, page: { limit: 50 } }).catch(() => undefined);
  }, [connectionStatus, isActive, runtime, serverId]);

  const isDirectoryLoading =
    isActive &&
    Boolean(serverId) &&
    (directoryStatus === "initial_loading" || directoryStatus === "revalidating");
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
