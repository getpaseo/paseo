import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import {
  readReplicaCache,
  waitForWorkspaceInReplicaCache,
  writeReplicaCache,
} from "../support/helpers/replica-cache-storage";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

async function currentProjectCursor() {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "project-cache" });
  try {
    const { sync } = await client.listProjects({ sync: {} });
    if (sync?.mode !== "snapshot") throw new Error("Missing project snapshot");
    const cursor = { generation: sync.generation, afterSeq: sync.headSeq };
    const changes = await client.listProjects({ sync: cursor });
    expect(changes).toMatchObject({ projects: [], sync: { mode: "changes", removals: [] } });
    return cursor;
  } finally {
    await client.close();
  }
}

// #10206: a previous version could persist a current cursor without the project rows it describes.
test("a new tab restores projects missing from a legacy directory cache", async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "project-cache-" });
  const serverId = getServerId();
  const projectRow = `sidebar-project-row-${workspace.projectKey}`;
  try {
    await gotoAppShell(page);
    await expect(page.getByTestId(projectRow)).toBeVisible();
    await waitForWorkspaceInReplicaCache(page, workspace.workspaceId);

    const cache = await readReplicaCache(page);
    const host = cache?.hosts?.find((entry) => entry.serverId === serverId);
    if (!host) throw new Error("Missing cached host");
    const cursors = { projects: await currentProjectCursor() };
    await writeReplicaCache(page, {
      hosts: [{ ...host, projects: [], directorySync: { version: 1, cursors } }],
    });

    const newTab = await context.newPage();
    try {
      await newTab.routeWebSocket(/:6767\b/, (socket) => socket.close());
      await gotoAppShell(newTab);
      await expect(newTab.getByTestId(projectRow)).toBeVisible();
      await expect(
        newTab.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`),
      ).toBeVisible();
    } finally {
      await newTab.close();
    }
  } finally {
    await workspace.cleanup();
  }
});
