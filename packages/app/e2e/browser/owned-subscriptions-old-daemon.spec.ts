import { randomUUID } from "node:crypto";
import { metroTest as test, expect } from "../support/fixtures";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

test("requires a host update before observing a published 0.2.5 daemon", async ({ page }) => {
  test.setTimeout(120_000);
  const serverId = `srv_old_pagination_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const daemon = await startIsolatedHostDaemon(serverId, { publishedVersion: "0.2.5" });
  const workspace = await seedWorkspace({
    repoPrefix: "timeline-old-daemon-pagination-",
    port: daemon.port,
  });
  const createdAgent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Published daemon pagination regression",
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const requests: unknown[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.type === "session" && frame.message.type !== "ping") requests.push(frame.message);
    }),
  );

  try {
    const host = buildSeededHost({
      serverId,
      endpoint: `127.0.0.1:${daemon.port}`,
      nowIso: new Date().toISOString(),
    });
    await page.addInitScript(
      ({ seededHost, preferences }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
        localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
      },
      { seededHost: host, preferences: buildCreateAgentPreferences() },
    );

    await page.goto(buildAgentRoute(workspace.workspaceId, createdAgent.id, serverId));
    const updateHost = page.getByText("Update the host to use this version of Paseo.", {
      exact: true,
    });
    await expect(updateHost).toHaveCount(1);
    await expect(updateHost).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage host", exact: true })).toBeVisible();
    expect(requests).toEqual([]);
    await page.reload();
    await expect(updateHost).toHaveCount(1);
    await expect(updateHost).toBeVisible();
    expect(requests).toEqual([]);
  } finally {
    await workspace.cleanup();
    await daemon.close();
  }
});
