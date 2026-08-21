import { execFileSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute, buildSettingsSectionRoute } from "../../src/utils/host-routes";
import { test, expect } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

interface DirtyWorkspace {
  id: string;
  repoPath: string;
}

interface WorkspaceFixtureOptions {
  includeDeletedFile?: boolean;
  includeNestedFolders?: boolean;
  includeRenamedFile?: boolean;
  includeUntrackedFile?: boolean;
}

interface CleanupTask {
  run: () => Promise<void>;
}

const cleanupTasks: CleanupTask[] = [];
const APP_SETTINGS_KEY = "@paseo:app-settings";

function changesTree(page: Page) {
  return page.getByTestId("changes-tree-rail-tree");
}

function changesContent(page: Page) {
  return page.getByTestId("changes-tree-rail-content");
}

async function readFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function failNextDiscardRequest(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message) as {
          message?: { type?: string; cwd?: string; requestId?: string };
        };
        if (envelope.message?.type === "checkout.discard_changes.request") {
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "checkout.discard_changes.response",
                payload: {
                  cwd: envelope.message.cwd,
                  success: false,
                  error: { code: "UNKNOWN", message: "Injected revert failure" },
                  requestId: envelope.message.requestId,
                },
              },
            }),
          );
          return;
        }
      }
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => browserSocket.send(message));
  });
}

const CHANGES_PREFERENCES_KEY = "@paseo:changes-preferences";

const BEFORE = `import { useLayoutEffect, useMemo, useRef, useState } from "react";

interface UseMountedTabSetInput {
  activeTabId: string | null;
  allTabIds: string[];
  cap: number;
}

interface UseMountedTabSetResult {
  mountedTabIds: Set<string>;
}

function createInitialMountedTabIds(input: UseMountedTabSetInput): Set<string> {
  if (!input.activeTabId || !input.allTabIds.includes(input.activeTabId)) {
    return new Set<string>();
  }
  return new Set<string>([input.activeTabId]);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

export function useMountedTabSet(input: UseMountedTabSetInput): UseMountedTabSetResult {
  const { activeTabId, allTabIds, cap } = input;
  const allTabIdsKey = allTabIds.join("\\u0000");
  const availableTabIds = useMemo(() => {
    void allTabIdsKey;
    return new Set(allTabIds);
  }, [allTabIds, allTabIdsKey]);
  const [mountedTabIds, setMountedTabIds] = useState(() => createInitialMountedTabIds(input));
  const lruRef = useRef(activeTabId && allTabIds.includes(activeTabId) ? [activeTabId] : []);

  useLayoutEffect(() => {
    const nextLru = lruRef.current.filter((tabId) => availableTabIds.has(tabId));
    if (activeTabId && availableTabIds.has(activeTabId)) {
      const existingIndex = nextLru.indexOf(activeTabId);
      if (existingIndex >= 0) {
        nextLru.splice(existingIndex, 1);
      }
      nextLru.unshift(activeTabId);
    }
    if (nextLru.length > cap) {
      nextLru.length = cap;
    }

    lruRef.current = nextLru;
    setMountedTabIds((previousMountedTabIds) => {
      const nextMountedTabIds = new Set(nextLru);
      return setsEqual(previousMountedTabIds, nextMountedTabIds)
        ? previousMountedTabIds
        : nextMountedTabIds;
    });
  }, [activeTabId, availableTabIds, cap]);

  return { mountedTabIds };
}
`;

const AFTER = `import { useLayoutEffect, useMemo, useRef, useState } from "react";

interface UseMountedTabSetInput {
  activeTabId: string | null;
  allTabIds: string[];
  cap: number;
}

interface UseMountedTabSetResult {
  mountedTabIds: Set<string>;
}

interface DeriveRenderMountedTabIdsInput {
  activeTabId: string | null;
  availableTabIds: Set<string>;
  cap: number;
  mountedTabIds: Set<string>;
}

function createInitialMountedTabIds(input: UseMountedTabSetInput): Set<string> {
  if (!input.activeTabId || !input.allTabIds.includes(input.activeTabId)) {
    return new Set<string>();
  }
  return new Set<string>([input.activeTabId]);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function deriveRenderMountedTabIds(input: DeriveRenderMountedTabIdsInput): Set<string> {
  const { activeTabId, availableTabIds, cap, mountedTabIds } = input;
  if (!activeTabId || !availableTabIds.has(activeTabId) || mountedTabIds.has(activeTabId)) {
    return mountedTabIds;
  }

  const next = new Set<string>([activeTabId]);
  const maxSize = Math.max(1, cap);
  for (const tabId of mountedTabIds) {
    if (next.size >= maxSize) {
      break;
    }
    if (availableTabIds.has(tabId)) {
      next.add(tabId);
    }
  }
  return next;
}

export function useMountedTabSet(input: UseMountedTabSetInput): UseMountedTabSetResult {
  const { activeTabId, allTabIds, cap } = input;
  const allTabIdsKey = allTabIds.join("\\u0000");
  const availableTabIds = useMemo(() => {
    void allTabIdsKey;
    return new Set(allTabIds);
  }, [allTabIds, allTabIdsKey]);
  const [mountedTabIds, setMountedTabIds] = useState(() => createInitialMountedTabIds(input));
  const lruRef = useRef(activeTabId && allTabIds.includes(activeTabId) ? [activeTabId] : []);
  const renderMountedTabIds = useMemo(
    () =>
      deriveRenderMountedTabIds({
        activeTabId,
        availableTabIds,
        cap,
        mountedTabIds,
      }),
    [activeTabId, availableTabIds, cap, mountedTabIds],
  );

  useLayoutEffect(() => {
    const nextLru = lruRef.current.filter((tabId) => availableTabIds.has(tabId));
    if (activeTabId && availableTabIds.has(activeTabId)) {
      const existingIndex = nextLru.indexOf(activeTabId);
      if (existingIndex >= 0) {
        nextLru.splice(existingIndex, 1);
      }
      nextLru.unshift(activeTabId);
    }
    if (nextLru.length > cap) {
      nextLru.length = cap;
    }

    lruRef.current = nextLru;
    setMountedTabIds((previousMountedTabIds) => {
      const nextMountedTabIds = new Set(nextLru);
      return setsEqual(previousMountedTabIds, nextMountedTabIds)
        ? previousMountedTabIds
        : nextMountedTabIds;
    });
  }, [activeTabId, availableTabIds, cap]);

  return { mountedTabIds: renderMountedTabIds };
}
`;

test.afterEach(async () => {
  for (const task of cleanupTasks.splice(0)) {
    await task.run();
  }
});

test("Changes opens the populated committed comparison for a clean checkout", async ({ page }) => {
  const workspace = await createWorkspaceWithCommittedDiff();

  await openWorkspaceChangesSurface(page, workspace);

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(panel.getByTestId("changes-diff-status-trigger")).toContainText("Committed");
  await expect(panel.getByText("committed-only.ts", { exact: true })).toBeVisible();
});

