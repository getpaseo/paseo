import { test, expect } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";

test.describe("Settings sidebar scrolling", () => {
  test.use({ viewport: { width: 900, height: 260 } });

  test("desktop drag region does not cover the scroll body", async ({ page }) => {
    await page.addInitScript(() => {
      window.paseoDesktop = {
        platform: "darwin",
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
    });

    await gotoAppShell(page);
    await openSettings(page);

    const sidebar = page.getByTestId("settings-sidebar");
    await expect(sidebar).toBeVisible();

    const geometry = await sidebar.evaluate((node) => {
      let scroller: HTMLElement | null = null;
      for (const element of node.querySelectorAll<HTMLElement>("*")) {
        if (element.scrollHeight > element.clientHeight) {
          scroller = element;
          break;
        }
      }
      if (!scroller) return null;

      const scrollerRect = scroller.getBoundingClientRect();
      const dragRegions = [];
      for (const element of node.querySelectorAll<HTMLElement>("*")) {
        if (getComputedStyle(element).getPropertyValue("-webkit-app-region") === "drag") {
          const rect = element.getBoundingClientRect();
          dragRegions.push({ bottom: rect.bottom });
        }
      }

      return {
        scrollBodyTop: scrollerRect.top,
        dragRegions,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry!.dragRegions).not.toEqual([]);
    for (const dragRegion of geometry!.dragRegions) {
      expect(dragRegion.bottom).toBeLessThanOrEqual(geometry!.scrollBodyTop + 1);
    }
  });
});
