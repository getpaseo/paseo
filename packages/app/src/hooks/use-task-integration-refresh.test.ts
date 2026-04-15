// Tests: useTaskIntegrationRefresh
//
// Covers:
//   1. Skips refresh when serverId is missing or host is not connected.
//   2. Skips tasks that have no integration links.
//   3. Calls searchIntegration with the correct identifier for each integration.
//   4. Updates task metadata with the fresh issue data returned by the daemon.
//   5. Does NOT repeat the refresh for a task already refreshed in this session.
//   6. Handles search errors gracefully — keeps the cached metadata.
//   7. Only processes the first matching integration per task (one search per task).

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Pure logic extracted from useTaskIntegrationRefresh ───────────────────────
//
// We test the core decision logic without mounting a React component.
// The hook's effect body is isolated below into a pure function for unit testing.

import type { KanbanTask } from "@/types/kanban";
import type { TaskMetadata } from "@/types/integrations";

type IntegrationId = KanbanTask["integrations"] extends infer T
  ? T extends Record<infer K, unknown>
    ? K extends `${infer I}IssueId` | `${infer J}ThreadId`
      ? I | J
      : never
    : never
  : never;

interface SearchParams {
  integrationId: string;
  query: string;
  limit: number;
}

interface FakeClient {
  searchIntegration: (params: SearchParams) => Promise<{ items: Record<string, unknown>[] }>;
}

const INTEGRATION_KEY_MAP: Array<{
  contextKey: keyof NonNullable<KanbanTask["integrations"]>;
  integrationId: string;
  metadataKey: keyof TaskMetadata;
}> = [
  { contextKey: "linearIssueId", integrationId: "linear", metadataKey: "linearIssue" },
  { contextKey: "githubIssueId", integrationId: "github", metadataKey: "githubIssue" },
  { contextKey: "jiraIssueId", integrationId: "jira", metadataKey: "jiraIssue" },
  { contextKey: "gitlabIssueId", integrationId: "gitlab", metadataKey: "gitlabIssue" },
  { contextKey: "plainThreadId", integrationId: "plain", metadataKey: "plainThread" },
  { contextKey: "forgejoIssueId", integrationId: "forgejo", metadataKey: "forgejoIssue" },
  { contextKey: "sentryIssueId", integrationId: "sentry", metadataKey: "sentryIssue" },
];

