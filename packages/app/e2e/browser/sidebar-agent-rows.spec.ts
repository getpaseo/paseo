import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

/**
 * A workspace row draws an agent sub-list only when it holds more than one active root agent.
 * These cover the geometry that reading the styles cannot settle: the disclosure lives in the
 * leading slot and swaps with the status indicator on hover, the count sits on the meta line, and
 * the sub-list hangs on that count's rail.
 *
 * The kebab check is kept even though the disclosure no longer shares the trailing slot with it.
 * It shipped there once, painted over by an overlay that `toBeVisible` was happy with, and this
 * is what would catch a move back.
 */

const AGENT_TITLES = ["Rebase onto upstream main", "Port sidebar agent rows", "Audit COMPAT tags"];

function rowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

test.describe("sidebar agent rows", () => {
  test("shows a count, expands, and keeps the kebab readable on hover", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-" });
    try {
      for (const title of AGENT_TITLES) {
        await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }

      await gotoAppShell(page);

      const row = page.getByTestId(rowTestId(workspace.workspaceId));
      await expect(row).toBeVisible({ timeout: 30_000 });

      const disclosure = page.getByTestId("sidebar-agent-list-disclosure");
      await expect(disclosure).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sidebar-workspace-agent-count")).toContainText(
        String(AGENT_TITLES.length),
      );

      // Collapsed by default: the count is there, the rows are not.
      await expect(page.getByTestId("sidebar-agent-list")).toHaveCount(0);

      await page.screenshot({ path: "test-results/agent-rows-collapsed-idle.png" });

      // Hover is where the kebab fades in over the trailing slot. The count must stay legible.
      //
      // `toBeVisible` is not enough for this: the kebab is an absolutely positioned overlay, so it
      // can paint over a control without changing its computed visibility. Compare boxes instead.
      await row.hover();
      await expect(disclosure).toBeVisible();
      await page.screenshot({ path: "test-results/agent-rows-collapsed-hover.png" });

      const kebab = page.getByTestId(
        `sidebar-workspace-kebab-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(kebab).toBeVisible({ timeout: 10_000 });
      const countBox = await disclosure.boundingBox();
      const kebabBox = await kebab.boundingBox();
      expect(countBox).not.toBeNull();
      expect(kebabBox).not.toBeNull();
      if (countBox && kebabBox) {
        const overlap =
          Math.min(countBox.x + countBox.width, kebabBox.x + kebabBox.width) -
          Math.max(countBox.x, kebabBox.x);
        expect(overlap, `count overlapped by the kebab by ${overlap}px`).toBeLessThanOrEqual(0);
      }

      await disclosure.click();
      const list = page.getByTestId("sidebar-agent-list");
      await expect(list).toBeVisible({ timeout: 10_000 });
      for (const title of AGENT_TITLES) {
        await expect(list.getByText(title, { exact: true })).toBeVisible();
      }

      // The row announces what distinguishes it, not just its title: two agents a provider has
      // not named yet would otherwise be spoken identically.
      const rows = list.getByRole("button");
      const spoken = await rows.first().getAttribute("aria-label");
      expect(spoken).toContain("mock");
      expect(spoken).toMatch(/Working|Done|Needs input|Ready to review|Failed/);

      // The sub-list hangs off the count, so its dots share a left rail with that digit. Without
      // it the rows read as a second, unrelated column.
      const railBox = await page.getByTestId("sidebar-workspace-agent-count").boundingBox();
      const firstDotBox = await list
        .getByTestId(/^sidebar-agent-row-dot-/)
        .first()
        .boundingBox();
      expect(railBox).not.toBeNull();
      expect(firstDotBox).not.toBeNull();
      if (railBox && firstDotBox) {
        const drift = Math.abs(firstDotBox.x - railBox.x);
        expect(
          drift,
          `agent dots drift ${drift}px from the count rail (dot x=${firstDotBox.x}, count x=${railBox.x})`,
        ).toBeLessThanOrEqual(1);
      }

      await row.hover();
      await page.screenshot({ path: "test-results/agent-rows-expanded-hover.png" });
    } finally {
      await workspace.cleanup();
    }
  });

  test("expands from the leading slot in status grouping too", async ({ page }) => {
    // Status and label grouping hoist rows out of their project block, so the leading slot carries
    // a project icon rather than a status indicator. The toggle has to wrap both: wrapping only
    // the indicator left those rows showing a count they could never open.
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-status-" });
    try {
      for (const title of AGENT_TITLES) {
        await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }

      await gotoAppShell(page);
      const row = page.getByTestId(rowTestId(workspace.workspaceId));
      await expect(row).toBeVisible({ timeout: 30_000 });

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await page.getByTestId("sidebar-display-grouping").click();
      await page.getByTestId("sidebar-grouping-status").click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sidebar-status-group-done")).toBeVisible({ timeout: 20_000 });

      const toggle = page.getByTestId("sidebar-agent-list-disclosure").first();
      await expect(toggle).toBeVisible({ timeout: 20_000 });

      // Hover the row and wait for the chevron before clicking. The toggle's child swaps from the
      // project icon to a narrower chevron on hover, so clicking mid-swap aims at the old box.
      await row.hover();
      await expect(toggle.locator("svg")).toBeVisible({ timeout: 8_000 });
      await toggle.click();

      const list = page.getByTestId("sidebar-agent-list");
      await expect(list).toBeVisible({ timeout: 10_000 });
      for (const title of AGENT_TITLES) {
        await expect(list.getByText(title, { exact: true })).toBeVisible();
      }
    } finally {
      await workspace.cleanup();
    }
  });

  test("leaves the rest of the row navigating", async ({ page }) => {
    // The toggle carries a generous hitSlop so touch can reach it. That slop must not reach the
    // title: everything outside the leading slot still opens the workspace.
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-nav-" });
    try {
      for (const title of AGENT_TITLES) {
        await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }

      await gotoAppShell(page);
      const row = page.getByTestId(rowTestId(workspace.workspaceId));
      await expect(row).toBeVisible({ timeout: 30_000 });
      const toggle = page.getByTestId("sidebar-agent-list-disclosure");
      await expect(toggle).toBeVisible({ timeout: 30_000 });

      // Press just right of the toggle's slop, where the title starts.
      const toggleBox = await toggle.boundingBox();
      const rowBox = await row.boundingBox();
      expect(toggleBox).not.toBeNull();
      expect(rowBox).not.toBeNull();
      if (toggleBox && rowBox) {
        await page.mouse.click(toggleBox.x + toggleBox.width + 16, rowBox.y + rowBox.height / 2);
      }

      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      await expect(page.getByTestId("sidebar-agent-list")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("holds the title rail when the leading slot swaps to a chevron", async ({ page }) => {
    // The toggle shows a 16px status slot at rest and a 14px chevron on hover. If it sizes to its
    // content, the title and meta line slide sideways as the pointer crosses the row.
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-rail-" });
    try {
      for (const title of AGENT_TITLES) {
        await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }

      await gotoAppShell(page);
      const row = page.getByTestId(rowTestId(workspace.workspaceId));
      await expect(row).toBeVisible({ timeout: 30_000 });
      const count = page.getByTestId("sidebar-workspace-agent-count");
      await expect(count).toBeVisible({ timeout: 30_000 });

      const atRest = await count.boundingBox();
      await row.hover();
      const toggle = page.getByTestId("sidebar-agent-list-disclosure");
      await expect(toggle.locator("svg")).toBeVisible({ timeout: 8_000 });
      const hovered = await count.boundingBox();

      expect(atRest).not.toBeNull();
      expect(hovered).not.toBeNull();
      if (atRest && hovered) {
        const shift = Math.abs(hovered.x - atRest.x);
        expect(shift, `row content shifted ${shift}px on hover`).toBeLessThanOrEqual(0.5);
      }
    } finally {
      await workspace.cleanup();
    }
  });

  test("opens the list from the meta-line count as well", async ({ page }) => {
    // The leading toggle is a 6px dot with no hover on touch. The count is the same action on a
    // target a thumb can find.
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-count-" });
    try {
      for (const title of AGENT_TITLES) {
        await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
          modeId: "load-test",
          model: "e2e-fast-stream",
        });
      }

      await gotoAppShell(page);
      await expect(page.getByTestId(rowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });
      const count = page.getByTestId("sidebar-workspace-agent-count");
      await expect(count).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sidebar-agent-list")).toHaveCount(0);

      await count.click();
      await expect(page.getByTestId("sidebar-agent-list")).toBeVisible({ timeout: 10_000 });
      // Same action as the leading toggle, so it closes again and never navigates.
      await count.click();
      await expect(page.getByTestId("sidebar-agent-list")).toHaveCount(0);
      await expect(page).not.toHaveURL(/\/workspace\//);
    } finally {
      await workspace.cleanup();
    }
  });

  test("draws nothing for a workspace holding one agent", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "paseo-e2e-agent-rows-single-" });
    try {
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Only agent",
        modeId: "load-test",
        model: "e2e-fast-stream",
      });

      await gotoAppShell(page);
      await expect(page.getByTestId(rowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("sidebar-agent-list-disclosure")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
