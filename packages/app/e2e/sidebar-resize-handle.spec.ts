import { expect, test, type Page } from "./fixtures";

test.use({ viewport: { width: 1600, height: 900 } });

async function expectBorderHighlight(page: Page, testID: string) {
  const handle = page.getByTestId(testID);
  await expect(handle).toBeVisible();
  await expect(page.getByTestId(`${testID}-highlight`)).toHaveCount(0);

  await handle.hover();
  await expect(page.getByTestId(`${testID}-highlight`)).toHaveCount(0);

  const highlight = page.getByTestId(`${testID}-highlight`);
  await expect(highlight).toBeVisible();
  await expect(highlight).toHaveCSS("width", "1px");
  await expect(highlight).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

test("both sidebar borders highlight on hover", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "sidebar-resize-handle-" });
  await workspace.navigateTo();

  await expectBorderHighlight(page, "left-sidebar-resize-handle");

  await page.getByTestId("workspace-explorer-toggle").first().click();
  await expectBorderHighlight(page, "explorer-sidebar-resize-handle");
});
