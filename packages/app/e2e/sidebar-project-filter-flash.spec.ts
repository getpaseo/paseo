import { test, expect } from "./fixtures";
import { gotoHome } from "./helpers/app";

test("project filter dropdown never appears visibly at 0,0 on open", async ({ page }) => {
  await gotoHome(page);

  const trigger = page.getByText("Project", { exact: true }).first();
  await expect(trigger).toBeVisible();

  await page.evaluate(() => {
    (window as any).__projectFilterFlashProbe = new Promise<{
      targetFound: boolean;
      visibleAtOrigin: boolean;
      records: Array<{ left: number; top: number; opacity: number }>;
    }>((resolve) => {
      let target: HTMLElement | null = null;
      const records: Array<{ left: number; top: number; opacity: number }> = [];

      const capture = () => {
        if (!target) return;
        const style = getComputedStyle(target);
        records.push({
          left: Number.parseFloat(style.left || "0"),
          top: Number.parseFloat(style.top || "0"),
          opacity: Number.parseFloat(style.opacity || "1"),
        });
      };

      const getContainer = (node: HTMLElement): HTMLElement | null => {
        let current: HTMLElement | null = node;
        while (current && current !== document.body) {
          const style = getComputedStyle(current);
          if (style.position === "absolute" && style.backgroundColor !== "rgba(0, 0, 0, 0)") {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      };

      const tryResolveTarget = (root: HTMLElement) => {
        const stack = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
        for (const element of stack) {
          if (!element.textContent?.includes("No projects")) continue;
          const container = getContainer(element);
          if (!container) continue;
          target = container;
          return true;
        }
        return false;
      };

      const finish = () => {
        observer.disconnect();
        if (!target) {
          resolve({
            targetFound: false,
            visibleAtOrigin: false,
            records: [],
          });
          return;
        }

        const visibleAtOrigin = records.some(
          (entry) => entry.left <= 1 && entry.top <= 1 && entry.opacity > 0.01
        );

        resolve({
          targetFound: true,
          visibleAtOrigin,
          records,
        });
      };

      const sampleFrames = () => {
        capture();
        requestAnimationFrame(() => {
          capture();
          requestAnimationFrame(() => {
            capture();
            requestAnimationFrame(() => {
              capture();
              requestAnimationFrame(() => {
                capture();
                finish();
              });
            });
          });
        });
      };

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const added of Array.from(mutation.addedNodes)) {
            if (!(added instanceof HTMLElement)) continue;
            if (tryResolveTarget(added)) {
              sampleFrames();
              return;
            }
          }

          if (
            mutation.type === "attributes" &&
            mutation.target instanceof HTMLElement &&
            !target &&
            tryResolveTarget(mutation.target)
          ) {
            sampleFrames();
            return;
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });

      setTimeout(() => finish(), 2500);
    });
  });

  await trigger.click();
  const probe = await page.evaluate(() => (window as any).__projectFilterFlashProbe);

  expect(probe.targetFound).toBe(true);
  expect(probe.visibleAtOrigin).toBe(false);
});
