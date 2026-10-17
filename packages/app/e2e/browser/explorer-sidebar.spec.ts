import { expect, test } from "../support/fixtures";
import {
  gotoWorkspace,
  pressNewTabShortcut,
  expectTabTitleFits,
} from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  ensureExplorerSidebar,
  openFilesPanel,
  resizeExplorerSidebarBy,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

function renderedWidth(element: Element): number {
  return element.getBoundingClientRect().width;
}

function explorerSidebar(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  return page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
}

async function expectExplorerActiveTabForeground(
  page: Parameters<typeof ensureExplorerSidebar>[0],
) {
  await openFilesPanel(page);
  const main = page.getByTestId("workspace-pane-main");
  await main.hover();
  const activeMainLabel = main
    .getByTestId("workspace-tabs-row")
    .locator('[aria-selected="true"]')
    .getByText("New tab", { exact: true });
  const foreground = await activeMainLabel.evaluate((element) => getComputedStyle(element).color);
  const activeFiles = explorerSidebar(page).getByRole("button", {
    name: "Browse workspace files",
    exact: true,
  });
  await expect(activeFiles).toHaveAttribute("aria-selected", "true");
  await expect(activeFiles.getByText("Files", { exact: true })).toHaveCSS("color", foreground);
}

test.describe("Explorer sidebar", () => {
  test("yields navigation on narrow tablets and restores it without changing saved widths", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "explorer-tablet-priority-" });
    try {
      await page.setViewportSize({ width: 1040, height: 900 });
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      const navigation = page.getByTestId("sidebar-footer");
      await expect(navigation).toBeVisible();
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+b`);
      await expect(navigation).toBeHidden();
      await page.keyboard.press(`${modifier}+b`);
      await expect(navigation).toBeVisible();
      const navigationWidth = await navigation.evaluate(renderedWidth);
      const readPreferences = () =>
        page.evaluate(() => ({
          panel: JSON.parse(localStorage.getItem("panel-state")!).state,
          explorerWidths: JSON.parse(localStorage.getItem("workspace-layout-state")!).state
            .explorerSidebarWidthByWorkspace,
        }));
      const before = await readPreferences();
      for (const width of [600, 639, 640, 960, 1000]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(navigation).toBeHidden();
        const explorerWidth = width < 640 ? 240 : Math.min(320, width - 400);
        await expect.poll(() => explorer.evaluate(renderedWidth)).toBe(explorerWidth);
        await expect
          .poll(() => page.getByTestId("workspace-pane-main").evaluate(renderedWidth))
          .toBe(width - explorerWidth - 1);
        await testInfo.attach(`explorer-priority-${width}`, {
          body: await page.screenshot({
            path: testInfo.outputPath(`explorer-priority-${width}.png`),
          }),
          contentType: "image/png",
        });
      }
      await page.getByTestId("workspace-explorer-toggle").first().click();
      await expect(navigation).toBeVisible();
      await expect.poll(() => navigation.evaluate(renderedWidth)).toBe(navigationWidth);
      await ensureExplorerSidebar(page);
      await expect(navigation).toBeHidden();

      await page.keyboard.press(`${modifier}+n`);
      await expect(navigation).toBeVisible();
      await gotoWorkspace(page, workspace.workspaceId);
      await ensureExplorerSidebar(page);
      await expect(navigation).toBeHidden();

      await page.keyboard.press(`${modifier}+Comma`);
      await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
      await expect(navigation).toBeHidden();
      await page.setViewportSize({ width: 1040, height: 900 });
      await expect(navigation).toBeHidden();
      await gotoWorkspace(page, workspace.workspaceId);
      await expect(explorerSidebar(page)).toBeVisible();
      await expect(navigation).toBeVisible();
      await expect.poll(() => explorerSidebar(page).evaluate(renderedWidth)).toBe(320);
      await page.keyboard.press(`${modifier}+Shift+F`);
      await expect(page.getByRole("button", { name: "Exit focus mode" })).toBeVisible();
      await expect(navigation).toBeHidden();
      await expect(explorerSidebar(page)).toHaveCount(0);
      await page.getByRole("button", { name: "Exit focus mode" }).click();
      await expect(navigation).toBeVisible();
      await expect(explorerSidebar(page)).toBeVisible();
      const after = await readPreferences();
      expect(after.panel.sidebarWidth).toBe(before.panel.sidebarWidth);
      expect(after.panel.desktop).toEqual(before.panel.desktop);
      expect(after.explorerWidths).toEqual(before.explorerWidths);
      await testInfo.attach("explorer-priority-1040", {
        body: await page.screenshot({ path: testInfo.outputPath("explorer-priority-1040.png") }),
        contentType: "image/png",
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("yields navigation until a resized Explorer fits and ignores an inactive workspace", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "explorer-resized-priority-" });
    const other = await seedWorkspace({ repoPrefix: "explorer-inactive-priority-" });
    try {
      await page.setViewportSize({ width: 1000, height: 900 });
      await gotoWorkspace(page, workspace.workspaceId);
      const explorer = await ensureExplorerSidebar(page);
      await resizeExplorerSidebarBy({ page, deltaWidth: 40 });
      await expect.poll(() => explorer.evaluate(renderedWidth)).toBe(360);
      const savedWidths = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("workspace-layout-state")!).state
            .explorerSidebarWidthByWorkspace,
      );
      for (const width of [1040, 1079]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.getByTestId("sidebar-footer")).toBeHidden();
        await expect.poll(() => explorer.evaluate(renderedWidth)).toBe(360);
      }
      await gotoWorkspace(page, other.workspaceId);
      await expect(explorerSidebar(page)).toHaveCount(0);
      await expect(page.getByTestId("sidebar-footer")).toBeVisible();
      await gotoWorkspace(page, workspace.workspaceId);
      await expect(page.getByTestId("sidebar-footer")).toBeHidden();
      await page.setViewportSize({ width: 1080, height: 900 });
      await expect(page.getByTestId("sidebar-footer")).toBeVisible();
      await expect.poll(() => explorerSidebar(page).evaluate(renderedWidth)).toBe(360);
      const restoredWidths = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("workspace-layout-state")!).state
            .explorerSidebarWidthByWorkspace,
      );
      expect(restoredWidths).toEqual(savedWidths);
      await testInfo.attach("explorer-priority-resized-1080", {
        body: await page.screenshot({
          path: testInfo.outputPath("explorer-priority-resized-1080.png"),
        }),
        contentType: "image/png",
      });
    } finally {
      await other.cleanup();
      await workspace.cleanup();
    }
  });

  test("starts with Files and Changes, switches views, and toggles without changing main", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "explorer-sidebar-defaults-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      const mainTabsBefore = await page
        .getByTestId("workspace-pane-main")
        .locator('[data-testid^="workspace-tab-"]')
        .count();

      const explorer = await ensureExplorerSidebar(page);
      await expect(explorer.getByTestId("workspace-tab-files")).toBeVisible();
      await expect(explorer.getByTestId("workspace-tab-changes_tree")).toBeVisible();
      await expect(explorer.getByTestId("workspace-new-tab-button")).toHaveCount(1);

      await expectExplorerActiveTabForeground(page);
      await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();

      await explorer.getByTestId("workspace-tab-changes_tree").click();
      await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();

      await page.getByTestId("workspace-explorer-toggle").first().click();
      await expect(explorerSidebar(page)).toHaveCount(0);
      await expect(
        page.getByTestId("workspace-pane-main").locator('[data-testid^="workspace-tab-"]'),
      ).toHaveCount(mainTabsBefore);
    } finally {
      await workspace.cleanup();
    }
  });
});

async function launchExplorerPanel(
  page: Parameters<typeof ensureExplorerSidebar>[0],
  name: string,
) {
  const explorer = explorerSidebar(page);
  await explorer.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
  await explorer.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function closeExplorerFilesFromContextMenu(
  page: Parameters<typeof ensureExplorerSidebar>[0],
) {
  const explorer = explorerSidebar(page);
  const files = explorer.getByRole("button", { name: "Browse workspace files", exact: true });
  await files.hover();
  await expect(explorer.getByTestId("workspace-files-close")).toHaveCount(0);
  await explorer.getByTestId("workspace-tab-changes_tree").hover();
  await expect(explorer.getByTestId("workspace-working-diff-close-changes_tree")).toHaveCount(0);
  await files.click({ button: "right", position: { x: 12, y: 13 } });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(files).toHaveCount(0);
}

async function expectWorkspaceCloseOnHover(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  const main = page.getByTestId("workspace-pane-main");
  const tab = main.locator('[data-testid^="workspace-tab-"][aria-selected="true"]');
  const close = main.getByRole("button", { name: "Close", exact: true });
  await explorerSidebar(page).hover();
  await expect(close.locator("..")).toHaveCSS("opacity", "0");
  await tab.hover();
  await expect(close.locator("..")).toHaveCSS("opacity", "1");
}

async function closeOtherExplorerTabs(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  const files = explorerSidebar(page).getByRole("button", {
    name: "Browse workspace files",
    exact: true,
  });
  await files.click({ button: "right", position: { x: 12, y: 13 } });
  const confirmation = page.waitForEvent("dialog").then((dialog) => {
    expect(dialog.message()).toContain("close 1 tab");
    return dialog.accept();
  });
  await page.getByRole("menuitem", { name: "Close other tabs", exact: true }).click();
  await confirmation;
}

test("Explorer keeps Files and Changes close actions in the context menu", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-shared-tabs-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    const main = page.getByTestId("workspace-pane-main");
    const mainTabsBefore = await main.getByTestId("workspace-tabs-row").getByRole("button").count();
    const explorer = await ensureExplorerSidebar(page);
    await expectTabTitleFits(page, "Files", { min: 64, max: 90 });

    await test.step("Explorer's + menu excludes Agent and terminal profiles", async () => {
      await explorer.getByRole("button", { name: "New tab", exact: true }).click();
      const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^Files/ })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^Changes/ })).toHaveCount(0);
      await expect(menu.getByText("Terminal profiles", { exact: true })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^Terminal/ })).toBeVisible();
      const entries = await menu.getByRole("menuitem").allTextContents();
      expect(entries.findIndex((entry) => entry.startsWith("Terminal"))).toBeLessThan(
        entries.findIndex((entry) => entry.startsWith("Diff")),
      );
      await page.keyboard.press("Escape");
      await main.getByTestId("workspace-new-tab-button").click();
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toBeVisible();
      await expect(menu.getByText("Terminal profiles", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("Files and Changes omit X, and + restores Files after context-menu close", async () => {
      await expectWorkspaceCloseOnHover(page);
      await closeExplorerFilesFromContextMenu(page);
      await launchExplorerPanel(page, "Files");
      await expect(
        explorer.getByRole("button", { name: "Browse workspace files", exact: true }),
      ).toBeVisible();
      await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    });

    await test.step("standard bulk-close menus affect only Explorer tabs", async () => {
      await closeOtherExplorerTabs(page);
      await expect(explorer.getByTestId("workspace-tab-changes_tree")).toHaveCount(0);
      await expect(explorer.getByTestId("workspace-tab-files")).toBeVisible();
      await expect(main.getByTestId("workspace-tabs-row").getByRole("button")).toHaveCount(
        mainTabsBefore,
      );
      await launchExplorerPanel(page, "Changes");
      await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();
    });

    await test.step("Cmd+T still belongs to the focused workspace pane", async () => {
      await pressNewTabShortcut(page);
      await expect(
        main.getByTestId("workspace-new-tab-panel").filter({ visible: true }),
      ).toBeVisible();
      await expect(explorer.getByTestId("workspace-new-tab-panel")).toHaveCount(0);
    });

    await testInfo.attach("shared-explorer-tabs", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await workspace.cleanup();
  }
});

async function dragAgentIntoExplorer(
  page: Parameters<typeof ensureExplorerSidebar>[0],
  agentId: string,
) {
  const source = page
    .getByTestId("workspace-pane-main")
    .getByTestId(`workspace-tab-agent_${agentId}`);
  const destination = explorerSidebar(page).getByTestId("workspace-tab-files");
  const sourceBox = await source.boundingBox();
  const destinationBox = await destination.boundingBox();
  if (!sourceBox || !destinationBox)
    throw new Error("Tab drag requires visible source and destination");
  const start = { x: sourceBox.x + 12, y: sourceBox.y + sourceBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 4);
  await page.mouse.move(destinationBox.x + 12, destinationBox.y + destinationBox.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
}

test("agents can still be dragged into Explorer when absent from its + menu", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-agent-drag-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    const explorer = await ensureExplorerSidebar(page);
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Dragged agent",
      modeId: "load-test",
      model: "ten-second-stream",
    });
    const main = page.getByTestId("workspace-pane-main");
    await expect(main.getByTestId(`workspace-tab-agent_${agent.id}`)).toBeVisible();
    await dragAgentIntoExplorer(page, agent.id);
    await expect(explorer.getByTestId(`workspace-tab-agent_${agent.id}`)).toBeVisible();
    await expect(main.getByTestId(`workspace-tab-agent_${agent.id}`)).toHaveCount(0);
    await explorer.getByRole("button", { name: "New tab", exact: true }).click();
    const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toHaveCount(0);
    await expect(menu.getByText("Terminal profiles", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await testInfo.attach("agent-in-explorer", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await workspace.cleanup();
  }
});
