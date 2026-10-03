import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openFileByTypedPath } from "../support/helpers/command-center";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { createTempDirectory } from "../support/helpers/workspace";

const OUTSIDE_FILE_NAME = "outside-plan.md";
const OUTSIDE_FILE_MARKER = "outside-workspace-marker-7f3a";
const HIDDEN_FILE_NAME = ".hidden-plan.md";
const HIDDEN_FILE_MARKER = "hidden-outside-workspace-marker-91c4";

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36",
});

/**
 * A directory next to the workspace holding one file, so the file is reachable both by its absolute
 * path and by a path that starts inside the workspace and steps out with `..`. Every run gets its own
 * directory: the sibling path is otherwise shared by concurrent runs.
 */
async function createWorkspaceSiblingFile(
  workspace: SeededWorkspace,
  fileName: string,
  marker: string,
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(
    path.join(path.dirname(workspace.workspaceDirectory), "paseo-outside-"),
  );
  const file = path.join(directory, fileName);
  await writeFile(file, `# ${marker}\n`);
  return { file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("file search opens a file named by an absolute path outside the workspace", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-absolute-path-",
    title: "Absolute path file search",
  });
  // The whole point: the file lives nowhere near the workspace the search runs in.
  const outside = await createTempDirectory("paseo-outside-");
  const outsideFile = path.join(outside.path, OUTSIDE_FILE_NAME);
  await writeFile(outsideFile, `# ${OUTSIDE_FILE_MARKER}\n`);

  try {
    await gotoWorkspace(page, seeded.workspaceId);
    await openFileByTypedPath(page, {
      typedPath: outsideFile,
      expectedPath: outsideFile,
      fileName: OUTSIDE_FILE_NAME,
    });
    // The tab only proves the click landed; the file content proves the daemon was asked for the
    // right path -- the pane reads paths outside the workspace by rooting the request at "/".
    await expect(page.getByText(OUTSIDE_FILE_MARKER)).toBeVisible({ timeout: 30_000 });
  } finally {
    await seeded.cleanup();
    await outside.cleanup();
  }
});

test("file search opens a hidden file outside the workspace by its absolute path", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-hidden-path-",
    title: "Hidden file search",
  });
  const outside = await createWorkspaceSiblingFile(seeded, HIDDEN_FILE_NAME, HIDDEN_FILE_MARKER);

  try {
    await gotoWorkspace(page, seeded.workspaceId);
    // Discovery filters hidden names, so only the named-path request can offer this row.
    await openFileByTypedPath(page, {
      typedPath: outside.file,
      expectedPath: outside.file,
      fileName: HIDDEN_FILE_NAME,
    });
    await expect(page.getByText(HIDDEN_FILE_MARKER)).toBeVisible({ timeout: 30_000 });
  } finally {
    await outside.cleanup();
    await seeded.cleanup();
  }
});

test("file search follows parent segments that leave the workspace", async ({ page }) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-parent-path-",
    title: "Parent segment file search",
  });
  const outside = await createWorkspaceSiblingFile(seeded, HIDDEN_FILE_NAME, HIDDEN_FILE_MARKER);
  // Spelled with `..` on purpose: the typed path starts inside the workspace and resolves outside.
  const throughParent = `${seeded.workspaceDirectory}/../${path.basename(path.dirname(outside.file))}/${HIDDEN_FILE_NAME}`;

  try {
    await gotoWorkspace(page, seeded.workspaceId);
    await openFileByTypedPath(page, {
      typedPath: throughParent,
      expectedPath: outside.file,
      fileName: HIDDEN_FILE_NAME,
    });
    await expect(page.getByText(HIDDEN_FILE_MARKER)).toBeVisible({ timeout: 30_000 });
  } finally {
    await outside.cleanup();
    await seeded.cleanup();
  }
});
