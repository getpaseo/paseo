import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

for (const viewport of [
  { width: 1280, height: 850 },
  { width: 390, height: 844 },
]) {
  test(`shows a model switch in the timeline at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "model-switch-timeline-",
      title: "Model switch",
    });
    const client = await connectDaemonClient<
      Pick<DaemonClient, "setAgentModel" | "close" | "connect">
    >({ clientIdPrefix: "model-switch-timeline" });
    try {
      await openAgentRoute(page, agent);
      await client.setAgentModel(agent.agentId, "e2e-another-model");
      const marker = page.getByText("Switched to e2e-another-model", { exact: true });
      await expect(marker).toBeVisible({ timeout: 30_000 });
      const markerRow = marker.locator("..");
      await expect(markerRow.locator('svg path[stroke-width="0.5"]')).toHaveCount(2);
      await page.reload();
      await expect(marker).toBeVisible({ timeout: 30_000 });
      await expect(marker).toHaveCount(1);
    } finally {
      await client.close();
      await agent.cleanup();
    }
  });
}