test("Changes expires a manual comparison when checkout dirtiness changes", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await openWorkspaceChanges(page, workspace);

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const mode = panel.getByTestId("changes-diff-status-trigger");
  await expect(mode).toContainText("Uncommitted");

  await mode.click();
  await page.getByTestId("changes-diff-mode-committed").click();
  await expect(mode).toContainText("Committed");
  await expect(panel.getByRole("button", { name: "See uncommitted changes" })).toBeVisible();

  execFileSync("git", ["add", "--all"], { cwd: workspace.repoPath });
  execFileSync("git", ["commit", "-m", "Commit working changes"], { cwd: workspace.repoPath });
  await expect(mode).toContainText("Committed");
  await expect(panel.getByRole("button", { name: "See uncommitted changes" })).toHaveCount(0, {
    timeout: 30_000,
  });

  await writeFile(path.join(workspace.repoPath, "new-working-change.txt"), "uncommitted\n");
  await expect(mode).toContainText("Uncommitted", { timeout: 30_000 });
});

test("an empty Changes comparison links to the populated comparison", async ({ page }) => {
  const workspace = await createWorkspaceWithCommittedDiff();
  await openWorkspaceChangesSurface(page, workspace);

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const mode = panel.getByTestId("changes-diff-status-trigger");
  await mode.click();
  await page.getByTestId("changes-diff-mode-committed").click();
  await expect(panel.getByText("committed-only.ts", { exact: true })).toBeVisible();

  await mode.click();
  await page.getByTestId("changes-diff-mode-uncommitted").click();

  await expect(panel.getByText("No uncommitted changes", { exact: true })).toBeVisible();
  const seeCommitted = panel.getByRole("button", { name: "See committed changes" });
  await expect(seeCommitted).toBeVisible();
  await seeCommitted.click();
  await expect(mode).toContainText("Committed");
  await expect(panel.getByText("committed-only.ts", { exact: true })).toBeVisible();
});

test("changes file actions open below the right-click without a reserved kebab", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await expect(page.getByTestId("diff-file-1")).toContainText("zz-deleted.ts");
  const deletedFileName = page.getByText("zz-deleted.ts", { exact: true });
  await expect(deletedFileName).toHaveCSS("user-select", "none");
  await deletedFileName.dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await expect(page.getByTestId(/diff-file-\d+-actions/)).toHaveCount(0);
  await page.getByTestId("diff-file-1-toggle").click({ button: "right" });
  await expect(page.getByText("Copy path")).toBeVisible();
  await page.getByText("Copy path", { exact: true }).click({ button: "right" });
  await expect(page.getByText("Copy path")).toBeVisible();
  await expect(page.getByTestId("diff-file-1-open-file")).toHaveCount(0);
  await page.keyboard.press("Escape");

  const fileRow = page.getByTestId("diff-file-0-toggle");
  const fileRowBounds = await fileRow.boundingBox();
  expect(fileRowBounds).not.toBeNull();
  await fileRow.click({ button: "right", position: { x: 80, y: 10 } });
  await expect(page.getByTestId("diff-file-0-open-file")).toBeVisible();
  const menuBounds = await page.getByTestId("diff-file-0-context-menu").boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(Math.abs(menuBounds!.x - (fileRowBounds!.x + 80))).toBeLessThanOrEqual(1);
  expect(menuBounds!.y).toBeGreaterThan(fileRowBounds!.y + 10);
  await page.getByTestId("diff-file-0-open-file").click();

  await expect(page.getByTestId("workspace-file-pane")).toBeVisible();
  await expect(page.getByTestId("workspace-tab-file_src/use-mounted-tab-set.ts")).toBeVisible();
});

test("canvas file headers select without toggling for context menu and long press", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const firstFile = page.getByTestId("diff-file-0-toggle");
  const deletedFile = page.getByTestId("diff-file-1-toggle");
  await deletedFile.click({ button: "right" });
  await expect(deletedFile).toHaveAttribute("aria-selected", "true");
  await expect(deletedFile).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Copy path")).toBeVisible();
  await page.keyboard.press("Escape");

  await longPressFileHeader(page, firstFile);
  await expect(firstFile).toHaveAttribute("aria-selected", "true");
  await expect(deletedFile).toHaveAttribute("aria-selected", "false");
  await expect(firstFile).toHaveAttribute("aria-expanded", "true");
});

test("every interactive file header has the same hover feedback", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const first = page.getByTestId("diff-file-0-toggle");
  const second = page.getByTestId("diff-file-1-toggle");
  const normalBackground = await first.evaluate(
    (element) => getComputedStyle(element.parentElement!).backgroundColor,
  );
  await expect
    .poll(() =>
      first.evaluate((element) => getComputedStyle(element.parentElement!).borderTopWidth),
    )
    .toBe("0px");

  await first.hover();
  const hoverBackground = await first.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(hoverBackground).not.toBe(normalBackground);

  await first.click();
  await page.mouse.move(0, 0);
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() =>
      first.evaluate((element) => getComputedStyle(element.parentElement!).backgroundColor),
    )
    .toBe(normalBackground);
  const [sharedBorder, secondTopBorderWidth] = await Promise.all([
    first.evaluate((element) => getComputedStyle(element.parentElement!).borderBottomColor),
    second.evaluate((element) => getComputedStyle(element.parentElement!).borderTopWidth),
  ]);
  expect(sharedBorder).not.toBe("rgba(0, 0, 0, 0)");
  expect(secondTopBorderWidth).toBe("0px");

  await first.hover();
  await expect
    .poll(() => first.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(hoverBackground);
  await second.hover();
  await expect
    .poll(() =>
      first.evaluate((element) => getComputedStyle(element.parentElement!).backgroundColor),
    )
    .toBe(normalBackground);
  await expect
    .poll(() => second.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(hoverBackground);
});

test("changes context menus duplicate files and folders", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
  await page.getByTestId("diff-file-0-duplicate").click();
  await expect
    .poll(() => readFileIfPresent(path.join(workspace.repoPath, "src/use-mounted-tab-set copy.ts")))
    .toBe(AFTER);

  await page.getByTestId("changes-toggle-tree").click();
  await changesTree(page).getByTestId("diff-folder-src-toggle").click({ button: "right" });
  await page.getByTestId("diff-folder-src-duplicate").click();
  await expect
    .poll(() => readFileIfPresent(path.join(workspace.repoPath, "src copy/use-mounted-tab-set.ts")))
    .toBe(AFTER);
});

test("changes tree aligns every file status after its diff stat", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({
    includeDeletedFile: true,
    includeUntrackedFile: true,
  });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await page.getByTestId("changes-toggle-tree").click();

  const tree = changesTree(page);
  const modifiedRow = tree.getByTestId("diff-tree-file-0");
  const deletedRow = tree.getByTestId("diff-tree-file-1");
  const addedRow = tree.getByTestId("diff-tree-file-2");
  const modifiedStatus = modifiedRow.getByRole("img", { name: "Modified" });
  await expect(modifiedStatus).toBeVisible();
  await expect(deletedRow.getByRole("img", { name: "Deleted" })).toBeVisible();
  await expect(addedRow.getByRole("img", { name: "New" })).toBeVisible();

  const [statBounds, statusBounds] = await Promise.all([
    modifiedRow.getByTestId("diff-tree-file-0-stat").boundingBox(),
    modifiedStatus.boundingBox(),
  ]);
  if (!statBounds || !statusBounds) throw new Error("Changes tree trailing status has no bounds");
  expect(statusBounds.x - (statBounds.x + statBounds.width)).toBeGreaterThanOrEqual(8);
});

