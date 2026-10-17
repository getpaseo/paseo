import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import type { WithWorkspace } from "../support/helpers/with-workspace";
import { openChangesPanel } from "../support/helpers/workspace-tabs";

const STORAGE_PREFIX = "@paseo:working-diff-viewed-files:";

async function openWorkingDiff(page: Page, withWorkspace: WithWorkspace) {
  const workspace = await withWorkspace({ prefix: "viewed-diff-" });
  const filePath = path.join(workspace.repoPath, "README.md");
  await writeFile(filePath, "# Temp Repo\nFirst change\n");
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesPanel(page);
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const header = panel.getByTestId("diff-file-0-toggle");
  const action = panel.getByTestId("diff-file-0-mark-as-viewed");
  await header.hover();
  await expect(action).toBeEnabled();
  return { filePath, panel, header, action };
}

async function savedViewedFiles(page: Page) {
  return page.evaluate((prefix) => {
    const entries: Record<string, Record<string, string>> = {};
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) entries[key] = JSON.parse(localStorage.getItem(key)!);
    }
    return entries;
  }, STORAGE_PREFIX);
}

for (const viewed of [true, false]) {
  test(`closing and reopening the diff preserves ${viewed ? "viewed" : "manually collapsed"} files`, async ({
    page,
    withWorkspace,
  }) => {
    const { panel, header, action } = await openWorkingDiff(page, withWorkspace);
    await (viewed ? action : header).click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    const tab = page.getByTestId("workspace-tab-working_diff").filter({ visible: true }).first();
    await tab.click({ button: "right" });
    await page.getByTestId("workspace-tab-context-working_diff-close").click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
    await page.getByTestId("workspace-new-tab-menu-diff").filter({ visible: true }).click();
    await expect(panel).toBeVisible();
    await header.hover();
    await expect(action).toHaveAttribute("aria-selected", String(viewed));
    await expect(header).toHaveAttribute("aria-expanded", "false");
  });
}

test("marking and unmarking a file preserves viewed and collapse state after reload", async ({
  page,
  withWorkspace,
}) => {
  const { panel, header, action } = await openWorkingDiff(page, withWorkspace);
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await action.click();
  await expect(action).toHaveAttribute("aria-selected", "true");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  const saved = await savedViewedFiles(page);
  expect(Object.values(saved)).toEqual([{ "README.md": expect.stringMatching(/^[a-f0-9]{64}$/) }]);

  await page.reload();
  await expect(panel).toBeVisible();
  await expect(action).toHaveAttribute("aria-selected", "true");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await openChangesPanel(page);
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await action.click();
  await expect(action).toHaveAttribute("aria-selected", "false");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => savedViewedFiles(page)).toEqual({ [Object.keys(saved)[0]]: {} });

  await page.reload();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.hover();
  await expect(action).toHaveAttribute("aria-selected", "false");
});

test("a viewed file expands when its diff changes in the active comparison", async ({
  page,
  withWorkspace,
}) => {
  const { filePath, panel, header, action } = await openWorkingDiff(page, withWorkspace);
  await action.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await writeFile(filePath, "# Temp Repo\nFirst change\nSecond change\n");
  await panel.getByTestId("changes-refresh").click();
  await expect(action).toHaveAttribute("aria-selected", "false");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => Object.values(await savedViewedFiles(page))).toEqual([{}]);
});

test("returning to a changed comparison keeps collapse choices from another comparison", async ({
  page,
  withWorkspace,
}) => {
  const { filePath, panel, header, action } = await openWorkingDiff(page, withWorkspace);
  await action.click();
  await expect(action).toHaveAttribute("aria-selected", "true");
  const whitespace = panel.getByTestId("changes-toggle-whitespace");
  await whitespace.click();
  await expect(action).toHaveAttribute("aria-selected", "false");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");

  await writeFile(filePath, "# Temp Repo\nFirst change\nSecond change\n");
  await panel.getByTestId("changes-refresh").click();
  await expect(panel.getByTestId("diff-file-0-stat")).toContainText("+2");
  await whitespace.click();
  await expect(action).toHaveAttribute("aria-selected", "false");
  await expect.poll(async () => Object.values(await savedViewedFiles(page))).toEqual([{}]);
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await whitespace.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
});

test("dismissing a failed automatic write does not retry it", async ({ page, withWorkspace }) => {
  const { filePath, panel, header, action } = await openWorkingDiff(page, withWorkspace);
  await action.click();
  await expect(action).toHaveAttribute("aria-selected", "true");
  const saved = await savedViewedFiles(page);
  // Fail only viewed-state writes so the real panel can still save layout changes.
  await page.evaluate((prefix) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix) && document.documentElement.dataset.failViewedWrite === "true") {
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      }
      setItem.call(this, key, value);
    };
    document.documentElement.dataset.failViewedWrite = "true";
  }, STORAGE_PREFIX);
  await writeFile(filePath, "# Temp Repo\nFirst change\nSecond change\n");
  await panel.getByTestId("changes-refresh").click();
  const error = panel.getByTestId("diff-viewed-error");
  await expect(error).toBeVisible();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await error.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(error).toHaveCount(0);
  await panel.getByTestId("changes-toggle-layout").click();
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(error).toHaveCount(0);
  expect(await savedViewedFiles(page)).toEqual(saved);

  await page.evaluate(() => {
    document.documentElement.dataset.failViewedWrite = "false";
  });
  await header.hover();
  await action.click();
  await expect(action).toHaveAttribute("aria-selected", "true");
  await expect(error).toHaveCount(0);
  expect(await savedViewedFiles(page)).not.toEqual(saved);
});

test("a failed manual write keeps the file unviewed and expanded until the user retries", async ({
  page,
  withWorkspace,
}) => {
  const { panel, header, action } = await openWorkingDiff(page, withWorkspace);
  await page.evaluate((prefix) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix)) {
        Storage.prototype.setItem = setItem;
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      setItem.call(this, key, value);
    };
  }, STORAGE_PREFIX);
  await action.click();
  await expect(panel.getByTestId("diff-viewed-error")).toBeVisible();
  await expect(action).toHaveAttribute("aria-selected", "false");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  expect(await savedViewedFiles(page)).toEqual({});
  await header.hover();
  await action.click();
  await expect(action).toHaveAttribute("aria-selected", "true");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByTestId("diff-viewed-error")).toHaveCount(0);
});

test("a failed storage read disables marking until the user retries", async ({
  page,
  withWorkspace,
}) => {
  const { panel, header, action } = await openWorkingDiff(page, withWorkspace);
  await action.click();
  await expect(action).toHaveAttribute("aria-selected", "true");
  const saved = await savedViewedFiles(page);
  await page.addInitScript((prefix) => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith(prefix) && document.documentElement.dataset.failViewedRead !== "false") {
        throw new DOMException("Storage unavailable", "SecurityError");
      }
      return getItem.call(this, key);
    };
  }, STORAGE_PREFIX);
  await page.reload();
  const error = panel.getByTestId("diff-viewed-error");
  await expect(error).toBeVisible();
  await header.hover();
  await expect(action).toBeDisabled();
  await page.evaluate(() => {
    document.documentElement.dataset.failViewedRead = "false";
  });
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(action).toBeEnabled();
  await expect(action).toHaveAttribute("aria-selected", "true");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(error).toHaveCount(0);
  expect(await savedViewedFiles(page)).toEqual(saved);
});
