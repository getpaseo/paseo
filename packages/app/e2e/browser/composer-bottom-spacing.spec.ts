import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("Composer bottom spacing", () => {
  test("the chat composer rests one content spacing above the window edge", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-bottom-spacing-",
      title: "Bottom spacing",
    });
    try {
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      const surface = page.getByTestId("message-input-root").filter({ visible: true }).first();
      await expect(surface).toBeVisible({ timeout: 30_000 });
      const box = await surface.boundingBox();
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      expect(box).not.toBeNull();
      expect(viewportHeight - (box!.y + box!.height)).toBe(16);
    } finally {
      await agent.cleanup();
    }
  });
});
