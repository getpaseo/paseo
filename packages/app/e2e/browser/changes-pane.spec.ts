import { execFileSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  // A root-level file whose name sorts BEFORE the root-level "src" directory.
  // zz-untracked.txt cannot stand in for it: "src" < "zz", so that file lands
  // last whether paths are compared whole or segment by segment.
  includeRootFileSortingFirst?: boolean;
  includeUntrackedFile?: boolean;
}

interface CleanupTask {
  run: () => Promise<void>;
}

const cleanupTasks: CleanupTask[] = [];
const APP_SETTINGS_KEY = "@paseo:app-settings";

function changesTree(page: Page) {
  return page.getByTestId("changes-file-tree").filter({ visible: true });
}

function diffHeaderForPath(panel: Locator, filePath: string): Locator {
  return panel.locator(`[data-diff-header-path="${filePath}"]`).getByTestId(/^diff-file-\d+$/);
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

  await openWorkspaceChangesSurface(page, workspace, 90_000);

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  await expect(tree.getByTestId("changes-diff-status-trigger")).toContainText("Committed");
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");
});

test("Changes expires a manual comparison when checkout dirtiness changes", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await openWorkspaceChanges(page, workspace);

  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const mode = tree.getByTestId("changes-diff-status-trigger");
  await expect(mode).toContainText("Uncommitted");

  await mode.click();
  await page.getByTestId("changes-diff-mode-committed").click();
  await expect(mode).toContainText("Committed");
  await expect(tree.getByRole("button", { name: "See uncommitted changes" })).toBeVisible();

  execFileSync("git", ["add", "--all"], { cwd: workspace.repoPath });
  execFileSync("git", ["commit", "-m", "Commit working changes"], { cwd: workspace.repoPath });
  await expect(mode).toContainText("Committed");
  await expect(tree.getByRole("button", { name: "See uncommitted changes" })).toHaveCount(0, {
    timeout: 30_000,
  });

  await writeFile(path.join(workspace.repoPath, "new-working-change.txt"), "uncommitted\n");
  await expect(mode).toContainText("Uncommitted", { timeout: 30_000 });
});

test("an empty Changes comparison links to the populated comparison", async ({ page }) => {
  const workspace = await createWorkspaceWithCommittedDiff();
  await openWorkspaceChangesSurface(page, workspace);

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const mode = tree.getByTestId("changes-diff-status-trigger");
  await mode.click();
  await page.getByTestId("changes-diff-mode-committed").click();
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");

  await mode.click();
  await page.getByTestId("changes-diff-mode-uncommitted").click();

  await expect(tree.getByText("No uncommitted changes", { exact: true })).toBeVisible();
  await expect(panel.getByText("No uncommitted changes", { exact: true })).toBeVisible();
  const seeCommitted = tree.getByRole("button", { name: "See committed changes" });
  await expect(seeCommitted).toBeVisible();
  await seeCommitted.click();
  await expect(mode).toContainText("Committed");
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");
});

test("Changes comparison controls the working diff and tree selection focuses its file", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithScrollableComparisons();
  await openWorkspaceChangesSurface(page, workspace);

  await selectChangesComparison(page, "Committed");
  await expectWorkingComparisonFiles(page, "committed");
  await selectChangedFileAndExpectFocused(page, "committed/50-target.ts");

  await selectChangesComparison(page, "Uncommitted");
  await expectWorkingComparisonFiles(page, "uncommitted");
  await selectChangedFileAndExpectFocused(page, "uncommitted/50-target.ts");
});

test("changes file actions open below the right-click without a reserved kebab", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const deletedFileName = page.getByTestId("diff-file-1");
  await expect(deletedFileName).toHaveAccessibleName(/zz-deleted\.ts/);
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
  const firstCanvas = page.getByTestId("git-diff-sticky-header-0");
  const secondCanvas = page.getByTestId("git-diff-sticky-header-1");
  const normalBackground = await headerCanvasPixel(firstCanvas, first, 10);

  await first.hover();
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).not.toBe(normalBackground);
  const hoverBackground = await headerCanvasPixel(firstCanvas, first, 10);

  await first.click();
  await page.mouse.move(0, 0);
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).toBe(normalBackground);

  await first.hover();
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).toBe(hoverBackground);
  await second.hover();
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).toBe(normalBackground);
  await expect.poll(() => headerCanvasPixel(secondCanvas, second, 10)).toBe(hoverBackground);
});