test("changes context menu recursively collapses descendant folders", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeNestedFolders: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await page.getByTestId("changes-toggle-tree").click();
  const tree = changesTree(page);
  await expect(tree.getByTestId("diff-folder-src/zz-folder")).toBeVisible();
  await expect(tree.getByTestId("diff-folder-src/zz-folder/nested")).toBeVisible();
  const rootRow = tree.getByTestId("diff-folder-src-toggle");
  const rootLabel = tree.getByTestId("diff-folder-src-toggle").getByText("src", { exact: true });
  await expect(rootRow).toHaveCSS("opacity", "1");
  await expect(rootLabel).toHaveCSS("opacity", "0.76");
  await rootRow.hover();
  await expect(rootLabel).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  const nestedLabel = tree
    .getByTestId("diff-folder-src/zz-folder-toggle")
    .getByText("zz-folder", { exact: true });
  const [rootBounds, nestedBounds] = await Promise.all([
    rootLabel.boundingBox(),
    nestedLabel.boundingBox(),
  ]);
  if (!rootBounds || !nestedBounds) throw new Error("Changes tree rows have no bounds");
  expect(nestedBounds.x - rootBounds.x).toBe(12);

  await tree.getByTestId("diff-folder-src-toggle").click({ button: "right" });
  await page.getByTestId("diff-folder-src-collapse-folder").click();
  await expect(tree.getByTestId("diff-folder-src/zz-folder")).toHaveCount(0);

  await tree.getByTestId("diff-folder-src-toggle").click();
  await expect(tree.getByTestId("diff-folder-src/zz-folder")).toBeVisible();
  await expect(tree.getByText("root.ts", { exact: true })).toHaveCount(0);

  await tree.getByTestId("diff-folder-src/zz-folder-toggle").click();
  await expect(tree.getByText("root.ts", { exact: true })).toBeVisible();
  await expect(tree.getByTestId("diff-folder-src/zz-folder/nested")).toBeVisible();
  await expect(tree.getByText("changed.ts", { exact: true })).toHaveCount(0);

  await tree.getByTestId("diff-folder-src/zz-folder/nested-toggle").click();
  await expect(tree.getByText("changed.ts", { exact: true })).toBeVisible();
});

test("changes context menus expose folder revert and restore a file after confirmation", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await page.getByTestId("changes-toggle-tree").click();
  const tree = changesTree(page);
  await tree.getByTestId("diff-folder-src-toggle").click({ button: "right" });
  const folderRevert = page.getByTestId("diff-folder-src-revert");
  await expect(folderRevert).toBeVisible();
  const revertLabelColor = await folderRevert
    .getByText("Discard changes", { exact: true })
    .evaluate((element) => getComputedStyle(element).color);
  await expect(folderRevert.locator("svg")).toHaveCSS("stroke", revertLabelColor);
  await page.keyboard.press("Escape");

  await tree.getByTestId("diff-tree-file-0-toggle").click({ button: "right" });
  const cancelledConfirmation = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      resolve(message);
    });
  });
  await page.getByTestId("diff-tree-file-0-revert").click();
  expect(await cancelledConfirmation).toContain("src/use-mounted-tab-set.ts");
  await expect(tree.getByTestId("diff-tree-file-0")).toBeVisible();
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), "utf8"))
    .toBe(AFTER);

  await tree.getByTestId("diff-tree-file-0-toggle").click({ button: "right" });
  const confirmation = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
  await page.getByTestId("diff-tree-file-0-revert").click();
  expect(await confirmation).toContain("src/use-mounted-tab-set.ts");

  await expect(tree.getByTestId("diff-tree-file-0")).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), "utf8"))
    .toBe(BEFORE);
});

test("discarding a staged rename restores its source path", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeRenamedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const renamedToggle = page
    .getByTestId(/^diff-file-\d+-toggle$/)
    .filter({ hasText: "zz-renamed.ts" });
  const toggleTestId = await renamedToggle.getAttribute("data-testid");
  expect(toggleTestId).not.toBeNull();
  const rowTestId = toggleTestId!.slice(0, -"-toggle".length);
  await renamedToggle.click({ button: "right" });
  const confirmation = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByTestId(`${rowTestId}-revert`).click();
  await confirmation;

  await expect(page.getByText("zz-renamed.ts", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/rename-source.ts"), "utf8"))
    .toBe("export const renamed = true;\n");
});

test("discarding an untracked file removes it from the working tree", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeUntrackedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const untrackedToggle = page
    .getByTestId(/^diff-file-\d+-toggle$/)
    .filter({ hasText: "zz-untracked.txt" });
  const toggleTestId = await untrackedToggle.getAttribute("data-testid");
  expect(toggleTestId).not.toBeNull();
  const rowTestId = toggleTestId!.slice(0, -"-toggle".length);
  await untrackedToggle.click({ button: "right" });
  const confirmation = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByTestId(`${rowTestId}-revert`).click();
  await confirmation;

  await expect(page.getByText("zz-untracked.txt", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    readFile(path.join(workspace.repoPath, "zz-untracked.txt"), "utf8"),
  ).rejects.toThrow();
});

test("shows a revert error returned by the daemon", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await failNextDiscardRequest(page);
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
  const confirmation = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByTestId("diff-file-0-revert").click();
  await confirmation;

  await expect(page.getByText("Injected revert failure", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("diff-file-0")).toBeVisible();
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), "utf8"))
    .toBe(AFTER);
});

test("Changes keeps review navigation and controls inside its workspace tab", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const visiblePanel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(visiblePanel).toBeVisible();
  await expect(visiblePanel.getByText("use-mounted-tab-set.ts", { exact: true })).toBeVisible();
  await expect(visiblePanel).toContainText("zz-deleted.ts");
  await expect(visiblePanel.getByTestId("changes-primary-cta")).toHaveCount(0);
  await expect(page.getByTestId("changes-primary-cta")).toHaveCount(1);
  await expect(page.getByTestId("changes-primary-cta")).toContainText("Commit");
  await expect(visiblePanel.getByTestId("diff-file-0-body")).toBeVisible();
  await visiblePanel.getByTestId("diff-file-0-toggle").click();
  await expect(visiblePanel.getByTestId("diff-file-0-body")).not.toBeVisible();

  // Collapse-all and the layout switch are overflow-menu items, not toolbar icons.
  const diffOptions = visiblePanel.getByRole("button", { name: "Diff options" });
  await expect(page.getByTestId("changes-toggle-collapse-all")).toHaveCount(0);
  await diffOptions.click();
  // A workspace tab has nowhere to open itself, so the menu withholds that item.
  await expect(page.getByTestId("changes-open-tab")).toHaveCount(0);
  await page.getByTestId("changes-toggle-collapse-all").click();
  await diffOptions.click();
  await expect(page.getByTestId("changes-toggle-collapse-all")).toContainText("Expand all files");
  await page.getByTestId("changes-toggle-collapse-all").click();
  await expect(visiblePanel.getByTestId("diff-file-0-body")).toBeVisible();

  const layoutItem = page.getByTestId("changes-toggle-layout");
  await diffOptions.click();
  await expect(layoutItem).toContainText("Side-by-side diff");
  // Leading icon only: the layout is still unified, so no trailing check.
  await expect(layoutItem.locator("svg")).toHaveCount(1);
  await layoutItem.click();
  await diffOptions.click();
  await expect(layoutItem.locator("svg")).toHaveCount(2);

  await expect(page.getByText("Hide whitespace", { exact: true })).toBeVisible();
  await expect(page.getByText("Wrap long lines", { exact: true })).toBeVisible();
  await expect(page.getByTestId("changes-refresh")).toHaveText("Refresh");
  await page.getByText("Wrap long lines", { exact: true }).click();
  await diffOptions.click();
  await expect(page.getByText("Scroll long lines", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(/^workspace-working-diff-close-/)).toHaveCount(1);

  await writeFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), BEFORE);
  await expect(visiblePanel.getByText("use-mounted-tab-set.ts", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(visiblePanel).toContainText("zz-deleted.ts");
  await writeFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), AFTER);
  await expect(visiblePanel.getByText("use-mounted-tab-set.ts", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(visiblePanel.getByText("zz-deleted.ts", { exact: true })).toBeVisible();
  await expect(visiblePanel.getByRole("img", { name: "Deleted" })).toBeVisible();
});

