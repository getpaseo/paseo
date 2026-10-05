import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import {
  collapseFolder,
  expandFolder,
  expectExplorerEntryHidden,
  expectExplorerEntryVisible,
  expectFileTabOpen,
  openFileExplorer,
} from "../support/helpers/file-explorer";
import { gotoWorkspace, waitForTabBar } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { createAgentTabFromMenu, openChangesTreePanel } from "../support/helpers/workspace-tabs";

const DEEP_FILE_PATH = "src/components/deep-file.ts";
const HIDDEN_FILE_PATH = ".vscode/settings.json";
const NOISE_DIRECTORY_COUNT = 30;

function noiseFiles(): Array<{ path: string; content: string }> {
  return Array.from({ length: NOISE_DIRECTORY_COUNT }, (_, index) => ({
    path: `src/aaa-noise-${String(index).padStart(2, "0")}/note.txt`,
    content: "noise\n",
  }));
}

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "file-explorer-reveal-",
    repo: {
      files: [
        { path: DEEP_FILE_PATH, content: "export const deepFile = true;\n" },
        { path: HIDDEN_FILE_PATH, content: "{}\n" },
        ...noiseFiles(),
      ],
    },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

function fileTab(page: Page, filePath: string): Locator {
  return page.getByTestId(`workspace-tab-file_${filePath}`).first();
}

function explorerRow(page: Page, name: string): Locator {
  return page
    .getByTestId("file-explorer-tree-scroll")
    .getByText(name, { exact: true })
    .first()
    .locator("xpath=ancestor::*[starts-with(@data-testid, 'file-explorer-row-')][1]");
}

