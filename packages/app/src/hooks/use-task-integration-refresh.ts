// useTaskIntegrationRefresh — refresh external issue data for kanban tasks
//
// When the app opens, tasks are hydrated from local AsyncStorage with the issue
// metadata that was cached at creation time. This hook re-fetches that data from
// the integration so the kanban board always shows up-to-date issue information.
//
// Strategy:
//   1. Collect all tasks that have an integration link (integrations.*IssueId).
//   2. For each unique (integrationId, issueIdentifier) pair, search the daemon
//      using searchIntegration and pick the first matching result.
//   3. Update the task's metadata in the kanban store with the fresh data.
//
// The hook is idempotent and safe to call on every render — it tracks which
// tasks have already been refreshed in the current session so it doesn't spam
// the daemon with repeat requests.

import { useEffect, useRef } from "react";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useKanbanStore } from "@/stores/kanban-store";
import type { KanbanTask, IntegrationId } from "@/types/kanban";

interface RefreshOptions {
  serverId: string | undefined;
  tasks: KanbanTask[];
}

// Map integration context key → IntegrationId
const INTEGRATION_KEY_MAP: Array<{
  contextKey: keyof NonNullable<KanbanTask["integrations"]>;
  integrationId: IntegrationId;
  metadataKey: keyof NonNullable<KanbanTask["metadata"]>;
}> = [
  { contextKey: "linearIssueId", integrationId: "linear", metadataKey: "linearIssue" },
  { contextKey: "githubIssueId", integrationId: "github", metadataKey: "githubIssue" },
  { contextKey: "jiraIssueId", integrationId: "jira", metadataKey: "jiraIssue" },
  { contextKey: "gitlabIssueId", integrationId: "gitlab", metadataKey: "gitlabIssue" },
  { contextKey: "plainThreadId", integrationId: "plain", metadataKey: "plainThread" },
  { contextKey: "forgejoIssueId", integrationId: "forgejo", metadataKey: "forgejoIssue" },
  { contextKey: "sentryIssueId", integrationId: "sentry", metadataKey: "sentryIssue" },
];

export function useTaskIntegrationRefresh({ serverId, tasks }: RefreshOptions) {
  const updateTask = useKanbanStore((s) => s.updateTask);
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  // Track task IDs that have been refreshed this session so we don't repeat
  const refreshedRef = useRef(new Set<string>());

  useEffect(() => {
    console.log(`[TaskIntegrationRefresh] effect triggered`, {
      serverId,
      isConnected,
      taskCount: tasks.length,
      tasksWithIntegrations: tasks.filter((t) => t.integrations).length,
      tasksWithMetadata: tasks.filter((t) => t.metadata).length,
      alreadyRefreshed: refreshedRef.current.size,
      taskDetails: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        hasIntegrations: !!t.integrations,
        integrationKeys: t.integrations ? Object.keys(t.integrations) : [],
        hasMetadata: !!t.metadata,
        metadataKeys: t.metadata ? Object.keys(t.metadata) : [],
      })),
    });

    if (!serverId) {
      console.warn(`[TaskIntegrationRefresh] SKIP — no serverId`);
      return;
    }
    if (!isConnected) {
      console.warn(`[TaskIntegrationRefresh] SKIP — host not connected (serverId=${serverId})`);
      return;
    }
    if (tasks.length === 0) {
      console.warn(`[TaskIntegrationRefresh] SKIP — no tasks`);
      return;
    }

    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      console.error(`[TaskIntegrationRefresh] SKIP — no client for serverId="${serverId}"`);
      return;
    }

    const tasksToRefresh = tasks.filter((t) => {
      if (refreshedRef.current.has(t.id)) return false;
      // Has explicit integration links
      if (t.integrations && Object.keys(t.integrations).length > 0) return true;
      // Fallback: derive integration links from metadata (tasks created before
      // the integrations field was reliably saved)
      if (t.metadata) {
        for (const { metadataKey } of INTEGRATION_KEY_MAP) {
          if (t.metadata[metadataKey]) return true;
        }
      }
      return false;
    });

    console.log(`[TaskIntegrationRefresh] tasks to refresh:`, {
      total: tasksToRefresh.length,
      tasks: tasksToRefresh.map((t) => ({
        id: t.id,
        name: t.name,
        integrations: t.integrations,
        hasMetadata: !!t.metadata,
      })),
    });

    if (tasksToRefresh.length === 0) return;

    for (const task of tasksToRefresh) {
      // Mark eagerly to avoid duplicate concurrent fetches
      refreshedRef.current.add(task.id);

      for (const { contextKey, integrationId, metadataKey } of INTEGRATION_KEY_MAP) {
        // Try explicit integration link first, then fall back to metadata
        let issueId = task.integrations?.[contextKey];
        if (!issueId) {
          // Derive from metadata: e.g. task.metadata.linearIssue?.identifier
          const metaItem = task.metadata?.[metadataKey] as Record<string, unknown> | undefined;
          if (metaItem) {
            issueId = String(
              metaItem.identifier ?? metaItem.key ?? metaItem.number ?? metaItem.id ?? "",
            );
            if (issueId) {
              // Backfill the integrations field so future refreshes are faster
              updateTask(task.id, {
                integrations: { ...task.integrations, [contextKey]: issueId },
              });
            }
          }
        }
        if (!issueId) continue;

        console.log(`[TaskIntegrationRefresh] refreshing task "${task.name}"`, {
          taskId: task.id,
          integrationId,
          issueId,
          metadataKey,
        });

        void (async () => {
          try {
            console.log(`[TaskIntegrationRefresh] calling searchIntegration...`, {
              integrationId,
              query: issueId,
            });
            const result = await client.searchIntegration({
              integrationId,
              query: issueId,
              limit: 5,
            });

            console.log(`[TaskIntegrationRefresh] searchIntegration response:`, {
              integrationId,
              issueId,
              itemCount: result?.items?.length ?? 0,
              items: result?.items?.map((i: Record<string, unknown>) => ({
                id: i.id,
                identifier: i.identifier,
                title: i.title,
              })),
            });

            const match =
              result.items.find(
                (item: Record<string, unknown>) =>
                  String(item.identifier ?? item.key ?? item.number ?? item.id ?? "") === issueId,
              ) ?? result.items[0];

            if (match) {
              console.log(
                `[TaskIntegrationRefresh] ✅ updating task "${task.name}" with fresh data`,
                {
                  taskId: task.id,
                  metadataKey,
                  matchIdentifier: match.identifier ?? match.key ?? match.id,
                },
              );
              updateTask(task.id, {
                metadata: {
                  ...task.metadata,
                  [metadataKey]: match,
                },
              });
            } else {
              console.warn(`[TaskIntegrationRefresh] ⚠️ no matching item found for "${issueId}"`);
            }
          } catch (err) {
            console.error(
              `[TaskIntegrationRefresh] ❌ FAILED to refresh task "${task.name}":`,
              err,
            );
            // Non-fatal: keep the cached metadata if the refresh fails
          }
        })();

        // Only process the first matched integration per task to avoid N searches
        break;
      }
    }
  }, [serverId, isConnected, tasks, updateTask]);
}