test("horizontal body scrolling never moves or repaints the canvas header", async ({ page }) => {
  const wideLine = `export const wide = "${"wide".repeat(160)}";`;
  const workspace = await createWorkspaceWithExactSelectionDiff(wideLine);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  const headerCanvas = page.getByTestId("git-diff-canvas");
  const header = page.getByTestId("diff-file-0-toggle");
  const beforePixel = await headerCanvasPixel(headerCanvas, header, 10);
  const beforeBounds = await header.boundingBox();

  await horizontallyScrollFirstFile(page, 320);
  await page.waitForTimeout(50);

  expect(await headerCanvasPixel(headerCanvas, header, 10)).toBe(beforePixel);
  expect(await header.boundingBox()).toEqual(beforeBounds);
});

test("in-flow file headers move with the diff document", async ({ page }) => {
  const workspace = await createWorkspaceWithStickyTransitionDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChangesSurface(page, workspace);

  const motion = await measureInFlowHeaderMotion(page);

  expect(motion).toEqual({ headerSurface: -120, shell: -120 });
});

test("the outgoing sticky header hands off without a gap or overlap", async ({
  page,
}, testInfo) => {
  const workspace = await createWorkspaceWithStickyTransitionDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChangesSurface(page, workspace);

  const scroller = page.getByTestId("git-diff-scroll");
  const first = page.getByTestId("diff-file-0-toggle");
  const second = page.getByTestId("diff-file-1-toggle");
  const secondTop = await second.evaluate((element) => {
    const scrollElement = element.closest<HTMLElement>('[data-testid="git-diff-scroll"]');
    if (!scrollElement) return Number.NaN;
    return (
      scrollElement.scrollTop +
      element.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top
    );
  });
  expect(secondTop).toBeGreaterThan(30);
  await scroller.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  }, secondTop - 15);
  await expect(first).toBeAttached();
  await expect(second).toBeAttached();

  const [scrollBounds, firstBounds, secondBounds] = await Promise.all([
    scroller.boundingBox(),
    first.boundingBox(),
    second.boundingBox(),
  ]);
  if (!scrollBounds || !firstBounds || !secondBounds) {
    throw new Error("Sticky transition geometry is unavailable");
  }
  expect(firstBounds.y - scrollBounds.y).toBeCloseTo(-15, 0);
  expect(secondBounds.y - scrollBounds.y).toBeCloseTo(15, 0);
  const transitionHits = await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [14, 16].map(
      (y) =>
        document
          .elementFromPoint(bounds.left + bounds.width / 2, bounds.top + y)
          ?.closest<HTMLElement>("[data-diff-header]")?.dataset.diffHeaderPath ?? null,
    );
  });
  expect(transitionHits).toEqual(["src/first.ts", "src/second.ts"]);
  await testInfo.attach("canvas-header-sticky-handoff", {
    body: await page.getByTestId("git-diff-canvas-root").screenshot(),
    contentType: "image/png",
  });

  await scroller.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  }, secondTop);
  await expect
    .poll(async () => {
      const bounds = await second.boundingBox();
      return bounds ? bounds.y - scrollBounds.y : Number.NaN;
    })
    .toBeCloseTo(0, 0);
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

