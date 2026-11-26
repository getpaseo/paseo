import { expect, it } from "vitest";
import { normalizeProjectDescriptor, normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { ReplicaCache } from ".";
import { createIndexedDbReplicaRowStore } from "./row-store.web";

const SERVER_ID = "shared-host";
const noLegacyCleanup = { clearLegacyCache: async () => undefined };

// Each browser tab opens its own ReplicaCache over the same IndexedDB database.
function openTab(databaseName: string, maxBytes?: number): ReplicaCache {
  const store = createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 });
  const cache = new ReplicaCache(store, { ...noLegacyCleanup, ...(maxBytes ? { maxBytes } : {}) });
  cache.setHosts([SERVER_ID]);
  return cache;
}

function workspace(name: string) {
  return normalizeWorkspaceDescriptor({
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Paseo",
    projectRootPath: "/repo/paseo",
    workspaceDirectory: "/repo/paseo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name,
    status: "running",
    statusEnteredAt: "2026-07-18T08:00:00.000Z",
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  });
}

const project = normalizeProjectDescriptor({
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectRootPath: "/repo/paseo",
  projectKind: "git",
});

const checkpoint = {
  projects: { generation: "g", afterSeq: 31 },
  workspaces: { generation: "g:background", afterSeq: 1494 },
};

// #10206: one tab evicts the host while another tab keeps writing directory deltas.
it("does not store a checkpoint for rows that another tab evicted", async () => {
  const databaseName = `replica-cross-tab-${crypto.randomUUID()}`;
  const syncingTab = openTab(databaseName);
  syncingTab.replaceDirectoryBaseline(SERVER_ID, {
    agents: new Map(),
    workspaces: new Map([["workspace-1", workspace("main")]]),
    projects: new Map([["project-1", project]]),
    checkpoint,
  });
  await syncingTab.flush();

  const evictingTab = openTab(databaseName, 8_192);
  await evictingTab.readDirectory(SERVER_ID);
  evictingTab.commitTimeline(SERVER_ID, "agent-1", {
    agentId: "agent-1",
    items: [
      {
        kind: "assistant_message",
        id: "message-1",
        text: "x".repeat(16_384),
        timestamp: new Date("2026-07-18T08:02:00.000Z"),
        timelineCursor: { epoch: "epoch-1", seq: 12 },
      },
    ],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 12 },
    hasOlder: false,
  });
  await evictingTab.flush();
  expect((await openTab(databaseName).readDirectory(SERVER_ID)).checkpoint).toBeUndefined();

  syncingTab.commitDirectoryMutations(
    SERVER_ID,
    [{ kind: "workspace", type: "upsert", id: "workspace-1", value: workspace("renamed") }],
    { ...checkpoint, workspaces: { generation: "g:background", afterSeq: 1495 } },
  );
  await syncingTab.flush();

  // The second tab wrote over a directory it never saw evicted, so the store rejected the write.
  const newTab = await openTab(databaseName).readDirectory(SERVER_ID);
  expect(newTab.projects.size).toBe(0);
  expect(newTab.checkpoint).toBeUndefined();
});
