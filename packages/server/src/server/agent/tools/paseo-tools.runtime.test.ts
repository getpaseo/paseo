import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createStub } from "../../test-utils/class-mocks.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

test("runtime tool catalogs deny unannotated and cross-workspace operations", async () => {
  const catalog = createPaseoToolCatalog({
    agentManager: createStub<AgentManager>({
      getAgent: (agentId) =>
        agentId === "agent-1"
          ? {
              id: "agent-1",
              cwd: "/workspace/wks-1",
              workspaceId: "wks-1",
              labels: {},
            }
          : {
              id: agentId,
              cwd: "/workspace/wks-1",
              workspaceId: "wks-1",
              labels: { "paseo.parent-agent-id": "agent-1" },
            },
    }),
    agentStorage: createStub<AgentStorage>({}),
    providerSnapshotManager: createStub<ProviderSnapshotManager>({}),
    callerAgentId: "agent-1",
    runtimeScope: {
      workspaceId: "wks-1",
      toolGroups: new Set([
        "workspace",
        "agents",
        "terminals",
        "scripts",
        "heartbeats",
        "providers",
        "permissions",
        "browser",
        "voice",
      ]),
    },
    logger: createTestLogger(),
  });

  expect(catalog.getTool("list_workspaces")).toBeDefined();
  expect(catalog.getTool("rename_workspace")).toBeDefined();
  expect(catalog.getTool("create_workspace")).toBeUndefined();
  expect(catalog.getTool("archive_workspace")).toBeUndefined();
  expect(catalog.getTool("create_schedule")).toBeUndefined();
  await expect(
    catalog.executeTool("rename_workspace", {
      workspaceId: "wks-2",
      title: "Other",
    }),
  ).rejects.toThrow("outside the caller workspace");
  await expect(catalog.executeTool("rename_workspace", { title: "Current" })).rejects.toThrow(
    "Workspace registry is required",
  );
  await expect(
    catalog.executeTool("update_agent", {
      agentId: "agent-2",
      labels: { "paseo.parent-agent-id": "agent-3" },
    }),
  ).rejects.toThrow("cannot update reserved Paseo labels");
});

test("runtime tool execution rejects a revoked caller after catalog creation", async () => {
  let authorized = true;
  const catalog = createPaseoToolCatalog({
    agentManager: createStub<AgentManager>({
      getAgent: () => ({
        id: "agent-1",
        cwd: "/workspace/wks-1",
        workspaceId: "wks-1",
        labels: {},
      }),
    }),
    agentStorage: createStub<AgentStorage>({}),
    providerSnapshotManager: createStub<ProviderSnapshotManager>({}),
    callerAgentId: "agent-1",
    runtimeScope: {
      workspaceId: "wks-1",
      toolGroups: new Set(["workspace"]),
    },
    assertCallerAuthorized: async () => {
      if (!authorized) throw new Error("authorization is no longer valid");
    },
    logger: createTestLogger(),
  });

  authorized = false;
  await expect(catalog.executeTool("list_workspaces", {})).rejects.toThrow(
    "authorization is no longer valid",
  );
});

test("explicit runtime scope remains restricted when its caller disappears", async () => {
  const catalog = createPaseoToolCatalog({
    agentManager: createStub<AgentManager>({ getAgent: () => null }),
    agentStorage: createStub<AgentStorage>({}),
    providerSnapshotManager: createStub<ProviderSnapshotManager>({}),
    callerAgentId: "agent-1",
    runtimeScope: {
      workspaceId: "wks-1",
      toolGroups: new Set(["workspace"]),
    },
    logger: createTestLogger(),
  });

  expect(catalog.getTool("list_workspaces")).toBeDefined();
  expect(catalog.getTool("create_workspace")).toBeUndefined();
  await expect(catalog.executeTool("list_workspaces", {})).rejects.toThrow(
    "caller is no longer active",
  );
});
