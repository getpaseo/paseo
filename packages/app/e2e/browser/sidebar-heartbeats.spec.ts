import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";

test("shows a subagent's scheduled heartbeat in the idle slot when enabled", async ({ page }) => {
  const parent = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-heartbeat-",
    title: "Heartbeat parent",
  });
  const client = parent.client as unknown as DaemonClient;
  let scheduleId: string | undefined;
  try {
    const child = await client.createAgent({
      provider: "mock",
      model: "ten-second-stream",
      modeId: "load-test",
      cwd: parent.cwd,
      workspaceId: parent.workspaceId,
      callerAgentId: parent.agentId,
      title: "Heartbeat child",
    });
    await openAgentRoute(page, { workspaceId: parent.workspaceId, agentId: child.id });
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${parent.workspaceId}`);
    const idle = row.getByTestId("workspace-status-indicator-done");
    const scheduled = row.getByTestId("workspace-status-indicator-heartbeat");
    const running = row.getByTestId("workspace-status-indicator-running");

    const created = await client.scheduleCreate({
      name: "Check delegated work",
      prompt: "Check the work",
      cadence: { type: "cron", expression: "0 0 1 1 *" },
      target: { type: "self", agentId: child.id },
      runOnCreate: false,
    });
    expect(created.error).toBeNull();
    scheduleId = created.schedule!.id;
    const tasks = page.getByRole("button", { name: "1 background task", exact: true });
    await expect(tasks).toBeVisible();
    await expect(idle).toBeVisible();

    await page.getByTestId("sidebar-display-preferences-menu").click();
    await page.getByTestId("sidebar-display-show-heartbeats").click();
    await page.keyboard.press("Escape");
    await expect(scheduled).toHaveAccessibleName("Heartbeat scheduled");
    await expect(idle).toHaveCount(0);
    await expect(running).toHaveCount(0);
    expect((await client.findWorkspace(parent.workspaceId))?.status).toBe("done");

    const [fired] = await Promise.all([
      client.scheduleRunOnce({ id: scheduleId }),
      expect(running).toBeVisible(),
    ]);
    expect(fired.error).toBeNull();
    await client.waitForFinish(child.id, 30_000);
    await client.clearWorkspaceAttention(parent.workspaceId);
    await expect(scheduled).toBeVisible();
    await expect(running).toHaveCount(0);

    await tasks.click();
    await page
      .getByTestId("background-work-panel")
      .getByRole("button", { name: "Stop Check delegated work" })
      .click();
    await expect(tasks).toHaveCount(0);
    await expect(idle).toBeVisible();
    await expect(scheduled).toHaveCount(0);
  } finally {
    if (scheduleId) await client.scheduleDelete({ id: scheduleId });
    await parent.cleanup();
  }
});
