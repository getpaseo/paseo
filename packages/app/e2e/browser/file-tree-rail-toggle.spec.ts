// The file panel's tree rail had no way to close: the changes panel's toolbar
// carries a folder-tree toggle, the file toolbar carried nothing, and the rail
// was permanent on desktop.
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "file-tree-rail-toggle-",
    repo: { files: [{ path: "docs/guide.md", content: "# Guide\n" }] },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test.describe("File panel tree rail", () => {
  test("the file toolbar toggle closes and reopens the tree", async ({ page }, testInfo) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openFileFromExplorer(page, "docs");
    await openFileFromExplorer(page, "guide.md");

    const rail = page.getByTestId("file-tree-rail-tree").filter({ visible: true });
    const toggle = page.getByTestId("file-toggle-tree").filter({ visible: true }).first();
    const editorToolbar = page.getByTestId("file-panel-bar").filter({ visible: true });
    const filesToolbar = page.getByTestId("files-pane-header").filter({ visible: true });
    const refresh = page.getByRole("button", { name: "Refresh files" }).filter({ visible: true });
    const hiddenFiles = page
      .getByRole("button", { name: "Hide hidden files" })
      .filter({ visible: true });
    const shoot = async (name: string) => {
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path });
      await testInfo.attach(name, { path, contentType: "image/png" });
    };
    await expect(rail).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute("aria-selected", "true");
    const [
      editorToolbarBox,
      filesToolbarBox,
      treeToggleBox,
      refreshBox,
      treeGlyphBox,
      refreshGlyphBox,
    ] = await Promise.all([
      editorToolbar.boundingBox(),
      filesToolbar.boundingBox(),
      toggle.boundingBox(),
      refresh.boundingBox(),
      toggle.locator("svg").boundingBox(),
      refresh.locator("svg").boundingBox(),
    ]);
    if (
      !editorToolbarBox ||
      !filesToolbarBox ||
      !treeToggleBox ||
      !refreshBox ||
      !treeGlyphBox ||
      !refreshGlyphBox
    ) {
      throw new Error("Pane-content toolbar geometry could not be measured");
    }
    expect(editorToolbarBox.height).toBe(36);
    expect(filesToolbarBox.height).toBe(36);
    expect(editorToolbarBox.y + editorToolbarBox.height).toBe(
      filesToolbarBox.y + filesToolbarBox.height,
    );
    expect(treeToggleBox.width).toBe(24);
    expect(treeToggleBox.height).toBe(24);
    expect(refreshBox.width).toBe(24);
    expect(refreshBox.height).toBe(24);
    expect(treeGlyphBox.width).toBe(14);
    expect(treeGlyphBox.height).toBe(14);
    expect(refreshGlyphBox.width).toBe(14);
    expect(refreshGlyphBox.height).toBe(14);

    const restBackground = await refresh.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const treeToggleSelectedBackground = await toggle.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await refresh.hover();
    const refreshHoverBackground = await refresh.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(refreshHoverBackground).not.toBe(restBackground);
    expect(refreshHoverBackground).toBe(treeToggleSelectedBackground);
    await hiddenFiles.click();
    const hiddenFilesSelected = page
      .getByRole("button", { name: "Show hidden files" })
      .filter({ visible: true });
    expect(
      await hiddenFilesSelected.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(refreshHoverBackground);
    await shoot("tree-open");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-selected", "false");
    await expect(rail).toHaveCount(0);
    await shoot("tree-closed");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-selected", "true");
    await expect(rail).toBeVisible();
    await shoot("tree-reopened");
  });
});
