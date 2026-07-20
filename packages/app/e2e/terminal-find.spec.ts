import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { TerminalE2EHarness, withTerminalInApp } from "./helpers/terminal-dsl";

async function assertFindBarReservesSpace(page: Page, harness: TerminalE2EHarness): Promise<void> {
  const surface = harness.terminalSurface(page).first();
  await expect(surface).toBeVisible({ timeout: 15_000 });

  const beforeBox = await surface.boundingBox();
  expect(beforeBox).not.toBeNull();

  await surface.click();
  await page.keyboard.press("Control+f");
  const findBar = page.getByTestId("terminal-find-bar");
  await expect(findBar).toBeVisible();

  const findBarBox = await findBar.boundingBox();
  const afterBox = await surface.boundingBox();
  expect(findBarBox).not.toBeNull();
  expect(afterBox).not.toBeNull();

  // "inline" placement (pane-find-bar.tsx) makes the find bar a normal-flow
  // sibling ABOVE the terminal output, pushing it down — not an absolutely
  // positioned overlay that would sit on top of (and hide) the top rows of
  // terminal output.
  expect(
    afterBox!.y,
    "terminal surface should move down to make room for the find bar",
  ).toBeGreaterThan(beforeBox!.y);
  expect(
    findBarBox!.y + findBarBox!.height,
    "find bar must not overlap the terminal surface below it",
  ).toBeLessThanOrEqual(afterBox!.y + 1);

  await page.keyboard.press("Escape");
  await expect(findBar).toBeHidden();
  await expect(async () => {
    const closedBox = await surface.boundingBox();
    expect(closedBox?.y).toBeLessThanOrEqual(beforeBox!.y + 1);
  }).toPass();
}

let harness: TerminalE2EHarness;

test.beforeAll(async () => {
  harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-find-" });
});

test.afterAll(async () => {
  await harness?.cleanup();
});

test.describe("Terminal find", () => {
  test("reserves space above the terminal viewport instead of overlaying it", async ({ page }) => {
    test.setTimeout(60_000);

    await withTerminalInApp(page, harness, { name: "terminal-find" }, () =>
      assertFindBarReservesSpace(page, harness),
    );
  });
});
