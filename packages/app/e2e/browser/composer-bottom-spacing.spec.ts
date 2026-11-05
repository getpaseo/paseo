import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function box(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: 30_000 });
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return { top: rect!.y, bottom: rect!.y + rect!.height };
}

test.describe("Composer bottom spacing", () => {
  test("the chat composer rests one content spacing above the window edge", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-bottom-spacing-",
      title: "Bottom spacing",
    });
    try {
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      const surface = await box(
        page.getByTestId("message-input-root").filter({ visible: true }).first(),
      );
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      expect(viewportHeight - surface.bottom).toBe(16);
    } finally {
      await agent.cleanup();
    }
  });

  test("the wide new workspace form keeps one content spacing above Import session", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "composer-bottom-spacing-form-" });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: workspace.projectKey,
        projectDisplayName: workspace.projectDisplayName,
      });
      const composer = await box(page.locator('[data-testid="message-input-root"]:visible'));
      const importButton = await box(page.getByTestId("new-workspace-import-session"));
      expect(importButton.top - composer.bottom).toBe(16);
    } finally {
      await workspace.cleanup();
    }
  });
});
