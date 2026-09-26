import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// #5447: a second client pins a workspace as soon as it sees it appear, while
// the creating client is still waiting for its initial agent.
test("workspace.create response reflects a pin made while the initial agent was starting", async () => {
  const daemon = await createTestPaseoDaemon();
  const directory = mkdtempSync(path.join(tmpdir(), "workspace-pin-order-"));
  const creator = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.9.2",
  });
  const pinner = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.9.2",
  });
  const seen: Array<{ source: string; pinnedAt: string | null | undefined }> =
    [];
  try {
    await creator.connect();
    await pinner.connect();
    await creator.fetchWorkspaces({ subscribe: {} });
    await pinner.fetchWorkspaces({ subscribe: {} });
    const pinned = new Set<string>();
    pinner.subscribeRawMessages((message) => {
      if (
        message.type !== "workspace_update" ||
        message.payload.kind !== "upsert"
      )
        return;
      const id = message.payload.workspace.id;
      if (pinned.has(id)) return;
      pinned.add(id);
      void pinner.setWorkspacePinned(id, true);
    });
    creator.subscribeRawMessages((message) => {
      if (
        message.type === "workspace_update" &&
        message.payload.kind === "upsert"
      ) {
        seen.push({
          source: "workspace_update",
          pinnedAt: message.payload.workspace.pinnedAt,
        });
      }
      if (message.type === "workspace.create.response") {
        seen.push({
          source: "create_response",
          pinnedAt: message.payload.workspace?.pinnedAt,
        });
      }
    });

    const created = await creator.createWorkspace({
      source: { kind: "directory", path: directory },
      agent: { provider: "claude", cwd: directory, modeId: "default" },
    });
    expect(created.error).toBeNull();

    const liveBeforeResponse = seen
      .slice(
        0,
        seen.findIndex((entry) => entry.source === "create_response")
      )
      .filter((entry) => entry.source === "workspace_update")
      .at(-1);
    expect(liveBeforeResponse?.pinnedAt).toBeTruthy();
    expect(created.workspace?.pinnedAt).toBe(liveBeforeResponse?.pinnedAt);
  } finally {
    await creator.close().catch(() => undefined);
    await pinner.close().catch(() => undefined);
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180000);
