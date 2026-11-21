import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoWorkspace } from "../../app/e2e/support/helpers/launcher";

function explorerSidebar(page: Page) {
  return page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
}

async function useDesktopWindowChrome(page: Page, mode: "native-mac" | "custom-windows") {
  await page.addInitScript((windowChromeMode) => {
    Object.assign(window, {
      paseoDesktop: {
        platform: windowChromeMode === "native-mac" ? "darwin" : "win32",
        windowChromeMode,
        invoke: async () => null,
        events: { on: async () => () => undefined },
        getPendingOpenProject: async () => null,
        window: {
          getCurrentWindow: () => ({
            isFullscreen: async () => false,
            onResized: async () => () => undefined,
          }),
        },
      },
    });
  }, mode);
}

function explorerToggle(page: Page, expanded: boolean) {
  return page.getByRole("button", {
    name: expanded ? "Close Explorer sidebar" : "Open Explorer sidebar",
    exact: true,
    expanded,
  });
}

async function recordExplorerToggle(button: Locator) {
  const recording = await button.evaluateHandle((target) => {
    const measure = () => {
      const glyph = target.querySelector("svg")?.getBoundingClientRect();
      return {
        connected: target.isConnected,
        x: glyph?.x,
        y: glyph?.y,
        width: glyph?.width,
        height: glyph?.height,
      };
    };
    const before = measure();
    const frames: ReturnType<typeof measure>[] = [];
    const done = new Promise<void>((resolve) => {
      target.addEventListener(
        "click",
        () => {
          const start = performance.now();
          const sample = () => {
            frames.push(measure());
            if (performance.now() - start < 300) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        },
        { once: true },
      );
    });
    return { before, frames, done };
  });
  try {
    await button.click();
    return await recording.evaluate(async ({ before, frames, done }) => {
      await done;
      return { before, frames };
    });
  } finally {
    await recording.dispose();
  }
}

async function expectExplorerToggleHasNativeClickArea(toggle: Locator) {
  const regions = await toggle.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    return [
      ...document.querySelectorAll('[style*="app-region"], [data-window-no-drag], [role="button"]'),
    ]
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left <= x && x < bounds.right && bounds.top <= y && y < bounds.bottom;
      })
      .map((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region"))
      .filter((region) => region === "drag" || region === "no-drag");
  });
  expect(regions).toContain("drag");
  expect(regions.at(-1)).toBe("no-drag");
}

async function expectExplorerToggleInHeaderTabOrder(page: Page, expanded: boolean) {
  const toggle = explorerToggle(page, expanded);
  await toggle.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Workspace actions", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(toggle).toBeFocused();
}

async function expectExplorerToggleToHoldPosition(page: Page, expanded: boolean) {
  const toggle = explorerToggle(page, expanded);
  await expect(toggle).toBeVisible();
  await expectExplorerToggleHasNativeClickArea(toggle);
  const { before, frames } = await recordExplorerToggle(toggle);
  await expect(explorerToggle(page, !expanded)).toBeVisible();
  expect(before.width).toBeGreaterThan(0);
  expect(frames.find((frame) => JSON.stringify(frame) !== JSON.stringify(before))).toBeUndefined();
}

test("keeps the Mac Explorer toggle in place across open and close", async ({
  page,
  withWorkspace,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useDesktopWindowChrome(page, "native-mac");

  const { workspaceId } = await withWorkspace();
  await gotoWorkspace(page, workspaceId);
  await expectExplorerToggleInHeaderTabOrder(page, false);
  await expectExplorerToggleToHoldPosition(page, false);
  await expectExplorerToggleInHeaderTabOrder(page, true);
  await expectExplorerToggleToHoldPosition(page, true);

  await page.setViewportSize({ width: 930, height: 900 });
  await expectExplorerToggleToHoldPosition(page, false);
  await expectExplorerToggleToHoldPosition(page, true);
});

async function expectClearOfWindowControls(page: Page, action: Locator) {
  const minimize = page.getByRole("button", { name: "Minimize window", exact: true });
  await expect(minimize).toBeVisible();
  await expect(action).toBeVisible();
  const controlBounds = await minimize.boundingBox();
  const actionBounds = await action.boundingBox();
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(controlBounds!.x);
}

test("keeps the Explorer actions clear of Windows controls", async ({ page, withWorkspace }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useDesktopWindowChrome(page, "custom-windows");

  const { workspaceId } = await withWorkspace();
  await gotoWorkspace(page, workspaceId);
  const open = explorerToggle(page, false);
  await expectClearOfWindowControls(page, open);
  await open.click();

  const close = explorerToggle(page, true);
  const newExplorerTab = explorerSidebar(page).getByRole("button", {
    name: "New tab",
    exact: true,
  });
  await expectClearOfWindowControls(page, close);
  await expectClearOfWindowControls(page, newExplorerTab);
  await close.click();
  await expect(open).toBeVisible();
});
