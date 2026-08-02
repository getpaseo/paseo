import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runArchiveCommandWithDeps } from "./archive.js";

function createFakeDaemonClient(
  response: Awaited<ReturnType<DaemonClient["archiveWorkspace"]>>,
): DaemonClient {
  return {
    archiveWorkspace: async () => response,
    close: async () => {},
  } as unknown as DaemonClient;
}

describe("workspace archive", () => {
  it("returns every archived agent on success", async () => {
    const fakeClient = createFakeDaemonClient({
      requestId: "req-success",
      workspaceId: "workspace-1",
      archivedAt: "2026-08-02T00:00:00.000Z",
      removedAgents: ["agent-parent", "agent-child"],
      error: null,
    });

    await expect(
      runArchiveCommandWithDeps(
        "workspace-1",
        { host: "localhost:6767" },
        { connectToDaemon: async () => fakeClient },
      ),
    ).resolves.toMatchObject({
      type: "single",
      data: {
        workspaceId: "workspace-1",
        status: "archived",
        archivedAt: "2026-08-02T00:00:00.000Z",
        removedAgents: ["agent-parent", "agent-child"],
      },
    });
  });

  it("keeps exact unique partial receipts on failure", async () => {
    const fakeClient = createFakeDaemonClient({
      requestId: "req-failure",
      workspaceId: "workspace-1",
      archivedAt: null,
      removedAgents: ["agent-parent", "agent-child", "agent-parent"],
      error: "Injected final snapshot persistence failure",
    });

    await expect(
      runArchiveCommandWithDeps(
        "workspace-1",
        { host: "localhost:6767" },
        { connectToDaemon: async () => fakeClient },
      ),
    ).rejects.toMatchObject({
      code: "WORKSPACE_ARCHIVE_FAILED",
      message: "Injected final snapshot persistence failure",
      removedAgents: ["agent-parent", "agent-child"],
      details: "Archived agents before failure: agent-parent, agent-child",
    });
  });

  it("accepts a legacy response without a receipt", async () => {
    const fakeClient = createFakeDaemonClient({
      requestId: "req-legacy",
      workspaceId: "workspace-1",
      archivedAt: "2026-08-02T00:00:00.000Z",
      error: null,
    });

    await expect(
      runArchiveCommandWithDeps(
        "workspace-1",
        { host: "localhost:6767" },
        { connectToDaemon: async () => fakeClient },
      ),
    ).resolves.toMatchObject({ data: { removedAgents: [] } });
  });
});
