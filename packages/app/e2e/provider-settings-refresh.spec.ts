import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "./fixtures";
import { expectComposerVisible } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgentAtMobileBreakpoint(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-sheet-stack-",
    title: "Provider sheet stack e2e",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByRole("button", { name: /Select model/ })).toBeVisible({
    timeout: 30_000,
  });
  return session;
}

async function openProviderSettingsFromModelSelector(page: Page) {
  await page.getByRole("button", { name: /Select model/ }).click();
  await expect(page.getByLabel("Bottom Sheet", { exact: true })).toBeVisible({ timeout: 10_000 });

  const openCodeRow = page.getByText("OpenCode", { exact: true }).first();
  if (await openCodeRow.isVisible().catch(() => false)) {
    await openCodeRow.click();
  }

  await page.getByRole("button", { name: /Open .* settings/ }).click();
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
}

async function expectModelSelectorVisible(page: Page) {
  await expect(page.getByRole("button", { name: /Open .* settings/ })).toBeVisible({
    timeout: 10_000,
  });
}

async function closeTopSheet(page: Page) {
  const closeTarget = page.getByLabel("Close", { exact: true }).last();
  if (await closeTarget.isVisible().catch(() => false)) {
    await closeTarget.click({ force: true });
    return;
  }

  const handle = page.getByRole("slider", { name: "Bottom sheet handle" }).last();
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error("Bottom sheet handle was not measurable");
  }
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 400, { steps: 8 });
  await page.mouse.up();
}

async function closeSheetByHeaderButton(page: Page, testId: string) {
  const sheet = page.getByTestId(testId);
  await sheet.getByLabel("Close", { exact: true }).click();
  await expect(sheet).not.toBeVisible({ timeout: 10_000 });
}

async function expectOverlayAbove(page: Page, frontTestId: string, backTestId: string) {
  const frontCoversBack = await page.evaluate(
    ({ frontTestId: frontId, backTestId: backId }) => {
      const front = document.querySelector(`[data-testid="${frontId}"]`);
      const back = document.querySelector(`[data-testid="${backId}"]`);
      if (!(front instanceof HTMLElement) || !(back instanceof HTMLElement)) return false;

      const frontRect = front.getBoundingClientRect();
      const backRect = back.getBoundingClientRect();
      const left = Math.max(frontRect.left, backRect.left);
      const right = Math.min(frontRect.right, backRect.right);
      const top = Math.max(frontRect.top, backRect.top);
      const bottom = Math.min(frontRect.bottom, backRect.bottom);
      if (left >= right || top >= bottom) return false;

      const topElement = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return topElement != null && front.contains(topElement);
    },
    { frontTestId, backTestId },
  );
  expect(frontCoversBack).toBe(true);
}

async function hasFocusWithin(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.contains(document.activeElement));
}

async function expectProviderSettingsVisible(page: Page) {
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Add model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diagnostic", exact: true })).toBeVisible();
}

async function exerciseProviderSettingsStack(page: Page) {
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByTestId("add-custom-model-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "add-custom-model-sheet");
  await expect(page.getByPlaceholder("e.g. openai/gpt-5")).not.toBeVisible({ timeout: 10_000 });
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Diagnostic", exact: true }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Refresh diagnostic/ }).click();
  await expect(page.getByTestId("provider-diagnostic-sheet")).toBeVisible({ timeout: 10_000 });
  await closeSheetByHeaderButton(page, "provider-diagnostic-sheet");
  await expectProviderSettingsVisible(page);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expectProviderSettingsVisible(page);
}

test.describe("provider settings overlay stack", () => {
  test("provider settings covers the desktop model selector without closing it", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-modal-layer-",
      title: "Provider modal layer e2e",
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);

      await page.getByRole("button", { name: /Select model/ }).click();
      const selector = page.getByTestId("combobox-desktop-container");
      await expect(selector).toBeVisible({ timeout: 10_000 });
      const searchInput = page.getByRole("textbox", { name: /search models/i });
      await expect(searchInput).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => hasFocusWithin(selector)).toBe(true);

      await page.keyboard.press("Shift+?");
      const shortcuts = page.getByTestId("keyboard-shortcuts-dialog");
      await expect(shortcuts).toBeVisible({ timeout: 10_000 });
      await expect(page.getByPlaceholder("Search shortcuts")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(shortcuts).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();

      const settingsButton = page.getByTestId("selector-header-settings-mock");
      await settingsButton.click();

      const settings = page.getByTestId("provider-settings-sheet");
      await expect(settings).toBeVisible({ timeout: 10_000 });
      await expectOverlayAbove(page, "provider-settings-sheet", "combobox-desktop-container");

      await page.keyboard.press("Escape");
      await expect(settings).not.toBeVisible({ timeout: 10_000 });
      await expect(selector).toBeVisible();
      await expect(settingsButton).toBeFocused();
    } finally {
      await session.cleanup();
    }
  });

  test("provider settings and children close back through the model selector stack", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const session = await openMockAgentAtMobileBreakpoint(page);

    try {
      await openProviderSettingsFromModelSelector(page);
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelSelectorVisible(page);
      await page.getByRole("button", { name: /Open .* settings/ }).click();
      await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 10_000 });
      await exerciseProviderSettingsStack(page);
      await closeSheetByHeaderButton(page, "provider-settings-sheet");

      await expectModelSelectorVisible(page);
      await closeTopSheet(page);
    } finally {
      await session.cleanup();
    }
  });
});