test("the scrolling diff lists files in changes tree order", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({
    includeNestedFolders: true,
    includeRootFileSortingFirst: true,
  });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const tree = changesTree(page);
  const treeNames = tree.locator('[data-testid^="diff-tree-file-"][data-testid$="-name"]');
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const diffHeaders = panel.getByTestId(/^diff-file-\d+$/);

  // Directories sort before files at every level, so the root note lands last
  // even though "a-root-note.txt" compares below "src/..." as a whole string.
  const expected = ["changed.ts", "root.ts", "use-mounted-tab-set.ts", "a-root-note.txt"];

  // Equal counts also prove no folder is collapsed: flattenDiffTree drops the
  // descendants of a collapsed folder, which would make the tree a subsequence
  // of the diff rather than a match, and mask a real ordering difference.
  await expect(treeNames).toHaveCount(expected.length);
  await expect(diffHeaders).toHaveCount(expected.length);
  await expect(treeNames).toHaveText(expected);
  const expectedHeaderNames = [
    "src/zz-folder/nested/changed.ts, +1, -1",
    "src/zz-folder/root.ts, +1, -1",
    "src/use-mounted-tab-set.ts, +37, -1",
    "a-root-note.txt, +1, -0",
  ];
  for (const [index, accessibleName] of expectedHeaderNames.entries()) {
    await expect(diffHeaders.nth(index)).toHaveAccessibleName(accessibleName);
  }
});

test("changes context menu recursively collapses descendant folders", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeNestedFolders: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

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

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const renamedHeader = diffHeaderForPath(panel, "src/zz-renamed.ts");
  await expect(renamedHeader).toHaveAccessibleName("src/zz-renamed.ts, +1, -0");
  const renamedToggle = renamedHeader.getByTestId(/^diff-file-\d+-toggle$/);
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

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const untrackedHeader = diffHeaderForPath(panel, "zz-untracked.txt");
  await expect(untrackedHeader).toHaveAccessibleName("zz-untracked.txt, +1, -0");
  const untrackedToggle = untrackedHeader.getByTestId(/^diff-file-\d+-toggle$/);
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
  await expect(visiblePanel.getByTestId("changes-repository-header")).toHaveCount(0);
  await expect(visiblePanel.getByTestId("changes-branch-switcher")).toHaveCount(0);
  await expect(visiblePanel.getByTestId("changes-diff-status-trigger")).toHaveCount(0);
  await expect(visiblePanel.getByTestId("changes-selected-diff-stat")).toHaveCount(0);
  await expect(visiblePanel.getByTestId("changes-header")).toHaveCount(1);
  await expect(diffHeaderForPath(visiblePanel, "src/use-mounted-tab-set.ts")).toHaveAccessibleName(
    "src/use-mounted-tab-set.ts, +37, -1",
  );
  await expect(diffHeaderForPath(visiblePanel, "src/zz-deleted.ts")).toHaveAccessibleName(
    "src/zz-deleted.ts, +0, -1",
  );
  await expect(visiblePanel.getByTestId("changes-primary-cta")).toHaveCount(0);
  await expect(page.getByTestId("changes-primary-cta")).toHaveCount(1);
  await expect(page.getByTestId("changes-primary-cta")).toContainText("Commit");
  await expect(visiblePanel.getByTestId("diff-file-0-body")).toBeVisible();
  await visiblePanel.getByTestId("diff-file-0-toggle").click();
  await expect(visiblePanel.getByTestId("diff-file-0-body")).not.toBeVisible();

  await expect(visiblePanel.getByRole("button", { name: "Diff options" })).toHaveCount(0);
  await expect(page.getByTestId("changes-open-tab")).toHaveCount(0);
  const collapseFiles = visiblePanel.getByTestId("changes-toggle-collapse-all");
  await expect(collapseFiles).toHaveAttribute("aria-label", "Collapse all files");
  await collapseFiles.click();
  await expect(collapseFiles).toHaveAttribute("aria-label", "Expand all files");
  await collapseFiles.click();
  await expect(visiblePanel.getByTestId("diff-file-0-body")).toBeVisible();

  const layout = visiblePanel.getByTestId("changes-toggle-layout");
  await expect(layout).toHaveAttribute("aria-label", "Switch to side-by-side diff");
  await layout.click();
  await expect(layout).toHaveAttribute("aria-label", "Switch to unified diff");

  const whitespace = visiblePanel.getByTestId("changes-toggle-whitespace");
  await expect(whitespace).toHaveAttribute("aria-label", "Hide whitespace");
  const wrapLines = visiblePanel.getByTestId("changes-toggle-wrap-lines");
  await expect(wrapLines).toHaveAttribute("aria-label", "Wrap long lines");
  await expect(visiblePanel.getByTestId("changes-refresh")).toHaveAttribute(
    "aria-label",
    "Refresh",
  );
  await wrapLines.click();
  await expect(wrapLines).toHaveAttribute("aria-label", "Scroll long lines");
  await expect(page.getByTestId(/^workspace-working-diff-close-/)).toHaveCount(1);

  await writeFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), BEFORE);
  await expect(
    visiblePanel.locator('[data-diff-header-path="src/use-mounted-tab-set.ts"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(visiblePanel.locator('[data-diff-header-path="src/zz-deleted.ts"]')).toBeVisible();
  await writeFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), AFTER);
  await expect(diffHeaderForPath(visiblePanel, "src/use-mounted-tab-set.ts")).toHaveAccessibleName(
    "src/use-mounted-tab-set.ts, +37, -1",
    { timeout: 30_000 },
  );
  await expect(diffHeaderForPath(visiblePanel, "src/zz-deleted.ts")).toHaveAccessibleName(
    "src/zz-deleted.ts, +0, -1",
  );
});