test("desktop Changes toggles a navigation tree beside the expanded diff document", async ({
  page,
}, testInfo) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await expectFlatFileList(page);
  await expect(page.getByTestId("changes-layout-unified")).toHaveCount(0);
  await expect(page.getByTestId("changes-layout-split")).toHaveCount(0);
  // The tree toggle is the one icon action that stays outside the overflow menu.
  await expect(page.getByTestId("changes-toggle-tree")).toBeVisible();
  const [changesToolbarBox, treeToggleBox, optionsBox, treeGlyphBox, optionsGlyphBox] =
    await Promise.all([
      page.getByTestId("changes-header").boundingBox(),
      page.getByTestId("changes-toggle-tree").boundingBox(),
      page.getByRole("button", { name: "Diff options" }).boundingBox(),
      page.getByTestId("changes-toggle-tree").locator("svg").boundingBox(),
      page.getByRole("button", { name: "Diff options" }).locator("svg").boundingBox(),
    ]);
  if (!changesToolbarBox || !treeToggleBox || !optionsBox || !treeGlyphBox || !optionsGlyphBox) {
    throw new Error("Changes toolbar geometry could not be measured");
  }
  expect(changesToolbarBox.height).toBe(36);
  expect(treeToggleBox.width).toBe(24);
  expect(treeToggleBox.height).toBe(24);
  expect(optionsBox.width).toBe(24);
  expect(optionsBox.height).toBe(24);
  expect(treeGlyphBox.width).toBe(14);
  expect(treeGlyphBox.height).toBe(14);
  expect(optionsGlyphBox.width).toBe(14);
  expect(optionsGlyphBox.height).toBe(14);
  const diffOptions = page.getByRole("button", { name: "Diff options" });
  const diffOptionsRestBackground = await diffOptions.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await diffOptions.hover();
  const diffOptionsHoverBackground = await diffOptions.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(diffOptionsHoverBackground).not.toBe(diffOptionsRestBackground);
  await page.getByTestId("changes-toggle-tree").hover();
  expect(
    await page
      .getByTestId("changes-toggle-tree")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe(diffOptionsHoverBackground);
  await expect(page.getByTestId("changes-toggle-collapse-all")).toHaveCount(0);
  await expect(page.getByTestId("changes-toggle-layout")).toHaveCount(0);

  await page.getByTestId("changes-options-menu").click();
  await expect(page.getByTestId("changes-options-menu-content")).toBeVisible();
  await expect(page.getByTestId("changes-toggle-collapse-all")).toContainText("Collapse all files");
  await expect(page.getByTestId("changes-toggle-layout")).toContainText("Side-by-side diff");
  await expect(page.getByTestId("changes-toggle-whitespace")).toContainText("Hide whitespace");
  await expect(page.getByTestId("changes-toggle-wrap-lines")).toContainText("Wrap long lines");
  await expect(page.getByTestId("changes-refresh")).toHaveText("Refresh");
  await page.getByTestId("changes-toggle-whitespace").click();
  await page.getByTestId("changes-options-menu").click();
  await expect(page.getByTestId("changes-toggle-whitespace")).toContainText("Show whitespace");
  await page.keyboard.press("Escape");

  await scrollToLowerUnwrappedDiffRows(page);
  await page.getByTestId("changes-toggle-tree").click();
  await expect(page.getByTestId("changes-toggle-tree")).toHaveAttribute("aria-selected", "true");
  expect(
    await page
      .getByTestId("changes-toggle-tree")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe(diffOptionsHoverBackground);
  const tree = changesTree(page);
  const content = changesContent(page);
  await expect(tree.getByTestId("diff-folder-src")).toBeVisible();
  await expect(tree.getByTestId("diff-folder-src").getByText("src", { exact: true })).toHaveCSS(
    "user-select",
    "none",
  );
  await expect(tree.getByTestId("diff-tree-file-0")).toBeVisible();
  await expect(tree.getByTestId("diff-folder-src-toggle").locator("svg")).toHaveCount(1);
  const folderToggleBounds = await tree.getByTestId("diff-folder-src-toggle").boundingBox();
  const folderChevronBounds = await tree
    .getByTestId("diff-folder-src-toggle")
    .locator("svg")
    .boundingBox();
  expect(folderToggleBounds).not.toBeNull();
  expect(folderChevronBounds).not.toBeNull();
  expect(folderChevronBounds!.y + folderChevronBounds!.height / 2).toBeCloseTo(
    folderToggleBounds!.y + folderToggleBounds!.height / 2,
    0,
  );
  const folderLabelBounds = await tree
    .getByTestId("diff-folder-src")
    .getByText("src", { exact: true })
    .boundingBox();
  const fileLabelBounds = await tree
    .getByTestId("diff-tree-file-0")
    .getByText("use-mounted-tab-set.ts", { exact: true })
    .boundingBox();
  expect(folderLabelBounds).not.toBeNull();
  expect(fileLabelBounds).not.toBeNull();
  expect(fileLabelBounds!.x - folderLabelBounds!.x).toBeCloseTo(12, 0);

  const folderToggle = tree.getByTestId("diff-folder-src-toggle");
  await folderToggle.click();
  await expect(folderToggle).toHaveAttribute("aria-selected", "true");
  await expect(tree.getByTestId("diff-tree-file-0")).toHaveCount(0);
  await folderToggle.click();
  await expect(folderToggle).toHaveAttribute("aria-selected", "true");
  await expect(tree.getByTestId("diff-tree-file-0")).toBeVisible();

  const fileToggle = tree.getByTestId("diff-tree-file-0-toggle");
  await fileToggle.click({ button: "right" });
  await expect(fileToggle).toHaveAttribute("aria-selected", "true");
  await expect(folderToggle).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("diff-tree-file-0-context-menu")).toBeVisible();
  await page.keyboard.press("Escape");

  await fileToggle.click();
  await expect(content.getByTestId("diff-file-0-body")).toBeVisible();
  const contentBounds = await content.boundingBox();
  const focusedFileBounds = await content.getByTestId("diff-file-0").boundingBox();
  expect(contentBounds).not.toBeNull();
  expect(focusedFileBounds).not.toBeNull();
  expect(focusedFileBounds!.y).toBeGreaterThanOrEqual(contentBounds!.y);
  expect(focusedFileBounds!.y).toBeLessThan(contentBounds!.y + 80);

  await tree.getByTestId("diff-folder-src-toggle").click();
  await expect(tree.getByTestId("diff-tree-file-0")).toHaveCount(0);

  await page.getByTestId("changes-toggle-tree").click();
  await expect(page.getByTestId("changes-toggle-tree")).toHaveAttribute("aria-selected", "false");
  await expectFlatFileList(page);
  const screenshot = testInfo.outputPath("changes-toolbar.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("changes-toolbar", { path: screenshot, contentType: "image/png" });
});

test("compact Changes keeps its options control touch-sized", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await page.setViewportSize({ width: 480, height: 900 });

  const options = page.getByRole("button", { name: "Diff options" }).filter({ visible: true });
  const [optionsBox, glyphBox] = await Promise.all([
    options.boundingBox(),
    options.locator("svg").boundingBox(),
  ]);
  if (!optionsBox || !glyphBox) {
    throw new Error("Compact Changes options geometry could not be measured");
  }
  expect(optionsBox.width).toBe(32);
  expect(optionsBox.height).toBe(32);
  expect(glyphBox.width).toBe(18);
  expect(glyphBox.height).toBe(18);

  await options.click();
  const wrapLines = page.getByText("Wrap long lines", { exact: true });
  await expect(wrapLines).toBeVisible();
  await wrapLines.click();
  await options.click();
  await expect(page.getByTestId("changes-toggle-wrap-lines")).toContainText("Scroll long lines");
});

