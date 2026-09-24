import { execFileSync } from "node:child_process";
import { openChangesPanel } from "../support/helpers/workspace-tabs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";

async function diffAnswerPoint(surface: Locator, row: number) {
  const body = surface.getByTestId("diff-file-0-body");
  await expect(body).toBeVisible();
  const bounds = await body.boundingBox();
  if (!bounds) throw new Error("Diff body missing");
  const metrics = await surface.getByTestId("git-diff-canvas").evaluate((canvas) => {
    const style = getComputedStyle(canvas);
    const size = Number.parseFloat(style.fontSize);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${size}px ${style.fontFamily}`;
    return {
      height: Math.round(size * 1.5),
      gutter: 2 * Math.ceil(size * 0.62) + 20,
      prefix: context.measureText("export const an").width,
    };
  });
  return { x: bounds.x + metrics.gutter + metrics.prefix, y: bounds.y + metrics.height * row };
}

test("TypeScript hover, definition and searchable usages use the real host", async ({
  page,
  withWorkspace,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await withWorkspace({ prefix: "code-language-" });
  await writeFile(
    path.join(workspace.repoPath, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  await writeFile(path.join(workspace.repoPath, "library.ts"), "export const answer = 42;\n");
  await writeFile(
    path.join(workspace.repoPath, "source.ts"),
    'import { answer } from "./library";\nconst result = answer;\n',
  );
  await workspace.navigateTo();
  await openFileExplorer(page);
  await openFileFromExplorer(page, "source.ts");
  const source = page.getByTestId("file-source-editor").filter({ visible: true });
  await expect(source).toBeVisible();
  const symbol = source.locator(".cm-line").nth(1).getByText("answer", { exact: true });
  await symbol.hover();
  await expect(page.getByTestId("code-language-hover")).toContainText("42", { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("hover.png") });
  const hover = page.getByTestId("code-language-hover");
  const hoverBounds = await hover.boundingBox();
  if (!hoverBounds) throw new Error("Hover card missing");
  await page.mouse.move(hoverBounds.x + 8, hoverBounds.y + 8, { steps: 12 });
  await expect(hover).toBeVisible();
  await expect(hover).not.toBeFocused();
  await page.mouse.move(10, 10);
  await expect(hover).toBeHidden();
  await symbol.click();
  await page.keyboard.press("Alt+F12");
  await expect(hover).toHaveAttribute("role", "dialog");
  await expect(hover).toBeFocused();
  await expect(hover).toContainText("42");
  await page.keyboard.press("Escape");
  await expect(hover).toBeHidden();
  await expect(source.locator("[contenteditable=true]")).toBeFocused();
  await symbol.click();
  await page.keyboard.press("Shift+F12");
  const popup = page.getByTestId("code-language-popup");
  await expect(popup.getByRole("combobox")).toBeVisible({ timeout: 30_000 });
  await expect(popup.getByRole("option").first()).toContainText("source.ts");
  await page.screenshot({ path: testInfo.outputPath("usages.png") });
  await popup.getByRole("combobox").fill("not-a-file");
  await expect(popup).toContainText("No locations found");
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await symbol.click();
  await page.keyboard.press("F12");
  await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toHaveAttribute(
    "aria-label",
    "Source editor for library.ts",
  );
  await expect(
    page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-selectionBackground")
      .first(),
  ).toBeVisible();
});

test("working diffs inspect current text and disable language actions on deleted lines", async ({
  page,
  withWorkspace,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await withWorkspace({ prefix: "code-language-diff-" });
  await writeFile(
    path.join(workspace.repoPath, "source.ts"),
    "export const answer = 41;\nconst result = answer;\n",
  );
  execFileSync("git", ["add", "source.ts"], { cwd: workspace.repoPath });
  execFileSync("git", ["commit", "-m", "Add source"], { cwd: workspace.repoPath });
  await writeFile(
    path.join(workspace.repoPath, "source.ts"),
    "export const answer = 42;\nconst result = answer;\n",
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      "@paseo:changes-preferences",
      JSON.stringify({ layout: "unified", wrapLines: false, hideWhitespace: false }),
    ),
  );
  await workspace.navigateTo();
  await openChangesPanel(page);
  const surface = page.getByTestId("working-diff-panel").filter({ visible: true });
  const added = await diffAnswerPoint(surface, 2.5);
  const removed = await diffAnswerPoint(surface, 1.5);
  await page.mouse.move(added.x, added.y);
  await expect(page.getByTestId("code-language-hover")).toContainText("42", { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("diff-hover.png") });
  await page.mouse.click(removed.x, removed.y, { button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Go to definition", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Open current file", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.mouse.click(added.x, added.y, { button: "right" });
  await expect(page.getByRole("menuitem", { name: "Find usages", exact: true })).toBeEnabled();
  await page.getByRole("menuitem", { name: "Find usages", exact: true }).click();
  await expect(page.getByTestId("code-language-popup").getByRole("option")).toContainText(
    "source.ts:2",
  );
  await page.getByTestId("code-language-popup").getByRole("combobox").press("Enter");
  await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toBeVisible();
});

test("compact Changes supports TypeScript inspection without a pane context", async ({
  page,
  withWorkspace,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await withWorkspace({ prefix: "code-language-compact-" });
  await writeFile(path.join(workspace.repoPath, "source.ts"), "export const answer = 41;\n");
  execFileSync("git", ["add", "source.ts"], { cwd: workspace.repoPath });
  execFileSync("git", ["commit", "-m", "Add source"], { cwd: workspace.repoPath });
  await writeFile(path.join(workspace.repoPath, "source.ts"), "export const answer = 42;\n");
  await page.addInitScript(() =>
    localStorage.setItem(
      "@paseo:changes-preferences",
      JSON.stringify({ layout: "unified", wrapLines: false, hideWhitespace: false }),
    ),
  );
  await workspace.navigateTo();
  await page.setViewportSize({ width: 480, height: 900 });
  await page.getByTestId("workspace-explorer-toggle").first().click();
  const changes = page.getByTestId("explorer-tab-changes").filter({ visible: true });
  await expect(changes).toBeVisible();
  await changes.click();
  const explorer = page.getByTestId("explorer-content-area").filter({ visible: true });
  await expect(explorer.getByTestId("git-diff-canvas")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("compact-changes.png") });
  const added = await diffAnswerPoint(explorer, 2.5);
  await page.mouse.move(added.x, added.y);
  await expect(page.getByTestId("code-language-hover")).toContainText("42", { timeout: 30_000 });
  await page.mouse.click(added.x, added.y, { button: "right" });
  await page.getByRole("menuitem", { name: "Go to definition", exact: true }).click();
  const editor = page.getByTestId("file-source-editor").filter({ visible: true });
  await expect(editor).toHaveAttribute("aria-label", "Source editor for source.ts");
  await expect(explorer).toBeHidden();
  await expect(editor.locator(".cm-selectionBackground").first()).toBeVisible();
});
