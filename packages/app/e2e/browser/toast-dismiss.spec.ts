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
    const dismiss = page.getByTestId("app-toast-dismiss");
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(page.getByTestId("app-toast-message")).toHaveCount(0, { timeout: 1_000 });
  });

  await test.step("a pointer on the toast keeps it past its duration; leaving lets it close", async () => {
    await showCopiedToast(page);
    const box = await page.getByTestId("app-toast-dismiss").boundingBox();
    if (!box) throw new Error("close button not on screen");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
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
