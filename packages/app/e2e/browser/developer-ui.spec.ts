import { metroTest as test, expect } from "../support/fixtures";
import { hideDeveloperToasts } from "../support/developer-ui.mjs";
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

async function openHiddenDeveloperToast(page: Page) {
  await page.setContent("<button>Continue</button>");
  await showTransientDeveloperToast(page, false);
  await hideDeveloperToasts(page);
}

async function navigateWithHiddenDeveloperToasts(page: Page) {
  await hideDeveloperToasts(page);
  await page.goto("data:text/html,<button>Continue</button>");
  await showTransientDeveloperToast(page, true);
}

async function inspectLayoutWithHiddenToast(page: Page) {
  const action = page.getByRole("button", { name: "Continue", exact: true });
  const boxes = await Promise.all(Array.from({ length: 4 }, () => action.boundingBox()));
  for (const box of boxes) expect(box).not.toBeNull();
  await expect(page.locator("#error-toast")).toBeHidden();
  await action.click();
}

test("a hidden developer toast does not stall concurrent layout checks", async ({ page }) => {
  test.setTimeout(10000);
  await openHiddenDeveloperToast(page);
  await inspectLayoutWithHiddenToast(page);
});

test("developer toast hiding survives navigation and Expo shadow-root updates", async ({
  page,
}) => {
  test.setTimeout(10000);
  await navigateWithHiddenDeveloperToasts(page);
  await inspectLayoutWithHiddenToast(page);
  await page.evaluate(() => {
    const root = document.getElementById("error-toast")!.shadowRoot!;
    const replacement = document.createElement("button");
    replacement.style.cssText = "width:32px;height:32px";
    replacement.addEventListener("click", () => replacement.remove());
    root.append(replacement);
  });
  await inspectLayoutWithHiddenToast(page);
});
