import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";

function previewSurface(page: Page) {
  return page.getByTestId("markdown-preview-surface").filter({ visible: true });
}

function previewFrame(page: Page) {
  return page.getByTestId("markdown-preview-frame").filter({ visible: true });
}

function previewScroll(page: Page) {
  return page.getByTestId("markdown-preview-scroll").filter({ visible: true });
}

function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}

function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}

async function openMarkdownPreview(page: Page, filename: string) {
  await openFileExplorer(page);
  await openFileFromExplorer(page, filename);
  await expect(previewFrame(page)).toBeVisible();
}

async function activeHighlightBox(page: Page) {
  return page.evaluate(() => {
    for (const [name, highlight] of CSS.highlights.entries()) {
      if (!name.startsWith("paseo-markdown-find-active-")) continue;
      for (const item of highlight.values()) {
        if (!(item instanceof Range)) continue;
        const rect = item.getClientRects()[0] ?? item.getBoundingClientRect();
        return {
          text: item.toString(),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      }
    }
    return null;
  });
}

async function expectActiveMatchUncovered(page: Page, surface: Locator = previewSurface(page)) {
  const widget = surface.getByLabel("Find", { exact: true }).filter({ visible: true });
  const scroll = surface.getByTestId("markdown-preview-scroll").filter({ visible: true });
  await expect
    .poll(async () => {
      const m = await activeHighlightBox(page);
      const w = await widget.boundingBox();
      const s = await scroll.boundingBox();
      if (!m || !w || !s) return "missing";
      const inScroll = m.y >= s.y - 1 && m.y + m.height <= s.y + s.height + 1;
      if (!inScroll) return "outside viewport";
      const covered =
        m.x < w.x + w.width && m.x + m.width > w.x && m.y < w.y + w.height && m.y + m.height > w.y;
      return covered ? "covered by Find" : "visible";
    })
    .toBe("visible");
}

test("searches rendered Markdown preview, scrolls to offscreen matches, and avoids covering top matches", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "markdown-preview-find-" });
  const filler = Array.from(
    { length: 45 },
    (_, index) => `Paragraph filler row ${index + 1}.`,
  ).join("\n\n");
  await writeFile(
    path.join(workspace.repoPath, "guide.md"),
    [
      "---",
      "owner: team-a.b",
      "---",
      "",
      "# Markdown Find Guide",
      "",
      "First **A.B** inline match and literal axb non-match.",
      "",
      "```ts",
      'const endpoint = "service.a.b";',
      "```",
      "",
      filler,
      "",
      "Final offscreen a.b occurrence at the bottom.",
      "",
    ].join("\n"),
  );

  await workspace.navigateTo();
  await openMarkdownPreview(page, "guide.md");

  await previewSurface(page).click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  await expect(page.getByRole("button", { name: "Toggle replace" })).toHaveCount(0);

  await query(page).fill("a.b");
  await expect(status(page)).toHaveText("1 of 4");
  await expectActiveMatchUncovered(page);

  // Navigate to the final offscreen occurrence via Shift+Enter wrap-around
  await query(page).press("Shift+Enter");
  await expect(status(page)).toHaveText("4 of 4");
  await expectActiveMatchUncovered(page);
  const scrolledTop = await previewScroll(page).evaluate((node: HTMLElement) => node.scrollTop);
  expect(scrolledTop).toBeGreaterThan(100);
  await page.screenshot({ path: testInfo.outputPath("markdown-preview-find-bottom.png") });

  // Wrap forward back to match 1
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("1 of 4");
  await expectActiveMatchUncovered(page);

  // Close with Escape and verify highlights clear
  await query(page).press("Escape");
  await expect(query(page)).toBeHidden();
  await expect.poll(() => activeHighlightBox(page)).toBeNull();
});

test("isolates Find to the focused Markdown preview pane in split layout", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "markdown-preview-find-split-" });
  await writeFile(path.join(workspace.repoPath, "left.md"), "# Left\n\nneedle one\n");
  await writeFile(
    path.join(workspace.repoPath, "right.md"),
    "# Right needle\n\nneedle two\n\nneedle three\n",
  );

  await workspace.navigateTo();
  await openMarkdownPreview(page, "left.md");
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await openFileFromExplorer(page, "right.md");

  const left = previewSurface(page).filter({ hasText: "needle one" });
  const right = previewSurface(page).filter({ hasText: "needle two" });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();

  await right.click();
  await page.keyboard.press("ControlOrMeta+f");
  await query(page).fill("needle");
  await expect(status(page)).toHaveText("1 of 3");
  await expectActiveMatchUncovered(page, right);
  await query(page).press("Escape");

  await left.click();
  await page.keyboard.press("ControlOrMeta+f");
  await query(page).fill("needle");
  await expect(status(page)).toHaveText("1 of 1");
  await expectActiveMatchUncovered(page, left);
});

test.describe("macOS", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  test("opens Markdown preview Find with Meta+f and ignores Control+f", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "markdown-preview-find-mac-" });
    await writeFile(
      path.join(workspace.repoPath, "mac.md"),
      "# Mac\n\nneedle first\n\nneedle second\n",
    );
    await workspace.navigateTo();
    await openMarkdownPreview(page, "mac.md");

    await previewSurface(page).click();
    await page.keyboard.press("Control+f");
    await expect(query(page)).toHaveCount(0);

    await page.keyboard.press("Meta+f");
    await expect(query(page)).toBeFocused();
    await query(page).fill("needle");
    await expect(status(page)).toHaveText("1 of 2");
  });
});
