import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { SessionOutboundMessage } from "../messages.js";

test("a warm reconnect does not resend the unchanged workspace snapshot", async () => {
  const artifacts = path.resolve(".artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "workspace-reconnect-"));
  const cwd = path.join(root, "repo");
  await mkdir(cwd);
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  await writeFile(path.join(cwd, "README.md"), "initial\n");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Initial",
    ],
    { cwd, stdio: "ignore" },
  );
  const homeRoot = path.join(root, "home");
  const registry = path.join(homeRoot, ".paseo", "projects");
  await mkdir(registry, { recursive: true });
  const timestamps = {
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
  };
  await writeFile(
    path.join(registry, "projects.json"),
    JSON.stringify([
      {
        projectId: "prj_reconnect",
        rootPath: cwd,
        kind: "git",
        displayName: "Reconnect",
        ...timestamps,
      },
    ]),
  );
  await writeFile(
    path.join(registry, "workspaces.json"),
    JSON.stringify(
      Array.from({ length: 3 }, (_, index) => ({
        workspaceId: `wks_reconnect_${index}`,
        projectId: "prj_reconnect",
        cwd,
        kind: "local_checkout",
        displayName: `Workspace ${index}`,
        title: `Workspace ${index}`,
        ...timestamps,
      })),
    ),
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    staticDir: path.join(root, "static"),
    cleanup: false,
    agentClients: {},
    pluginsEnabled: false,
  });
  const clients: DaemonClient[] = [];
  try {
    const warm = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    clients.push(warm);
    await warm.connect();
    await warm.getCheckoutStatus(cwd);
    await warm.close();

    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    clients.push(client);
    await client.connect();
    const updates: Extract<SessionOutboundMessage, { type: "workspace_update" }>[] = [];
    const events = client.observeEvents(["checkout_status_update"]);
    events.subscribe({ snapshot: () => {}, update: () => {} });
    await events.ready;
    const snapshot = await client.fetchWorkspaces({ sync: {}, subscribe: {} });
    snapshot.subscription.subscribe({
      snapshot() {},
      update(message) {
        if (message.type === "workspace_update") updates.push(message);
      },
    });
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.entries[0]?.gitRuntime?.currentBranch).toBe("main");
    await client.getCheckoutStatus(cwd);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await writeFile(
      path.join(root, "observed.json"),
      JSON.stringify({ snapshot, updates }, null, 2),
    );
    const values = new Map(
      snapshot.entries.map(({ syncSeq: _, ...workspace }) => [
        workspace.id,
        JSON.parse(JSON.stringify(workspace)),
      ]),
    );
    const identical = updates.filter(
      ({ payload }) =>
        payload.kind === "upsert" &&
        isDeepStrictEqual(
          JSON.parse(JSON.stringify(payload.workspace)),
          values.get(payload.workspace.id),
        ),
    );
    expect(identical, "workspace_update duplicates the snapshot without a data change").toEqual([]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await daemon.close();
  }
}, 30_000);