test("compact Changes keeps its actions compact and menu-only", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await page.setViewportSize({ width: 480, height: 900 });

  const compactChangesTab = page.getByTestId("explorer-tab-changes").filter({ visible: true });
  if (!(await compactChangesTab.isVisible())) {
    await page.getByTestId("workspace-explorer-toggle").first().click();
  }
  await expect(compactChangesTab).toBeVisible();
  await compactChangesTab.click();
  const compactExplorer = page.getByTestId("explorer-content-area").filter({ visible: true });
  await expect(compactExplorer.getByTestId("changes-header")).toBeVisible();

  const actions = compactExplorer.getByTestId("changes-actions-menu-trigger");
  const options = compactExplorer.getByRole("button", { name: "Diff options" });
  const [actionsBox, optionsBox, glyphBox] = await Promise.all([
    actions.boundingBox(),
    options.boundingBox(),
    options.locator("svg").boundingBox(),
  ]);
  if (!actionsBox || !optionsBox || !glyphBox) {
    throw new Error("Compact Changes toolbar geometry could not be measured");
  }
  expect(actionsBox.width).toBe(48);
  expect(actionsBox.height).toBe(28);
  expect(optionsBox.width).toBe(32);
  expect(optionsBox.height).toBe(32);
  expect(glyphBox.width).toBe(18);
  expect(glyphBox.height).toBe(18);

  await expect(actions).not.toContainText("Commit");
  await expect(actions.locator("svg")).toHaveCount(2);
  await actions.click();
  await expect(page.getByTestId("changes-primary-cta-menu")).toBeVisible();
  await expect(page.getByTestId("changes-menu-commit")).toContainText("Commit");
  await page.keyboard.press("Escape");

  await options.click();
  const wrapLines = page.getByText("Wrap long lines", { exact: true });
  await expect(wrapLines).toBeVisible();
  await wrapLines.click();
  await options.click();
  await expect(
    page.getByTestId("changes-options-menu-content").getByTestId("changes-toggle-wrap-lines"),
  ).toContainText("Scroll long lines");
});

test("canvas diff stays sharp while its workspace pane is resized", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const canvas = page.getByTestId("git-diff-canvas");
  const root = page.getByTestId("git-diff-canvas-root");
  const handle = page
    .getByTestId("workspace-explorer-sidebar-resize-handle")
    .getByRole("separator");
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
  if (!handleBounds) throw new Error("Explorer sidebar resize handle has no bounds");

  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 120);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + 120, handleBounds.y + 120);
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

