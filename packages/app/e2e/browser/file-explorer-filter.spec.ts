import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  expectExplorerEntryHidden,
  expectExplorerEntryVisible,
  expandFolder,
  expectFileTabOpen,
  openFileExplorer,
} from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

let workspace: SeededWorkspace;

test.beforeEach(async () => {
  workspace = await seedWorkspace({ repoPrefix: "file-explorer-filter-" });
  await mkdir(path.join(workspace.repoPath, "data/nested"), { recursive: true });
  await writeFile(path.join(workspace.repoPath, "data/nested/report.csv"), "name,total\n");
  await mkdir(path.join(workspace.repoPath, "docs"), { recursive: true });
  await writeFile(path.join(workspace.repoPath, "docs/guide.md"), "# Guide\n");
});

test.afterEach(async () => {
  await workspace?.cleanup();
});

function filterInput(page: Page) {
  return page.getByTestId("files-filter-input");
}

function matches(page: Page) {
  return page.locator('[data-testid^="file-filter-row-"][aria-selected]');
}

function match(page: Page, name: string) {
  return matches(page).filter({ hasText: name });
}

test("finds files in collapsed folders and acts on them", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);
  await expandFolder(page, "docs");
  await expectExplorerEntryVisible(page, "guide.md");

  await filterInput(page).fill("report");
  await expect(matches(page)).toHaveCount(1);
  await expect(match(page, "report.csv")).toContainText("data/nested");
  // Draggable onto the chat, like a tree row.
  await expect(match(page, "report.csv").locator('[draggable="true"]')).toHaveCount(1);

  await match(page, "report.csv").click({ button: "right" });
  const menu = page.getByTestId(/file-filter-row-\d+-context-menu$/);
  for (const name of [
    "Reveal in Files",
    "Copy path",
    "Copy relative path",
    "Download",
    "Rename",
    "Delete",
  ]) {
    await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole("menuitem", { name: "New file", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await match(page, "report.csv").click();
  await expectFileTabOpen(page, "data/nested/report.csv");

  // Escape restores the tree with its expanded folders.
  await filterInput(page).press("Escape");
  await expect(filterInput(page)).toHaveValue("");
  await expectExplorerEntryVisible(page, "guide.md");
  await expectExplorerEntryHidden(page, "report.csv");

  // So does the clear button.
  await filterInput(page).fill("zzz-no-such-file");
  await expect(page.getByText("No matching files", { exact: true })).toBeVisible();
  await page.getByTestId("files-filter-clear").click();
  await expect(filterInput(page)).toHaveValue("");
  await expectExplorerEntryVisible(page, "guide.md");

  // Revealing a match leaves the filter and selects the file in the tree.
  await filterInput(page).fill("report");
  await match(page, "report.csv").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reveal in Files", exact: true }).click();
  await expect(filterInput(page)).toHaveValue("");
  await expect(
    page.locator('[data-testid^="file-explorer-row-"][aria-selected="true"]'),
  ).toContainText("report.csv");
});

/** The directory listings the app asks the host for, by path. */
function recordDirectoryListings(page: Page): string[] {
  const listed: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const { message } = JSON.parse(payload);
      if (message?.type === "file_explorer_request" && message.mode === "list") {
        listed.push(message.path);
      }
    });
  });
  return listed;
}

test("opens a matching folder in the tree", async ({ page }) => {
  const listed = recordDirectoryListings(page);
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  await filterInput(page).fill("nested");
  await match(page, "nested").first().click();

  await expect(filterInput(page)).toHaveValue("");
  await expectExplorerEntryVisible(page, "report.csv");
  await expect(
    page.locator('[data-testid^="file-explorer-row-"][aria-selected="true"]'),
  ).toContainText("nested");
  // One walk down to the folder: its collapsed parent is listed once.
  expect(listed.filter((directory) => directory === "data")).toEqual(["data"]);
});

test("renames and deletes a match without leaving the filter", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  await filterInput(page).fill("guide");
  await match(page, "guide.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const nameInput = page.getByTestId("file-explorer-name-input");
  await nameInput.fill("guide-v2.md");
  await nameInput.press("Enter");
  await expect(match(page, "guide-v2.md")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await match(page, "guide-v2.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByText("No matching files", { exact: true })).toBeVisible();
});
