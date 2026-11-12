import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";

function diffPanel(page: Page) {
  return page.getByTestId("working-diff-panel").filter({ visible: true });
}

function diffScroll(page: Page) {
  return diffPanel(page).getByTestId("git-diff-scroll");
}

function diffCanvas(page: Page) {
  return diffPanel(page).getByTestId("git-diff-canvas");
}

async function canvasDataUrl(page: Page) {
  return diffCanvas(page).evaluate((node: HTMLCanvasElement) => node.toDataURL());
}

function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}

function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}

async function openChangesDiffTab(page: Page) {
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page.getByTestId("workspace-new-tab-menu-diff").filter({ visible: true }).first().click();
  await expect(diffPanel(page)).toBeVisible();
}

test("searches Changes diff canvas, scrolls to offscreen matches, and clears highlights on close", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "diff-pane-find-" });
  const filler = Array.from(
    { length: 65 },
    (_, index) => `const fillerLine${index} = ${index};`,
  ).join("\n");
  await writeFile(
    path.join(workspace.repoPath, "README.md"),
    [
      "# Diff Search Demo",
      "const firstMatch = 'alpha.beta';",
      "const nonLiteral = 'alphaxbeta';",
      "const secondMatch = 'ALPHA.BETA';",
      filler,
      "const bottomOffscreenMatch = 'alpha.beta';",
      "",
    ].join("\n"),
  );

  await workspace.navigateTo();
  await openChangesDiffTab(page);
  await expect(diffPanel(page).getByTestId("diff-file-0")).toBeVisible({ timeout: 30_000 });

  await diffScroll(page).click({ position: { x: 80, y: 60 } });
  const baselineCanvas = await canvasDataUrl(page);
  await page.keyboard.press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  await expect(page.getByRole("button", { name: "Toggle replace" })).toHaveCount(0);

  await query(page).fill("alpha.beta");
  await expect(status(page)).toHaveText("1 of 3");
  await expect.poll(() => canvasDataUrl(page)).not.toBe(baselineCanvas);
  await page.screenshot({ path: testInfo.outputPath("diff-pane-find-highlighted.png") });

  // Jump to the offscreen bottom match via Shift+Enter wrap-around
  await query(page).press("Shift+Enter");
  await expect(status(page)).toHaveText("3 of 3");
  await expect
    .poll(() => diffScroll(page).evaluate((node: HTMLElement) => node.scrollTop))
    .toBeGreaterThan(200);
  await page.screenshot({ path: testInfo.outputPath("diff-pane-find-offscreen.png") });

  // Advance forward wrapping back to match 1
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("1 of 3");
  await expect
    .poll(() => diffScroll(page).evaluate((node: HTMLElement) => node.scrollTop))
    .toBeLessThan(80);
  const highlightedAtMatch1 = await canvasDataUrl(page);

  // Escape closes Find, clears Canvas highlights, and returns focus to the diff scroll container
  await query(page).press("Escape");
  await expect(query(page)).toBeHidden();
  await expect(diffScroll(page)).toBeFocused();
  await expect.poll(() => canvasDataUrl(page)).not.toBe(highlightedAtMatch1);
  await diffScroll(page).evaluate((node: HTMLElement) => {
    node.scrollTop = 0;
  });
  await expect.poll(() => canvasDataUrl(page)).toBe(baselineCanvas);
});

test.describe("macOS", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  test("opens Changes diff Find with Meta+f and ignores Control+f", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "diff-pane-find-mac-" });
    await writeFile(path.join(workspace.repoPath, "README.md"), "needle one\nneedle two\n");
    await workspace.navigateTo();
    await openChangesDiffTab(page);
    await expect(diffPanel(page).getByTestId("diff-file-0")).toBeVisible({ timeout: 30_000 });

    await diffScroll(page).click({ position: { x: 80, y: 50 } });
    await page.keyboard.press("Control+f");
    await expect(query(page)).toHaveCount(0);

    await page.keyboard.press("Meta+f");
    await expect(query(page)).toBeFocused();
    await query(page).fill("needle");
    await expect(status(page)).toHaveText("1 of 2");
  });
});
