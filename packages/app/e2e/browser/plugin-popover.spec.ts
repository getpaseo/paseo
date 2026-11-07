import { expect, test, type Page } from "../support/fixtures";
import { composerLocator, submitMessageWithButton } from "../support/helpers/composer";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { withPopoverTimelinePlugin } from "../support/helpers/plugin-timeline";

async function openPreviewWhileTyping(page: Page): Promise<void> {
  await composerLocator(page).focus();
  await page.getByRole("button", { name: "Hover plugin preview", exact: true }).hover();
  await expect(page.getByRole("dialog", { name: "Plugin preview" })).toBeVisible();
  await expect(composerLocator(page)).toBeFocused();
}

async function dismissPreview(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Plugin preview" })).not.toBeVisible();
}

test("Escape dismisses a plugin preview before interrupting the agent", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "plugin-popover-",
    title: "Plugin preview keyboard regression",
    model: "e2e-fast-stream",
  });
  try {
    await withPopoverTimelinePlugin(async () => {
      await openAgentRoute(page, agent);
      await submitMessageWithButton(page, "Show the plugin preview.");
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expect(page.getByRole("button", { name: "Hover plugin preview" })).toBeVisible();
      await submitMessageWithButton(page, "withhold synthetic user message until interrupted");
      const stop = page.getByRole("button", { name: "Stop agent", exact: true });
      await expect(stop).toBeVisible();

      await openPreviewWhileTyping(page);
      await dismissPreview(page);
      await expect(stop).toBeVisible();
      await expect(composerLocator(page)).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(stop).not.toBeVisible();
      await agent.client.waitForFinish(agent.agentId, 15_000);
    });
  } finally {
    await agent.cleanup();
  }
});
