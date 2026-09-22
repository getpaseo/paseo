import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { connectSeedClient } from "../support/helpers/seed-client";

// A project view key carries the project's path, so a directory whose name ends
// in a space produces a key that ends in a space. The sidebar order store used
// to trim it on write, which left the reconcile effect writing a new order on
// every render until React tore the app down with "Maximum update depth
// exceeded" on every load (#4880).
test("a project whose folder name ends in a space renders in the sidebar", async ({ page }) => {
  const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-trailing-space-"));
  const directoryPath = path.join(parentDirectory, `Reklamation-${randomUUID().slice(0, 8)} `);
  await mkdir(directoryPath);
  await writeFile(path.join(directoryPath, "README.md"), "# Trailing space\n");

  const client = await connectSeedClient();
  let projectId: string | null = null;
  try {
    const added = await client.addProject(directoryPath);
    projectId = added.project?.projectId ?? null;
    expect(added.error).toBeNull();
    expect(added.project?.projectRootPath).toBe(directoryPath);
    const projectKey = added.project?.projectKey;
    if (!projectKey) throw new Error("The daemon added the project without a project key");

    await gotoAppShell(page);

    const projectRow = page.getByTestId(
      `sidebar-project-row-${projectEquivalenceViewKey(projectKey)}`,
    );
    await expect(projectRow).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Paseo ran into a problem.")).toHaveCount(0);
  } finally {
    if (projectId) await client.removeProject(projectId).catch(() => undefined);
    await client.close();
    await rm(parentDirectory, { recursive: true, force: true });
  }
});
