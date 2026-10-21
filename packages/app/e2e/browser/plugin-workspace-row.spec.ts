import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  installRowFixture,
  paintsAbove,
  runRowFixtureCommand,
  titleOpacity,
  workspaceRow,
} from "../support/helpers/plugin-workspace-row";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe("Plugin workspace row accessory", () => {
  test.describe.configure({ timeout: 180_000 });

  test("replaces the native slot only while a healthy accessory is registered", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "row-accessory-",
      title: "Fix flaky login test",
    });
    try {
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Fix flaky login test",
        model: "e2e-fast-stream",
        modeId: "load-test",
        initialPrompt: "emit synthetic turn failure",
      });
      const row = workspaceRow(page, workspace.workspaceId);
      const nativeStatus = row.getByTestId("workspace-status-indicator-failed");
      const accessory = row.getByTestId("row-fixture-accessory");
      const badge = row.getByTestId("project-status-badge");

      await gotoAppShell(page);
      // Without a plugin the row keeps its native status and nothing else in the slot.
      await expect(nativeStatus).toBeVisible({ timeout: 60_000 });
      await expect(accessory).toHaveCount(0);
      await expect(badge).toHaveCount(0);

      const fixture = await installRowFixture();
      try {
        // The accessory takes the slot and the native status stays as its corner badge.
        await expect(accessory).toBeVisible({ timeout: 60_000 });
        await expect(badge).toHaveAttribute("aria-label", "Failed");
        await expect(nativeStatus).toHaveCount(0);

        // A throwing accessory gives the row its native status back.
        await row.click();
        await runRowFixtureCommand(page, "Row fixture: break accessory");
        await expect(nativeStatus).toBeVisible();
        await expect(accessory).toHaveCount(0);

        // Removing it selects the healthy accessory again, without a plugin reload.
        await runRowFixtureCommand(page, "Row fixture: fix accessory");
        await expect(accessory).toBeVisible();
        await expect(nativeStatus).toHaveCount(0);
      } finally {
        await fixture.cleanup();
      }
    } finally {
      await workspace.cleanup();
    }
  });

  test("plays takeovers over the row with the native status on top", async ({ page }) => {
    const setup = await seedWorkspace({ repoPrefix: "row-takeover-setup-" });
    const failed = await seedWorkspace({
      repoPrefix: "row-takeover-",
      title: "Fix flaky login test",
    });
    try {
      await failed.client.createAgent({
        provider: "mock",
        cwd: failed.repoPath,
        workspaceId: failed.workspaceId,
        title: "Fix flaky login test",
        model: "e2e-fast-stream",
        modeId: "load-test",
        initialPrompt: "emit synthetic turn failure",
      });
      const fixture = await installRowFixture({ setupWorkspaceId: setup.workspaceId });
      try {
        await gotoAppShell(page);
        // A takeover requested while the plugin sets up plays, and the plugin stays loaded.
        const setupRow = workspaceRow(page, setup.workspaceId);
        await expect(setupRow.getByText("takeover setup")).toBeVisible({ timeout: 60_000 });

        // The Overlay asks for pointer events, but a click on it still opens the row's workspace.
        const setupOverlay = await setupRow.getByTestId("row-fixture-overlay").boundingBox();
        if (!setupOverlay) throw new Error("setup overlay is not rendered");
        await page.mouse.click(
          setupOverlay.x + setupOverlay.width / 2,
          setupOverlay.y + setupOverlay.height / 2,
        );
        await expect(page).toHaveURL(
          new RegExp(`${escapeRegExp(buildHostWorkspaceRoute(getServerId(), setup.workspaceId))}$`),
        );

        const row = workspaceRow(page, failed.workspaceId);
        const badge = row.getByTestId("project-status-badge");
        const overlay = row.getByTestId("row-fixture-overlay");
        await expect(row.getByTestId("row-fixture-accessory")).toBeVisible();
        await row.click();
        // Hovering changes the title's opacity: measure with the pointer away from the sidebar.
        await page.mouse.move(1000, 600);
        const opacity = () => titleOpacity(row, "Fix flaky login test");
        const restingOpacity = await opacity();
        expect(restingOpacity).toBeGreaterThan(0);

        // An opaque Overlay covers the row; the host's status badge stays above it.
        await runRowFixtureCommand(page, "Row fixture: takeover");
        await expect(overlay).toBeVisible();
        await expect.poll(opacity).toBe(0);
        await expect(badge).toHaveAttribute("aria-label", "Failed");
        expect(await paintsAbove(badge, overlay)).toBe(true);

        await runRowFixtureCommand(page, "Row fixture: stop takeover");
        await expect(overlay).toHaveCount(0);
        await expect.poll(opacity).toBe(restingOpacity);

        // An Overlay that throws ends its takeover at once instead of hiding the row for 10 s.
        await runRowFixtureCommand(page, "Row fixture: throwing takeover");
        await expect.poll(opacity, { timeout: 3_000 }).toBe(restingOpacity);
        await expect(overlay).toHaveCount(0);

        // Removing the accessory ends its takeover: the row text never shows under a live Overlay.
        await runRowFixtureCommand(page, "Row fixture: takeover");
        await expect(overlay).toBeVisible();
        await runRowFixtureCommand(page, "Row fixture: remove accessory");
        // Well before the 10 s takeover would end on its own.
        await expect(overlay).toHaveCount(0, { timeout: 2_000 });
        await expect(row.getByTestId("workspace-status-indicator-failed")).toBeVisible();
        await expect.poll(opacity, { timeout: 3_000 }).toBe(restingOpacity);
      } finally {
        await fixture.cleanup();
      }
    } finally {
      await failed.cleanup();
      await setup.cleanup();
    }
  });
});
