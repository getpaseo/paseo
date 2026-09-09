import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  prepareContentSearch,
  searchContents,
  previewAndOpenSecondOccurrence,
  openCompactPreview,
  preserveDirtyBufferAndUndo,
  recoverChangedAndMissingPreview,
  searchContentsByTouch,
} from "../support/helpers/workspace-content-search";

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36",
});
test("searches unopened saved contents, previews keyboard selection and opens the exact occurrence", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await prepareContentSearch(workspace);
  await searchContents(page, "needle");
  await previewAndOpenSecondOccurrence(page, testInfo.outputPath("content-search-wide.png"));
  await preserveDirtyBufferAndUndo(page, workspace);
});
test("compact search keeps list, preview and Open in the existing popup", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await prepareContentSearch(workspace);
  await page.setViewportSize({ width: 390, height: 844 });
  await searchContentsByTouch(page, "needle");
  await openCompactPreview(page, testInfo.outputPath("content-search-compact.png"));
});

test("changed saved files, empty results and occurrence limits stay explicit", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await prepareContentSearch(workspace);
  await searchContents(page, "needle");
  await recoverChangedAndMissingPreview(
    page,
    workspace,
    testInfo.outputPath("content-search-limited.png"),
  );
});

test("a host without content search advertises an update requirement without sending the new RPC", async ({
  page,
  withWorkspace,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  gate.setWorkspaceContentSearchStripped();
  const workspace = await withWorkspace();
  await prepareContentSearch(workspace);
  await page.keyboard.press("Meta+Shift+F");
  await expect(
    page.getByText("Update this host to search file contents", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Update this host to search file contents", { exact: true }),
  ).toBeVisible();
  expect(gate.getClientRequestCount("fs.content.search.request")).toBe(0);
  await page.keyboard.press("Backspace");
  await expect(
    page.getByRole("textbox", {
      name: "Search commands, files, workspaces, and agents...",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+p");
  await expect(page.getByRole("textbox", { name: "Search files...", exact: true })).toBeFocused();
});

import { openLiteralSourceOccurrence } from "../support/helpers/workspace-content-search";

test("SVG image opening stays visual while a saved occurrence opens exact source", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await openLiteralSourceOccurrence(
    page,
    workspace,
    {
      path: "icon.svg",
      content: '<svg xmlns="http://www.w3.org/2000/svg"><title>needle</title></svg>',
      result: 'icon.svg:1:48 <svg xmlns="http://www.w3.org/2000/svg"><title>needle</title></svg>',
      imageFirst: true,
    },
    testInfo.outputPath("svg-source-open.png"),
  );
});

test("literal leading-space file identity survives preview and exact tab activation", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await openLiteralSourceOccurrence(
    page,
    workspace,
    {
      path: " leading.txt",
      content: "needle",
      result: " leading.txt:1:1 needle",
      cursor: "Line 1, column 7",
    },
    testInfo.outputPath("literal-path-open.png"),
  );
});

test("CR-only saved occurrences use the source editor line and exact selection", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await openLiteralSourceOccurrence(
    page,
    workspace,
    {
      path: "cr-only.txt",
      content: "first\rneedle",
      result: "cr-only.txt:2:1 needle",
      cursor: "Line 2, column 7",
    },
    testInfo.outputPath("cr-source-open.png"),
  );
});
