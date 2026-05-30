import { expect, test, type Page } from "./fixtures";
import { expectComposerVisible } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgentAtMobileBreakpoint(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "bottom-sheet-reopen-",
    title: "Bottom sheet reopen e2e",
    initialPrompt: "Prepare a bottom sheet reopen test agent.",
  });
  await openAgentRoute(page, session);
  await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible({
    timeout: 30_000,
  });
  await expectComposerVisible(page);
  await expect(page.getByRole("button", { name: /Select model/ })).toBeVisible({
    timeout: 30_000,
  });
  return session;
}

async function withMobileMockAgent(page: Page, run: () => Promise<void>) {
  const session = await openMockAgentAtMobileBreakpoint(page);

  try {
    await run();
  } finally {
    await session.cleanup();
  }
}

function bottomSheetBackdrop(page: Page) {
  return page.getByRole("button", { name: "Bottom sheet backdrop" }).first();
}

async function expectBottomSheetOpen(page: Page) {
  await expect(bottomSheetBackdrop(page)).toBeVisible({ timeout: 10_000 });
}

async function closeBottomSheetWithBackdrop(page: Page) {
  const backdrop = bottomSheetBackdrop(page);
  // A single backdrop tap can be dropped when it lands mid present-animation:
  // Gorhom ignores backdrop presses until the sheet settles at its snap point,
  // which a loaded CI runner makes likely (the model selector's sheet animates a
  // touch longer than the tab switcher's). Re-tap until the sheet dismisses. This
  // stays a pure backdrop dismissal — no Escape/pan fallback — so it still
  // exercises the real close path; the post-close guard below is what protects
  // the regression this test exists for: a sheet that dismisses, then re-presents.
  await expect(async () => {
    if (await backdrop.isVisible()) {
      const box = await backdrop.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + 24);
    }
    await expect(backdrop).not.toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  // Guard against the regression where the sheet starts dismissing, then re-presents.
  await page.waitForTimeout(500);
  await expect(backdrop).not.toBeVisible({ timeout: 1_000 });
}

async function openTabSwitcher(page: Page) {
  const trigger = page.getByRole("button", { name: /Switch tabs/ });
  await trigger.click();
  await expectBottomSheetOpen(page);
}

async function openModelSelector(page: Page) {
  await page.getByRole("button", { name: /Select model/ }).click();
  await expectBottomSheetOpen(page);
  await expect(
    page.getByLabel("Bottom Sheet", { exact: true }).getByText("Ten second stream", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 10_000 });
}

async function openAndCloseTabSwitcherTwice(page: Page) {
  await openTabSwitcher(page);
  await closeBottomSheetWithBackdrop(page);
  await openTabSwitcher(page);
  await closeBottomSheetWithBackdrop(page);
}

async function openAndCloseModelSelectorTwice(page: Page) {
  await openModelSelector(page);
  await closeBottomSheetWithBackdrop(page);
  await openModelSelector(page);
  await closeBottomSheetWithBackdrop(page);
}

test.describe("mobile bottom sheet reopen", () => {
  test("tab switcher can open, close, reopen, and close again", async ({ page }) => {
    await withMobileMockAgent(page, async () => {
      await openAndCloseTabSwitcherTwice(page);
    });
  });

  test("model selector can open, close, reopen, and close again", async ({ page }) => {
    await withMobileMockAgent(page, async () => {
      await openAndCloseModelSelectorTwice(page);
    });
  });
});
