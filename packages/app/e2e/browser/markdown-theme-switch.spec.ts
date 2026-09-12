import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import {
  createAgentTabFromMenu,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { readTranscriptColors, THEME_SWITCH_COLORS } from "../support/helpers/markdown-theme";

/**
 * getpaseo/paseo#3581 baseline: with System appearance, a live OS scheme switch
 * while the page is open must repaint the agent transcript markdown, not just
 * the CSS-variable chrome around it.
 */
test("markdown repaints after a live system theme switch", async ({ page }) => {
  test.setTimeout(180_000);

  await page.emulateMedia({ colorScheme: "dark" });

  const workspace = await seedWorkspace({ repoPrefix: "md-theme-switch-" });

  try {
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
    await waitForWorkspaceTabsVisible(page);
    await createAgentTabFromMenu(page);
    await expectComposerVisible(page);

    const prompt = "Please review the scroll anchor behavior.";
    await submitMessage(page, prompt);
    const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
    await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
    await expect(page.getByText("Cycle 1", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    const dark = await readTranscriptColors(page);
    expect(dark.heading).toBe(THEME_SWITCH_COLORS.dark.heading);
    expect(dark.sidebar).toBe(THEME_SWITCH_COLORS.dark.sidebar);

    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(async () => (await readTranscriptColors(page)).heading, { timeout: 10_000 })
      .toBe(THEME_SWITCH_COLORS.light.heading);
    expect((await readTranscriptColors(page)).sidebar).toBe(THEME_SWITCH_COLORS.light.sidebar);
  } finally {
    await workspace.cleanup();
  }
});