test("autofocusing an inline review keeps the Changes tab focused", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const changesTab = page.getByTestId("workspace-tab-working_diff").filter({ visible: true });
  const focusedBackground = await changesTab.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await startReviewOnFirstChangedLine(page);
  await expect(page.getByTestId("inline-review-editor-input")).toBeFocused();
  await expect
    .poll(() => changesTab.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(focusedBackground);
});

test("inline reviews keep the browser text context menu", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await startReviewOnFirstChangedLine(page);
  await page.getByTestId("inline-review-editor-input").click({ button: "right" });
  await expect(page.getByTestId("diff-source-context-menu")).toHaveCount(0);
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
  await expect(grab).toHaveCSS("cursor", "grabbing");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 180);
  await page.mouse.up();

  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("canvas headers keep a many-file diff bounded while scrolling end to end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspace = await createWorkspaceWithManyTinyDiffs(2_000);
  await useUnwrappedDiffLines(page);
  await openWorkspaceChangesSurface(page, workspace, 90_000);

  const root = page.getByTestId("git-diff-canvas-root");
  const scroller = page.getByTestId("git-diff-scroll");
  await expect(root.locator('[data-testid^="git-diff-sticky-header-"]')).toHaveCount(2);
  await expect.poll(() => root.locator('[data-diff-header="true"]').count()).toBeLessThan(120);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });

  await expect(page.getByTestId("diff-file-1999")).toBeVisible();
  await expect.poll(() => root.locator('[data-diff-header="true"]').count()).toBeLessThan(120);
  await expect(root.locator('[data-testid^="git-diff-sticky-header-"]')).toHaveCount(2);
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

test("canvas diff context menu copies selections and source lines", async ({ context, page }) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("ABCDEFGHIJ");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  await dragExactAddedText(page, { startOffset: 2, endOffset: 8 });
  await rightClickFirstChangedLine(page);
  await page.getByTestId("diff-source-copy-selection").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("CDEFGH");

  await rightClickFirstChangedLine(page);
  await page.getByTestId("diff-source-copy-line").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("ABCDEFGHIJ");
});

test("canvas diff clears a selection when collapsing an earlier file", async ({ page }) => {
  const workspace = await createWorkspaceWithTwoSelectionDiffs();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await dragExactAddedText(page, { startOffset: 2, endOffset: 8 }, 1);
  await page.getByTestId("diff-file-0-toggle").click();
  await rightClickFirstChangedLine(page, 1);
  await expect(page.getByTestId("diff-source-copy-selection")).toBeDisabled();
});

