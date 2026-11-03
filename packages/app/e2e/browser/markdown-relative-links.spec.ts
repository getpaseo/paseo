import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  expandFolder,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";

async function openNestedGuide(page: Page): Promise<void> {
  await openFileExplorer(page);
  await expandFolder(page, "docs");
  await openFileFromExplorer(page, "guide.md");
}

async function followDetailsLink(page: Page): Promise<void> {
  await page
    .getByTestId("markdown-preview-frame")
    .getByRole("link", { name: "Details", exact: true })
    .click();
}

test("Markdown preview resolves a relative link from the document directory", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "markdown-relative-links-" });
  await mkdir(path.join(workspace.repoPath, "docs/guide"), { recursive: true });
  await writeFile(
    path.join(workspace.repoPath, "docs/guide.md"),
    "# Guide\n\n[Details](guide/details.md)\n",
  );
  await writeFile(
    path.join(workspace.repoPath, "docs/guide/details.md"),
    "# Nested details destination\n",
  );
  await workspace.navigateTo();

  await openNestedGuide(page);
  await followDetailsLink(page);

  await expect(
    page
      .getByTestId("markdown-preview-frame")
      .getByText("Nested details destination", { exact: true }),
  ).toBeVisible();
});
