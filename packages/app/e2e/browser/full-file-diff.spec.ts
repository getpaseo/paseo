import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { test, expect } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const cleanupTasks: Array<() => Promise<void>> = [];

const LONG_FILE_PATH = "src/long-module.ts";
const OTHER_FILE_PATH = "src/other.ts";
const LINE_COUNT = 240;

function longModule(changed: boolean): string {
  const lines = Array.from({ length: LINE_COUNT }, (_, index) => {
    const lineNumber = index + 1;
    if (changed && lineNumber === 150) return "export const value150 = computeUpdated(150);";
    return `export const value${lineNumber} = compute(${lineNumber});`;
  });
  if (changed) lines.splice(200, 0, "export const inserted = compute(-1);");
  return `${lines.join("\n")}\n`;
}

test.afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

test("full file shows every line with changes in place and a minimap that scrolls", async ({
  page,
}) => {
  const workspaceId = await createWorkspace();
  await openChanges(page, workspaceId);
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });

  await test.step("turn on the full-file view", async () => {
    await expect(panel.getByTestId("git-diff-minimap")).toHaveCount(0);
    await attachScreenshot(page, "01-changes-only");
    await panel.getByTestId("changes-toggle-full-file").click();
    await expect(panel.getByTestId("full-file-diff")).toBeVisible();
    await expect(panel.getByTestId("git-diff-minimap")).toBeVisible();
    await expect(panel.getByTestId("changes-toggle-full-file")).toHaveAccessibleName(
      "Show changes only",
    );
  });

  const scroll = panel.getByTestId("git-diff-scroll");
  await test.step("open the file at its first change", async () => {
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/long-module\.ts/);
    // 240 unchanged-and-changed lines are far taller than the hunks alone.
    await expect.poll(() => scrollMetrics(scroll, "height")).toBeGreaterThan(LINE_COUNT * 15);
    await expect.poll(() => scrollMetrics(scroll, "top")).toBeGreaterThan(1000);
    await attachScreenshot(page, "02-full-file-first-change");
  });

  await test.step("the minimap jumps to where it is pressed", async () => {
    const minimap = panel.getByTestId("git-diff-minimap");
    const bounds = await minimap.boundingBox();
    if (!bounds) throw new Error("Minimap has no bounds");
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + 2);
    await expect.poll(() => scrollMetrics(scroll, "top")).toBeLessThan(50);
    await attachScreenshot(page, "03-minimap-top");

    const sliderBottom = await minimapContentBottom(page);
    await page.mouse.click(bounds.x + bounds.width / 2, sliderBottom - 2);
    await expect.poll(() => scrollMetrics(scroll, "bottomGap")).toBeLessThan(50);
  });

  await test.step("comment on an unchanged line", async () => {
    const minimapBounds = await panel.getByTestId("git-diff-minimap").boundingBox();
    if (!minimapBounds) throw new Error("Minimap has no bounds");
    await page.mouse.click(minimapBounds.x + 10, minimapBounds.y + 2);
    await expect.poll(() => scrollMetrics(scroll, "top")).toBeLessThan(50);
    const body = page.getByTestId("diff-file-0-body");
    const bodyBounds = await body.boundingBox();
    if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
    const lineHeight = await codeLineHeight(page);
    // Line 3 is far outside any hunk.
    await page.mouse.move(bodyBounds.x + 40, bodyBounds.y + lineHeight * 2.5);
    await page.getByRole("button", { name: "Add review comment" }).click();
    await page.getByTestId("inline-review-editor-input").fill("Why does line 3 stay as is?");
    await page.getByTestId("inline-review-editor-save").click();
    await expect(page.getByText("Why does line 3 stay as is?", { exact: true })).toBeVisible();
    await attachScreenshot(page, "04-comment-on-unchanged-line");
  });

  await test.step("step to the next changed file", async () => {
    await panel.getByTestId("changes-next-file").click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/other\.ts/);
    await panel.getByTestId("changes-previous-file").click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/long-module\.ts/);
  });

  await test.step("split layout keeps the full file", async () => {
    await panel.getByTestId("changes-toggle-layout").click();
    await expect(panel.getByTestId("git-diff-minimap")).toBeVisible();
    await attachScreenshot(page, "05-full-file-split");
  });

  await test.step("turning it off restores the hunk view", async () => {
    await panel.getByTestId("changes-toggle-full-file").click();
    await expect(panel.getByTestId("full-file-diff")).toHaveCount(0);
    await expect(panel.getByTestId("git-diff-minimap")).toHaveCount(0);
  });
});

async function createWorkspace(): Promise<string> {
  const repo = await createTempGitRepo("full-file-diff-", {
    files: [
      { path: LONG_FILE_PATH, content: longModule(false) },
      { path: OTHER_FILE_PATH, content: "export const other = 1;\n" },
    ],
  });
  const client = await connectSeedClient();
  cleanupTasks.push(async () => {
    await client.close().catch(() => undefined);
    await repo.cleanup().catch(() => undefined);
  });
  await writeFile(path.join(repo.path, LONG_FILE_PATH), longModule(true));
  await writeFile(path.join(repo.path, OTHER_FILE_PATH), "export const other = 2;\n");
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create workspace ${repo.path}`);
  }
  return created.workspace.id;
}

async function openChanges(page: Page, workspaceId: string): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
}

function scrollMetrics(scroll: Locator, metric: "top" | "height" | "bottomGap"): Promise<number> {
  return scroll.evaluate((element, requested) => {
    if (requested === "top") return element.scrollTop;
    if (requested === "height") return element.scrollHeight;
    return element.scrollHeight - element.clientHeight - element.scrollTop;
  }, metric);
}

function codeLineHeight(page: Page): Promise<number> {
  return page
    .getByTestId("git-diff-canvas")
    .evaluate((element) => Math.round(Number.parseFloat(getComputedStyle(element).fontSize) * 1.5));
}

/** Bottom of the painted minimap content, which is shorter than the rail for a short file. */
async function minimapContentBottom(page: Page): Promise<number> {
  const minimap = page.getByTestId("git-diff-minimap").filter({ visible: true });
  const bounds = await minimap.boundingBox();
  if (!bounds) throw new Error("Minimap has no bounds");
  const scale = await page
    .getByTestId("git-diff-scroll")
    .filter({ visible: true })
    .evaluate((element, height) => Math.min(height / element.scrollHeight, 3 / 18), bounds.height);
  const scrollHeight = await page
    .getByTestId("git-diff-scroll")
    .filter({ visible: true })
    .evaluate((element) => element.scrollHeight);
  return bounds.y + Math.min(bounds.height, scrollHeight * scale);
}

async function attachScreenshot(page: Page, name: string): Promise<void> {
  const screenshotPath = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath });
  await test.info().attach(name, { path: screenshotPath, contentType: "image/png" });
}