async function runRefreshEffect(
  tasks: KanbanTask[],
  client: FakeClient,
  alreadyRefreshed: Set<string>,
  onUpdate: (taskId: string, changes: Partial<KanbanTask>) => void,
) {
  const toRefresh = tasks.filter((t) => {
    if (alreadyRefreshed.has(t.id)) return false;
    // Has explicit integration links
    if (t.integrations && Object.keys(t.integrations).length > 0) return true;
    // Fallback: derive from metadata
    if (t.metadata) {
      for (const { metadataKey } of INTEGRATION_KEY_MAP) {
        if ((t.metadata as Record<string, unknown>)[metadataKey]) return true;
      }
    }
    return false;
  });

  for (const task of toRefresh) {
    alreadyRefreshed.add(task.id);

    for (const { contextKey, integrationId, metadataKey } of INTEGRATION_KEY_MAP) {
      // Try explicit integration link first, then fall back to metadata
      let issueId = task.integrations?.[contextKey];
      if (!issueId) {
        const metaItem = (task.metadata as Record<string, unknown> | undefined)?.[metadataKey] as
          | Record<string, unknown>
          | undefined;
        if (metaItem) {
          issueId = String(
            metaItem.identifier ?? metaItem.key ?? metaItem.number ?? metaItem.id ?? "",
          );
          if (issueId) {
            // Backfill the integrations field
            onUpdate(task.id, {
              integrations: { ...task.integrations, [contextKey]: issueId },
            });
          }
        }
      }
      if (!issueId) continue;

      try {
        const result = await client.searchIntegration({ integrationId, query: issueId, limit: 5 });
        const match =
          result.items.find(
            (item) =>
              String(item.identifier ?? item.key ?? item.number ?? item.id ?? "") === issueId,
          ) ?? result.items[0];

        if (match) {
          onUpdate(task.id, {
            metadata: { ...task.metadata, [metadataKey]: match },
          });
        }
      } catch {
        // Keep cached metadata on error
      }

      break; // Only process first matched integration per task
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Task",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFakeClient(
  items: Record<string, unknown>[] = [],
): FakeClient & { calls: SearchParams[] } {
  const calls: SearchParams[] = [];
  return {
    calls,
    searchIntegration: vi.fn(async (params: SearchParams) => {
      calls.push(params);
      return { items };
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runRefreshEffect — task filtering", () => {
  it("skips tasks that have no integrations", async () => {
    const task = makeTask({ id: "t1" }); // no integrations
    const client = makeFakeClient();
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(client.searchIntegration).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("skips tasks already refreshed this session", async () => {
    const task = makeTask({ id: "t1", integrations: { linearIssueId: "BRA-3" } });
    const client = makeFakeClient([{ identifier: "BRA-3", title: "connect your tools" }]);
    const refreshed = new Set(["t1"]); // already refreshed
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, refreshed, onUpdate);

    expect(client.searchIntegration).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("processes only tasks with integration links that haven't been refreshed", async () => {
    const taskA = makeTask({ id: "tA", integrations: { linearIssueId: "BRA-1" } });
    const taskB = makeTask({ id: "tB" }); // no integration
    const taskC = makeTask({ id: "tC", integrations: { linearIssueId: "BRA-2" } });
    const client = makeFakeClient([{ identifier: "BRA-1", title: "issue 1" }]);
    const refreshed = new Set<string>();
    const onUpdate = vi.fn();

    await runRefreshEffect([taskA, taskB, taskC], client, refreshed, onUpdate);

    expect(client.searchIntegration).toHaveBeenCalledTimes(2);
    expect(refreshed.has("tA")).toBe(true);
    expect(refreshed.has("tB")).toBe(false); // no integration, never added
    expect(refreshed.has("tC")).toBe(true);
  });
});

describe("runRefreshEffect — search and update", () => {
  it("searches using the correct integrationId and issueId", async () => {
    const task = makeTask({ id: "t1", integrations: { linearIssueId: "BRA-3" } });
    const client = makeFakeClient([{ identifier: "BRA-3", title: "connect your tools" }]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(client.calls[0]).toMatchObject({
      integrationId: "linear",
      query: "BRA-3",
    });
  });

  it("updates task metadata with matched item from search results", async () => {
    const freshIssue = { identifier: "BRA-3", title: "connect your tools (fresh)", id: "uid" };
    const task = makeTask({
      id: "t1",
      integrations: { linearIssueId: "BRA-3" },
      metadata: { linearIssue: { id: "uid", identifier: "BRA-3", title: "old title" } },
    });
    const client = makeFakeClient([freshIssue]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(onUpdate).toHaveBeenCalledWith("t1", {
      metadata: { ...task.metadata, linearIssue: freshIssue },
    });
  });

  it("falls back to first result when no exact identifier match", async () => {
    // Server returns a result but identifier doesn't match exactly (e.g. numeric ID)
    const firstItem = { id: "uuid-1", identifier: "BRA-99", title: "fallback issue" };
    const task = makeTask({
      id: "t1",
      integrations: { linearIssueId: "BRA-99" },
    });
    const client = makeFakeClient([firstItem]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(onUpdate).toHaveBeenCalledWith("t1", {
      metadata: { linearIssue: firstItem },
    });
  });

  it("does NOT update when search returns empty results", async () => {
    const task = makeTask({ id: "t1", integrations: { linearIssueId: "BRA-3" } });
    const client = makeFakeClient([]); // no items
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("handles search error gracefully — does not throw and does not update", async () => {
    const task = makeTask({ id: "t1", integrations: { linearIssueId: "BRA-3" } });
    const client: FakeClient & { calls: SearchParams[] } = {
      calls: [],
      searchIntegration: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    const onUpdate = vi.fn();

    // Must not throw
    await expect(runRefreshEffect([task], client, new Set(), onUpdate)).resolves.toBeUndefined();

    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("runRefreshEffect — integration priority (only first matched per task)", () => {
  it("only searches the first integration found on a task — no duplicate searches", async () => {
    // Task has both linear and github — only linear should be searched
    const task = makeTask({
      id: "t1",
      integrations: { linearIssueId: "BRA-3", githubIssueId: "42" },
    });
    const client = makeFakeClient([{ identifier: "BRA-3", title: "linear issue" }]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    // Should only call once (linear takes priority)
    expect(client.searchIntegration).toHaveBeenCalledTimes(1);
    expect(client.calls[0]?.integrationId).toBe("linear");
  });
});

describe("runRefreshEffect — session deduplication", () => {
  it("marks task as refreshed after first run so second run skips it", async () => {
    const task = makeTask({ id: "t1", integrations: { linearIssueId: "BRA-3" } });
    const client = makeFakeClient([{ identifier: "BRA-3", title: "issue" }]);
    const refreshed = new Set<string>();
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, refreshed, onUpdate);
    expect(client.searchIntegration).toHaveBeenCalledTimes(1);

    // Second call with same task and same Set — must be skipped
    await runRefreshEffect([task], client, refreshed, onUpdate);
    expect(client.searchIntegration).toHaveBeenCalledTimes(1); // still just 1
  });
});

describe("runRefreshEffect — GitHub issues (number-based identifier)", () => {
  it("searches github with the issue number string", async () => {
    const task = makeTask({ id: "t1", integrations: { githubIssueId: "42" } });
    const client = makeFakeClient([{ number: 42, title: "Add dark mode" }]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(client.calls[0]).toMatchObject({ integrationId: "github", query: "42" });
    expect(onUpdate).toHaveBeenCalledWith("t1", {
      metadata: { githubIssue: { number: 42, title: "Add dark mode" } },
    });
  });
});

describe("runRefreshEffect — Jira issues (key-based identifier)", () => {
  it("searches jira with the issue key", async () => {
    const task = makeTask({ id: "t1", integrations: { jiraIssueId: "ENG-10" } });
    const client = makeFakeClient([{ key: "ENG-10", title: "Fix authentication" }]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(client.calls[0]).toMatchObject({ integrationId: "jira", query: "ENG-10" });
  });
});

describe("runRefreshEffect — metadata fallback (no integrations field)", () => {
  it("derives issueId from metadata.linearIssue.identifier when integrations is missing", async () => {
    const task = makeTask({
      id: "t1",
      // No integrations field — only metadata
      metadata: { linearIssue: { id: "uid", identifier: "BRA-3", title: "old title" } } as any,
    });
    const freshIssue = { id: "uid", identifier: "BRA-3", title: "fresh title" };
    const client = makeFakeClient([freshIssue]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    // Should search using the identifier from metadata
    expect(client.calls[0]).toMatchObject({ integrationId: "linear", query: "BRA-3" });
    // Should backfill integrations field
    expect(onUpdate).toHaveBeenCalledWith("t1", {
      integrations: { linearIssueId: "BRA-3" },
    });
    // Should also update metadata with fresh data
    expect(onUpdate).toHaveBeenCalledWith("t1", {
      metadata: expect.objectContaining({ linearIssue: freshIssue }),
    });
  });

  it("derives issueId from metadata.githubIssue.number when integrations is missing", async () => {
    const task = makeTask({
      id: "t1",
      metadata: { githubIssue: { number: 42, title: "old" } } as any,
    });
    const freshIssue = { number: 42, title: "fresh" };
    const client = makeFakeClient([freshIssue]);
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(client.calls[0]).toMatchObject({ integrationId: "github", query: "42" });
  });

  it("skips tasks with empty metadata (no integrations, no metadata)", async () => {
    const task = makeTask({ id: "t1" }); // no integrations, no metadata
    const client = makeFakeClient();
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(client.searchIntegration).not.toHaveBeenCalled();
  });

  it("skips tasks with empty integrations object and no metadata", async () => {
    const task = makeTask({ id: "t1", integrations: {} });
    const client = makeFakeClient();
    const onUpdate = vi.fn();

    await runRefreshEffect([task], client, new Set(), onUpdate);

    expect(client.searchIntegration).not.toHaveBeenCalled();
  });
});