test("canvas diff stays sharp while its workspace pane is resized", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const canvas = page.getByTestId("git-diff-canvas");
  const root = page.getByTestId("git-diff-canvas-root");
  const handle = page.getByTestId("workspace-split-resize-handle").getByRole("separator");
  await expect(handle).toBeVisible();
  await expect
    .poll(async () => {
      const [canvasWidth, rootWidth] = await Promise.all([
        canvas.evaluate((element) => (element as HTMLCanvasElement).getBoundingClientRect().width),
        root.evaluate((element) => element.getBoundingClientRect().width),
      ]);
      return Math.abs(canvasWidth - rootWidth) < 1;
    })
    .toBe(true);
  const [handleBounds, before] = await Promise.all([
    handle.boundingBox(),
    canvas.evaluate((element) => {
      const canvasElement = element as HTMLCanvasElement;
      return {
        width: canvasElement.getBoundingClientRect().width,
        ratio: window.devicePixelRatio || 1,
      };
    }),
  ]);
  if (!handleBounds) throw new Error("Workspace split resize handle has no bounds");

  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 120);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x - 120, handleBounds.y + 120);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const duringDrag = await Promise.all([
    canvas.evaluate((element) => (element as HTMLCanvasElement).getBoundingClientRect().width),
    root.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(duringDrag[0]).toBeCloseTo(before.width, 0);
  expect(duringDrag[1]).toBeGreaterThan(before.width + 10);

  await page.mouse.up();
  const resizeFrames = await page.evaluate(async () => {
    const canvasElement = document.querySelector<HTMLCanvasElement>(
      '[data-testid="git-diff-canvas"]',
    )!;
    const ratio = window.devicePixelRatio || 1;
    const frames: Array<{ cssWidth: number; bitmapWidth: number }> = [];
    for (let index = 0; index < 10; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push({
        cssWidth: canvasElement.getBoundingClientRect().width,
        bitmapWidth: canvasElement.width / ratio,
      });
    }
    return frames;
  });
  for (const frame of resizeFrames) {
    expect(Math.abs(frame.cssWidth - frame.bitmapWidth)).toBeLessThan(1);
  }
  await expect
    .poll(async () => {
      const [canvasWidth, rootWidth, backingWidth] = await Promise.all([
        canvas.evaluate((element) => (element as HTMLCanvasElement).getBoundingClientRect().width),
        root.evaluate((element) => element.getBoundingClientRect().width),
        canvas.evaluate((element) => (element as HTMLCanvasElement).width),
      ]);
      return (
        Math.abs(canvasWidth - rootWidth) < 1 &&
        Math.abs(backingWidth / before.ratio - rootWidth) < 1
      );
    })
    .toBe(true);
});

test("changes diff applies code size changes to gutter and code typography", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useCodeFont(page, 12);
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  const before = await readDiffTypographyGeometry(page);

  await changeCodeTypographyFromSettings(page, {
    fontSize: 18,
    fontFamily: "Courier New, Courier, monospace",
  });
  await returnToWorkspaceChanges(page);
  await expectStoredCodeFontSize(page, 18);
  await scrollToLowerUnwrappedDiffRows(page);

  await expectDiffCodeFontSize(page, 18);
  await expectDiffCodeFontFamily(page, "Courier");
  await expectVisibleDiffRowsShareTypography(page);
  const after = await readDiffTypographyGeometry(page);
  expect(after.horizontalExtent).toBeGreaterThan(before.horizontalExtent);
  expect(after.canvasPixels).not.toEqual(before.canvasPixels);
});

test("canvas diff does not commit geometry before configured fonts are ready", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await holdBrowserFontLoads(page);
  await useUnwrappedDiffLines(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);

  await expect(page.getByTestId("git-diff-canvas")).toBeVisible();
  await expect(page.getByTestId("diff-file-0-body")).toHaveCount(0);
  await releaseBrowserFontLoads(page);
  await expectExpandedMountedTabDiff(page);
});

test("canvas diff creates, edits, and deletes an inline review without DOM code rows", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await startReviewOnFirstChangedLine(page);
  await cancelInlineReview(page);
  await startReviewOnFirstChangedLine(page);
  await saveInlineReview(page, "Please keep this branch explicit");
  await editInlineReview(page, "Please keep this branch named explicitly");
  await deleteInlineReview(page);

  await expect(page.locator('[data-testid^="diff-code-row-"]')).toHaveCount(0);
});

test("split canvas creates a review on the changed side and keeps it in that column", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await configureDiffPresentation(page, { layout: "split", wrapLines: false });
  await openWorkspaceChanges(page, workspace);
  await setOpenChangesPresentation(page, { layout: "split", wrapLines: false });
  await startReviewOnFirstChangedLine(page, "right");
  const [editor, body] = await Promise.all([
    page.getByTestId("inline-review-editor").boundingBox(),
    page.getByTestId("diff-file-0-body").boundingBox(),
  ]);
  expect(editor).not.toBeNull();
  expect(body).not.toBeNull();
  expect(editor!.x).toBeGreaterThanOrEqual(body!.x + body!.width / 2);
  await cancelInlineReview(page);
});

test("scrolling clears the hovered review affordance", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await hoverFirstChangedGutter(page);
  await expect(page.getByRole("button", { name: "Add review comment" })).toBeVisible();
  await page.getByTestId("git-diff-scroll").evaluate((element) => {
    element.scrollTop += 80;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });

  await expect(page.getByRole("button", { name: "Add review comment" })).toHaveCount(0);
});