/** Opens a file through Command Center file search, bypassing the Explorer tree entirely. */
async function openFileViaCommandCenter(page: Page, filePath: string): Promise<void> {
  const panel = await openCommandCenter(page);
  const fileName = filePath.split("/").at(-1);
  if (!fileName) throw new Error(`Expected a file name in ${filePath}`);
  await panel.getByTestId("command-center-input").fill(fileName);
  const row = panel.getByTestId(`command-center-file-row-${filePath}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expectFileTabOpen(page, filePath);
}

async function revealFromTabContextMenu(page: Page, filePath: string): Promise<void> {
  await fileTab(page, filePath).click({ button: "right" });
  const menuItem = page.getByTestId(`workspace-tab-context-file_${filePath}-reveal-in-files`);
  await expect(menuItem).toBeVisible({ timeout: 10_000 });
  await menuItem.click();
}

async function revealFromCommandCenter(page: Page): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill("Reveal in Files");
  const action = panel.getByRole("button", { name: /^Reveal in Files(?:\s|$)/ });
  await expect(action).toBeVisible({ timeout: 10_000 });
  await action.click();
}

/**
 * The row is selected, and its box sits inside the tree's clipped scroll viewport. Polls rather
 * than asserting once: the row enters the DOM (and so passes `toBeVisible`) as soon as the
 * virtualization window grows to include it, before the animated `scrollToIndex` finishes moving
 * it into the visible, clipped area.
 */
async function expectRowSelectedAndInViewport(page: Page, name: string): Promise<void> {
  const row = explorerRow(page, name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute("aria-selected", "true");

  const container = page.getByTestId("file-explorer-tree-scroll");
  await expect(async () => {
    const rowBox = await row.boundingBox();
    const containerBox = await container.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(containerBox).not.toBeNull();
    expect(rowBox!.y).toBeGreaterThanOrEqual(containerBox!.y - 1);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(
      containerBox!.y + containerBox!.height + 1,
    );
  }).toPass({ timeout: 10_000 });
}

/** The row is selected and its center sits in the middle half of the tree's viewport. */
async function expectRowSelectedAndCentered(page: Page, name: string): Promise<void> {
  const row = explorerRow(page, name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute("aria-selected", "true");
  const container = page.getByTestId("file-explorer-tree-scroll");
  await expect(async () => {
    const rowBox = await row.boundingBox();
    const containerBox = await container.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(containerBox).not.toBeNull();
    const rowCenterRatio =
      (rowBox!.y + rowBox!.height / 2 - containerBox!.y) / containerBox!.height;
    expect(rowCenterRatio).toBeGreaterThan(0.25);
    expect(rowCenterRatio).toBeLessThan(0.75);
  }).toPass({ timeout: 10_000 });
}

async function hideExplorer(page: Page): Promise<void> {
  const explorerToggle = page.getByTestId("workspace-explorer-toggle").first();
  if ((await explorerToggle.getAttribute("aria-expanded")) === "true") {
    await explorerToggle.click();
  }
  await expect(explorerToggle).toHaveAttribute("aria-expanded", "false", { timeout: 10_000 });
}

async function expectFileTabFocused(page: Page, filePath: string): Promise<void> {
  await expect(fileTab(page, filePath)).toHaveAttribute("aria-selected", "true");
}

test.describe("Reveal in Files", () => {
  test("expands ancestors and scrolls to a deep file, then re-reveals after it scrolls away", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileViaCommandCenter(page, DEEP_FILE_PATH);

    // Hide Explorer before revealing so the app has to show it, not just switch its view.
    await hideExplorer(page);

    await revealFromTabContextMenu(page, DEEP_FILE_PATH);

    await expect(page.getByTestId("file-explorer-tree-scroll")).toBeVisible({ timeout: 30_000 });
    await expectExplorerEntryVisible(page, "components");
    await expectRowSelectedAndInViewport(page, "deep-file.ts");
    await expectFileTabFocused(page, DEEP_FILE_PATH);

    // Scroll the target away by collapsing an ancestor, then reveal again.
    await collapseFolder(page, "src");
    await expectExplorerEntryHidden(page, "deep-file.ts");

    await revealFromTabContextMenu(page, DEEP_FILE_PATH);

    await expectRowSelectedAndInViewport(page, "deep-file.ts");
    await expectFileTabFocused(page, DEEP_FILE_PATH);
  });

  test("reveals through the Command Center when a file tab is focused, and hides the command otherwise", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileViaCommandCenter(page, DEEP_FILE_PATH);

    await revealFromCommandCenter(page);

    await expectRowSelectedAndInViewport(page, "deep-file.ts");
    await expectFileTabFocused(page, DEEP_FILE_PATH);

    // Focus a non-file tab; the command must disappear from the palette.
    await createAgentTabFromMenu(page);
    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("Reveal in Files");
    await expect(panel.getByRole("button", { name: /^Reveal in Files(?:\s|$)/ })).toHaveCount(0);
  });

  test("reveals a file created after its folder was already listed and expanded", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await expandFolder(page, "src");
    await expandFolder(page, "components");
    await expectExplorerEntryVisible(page, "deep-file.ts");

    const newFilePath = "src/components/new-from-agent.ts";
    await writeFile(
      path.join(workspace.repoPath, newFilePath),
      "export const createdAfterListing = true;\n",
      "utf8",
    );

    await openFileViaCommandCenter(page, newFilePath);
    await revealFromTabContextMenu(page, newFilePath);

    await expectRowSelectedAndInViewport(page, "new-from-agent.ts");
    await expect(page.getByText("File not found in Files", { exact: true })).toHaveCount(0);
  });

  test("explains a hidden file without changing the hidden-files setting", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    await page.getByTestId("files-hidden-toggle").click();
    await expectExplorerEntryHidden(page, ".vscode");

    await openFileViaCommandCenter(page, HIDDEN_FILE_PATH);
    await revealFromTabContextMenu(page, HIDDEN_FILE_PATH);

    await expect(
      page.getByText("This file is hidden. Show hidden files to see it.", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expectExplorerEntryHidden(page, ".vscode");
  });
});

const LARGE_SIBLING_COUNT = 495;
const LARGE_TARGET_NAME = "zzz-target.ts";
const LARGE_TARGET_PATH = `src/components/${LARGE_TARGET_NAME}`;
/** Sorts next to `sibling-247.ts`, mid-folder, so it has room to center in either direction. */
const LARGE_MID_TARGET_NAME = "sibling-247-target.ts";
const LARGE_MID_TARGET_PATH = `src/components/${LARGE_MID_TARGET_NAME}`;

function largeFolderFiles(): Array<{ path: string; content: string }> {
  const siblings = Array.from({ length: LARGE_SIBLING_COUNT }, (_, index) => ({
    path: `src/components/sibling-${String(index).padStart(3, "0")}.ts`,
    content: "export const sibling = true;\n",
  }));
  return [
    ...siblings,
    { path: LARGE_TARGET_PATH, content: "export const target = true;\n" },
    { path: LARGE_MID_TARGET_PATH, content: "export const midTarget = true;\n" },
    { path: "lib/util.ts", content: "export const util = true;\n" },
  ];
}

const CENTERING_TARGET_PATH = "src/centering/mmm-target.ts";
const CENTERING_SIBLING_COUNT = 40;

/** Siblings sorting both before ("aaa-...") and after ("zzz-...") the target, so a scroll that
 * merely lands the row on screen (rather than centering it) is distinguishable from one that
 * centers it: there is equally much room to over- or under-shoot in either direction. */
function centeringFolderFiles(): Array<{ path: string; content: string }> {
  const before = Array.from({ length: CENTERING_SIBLING_COUNT }, (_, index) => ({
    path: `src/centering/aaa-sibling-${String(index).padStart(2, "0")}.ts`,
    content: "export const before = true;\n",
  }));
  const after = Array.from({ length: CENTERING_SIBLING_COUNT }, (_, index) => ({
    path: `src/centering/zzz-sibling-${String(index).padStart(2, "0")}.ts`,
    content: "export const after = true;\n",
  }));
  return [
    ...before,
    { path: CENTERING_TARGET_PATH, content: "export const target = true;\n" },
    ...after,
  ];
}

test.describe("Reveal in Files centers the row when the tree just became visible", () => {
  let centeringWorkspace: SeededWorkspace;

  test.beforeAll(async () => {
    centeringWorkspace = await seedWorkspace({
      repoPrefix: "file-explorer-reveal-centering-",
      repo: { files: centeringFolderFiles() },
    });
  });

  test.afterAll(async () => {
    await centeringWorkspace?.cleanup();
  });

  test("centers the row after Explorer switches from Changes to Files", async ({ page }) => {
    await gotoWorkspace(page, centeringWorkspace.workspaceId);
    await openFileViaCommandCenter(page, CENTERING_TARGET_PATH);
    await openChangesTreePanel(page);

    await revealFromTabContextMenu(page, CENTERING_TARGET_PATH);

    await expectRowSelectedAndCentered(page, "mmm-target.ts");
  });
});

test.describe("Reveal in Files in a large tree", () => {
  let largeWorkspace: SeededWorkspace;

  test.beforeAll(async () => {
    largeWorkspace = await seedWorkspace({
      repoPrefix: "file-explorer-reveal-large-",
      repo: { files: largeFolderFiles() },
    });
  });

  test.afterAll(async () => {
    await largeWorkspace?.cleanup();
  });

  test("reaches a row hundreds deep in one expanded folder, like a real components directory", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, largeWorkspace.workspaceId);
    await openFileViaCommandCenter(page, LARGE_TARGET_PATH);

    await revealFromTabContextMenu(page, LARGE_TARGET_PATH);

    await expectRowSelectedAndInViewport(page, LARGE_TARGET_NAME);
    await expectFileTabFocused(page, LARGE_TARGET_PATH);
  });

  test("centers a deep row after a reload, while the remounted tree restores its persisted folders", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await gotoWorkspace(page, largeWorkspace.workspaceId);
    await openFileExplorer(page);
    await expandFolder(page, "lib");
    await expandFolder(page, "src");
    await expandFolder(page, "components");
    await expectExplorerEntryVisible(page, "sibling-000.ts");
    // Collapse `src` with `components` still expanded: the restore then can't reach `components`,
    // so a restore landing after the reveal would drop the reveal's expansion of it.
    await collapseFolder(page, "src");
    await expectExplorerEntryHidden(page, "components");
    await hideExplorer(page);

    await page.reload();
    await waitForTabBar(page);
    await openFileViaCommandCenter(page, LARGE_MID_TARGET_PATH);
    await hideExplorer(page);

    await revealFromTabContextMenu(page, LARGE_MID_TARGET_PATH);

    await expectRowSelectedAndCentered(page, LARGE_MID_TARGET_NAME);
    await expectExplorerEntryVisible(page, "util.ts");
    await expectFileTabFocused(page, LARGE_MID_TARGET_PATH);
  });

  test("centers a deep row when Explorer was showing Changes", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoWorkspace(page, largeWorkspace.workspaceId);
    await openFileViaCommandCenter(page, LARGE_MID_TARGET_PATH);
    await openChangesTreePanel(page);

    await revealFromTabContextMenu(page, LARGE_MID_TARGET_PATH);

    await expectRowSelectedAndCentered(page, LARGE_MID_TARGET_NAME);
    await expectFileTabFocused(page, LARGE_MID_TARGET_PATH);
  });
});