test("clicking the canvas dismisses a selection without opening a review", async ({ page }) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("ABCDEFGHIJ");
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  await dragExactAddedText(page, { startOffset: 2, endOffset: 8 });
  await clickFirstChangedLine(page);
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);

  await clickFirstChangedLine(page);
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
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
  const diffPanel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const layoutItem = diffPanel.getByTestId("changes-toggle-layout");
  const currentLayout =
    (await layoutItem.getAttribute("aria-label")) === "Switch to unified diff"
      ? "split"
      : "unified";
  if (currentLayout !== requestedPresentation.layout) {
    await layoutItem.click();
  }

  const wrapItem = diffPanel.getByTestId("changes-toggle-wrap-lines");
  const currentWrapLines = (await wrapItem.getAttribute("aria-label")) === "Scroll long lines";
  if (currentWrapLines !== requestedPresentation.wrapLines) {
    await wrapItem.click();
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
  if (options.includeRootFileSortingFirst) {
    await writeFile(path.join(repo.path, "a-root-note.txt"), "root note\n");
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

async function createWorkspaceWithScrollableComparisons(): Promise<DirtyWorkspace> {
  const repo = await createTempGitRepo("changes-comparison-focus-", {
    files: [{ path: "tracked.ts", content: "export const tracked = true;\n" }],
  });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  const longFile = Array.from(
    { length: 120 },
    (_, index) => `export const line${index} = ${index};`,
  ).join("\n");
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo.path });
  await writeComparisonFiles(repo.path, "committed", longFile);
  execFileSync("git", ["add", "committed"], { cwd: repo.path });
  execFileSync("git", ["commit", "-m", "Add committed comparison files"], { cwd: repo.path });
  await writeComparisonFiles(repo.path, "uncommitted", longFile);

  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create comparison workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function writeComparisonFiles(
  repoPath: string,
  directory: "committed" | "uncommitted",
  longFile: string,
): Promise<void> {
  await mkdir(path.join(repoPath, directory), { recursive: true });
  await Promise.all([
    writeFile(path.join(repoPath, directory, "00-before.ts"), `${longFile}\n`),
    writeFile(path.join(repoPath, directory, "50-target.ts"), "export const target = true;\n"),
    writeFile(path.join(repoPath, directory, "99-after.ts"), `${longFile}\n`),
  ]);
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

async function createWorkspaceWithTwoSelectionDiffs(): Promise<DirtyWorkspace> {
  const repo = await createTempGitRepo("changes-canvas-selection-shift-", {
    files: [
      { path: "src/first.ts", content: "" },
      { path: "src/second.ts", content: "" },
    ],
  });
  await Promise.all([
    writeFile(path.join(repo.path, "src/first.ts"), "FIRST\n"),
    writeFile(path.join(repo.path, "src/second.ts"), "ABCDEFGHIJ\n"),
  ]);
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

async function createWorkspaceWithManyTinyDiffs(fileCount: number): Promise<DirtyWorkspace> {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/file-${String(index).padStart(4, "0")}.ts`,
    content: "export const value = 0;\n",
  }));
  const repo = await createTempGitRepo("changes-canvas-many-files-", { files });
  await Promise.all(
    files.map((file, index) =>
      writeFile(path.join(repo.path, file.path), `export const value = ${index + 1};\n`),
    ),
  );
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create many-file workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithStickyTransitionDiff(): Promise<DirtyWorkspace> {
  const source = Array.from(
    { length: 48 },
    (_, index) => `export const value${index} = ${index};`,
  ).join("\n");
  const files = ["src/first.ts", "src/second.ts"].map((filePath) => ({
    path: filePath,
    content: `${source}\n`,
  }));
  const repo = await createTempGitRepo("changes-canvas-sticky-transition-", { files });
  const changedSource = Array.from(
    { length: 48 },
    (_, index) => `export const value${index} = ${index + 100};`,
  ).join("\n");
  await Promise.all(
    files.map((file) => writeFile(path.join(repo.path, file.path), `${changedSource}\n`)),
  );
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create sticky workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function openWorkspaceChanges(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await page.getByTestId("workspace-explorer-toggle").first().click();
  await openChangesInVisibleExplorer(page);
  await expectExpandedMountedTabDiff(page);
}

async function openWorkspaceChangesSurface(
  page: Page,
  workspace: DirtyWorkspace,
  timeout?: number,
): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page, timeout);
}

async function openSelectionWorkspaceChanges(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
  const diffPanel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(diffPanel.getByTestId("diff-file-0")).toHaveAccessibleName(/selection\.ts/, {
    timeout: 30_000,
  });
  await expectExpandedMountedTabDiff(page);
}

async function openChangesInVisibleExplorer(page: Page): Promise<void> {
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  await expect(explorer).toBeVisible({ timeout: 30_000 });
  const changesTab = explorer.getByRole("button", { name: /Working tree diff/i }).first();
  await changesTab.click();
  const changedFile = explorer
    .locator('[data-testid^="diff-tree-file-"][data-testid$="-toggle"]')
    .filter({ visible: true })
    .first();
  await expect(changedFile).toBeVisible({ timeout: 30_000 });
  await changedFile.click();
  await expect(page.getByTestId("working-diff-panel").filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function selectChangesComparison(
  page: Page,
  comparison: "Committed" | "Uncommitted",
): Promise<void> {
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  await tree.getByTestId("changes-diff-status-trigger").click();
  await page.getByTestId(`changes-diff-mode-${comparison.toLowerCase()}`).click();
  await expect(tree.getByTestId("changes-diff-status-trigger")).toContainText(comparison);
}

async function expectWorkingComparisonFiles(
  page: Page,
  comparison: "committed" | "uncommitted",
): Promise<void> {
  const tree = changesTree(page);
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const paths = ["00-before.ts", "50-target.ts", "99-after.ts"];
  await expect(tree.locator('[data-testid^="diff-tree-file-"][data-testid$="-name"]')).toHaveText(
    paths,
  );
  for (const fileName of paths) {
    await expect(diffHeaderForPath(panel, `${comparison}/${fileName}`)).toBeAttached();
  }
}

async function selectChangedFileAndExpectFocused(page: Page, filePath: string): Promise<void> {
  const tree = changesTree(page);
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const scroller = panel.getByTestId("git-diff-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });

  await tree.getByText(path.basename(filePath), { exact: true }).click();
  const header = diffHeaderForPath(panel, filePath);
  await expect(header).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const [scrollBounds, headerBounds] = await Promise.all([
    scroller.boundingBox(),
    header.boundingBox(),
  ]);
  if (!scrollBounds || !headerBounds)
    throw new Error("Focused diff header geometry is unavailable");
  expect(headerBounds.y - scrollBounds.y).toBeCloseTo(0, 0);
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
  await page.mouse.move(columnLeft + 20, bodyBounds.y + lineHeight * 1.5);
  await page.getByRole("button", { name: "Add review comment" }).click();
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

async function rightClickFirstChangedLine(page: Page, fileIndex = 0): Promise<void> {
  const body = page.getByTestId(`diff-file-${fileIndex}-body`);
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  await page.mouse.click(bodyBounds.x + 120, bodyBounds.y + lineHeight * 1.5, {
    button: "right",
  });
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
  fileIndex = 0,
): Promise<void> {
  const body = page.getByTestId(`diff-file-${fileIndex}-body`);
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

async function measureInFlowHeaderMotion(
  page: Page,
): Promise<{ headerSurface: number; shell: number }> {
  return page.getByTestId("git-diff-scroll").evaluate(async (element) => {
    const scroll = element as HTMLElement;
    const headerSurface = document.querySelector<HTMLElement>('[data-testid="git-diff-canvas"]');
    const shell = document.querySelector<HTMLElement>('[data-diff-header-path="src/second.ts"]');
    if (!headerSurface || !shell) throw new Error("Diff header motion surfaces are unavailable");

    const shellDocumentTop =
      scroll.scrollTop + shell.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    scroll.scrollTop = Math.max(0, shellDocumentTop - scroll.clientHeight + 80);
    scroll.dispatchEvent(new Event("scroll", { bubbles: false }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const before = {
      headerSurface: headerSurface.getBoundingClientRect().top,
      shell: shell.getBoundingClientRect().top,
    };
    scroll.scrollTop += 120;
    const after = {
      headerSurface: headerSurface.getBoundingClientRect().top,
      shell: shell.getBoundingClientRect().top,
    };
    return {
      headerSurface: after.headerSurface - before.headerSurface,
      shell: after.shell - before.shell,
    };
  });
}

async function longPressFileHeader(page: Page, header: Locator): Promise<void> {
  const bounds = await header.boundingBox();
  if (!bounds) throw new Error("File header has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
}

async function headerCanvasPixel(
  canvas: Locator,
  header: Locator,
  offsetY: number,
): Promise<string> {
  const [canvasBounds, headerBounds] = await Promise.all([
    canvas.boundingBox(),
    header.boundingBox(),
  ]);
  if (!canvasBounds || !headerBounds) throw new Error("Canvas header has no bounds");
  return canvas.evaluate(
    (element, point) => {
      const target = element as HTMLCanvasElement;
      const ratio = target.width / target.getBoundingClientRect().width;
      const context = target.getContext("2d");
      if (!context) throw new Error("Canvas header has no 2D context");
      return Array.from(
        context.getImageData(Math.round(point.x * ratio), Math.round(point.y * ratio), 1, 1).data,
      ).join(",");
    },
    { x: 4, y: headerBounds.y - canvasBounds.y + offsetY },
  );
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