test("canvas diff uses the overlay scrollbar and its thumb controls vertical scrolling", async ({
  page,
}) => {
  const lines = Array.from({ length: 240 }, (_, index) => `export const line${index} = ${index};`);
  const workspace = await createWorkspaceWithExactSelectionDiff(lines.join("\n"));
  await openSelectionWorkspaceChanges(page, workspace);

  const root = page.getByTestId("git-diff-canvas-root");
  const scroller = page.getByTestId("git-diff-scroll");
  const grab = root.getByTestId("workspace-overlay-scrollbar-grab");
  await expect(grab).toBeVisible();
  await expect(scroller).toHaveCSS("scrollbar-width", "none");

  const bounds = await grab.boundingBox();
  if (!bounds) throw new Error("Diff overlay scrollbar thumb has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 180);
  await page.mouse.up();

  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("the whole reviewable row reveals the gutter affordance and uses a text cursor", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  await page.mouse.move(bodyBounds.x + bodyBounds.width - 32, bodyBounds.y + lineHeight * 1.5);

  const affordance = page.getByRole("button", { name: "Add review comment" });
  await expect(affordance).toBeVisible();
  await expect(affordance.locator("svg")).toBeVisible();
  const affordanceBounds = await affordance.boundingBox();
  expect(affordanceBounds?.width).toBeCloseTo(22, 0);
  expect(affordanceBounds?.height).toBeCloseTo(22, 0);
  await expect(affordance).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByTestId("git-diff-scroll")).toHaveCSS("cursor", "text");
});

test("canvas diff copies a dragged character selection without opening a review", async ({
  context,
  page,
}) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("ABCDEFGHIJ");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  await dragExactAddedText(page, { startOffset: 2, endOffset: 8 });
  await page.keyboard.press("ControlOrMeta+C");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("CDEFGH");
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
});

test("the first click after a canvas selection only dismisses the selection", async ({ page }) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("ABCDEFGHIJ");
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  await dragExactAddedText(page, { startOffset: 2, endOffset: 8 });
  await clickFirstChangedLine(page);
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);

  await clickFirstChangedLine(page);
  await expect(page.getByTestId("inline-review-editor")).toBeVisible();
});

test("canvas diff replaces a selection with forward and backward drags", async ({
  context,
  page,
}) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("ABCDE\nFGHIJ");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);
  for (const [start, end, expectedText] of [
    [{ line: 0, offset: 2 }, { line: 1, offset: 3 }, "CDE\nFGH"],
    [{ line: 1, offset: 5 }, { line: 0, offset: 3 }, "DE\nFGHIJ"],
  ] as const) {
    await dragAddedTextRange(page, { lines: ["ABCDE", "FGHIJ"], start, end });
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedText);
  }
});

test("canvas diff copies only the selected split side", async ({ context, page }) => {
  const lines = ["RIGHT-ONE", "RIGHT-TWO"];
  const workspace = await createWorkspaceWithExactSelectionDiff(lines.join("\n"));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await configureDiffPresentation(page, { layout: "split", wrapLines: false });
  await openSelectionWorkspaceChanges(page, workspace);
  await setOpenChangesPresentation(page, { layout: "split", wrapLines: false });
  const before = await readSelectionPaintSamples(page, "right");
  await dragAddedTextRange(page, {
    lines,
    side: "right",
    start: { line: 0, offset: 1 },
    end: { line: 1, offset: 5 },
  });
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("IGHT-ONE\nRIGHT");
  const after = await readSelectionPaintSamples(page, "right");
  expect(after.gutter).toEqual(before.gutter);
  expect(after.opposite).toEqual(before.opposite);
  expect(after.code).not.toEqual(before.code);
});

test("canvas diff copies exact wrapped fragments", async ({ context, page }) => {
  const content = "abcdefghijklmnopqrstuvwxyz".repeat(8);
  const workspace = await createWorkspaceWithExactSelectionDiff(content);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await configureDiffPresentation(page, { layout: "unified", wrapLines: true });
  await openSelectionWorkspaceChanges(page, workspace);
  await setOpenChangesPresentation(page, { layout: "unified", wrapLines: true });
  await dragAddedTextRange(page, {
    lines: [content],
    wrapped: true,
    start: { line: 0, offset: 35 },
    end: { line: 0, offset: 95 },
  });
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(content.slice(35, 95));
});

test("horizontally scrolled selection copies exactly and does not paint the gutter", async ({
  context,
  page,
}) => {
  const content = "0123456789".repeat(50);
  const workspace = await createWorkspaceWithExactSelectionDiff(content);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);
  const horizontalOffset = await horizontallyScrollFirstFile(page, 320);
  const before = await readSelectionPaintSamples(page);
  await dragAddedTextRange(page, {
    lines: [content],
    horizontalOffset,
    start: { line: 0, offset: 48 },
    end: { line: 0, offset: 58 },
  });
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(content.slice(48, 58));
  const after = await readSelectionPaintSamples(page);
  expect(after.gutter).toEqual(before.gutter);
  expect(after.code).not.toEqual(before.code);
});

test("dragging within one wide grapheme or outside its cell never opens a review", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("👨‍👩‍👧‍👦tail");
  await useCodeFont(page, 40);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  await dragWithinFirstAddedGrapheme(page);
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);

  await dragFirstAddedLineIntoHeader(page);
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);

  const body = await page.getByTestId("diff-file-0-body").boundingBox();
  if (!body) throw new Error("Expanded diff body has no bounds");
  await page.mouse.click(body.x + 60, body.y + 90, { button: "right" });
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
});

test("collapsing and expanding restores the real horizontal scroll offset", async ({ page }) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("x".repeat(400));
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  const retainedOffset = await horizontallyScrollFirstFile(page, 320);
  await page.getByTestId("diff-file-0-toggle").click();
  await expect(page.getByTestId("diff-file-0-horizontal-scroll")).toHaveCount(0);
  await page.getByTestId("diff-file-0-toggle").click();

  await expect
    .poll(() =>
      page.getByTestId("diff-file-0-horizontal-scroll").evaluate((element) => element.scrollLeft),
    )
    .toBe(retainedOffset);
});

async function useCodeFont(page: Page, codeFontSize: number): Promise<void> {
  await page.addInitScript(
    ({ settingsKey, fontSize }) => {
      if (localStorage.getItem(settingsKey)) {
        return;
      }
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          theme: "dark",
          sendBehavior: "interrupt",
          serviceUrlBehavior: "ask",
          terminalScrollbackLines: 10_000,
          uiFontFamily: "",
          monoFontFamily: "",
          uiFontSize: 16,
          codeFontSize: fontSize,
          syntaxTheme: "one",
        }),
      );
    },
    { settingsKey: APP_SETTINGS_KEY, fontSize: codeFontSize },
  );
}

async function useUnwrappedDiffLines(page: Page): Promise<void> {
  await configureDiffPresentation(page, { layout: "unified", wrapLines: false });
}

async function configureDiffPresentation(
  page: Page,
  requestedPresentation: { layout: "unified" | "split"; wrapLines: boolean },
): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, presentation }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          layout: presentation.layout,
          desktopTreeVisible: false,
          wrapLines: presentation.wrapLines,
          hideWhitespace: false,
        }),
      );
    },
    { preferencesKey: CHANGES_PREFERENCES_KEY, presentation: requestedPresentation },
  );
}

async function setOpenChangesPresentation(
  page: Page,
  requestedPresentation: { layout: "unified" | "split"; wrapLines: boolean },
): Promise<void> {
  const options = page.getByRole("button", { name: "Diff options" }).filter({ visible: true });

  await options.click();
  const layoutItem = page.getByTestId("changes-toggle-layout");
  const currentLayout = (await layoutItem.locator("svg").count()) === 2 ? "split" : "unified";
  if (currentLayout !== requestedPresentation.layout) {
    await layoutItem.click();
  } else {
    await page.keyboard.press("Escape");
  }

  await options.click();
  const wrapItem = page.getByTestId("changes-toggle-wrap-lines");
  const currentWrapLines = (await wrapItem.locator("svg").count()) === 2;
  if (currentWrapLines !== requestedPresentation.wrapLines) {
    await wrapItem.click();
  } else {
    await page.keyboard.press("Escape");
  }
}

