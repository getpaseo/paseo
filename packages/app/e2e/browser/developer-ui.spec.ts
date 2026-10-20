import { metroTest as test, expect } from "../support/fixtures";
import { installDeveloperToastDismissal } from "../support/developer-ui.mjs";
import type { Page } from "@playwright/test";

async function showTransientDeveloperToast(page: Page, shadow: boolean) {
  await page.evaluate((useShadow) => {
    const toast = document.createElement("div");
    toast.id = "error-toast";
    document.body.append(toast);
    const root = useShadow ? toast.attachShadow({ mode: "open" }) : toast;
    const button = document.createElement("button");
    button.style.cssText = "width:32px;height:32px";
    button.addEventListener("click", () => button.remove());
    root.append(button);
  }, shadow);
}

async function openTransientDeveloperToast(page: Page) {
  await page.setContent("<button>Continue</button>");
  await showTransientDeveloperToast(page, false);
  await installDeveloperToastDismissal(page);
}

async function navigateWithDeveloperToastDismissal(page: Page) {
  await installDeveloperToastDismissal(page);
  await page.goto("data:text/html,<button>Continue</button>");
  await showTransientDeveloperToast(page, true);
}

async function inspectLayoutWhileToastDisappears(page: Page) {
  const action = page.getByRole("button", { name: "Continue", exact: true });
  const boxes = await Promise.all(Array.from({ length: 4 }, () => action.boundingBox()));
  for (const box of boxes) expect(box).not.toBeNull();
  await expect(page.locator("#error-toast").getByRole("button")).toHaveCount(0);
  await action.click();
}

test("a disappearing developer toast does not stall concurrent layout checks", async ({ page }) => {
  test.setTimeout(10000);
  await openTransientDeveloperToast(page);
  await inspectLayoutWhileToastDisappears(page);
});

test("developer toast dismissal survives navigation and observes Expo shadow-root updates", async ({
  page,
}) => {
  test.setTimeout(10000);
  await navigateWithDeveloperToastDismissal(page);
  await inspectLayoutWhileToastDisappears(page);
  await page.evaluate(() => {
    const root = document.getElementById("error-toast")!.shadowRoot!;
    const replacement = document.createElement("button");
    replacement.style.cssText = "width:32px;height:32px";
    replacement.addEventListener("click", () => replacement.remove());
    root.append(replacement);
  });
  await inspectLayoutWhileToastDisappears(page);
});
