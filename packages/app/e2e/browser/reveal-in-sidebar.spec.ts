import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const SHOT_DIR = "test-results/reveal";

test.describe("Reveal in sidebar", () => {
  test.describe.configure({ timeout: 240_000 });

  test("the header crosshair expands the collapsed project and flashes the current workspace row", async ({
    page,
  }) => {
    const alpha = await seedWorkspace({ repoPrefix: "reveal-alpha-", title: "Alpha work" });
    const beta = await seedWorkspace({ repoPrefix: "reveal-beta-", title: "Beta work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);
    const betaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`);
    // The project row is the workspace's own header; its testID suffix is a per-project key,
    // so anchor on the rendered name (the seeded repo basename) instead of a key format.
    const betaProjectRow = page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: "reveal-beta" });
    const revealButton = page.getByTestId("workspace-header-reveal-in-sidebar-button");

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toBeVisible();

      // Enter the Beta workspace so the header names it and the crosshair reveals it.
      await betaRow.click();
      await expect(page.getByTestId("workspace-header-title")).toHaveText(/Beta work/);
      await expect(revealButton).toBeVisible();
      await revealButton.hover();
      await expect(page.getByText("Reveal in sidebar")).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/1-crosshair-tooltip.png` });

      // Collapse the Beta project: the header still names it, but the row is hidden, so the
      // reveal has to expand the section before it can scroll the row into view.
      await betaProjectRow.click();
      await expect(betaRow).toHaveCount(0);
      await page.screenshot({ path: `${SHOT_DIR}/2-collapsed.png` });

      await revealButton.click();
      await expect(betaRow).toBeVisible({ timeout: 10_000 });
      // The scroll lands and the highlight pulses twice; catch it mid-flash.
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOT_DIR}/3-flash.png` });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOT_DIR}/4-settled.png` });
      await expect(betaRow).toBeInViewport();
    } finally {
      await alpha.cleanup();
      await beta.cleanup();
    }
  });

  test("the command center runs the same reveal", async ({ page }) => {
    const alpha = await seedWorkspace({ repoPrefix: "reveal-cmd-alpha-", title: "Alpha work" });
    const beta = await seedWorkspace({ repoPrefix: "reveal-cmd-beta-", title: "Beta work" });
    const serverId = getServerId();
    const betaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`);

    try {
      await gotoAppShell(page);
      await expect(betaRow).toBeVisible({ timeout: 30_000 });

      await betaRow.click();
      await expect(page.getByTestId("workspace-header-title")).toHaveText(/Beta work/);

      await page.keyboard.press("Control+K");
      const input = page.getByTestId("command-center-input");
      await expect(input).toBeVisible();
      await input.fill("reveal");
      await expect(
        page
          .getByTestId("command-center-results")
          .getByRole("button", { name: "Reveal in sidebar" }),
      ).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/5-command-center.png` });

      await page.keyboard.press("Enter");
      // The command closes and the current workspace's row flashes in the sidebar.
      await expect(page.getByTestId("command-center-panel")).toHaveCount(0);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOT_DIR}/6-command-center-flash.png` });
      await expect(betaRow).toBeInViewport();
    } finally {
      await alpha.cleanup();
      await beta.cleanup();
    }
  });
});
