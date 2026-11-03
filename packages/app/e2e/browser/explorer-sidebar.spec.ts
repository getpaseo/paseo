import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { writeFile } from "node:fs/promises";
import { openFileFromExplorer } from "../support/helpers/file-explorer";
import { openSettingsSection, clickSettingsBackToWorkspace } from "../support/helpers/settings";
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
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

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
      await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toHaveCount(1);
      await expect(menu.getByRole("menuitem", { name: /^Files/ })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /^Changes/ })).toHaveCount(0);
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

async function dragTabIntoExplorer(
  page: Parameters<typeof ensureExplorerSidebar>[0],
  tabId: string,
) {
  const source = page.getByTestId("workspace-pane-main").getByTestId(`workspace-tab-${tabId}`);
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

test("moves agents into Explorer and keeps the shared Agent launcher available", async ({
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
    await dragTabIntoExplorer(page, `agent_${agent.id}`);
    await expect(explorer.getByTestId(`workspace-tab-agent_${agent.id}`)).toBeVisible();
    await expect(main.getByTestId(`workspace-tab-agent_${agent.id}`)).toHaveCount(0);
    await explorer.getByRole("button", { name: "New tab", exact: true }).click();
    const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Agent/ })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await testInfo.attach("agent-in-explorer", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await workspace.cleanup();
  }
});

test("tablet prototype keeps Explorer tabs when resizing down to a phone", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "tablet-explorer-" });
  try {
    await page.setViewportSize({ width: 951, height: 669 });
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);
    await ensureExplorerSidebar(page);
    await expect(
      explorerSidebar(page).getByRole("button", { name: "Browse workspace files", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("tablet-951.png") });
    await openExplorerAgentDraft(page);
    await page.screenshot({ path: testInfo.outputPath("tablet-agent-draft.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await revealPhoneExplorer(page);
    await expect(
      explorerSidebar(page).getByRole("button", { name: "New tab", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("phone-shared-explorer.png") });
  } finally {
    await workspace.cleanup();
  }
});

async function openExplorerAgentDraft(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  await explorerSidebar(page).getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Agent/ }).click();
  await expect(explorerSidebar(page).getByRole("textbox").first()).toBeVisible();
}

async function revealPhoneExplorer(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  await page.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
  await expect(explorerSidebar(page)).toBeVisible();
  await expect(
    explorerSidebar(page).getByRole("button", { name: "Close Explorer sidebar", exact: true }),
  ).toBeInViewport({ ratio: 1 });
}

async function cycleWorkspaceTheme(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  await page.keyboard.press("Control+Alt+t");
}

test("retains the Explorer host through appearance changes and folding", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-lifetime-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    const explorer = await ensureExplorerSidebar(page);
    await openFilesPanel(page);
    const host = await explorer.elementHandle();
    if (!host) throw new Error("Explorer must be mounted before changing appearance");
    const previousColor = await explorer.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await cycleWorkspaceTheme(page);
    await expect
      .poll(() => explorer.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(previousColor);
    expect(await host.evaluate((element) => element.isConnected)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureExplorerSidebar(page);
    expect(await host.evaluate((element) => element.isConnected)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(explorer).toBeVisible();
    expect(await host.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    await workspace.cleanup();
  }
});

async function reorderCompactExplorerTabs(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  const explorer = explorerSidebar(page);
  const files = explorer.getByTestId("workspace-tab-files");
  const changes = explorer.getByTestId("workspace-tab-changes_tree");
  const source = await changes.boundingBox();
  const target = await files.boundingBox();
  if (!source || !target) throw new Error("Explorer tabs must be visible to reorder");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 - 12, source.y + source.height / 2);
  await page.mouse.move(target.x + 3, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const afterFiles = await files.boundingBox();
      const afterChanges = await changes.boundingBox();
      return Boolean(afterFiles && afterChanges && afterChanges.x < afterFiles.x);
    })
    .toBe(true);
}

