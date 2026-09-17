import { execFileSync } from "node:child_process";
import { openChangesPanel } from "../support/helpers/workspace-tabs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";

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
  await page.mouse.move(10, 10);
  await expect(page.getByTestId("code-language-hover")).toBeHidden();
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
  const body = page.getByTestId("diff-file-0-body");
  await expect(body).toBeVisible();
  const bounds = await body.boundingBox();
  if (!bounds) throw new Error("Diff body missing");
  const metrics = await page.getByTestId("git-diff-canvas").evaluate((canvas) => {
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
  const x = bounds.x + metrics.gutter + metrics.prefix;
  await page.mouse.move(x, bounds.y + metrics.height * 2.5);
  await expect(page.getByTestId("code-language-hover")).toContainText("42", { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("diff-hover.png") });
  await page.mouse.click(x, bounds.y + metrics.height * 1.5, { button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Go to definition", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Open current file", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.mouse.click(x, bounds.y + metrics.height * 2.5, { button: "right" });
  await expect(page.getByRole("menuitem", { name: "Find usages", exact: true })).toBeEnabled();
  await page.getByRole("menuitem", { name: "Find usages", exact: true }).click();
  await expect(page.getByTestId("code-language-popup").getByRole("option")).toContainText(
    "source.ts:2",
  );
  await page.getByTestId("code-language-popup").getByRole("combobox").press("Enter");
  await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toBeVisible();
});
