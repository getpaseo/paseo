import type { Page } from "@playwright/test";
import { test, expect } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";

// Windows and Linux draw their window controls top-right, so the desktop sidebar has no
// chrome row of its own. Its window-drag surface is the strip above the navigation rows.
const CUSTOM_CHROME_HOSTS = [
  { platform: "linux", windowChromeMode: "custom-linux" },
  { platform: "win32", windowChromeMode: "custom-windows" },
] as const;

async function installDesktopHost(
  page: Page,
  host: (typeof CUSTOM_CHROME_HOSTS)[number],
): Promise<void> {
  await page.addInitScript((desktopHost) => {
    window.paseoDesktop = {
      ...desktopHost,
      events: { on: () => () => {} },
      invoke: async (command: string) => {
        if (command === "get_desktop_settings") {
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
          };
        }
        return null;
      },
    };
  }, host);
}

async function sidebarDragGeometry(page: Page) {
  const navScroll = page.locator('[data-testid="sidebar-nav-scroll"]:visible').first();
  await expect(navScroll).toBeVisible();
  return navScroll.evaluate((node) => {
    const nav = node.getBoundingClientRect();
    const dragRegions = [];
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      if (getComputedStyle(element).getPropertyValue("-webkit-app-region") !== "drag") continue;
      const rect = element.getBoundingClientRect();
      const overSidebar = rect.left < nav.right && rect.right > nav.left;
      if (overSidebar && rect.height > 0) dragRegions.push({ top: rect.top, bottom: rect.bottom });
    }
    return { navTop: nav.top, navBottom: nav.bottom, dragRegions };
  });
}

for (const host of CUSTOM_CHROME_HOSTS) {
  test.describe(`Desktop sidebar on ${host.platform}`, () => {
    test.use({ viewport: { width: 1280, height: 480 } });

    test("keeps a window drag strip above the scrolling navigation", async ({ page }) => {
      await installDesktopHost(page, host);
      await gotoAppShell(page);

      const geometry = await sidebarDragGeometry(page);
      expect(geometry.dragRegions).not.toEqual([]);
      for (const region of geometry.dragRegions) {
        expect(region.bottom).toBeLessThanOrEqual(geometry.navTop + 1);
      }
    });
  });
}
