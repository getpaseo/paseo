import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";

test.use({ viewport: { width: 1600, height: 900 } });

async function expectBorderHighlight(
  page: Page,
  testID: string,
  hoverTarget: Locator,
  expectedWidth: string,
) {
  const handle = page.getByTestId(testID);
  await expect(handle).toBeVisible();
  await expect(page.getByTestId(`${testID}-highlight`)).toHaveCount(0);

  await hoverTarget.hover();

  const highlight = page.getByTestId(`${testID}-highlight`);
  await expect(highlight).toBeVisible();
  await expect(highlight).toHaveCSS("width", expectedWidth);
  await expect(highlight).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

test("sidebar and workspace pane borders highlight on hover", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "sidebar-resize-handle-" });
  await workspace.navigateTo();

  const sidebarHandle = page.getByTestId("left-sidebar-resize-handle");
  await expectBorderHighlight(page, "left-sidebar-resize-handle", sidebarHandle, "1px");

  await page.getByTestId("workspace-explorer-toggle").first().click();
  const splitHandle = page.getByTestId("workspace-split-resize-handle");
  await expectBorderHighlight(
    page,
    "workspace-split-resize-handle",
    splitHandle.getByRole("separator"),
    "3px",
  );
});