async function holdBrowserFontLoads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fontSet = document.fonts;
    const originalLoad = fontSet.load.bind(fontSet);
    const pending: Array<() => void> = [];
    Object.defineProperty(fontSet, "load", {
      configurable: true,
      value(font: string, text?: string) {
        return new Promise<FontFace[]>((resolve, reject) => {
          pending.push(() => {
            originalLoad(font, text).then(resolve, reject);
          });
        });
      },
    });
    Object.assign(window, {
      __releasePaseoDiffFontLoads() {
        for (const release of pending.splice(0)) release();
      },
    });
  });
}

async function releaseBrowserFontLoads(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as typeof window & { __releasePaseoDiffFontLoads: () => void }
    ).__releasePaseoDiffFontLoads();
  });
}

async function expectFlatFileList(page: Page): Promise<void> {
  await expect(page.locator('[data-testid^="diff-folder-"]')).toHaveCount(0);
  await expect(page.getByTestId("diff-file-0")).toContainText("use-mounted-tab-set.ts");
  await expect(page.getByTestId("diff-file-0")).toContainText("src");
}

async function expectDiffCodeFontSize(page: Page, fontSize: number): Promise<void> {
  const canvas = page.getByTestId("git-diff-canvas");
  await expect
    .poll(async () => {
      return canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    })
    .toBe(fontSize);
}

async function expectDiffCodeFontFamily(page: Page, fontFamily: string): Promise<void> {
  await expect
    .poll(() =>
      page
        .getByTestId("git-diff-canvas")
        .evaluate((element) => getComputedStyle(element).fontFamily),
    )
    .toContain(fontFamily);
}

async function expectVisibleDiffRowsShareTypography(page: Page): Promise<void> {
  await expect(page.getByTestId("git-diff-canvas")).toBeVisible();
  await expect(page.locator('[data-testid^="diff-code-row-"]')).toHaveCount(0);
}

async function createWorkspaceWithMountedTabDiff(
  options: WorkspaceFixtureOptions = {},
): Promise<DirtyWorkspace> {
  const files = [{ path: "src/use-mounted-tab-set.ts", content: BEFORE }];
  if (options.includeDeletedFile) {
    files.push({ path: "src/zz-deleted.ts", content: "export const deleted = true;\n" });
  }
  if (options.includeRenamedFile) {
    files.push({ path: "src/rename-source.ts", content: "export const renamed = true;\n" });
  }
  if (options.includeNestedFolders) {
    files.push(
      { path: "src/zz-folder/root.ts", content: "export const root = 1;\n" },
      { path: "src/zz-folder/nested/changed.ts", content: "export const nested = 1;\n" },
    );
  }
  const repo = await createTempGitRepo("changes-pane-", { files });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  await writeFile(path.join(repo.path, "src/use-mounted-tab-set.ts"), AFTER);
  if (options.includeUntrackedFile) {
    await writeFile(path.join(repo.path, "zz-untracked.txt"), "remove me\n");
  }
  if (options.includeDeletedFile) {
    await unlink(path.join(repo.path, "src/zz-deleted.ts"));
  }
  if (options.includeRenamedFile) {
    execFileSync("git", ["mv", "src/rename-source.ts", "src/zz-renamed.ts"], {
      cwd: repo.path,
    });
  }
  if (options.includeNestedFolders) {
    await writeFile(path.join(repo.path, "src/zz-folder/root.ts"), "export const root = 2;\n");
    await writeFile(
      path.join(repo.path, "src/zz-folder/nested/changed.ts"),
      "export const nested = 2;\n",
    );
  }
  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: repo.path },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? `Failed to create workspace ${repo.path}`);
  }
  return { id: createdWorkspace.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithCommittedDiff(): Promise<DirtyWorkspace> {
  const repo = await createTempGitRepo("changes-committed-", {
    files: [{ path: "tracked.ts", content: "export const tracked = 1;\n" }],
  });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo.path });
  await writeFile(path.join(repo.path, "committed-only.ts"), "export const committed = true;\n");
  execFileSync("git", ["add", "committed-only.ts"], { cwd: repo.path });
  execFileSync("git", ["commit", "-m", "Add committed-only file"], { cwd: repo.path });

  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create committed workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithExactSelectionDiff(content: string): Promise<DirtyWorkspace> {
  const repo = await createTempGitRepo("changes-canvas-selection-", {
    files: [{ path: "src/selection.ts", content: "" }],
  });
  await writeFile(path.join(repo.path, "src/selection.ts"), `${content}\n`);
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create selection workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function openWorkspaceChanges(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesInVisibleExplorer(page);
  await expectExpandedMountedTabDiff(page);
}

async function openWorkspaceChangesSurface(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
}

async function openSelectionWorkspaceChanges(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
  await expect(page.getByText("selection.ts")).toBeVisible({ timeout: 30_000 });
  await expectExpandedMountedTabDiff(page);
}

async function openChangesInVisibleExplorer(page: Page): Promise<void> {
  await openChangesPanel(page);
  await expect(page.getByText("use-mounted-tab-set.ts")).toBeVisible({ timeout: 30_000 });
}

async function expectExpandedMountedTabDiff(page: Page): Promise<void> {
  await expect(page.getByTestId("diff-file-0-body")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });
}

async function changeCodeTypographyFromSettings(
  page: Page,
  typography: { fontSize: number; fontFamily: string },
): Promise<void> {
  await page.getByTestId("sidebar-settings").click();
  await expect(page).toHaveURL(new RegExp(`${buildSettingsSectionRoute("general")}|/settings$`));
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByLabel("Code font family").fill(typography.fontFamily);
  await page.getByLabel("Code font family").press("Enter");
  await page.getByLabel("Code font size").fill(String(typography.fontSize));
  await page.getByLabel("Code font size").press("Enter");
  await expect(page.getByLabel("Code font family")).toHaveValue(typography.fontFamily);
  await expect(page.getByLabel("Code font size")).toHaveValue(String(typography.fontSize));
  await expectStoredCodeFontSize(page, typography.fontSize);
}

async function expectStoredCodeFontSize(page: Page, codeFontSize: number): Promise<void> {
  await expect
    .poll(async () => {
      const raw = await page.evaluate(
        (settingsKey) => localStorage.getItem(settingsKey),
        APP_SETTINGS_KEY,
      );
      if (!raw) {
        return null;
      }
      return (JSON.parse(raw) as { codeFontSize?: number }).codeFontSize ?? null;
    })
    .toBe(codeFontSize);
}

async function startReviewOnFirstChangedLine(
  page: Page,
  side: "unified" | "right" = "unified",
): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const columnLeft = side === "right" ? bodyBounds.x + bodyBounds.width / 2 : bodyBounds.x;
  await page.mouse.click(columnLeft + 20, bodyBounds.y + lineHeight * 1.5);
  await expect(page.getByTestId("inline-review-editor")).toBeVisible();
}

async function clickFirstChangedLine(page: Page): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  await page.mouse.click(bodyBounds.x + 120, bodyBounds.y + lineHeight * 1.5);
}

async function hoverFirstChangedGutter(page: Page): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const gutterWidth = 2 * Math.ceil(fontSize * 0.62) + 12;
  await page.mouse.move(bodyBounds.x + gutterWidth, bodyBounds.y + lineHeight * 1.5);
}

