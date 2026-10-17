import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime } from "./support/runtime";

test("titlebar double-click toggles normal/maximized state without affecting controls", async ({
  page,
}) => {
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    manageBuiltInDaemon: false,
    windowMaximized: false,
  });
  await gotoAppShell(page);

  const topResizer = page.getByTestId("titlebar-top-resizer").first();
  const doubleClickFallback = page.getByTestId("titlebar-double-click-fallback").first();
  await expect(topResizer).toBeVisible({ timeout: 30_000 });
  await expect(doubleClickFallback).toBeVisible({ timeout: 30_000 });

  await topResizer.dblclick({ position: { x: 80, y: 2 } });
  await expect.poll(() => page.evaluate(() => window.__desktopWindowMaximized)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__desktopWindowToggleMaximizeCount)).toBe(1);

  // The same empty surface restores a maximized window. This is the path that
  // remains usable below the auto-hidden macOS menu-bar strip.
  await doubleClickFallback.dblclick({ position: { x: 80, y: 4 } });
  await expect.poll(() => page.evaluate(() => window.__desktopWindowMaximized)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__desktopWindowToggleMaximizeCount)).toBe(2);

  // Interactive children are siblings above the drag overlay and must not
  // forward their own double-clicks to the window bridge.
  const settingsButton = page.getByTestId("sidebar-settings").first();
  await expect(settingsButton).toBeVisible({ timeout: 30_000 });
  await settingsButton.dblclick();
  await expect.poll(() => page.evaluate(() => window.__desktopWindowToggleMaximizeCount)).toBe(2);
});
