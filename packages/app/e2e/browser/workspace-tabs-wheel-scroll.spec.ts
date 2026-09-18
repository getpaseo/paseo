import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace, pressNewTabShortcut } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

// The strip keeps every tab at its minimum width once they stop fitting, so a
// narrow-but-desktop viewport reaches the overflow state with a handful of tabs.
const TABS_TO_OPEN = 12;
const VIEWPORT = { width: 760, height: 800 };

test("a vertical mouse wheel pans the overflowing workspace tab strip", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "workspace-tabs-wheel-" });
  try {
    await page.setViewportSize(VIEWPORT);
    await gotoWorkspace(page, workspace.workspaceId);

    for (let index = 0; index < TABS_TO_OPEN; index += 1) {
      await pressNewTabShortcut(page);
    }

    const strip = page.getByTestId("workspace-tabs-scroll").filter({ visible: true }).first();
    await expect(strip).toBeVisible({ timeout: 30_000 });

    const overflow = () => strip.evaluate((element) => element.scrollWidth - element.clientWidth);
    const scrollLeft = () => strip.evaluate((element) => element.scrollLeft);
    await expect.poll(overflow).toBeGreaterThan(0);

    // Nothing auto-scrolls the strip to the newest tab yet, so the leading edge is the start.
    expect(await scrollLeft()).toBe(0);
    await strip.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(scrollLeft).toBeGreaterThan(0);

    // The far edge is reachable, so every tab can be brought into view.
    await page.mouse.wheel(0, await overflow());
    await expect.poll(async () => (await overflow()) - (await scrollLeft())).toBeLessThanOrEqual(1);

    // The same wheel pans back to the leading edge.
    await page.mouse.wheel(0, -(await strip.evaluate((element) => element.scrollWidth)));
    await expect.poll(scrollLeft).toBe(0);
  } finally {
    await workspace.cleanup();
  }
});