async function saveInlineReview(page: Page, body: string): Promise<void> {
  await page.getByTestId("inline-review-editor-input").fill(body);
  await page.getByTestId("inline-review-editor-save").click();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
}

async function cancelInlineReview(page: Page): Promise<void> {
  await page.getByTestId("inline-review-editor-cancel").click();
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
}

async function editInlineReview(page: Page, body: string): Promise<void> {
  await page.getByTestId(/^review-comment-edit-/).click();
  await expect(page.getByTestId("inline-review-editor")).toBeVisible();
  await page.getByTestId("inline-review-editor-input").fill(body);
  await page.getByTestId("inline-review-editor-save").click();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
}

async function deleteInlineReview(page: Page): Promise<void> {
  await page.getByTestId(/^review-comment-delete-/).click();
  await expect(page.getByTestId(/^review-comment-delete-/)).toHaveCount(0);
}

async function dragExactAddedText(
  page: Page,
  offsets: { startOffset: number; endOffset: number },
): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, metrics] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const measurementCanvas = document.createElement("canvas");
      const context = measurementCanvas.getContext("2d")!;
      context.font = `${fontSize}px ${style.fontFamily}`;
      return { fontSize, characterWidth: context.measureText("A").width };
    }),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(metrics.fontSize * 1.5);
  const gutterWidth = Math.max(2, String(1).length) * Math.ceil(metrics.fontSize * 0.62) + 12;
  const textLeft = bodyBounds.x + gutterWidth + 8;
  await page.mouse.move(
    textLeft + offsets.startOffset * metrics.characterWidth + 1,
    bodyBounds.y + lineHeight * 1.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    textLeft + offsets.endOffset * metrics.characterWidth - 1,
    bodyBounds.y + lineHeight * 1.5,
    { steps: 8 },
  );
  await page.mouse.up();
}

async function dragAddedTextRange(
  page: Page,
  input: {
    lines: string[];
    start: { line: number; offset: number };
    end: { line: number; offset: number };
    side?: "left" | "right";
    wrapped?: boolean;
    horizontalOffset?: number;
  },
): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bounds, metrics] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${fontSize}px ${style.fontFamily}`;
      return { fontSize, characterWidth: context.measureText("A").width };
    }),
  ]);
  if (!bounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(metrics.fontSize * 1.5);
  const gutterWidth = 2 * Math.ceil(metrics.fontSize * 0.62) + 12;
  const columnWidth = input.side ? bounds.width / 2 : bounds.width;
  const columnLeft = input.side === "right" ? bounds.x + columnWidth : bounds.x;
  const availableWidth = columnWidth - gutterWidth - 16;
  const charactersPerFragment = Math.max(1, Math.floor(availableWidth / metrics.characterWidth));
  const fragmentsBefore = (line: number) =>
    input.wrapped
      ? input.lines
          .slice(0, line)
          .reduce(
            (total, text) => total + Math.max(1, Math.ceil(text.length / charactersPerFragment)),
            0,
          )
      : line;
  const point = ({ line, offset }: { line: number; offset: number }) => {
    const fragment = input.wrapped ? Math.floor(offset / charactersPerFragment) : 0;
    const localOffset = input.wrapped ? offset % charactersPerFragment : offset;
    return {
      x:
        columnLeft +
        gutterWidth +
        8 +
        localOffset * metrics.characterWidth -
        (input.horizontalOffset ?? 0),
      y: bounds.y + (1 + fragmentsBefore(line) + fragment + 0.5) * lineHeight,
    };
  };
  const start = point(input.start);
  const end = point(input.end);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function readSelectionPaintSamples(
  page: Page,
  side: "unified" | "right" = "unified",
): Promise<{ gutter: number[]; code: number[]; opposite: number[] }> {
  return page.getByTestId("diff-file-0-body").evaluate((body, selectedSide) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="git-diff-canvas"]')!;
    const bodyBounds = body.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvasBounds.width;
    const scaleY = canvas.height / canvasBounds.height;
    const context = canvas.getContext("2d")!;
    const sample = (left: number, top: number, width: number, height: number) =>
      Array.from(
        context.getImageData(
          Math.round((left - canvasBounds.left) * scaleX),
          Math.round((top - canvasBounds.top) * scaleY),
          Math.max(1, Math.round(width * scaleX)),
          Math.max(1, Math.round(height * scaleY)),
        ).data,
      );
    const columnLeft =
      selectedSide === "right" ? bodyBounds.left + bodyBounds.width / 2 : bodyBounds.left;
    return {
      gutter: sample(columnLeft + 2, bodyBounds.top + 24, 8, 8),
      code: sample(columnLeft + 80, bodyBounds.top + 24, 80, 10),
      opposite: sample(bodyBounds.left + 80, bodyBounds.top + 24, 80, 10),
    };
  }, side);
}

async function dragWithinFirstAddedGrapheme(page: Page): Promise<void> {
  const bodyBounds = await page.getByTestId("diff-file-0-body").boundingBox();
  const fontSize = await page
    .getByTestId("git-diff-canvas")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const gutterWidth = 2 * Math.ceil(fontSize * 0.62) + 12;
  const x = bodyBounds.x + gutterWidth + 10;
  const y = bodyBounds.y + lineHeight * 1.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y, { steps: 3 });
  await page.mouse.up();
}

async function dragFirstAddedLineIntoHeader(page: Page): Promise<void> {
  const bodyBounds = await page.getByTestId("diff-file-0-body").boundingBox();
  const fontSize = await page
    .getByTestId("git-diff-canvas")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const x = bodyBounds.x + 60;
  await page.mouse.move(x, bodyBounds.y + lineHeight * 1.5);
  await page.mouse.down();
  await page.mouse.move(x, bodyBounds.y - 10, { steps: 4 });
  await page.mouse.up();
}

async function horizontallyScrollFirstFile(page: Page, requestedOffset: number): Promise<number> {
  const horizontalScroll = page.getByTestId("diff-file-0-horizontal-scroll");
  const retainedOffset = await horizontalScroll.evaluate((element, offset) => {
    element.scrollLeft = offset;
    element.dispatchEvent(new Event("scroll"));
    return element.scrollLeft;
  }, requestedOffset);
  expect(retainedOffset).toBeGreaterThan(0);
  return retainedOffset;
}

async function longPressFileHeader(page: Page, header: Locator): Promise<void> {
  const bounds = await header.boundingBox();
  if (!bounds) throw new Error("File header has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
}

async function readDiffTypographyGeometry(page: Page): Promise<{
  horizontalExtent: number;
  canvasPixels: string;
}> {
  const horizontalExtent = await page
    .getByTestId("diff-file-0-horizontal-scroll")
    .evaluate((element) => element.scrollWidth);
  const canvasPixels = (await page.getByTestId("git-diff-canvas").screenshot()).toString("base64");
  return { horizontalExtent, canvasPixels };
}

async function returnToWorkspaceChanges(page: Page): Promise<void> {
  await page.getByTestId("settings-back-to-workspace").click();
  await waitForWorkspaceTabsVisible(page);
  await openChangesInVisibleExplorer(page);
  await expectExpandedMountedTabDiff(page);
}

async function scrollToLowerUnwrappedDiffRows(page: Page): Promise<void> {
  await page.getByTestId("git-diff-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await expect(page.getByTestId("git-diff-canvas")).toBeVisible();
}
