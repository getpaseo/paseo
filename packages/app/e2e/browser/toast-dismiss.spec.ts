import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";

// A timed toast can be closed with its button. The button sits inside the toast's hover target,
// so a real pointer resting on the toast must still pause the timer, and leaving must resume it.

async function openDiagnostic(page: Page): Promise<void> {
  await page.getByTestId("sidebar-help").click();
  await page.getByTestId("sidebar-help-diagnostics").click();
  await expect(
    page.getByTestId("app-diagnostic-sheet").getByRole("button", { name: "Copy diagnostic" }),
  ).toBeEnabled();
}

/** The toast's close button, found by its accessible name. */
function dismissButton(page: Page) {
  return page.getByTestId("app-toast").getByRole("button", { name: "Dismiss" });
}

/** Copy diagnostic shows a timed toast. */
async function showCopiedToast(page: Page): Promise<void> {
  await page
    .getByTestId("app-diagnostic-sheet")
    .getByRole("button", { name: "Copy diagnostic" })
    .click();
  await expect(page.getByTestId("app-toast-message")).toBeVisible();
}

test("a timed toast closes from its button and waits while the pointer rests on it", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoAppShell(page);
  await openDiagnostic(page);

  await test.step("the close button closes the toast at once", async () => {
    await showCopiedToast(page);
    await expect(dismissButton(page)).toBeVisible();
    await dismissButton(page).click();
    await expect(page.getByTestId("app-toast-message")).toHaveCount(0, { timeout: 1_000 });
  });

  await test.step("a pointer on the toast keeps it past its duration; leaving lets it close", async () => {
    await showCopiedToast(page);
    // A real pointer move onto the button, inside the toast's hover target.
    await dismissButton(page).hover();
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId("app-toast-message")).toBeVisible();

    await page.mouse.move(5, 5);
    await expect(page.getByTestId("app-toast-message")).toHaveCount(0, { timeout: 6_000 });
  });

  await test.step("left alone, the toast closes on its own", async () => {
    await page.mouse.move(5, 5);
    await showCopiedToast(page);
    await expect(page.getByTestId("app-toast-message")).toHaveCount(0, { timeout: 6_000 });
  });
});