test("reorders compact Explorer tabs with a pointer without changing selection", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-compact-drag-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await page.setViewportSize({ width: 390, height: 844 });
    await openFilesPanel(page);
    await reorderCompactExplorerTabs(page);
    await expect(
      explorerSidebar(page).getByRole("button", { name: "Browse workspace files", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    await workspace.cleanup();
  }
});

// Exercise appearance at its consumers while the real workspace navigator retains the panels.
test("updates populated code and diff appearance without losing the editor instance or draft", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-populated-appearance-" });
  const source = Array.from(
    { length: 120 },
    (_, index) => `export const line${index} = "retained ${index}";`,
  ).join("\n");
  try {
    await writeFile(`${workspace.repoPath}/appearance.ts`, source);
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ codeFontSize: 13, theme: "light" }),
      );
      localStorage.setItem(
        "@paseo:changes-preferences",
        JSON.stringify({ inlineDiff: true, layout: "unified" }),
      );
    });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFilesPanel(page);
    await openFileFromExplorer(page, "appearance.ts");
    const editor = page.getByTestId("file-source-editor").filter({ visible: true });
    const text = editor.locator(".cm-content");
    await expect(text).toBeVisible();
    await text.fill(`${source}\n// unsaved local edit`);
    const instance = await editor.elementHandle();
    const scroller = editor.locator(".cm-scroller");
    await scroller.evaluate((node) => {
      node.scrollTop = 400;
    });
    const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
    await explorerSidebar(page).getByTestId("workspace-tab-changes_tree").click();
    const diff = explorerSidebar(page).getByTestId("git-diff-canvas");
    await expect(diff).toBeVisible();
    await page.keyboard.press("Control+,");
    await openSettingsSection(page, "appearance");
    await page.getByLabel("Code font size", { exact: true }).fill("19");
    await page.getByLabel("Code font size", { exact: true }).press("Tab");
    await clickSettingsBackToWorkspace(page);
    await expect(text).toHaveCSS("font-size", "19px");
    expect(await instance!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("unsaved local edit");
    expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
    await expect(diff).toHaveCSS("font-size", "19px");
    await cycleWorkspaceTheme(page);
    expect(await instance!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("unsaved local edit");
    await dragTabIntoExplorer(page, "file_appearance.ts");
    await expect(explorerSidebar(page).getByTestId("file-source-editor")).toBeVisible();
    const explorerEditor = await explorerSidebar(page)
      .getByTestId("file-source-editor")
      .elementHandle();
    await text.fill(`${source}\n// retained Explorer edit`);
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureExplorerSidebar(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await explorerEditor!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(text).toContainText("retained Explorer edit");
  } finally {
    await workspace.cleanup();
  }
});

test("retains populated Explorer chat and terminal attachments through appearance, hide and fold", async ({
  page,
}) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "explorer-chat-appearance-",
    title: "Retained chat",
    initialPrompt: "Show the retention marker",
    featureValues: {
      mockAssistantResponse: "Explorer populated paragraph.\n\n```ts\nconst retained = 42;\n```",
    },
  });
  const attaches: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      try {
        const message = JSON.parse(frame.payload).message;
        if (message?.type === "subscribe_terminal_request") attaches.push(message.terminalId);
      } catch {
        /* Binary terminal traffic is not a JSON request. */
      }
    }),
  );
  try {
    await openAgentRoute(page, workspace);
    await ensureExplorerSidebar(page);
    await dragTabIntoExplorer(page, `agent_${workspace.agentId}`);
    const explorer = explorerSidebar(page);
    const paragraph = explorer.getByText("Explorer populated paragraph.", { exact: true });
    await expect(paragraph).toBeVisible();
    const composer = explorer.getByRole("textbox", { name: "Message agent..." });
    await composer.fill("Unsubmitted Explorer draft");
    const composerNode = await composer.elementHandle();
    await page.keyboard.press("Control+,");
    await openSettingsSection(page, "appearance");
    await page.getByLabel("Content font size", { exact: true }).fill("20");
    await page.getByLabel("Content font size", { exact: true }).press("Tab");
    await clickSettingsBackToWorkspace(page);
    await expect(paragraph).toHaveCSS("font-size", "20px");
    expect(await composerNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsubmitted Explorer draft");
    const previousColor = await paragraph.evaluate((node) => getComputedStyle(node).color);
    await cycleWorkspaceTheme(page);
    await expect
      .poll(() => paragraph.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(previousColor);
    await explorer.getByRole("button", { name: "New tab", exact: true }).click();
    await page
      .getByRole("menuitem", { name: /^Terminal/ })
      .first()
      .click();
    const terminal = explorer.getByTestId("terminal-surface");
    await expect(terminal).toBeVisible();
    await expect.poll(() => attaches.length).toBe(1);
    const terminalNode = await terminal.elementHandle();
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await ensureExplorerSidebar(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureExplorerSidebar(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await cycleWorkspaceTheme(page);
    expect(await terminalNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(attaches).toHaveLength(1);
    await explorer.getByTestId(`workspace-tab-agent_${workspace.agentId}`).click();
    expect(await composerNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(composer).toHaveValue("Unsubmitted Explorer draft");
    await expect(paragraph).toHaveCSS("font-size", "20px");
  } finally {
    await workspace.cleanup();
  }
});

test("compact file sheets cover Explorer and return to its retained file list", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "explorer-sheet-layer-" });
  try {
    await writeFile(`${workspace.repoPath}/sheet-marker.txt`, "Explorer sheet marker\n");
    await gotoWorkspace(page, workspace.workspaceId);
    await page.setViewportSize({ width: 390, height: 844 });
    const explorer = await ensureExplorerSidebar(page);
    await openFilesPanel(page);
    const host = await explorer.elementHandle();
    await openFileFromExplorer(page, "sheet-marker.txt");
    await expect(page.getByText("Explorer sheet marker", { exact: true })).toBeVisible();
    // A real click also proves the sheet draws above the retained Explorer overlay.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText("Explorer sheet marker", { exact: true })).toHaveCount(0);
    await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
    expect(await host!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await workspace.cleanup();
  }
});
