import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { connectSeedClient } from "../support/helpers/seed-client";

interface SeededProject {
  projectKey: string;
  cleanup(): Promise<void>;
}

/**
 * Adds a project whose directory name ends in a space, which `seedWorkspace`
 * cannot produce because `mkdtemp` appends the random suffix. The project is
 * owned until `cleanup`, which removes the daemon record before the directory.
 */
async function seedProjectNamedWithTrailingSpace(): Promise<SeededProject> {
  const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-trailing-space-"));
  const directoryPath = path.join(parentDirectory, `Reklamation-${randomUUID().slice(0, 8)} `);
  await mkdir(directoryPath);
  await writeFile(path.join(directoryPath, "README.md"), "# Trailing space\n");

  const client = await connectSeedClient();
  const removeParentDirectory = () => rm(parentDirectory, { recursive: true, force: true });
  try {
    const added = await client.addProject(directoryPath);
    expect(added.error).toBeNull();
    expect(added.project?.projectRootPath).toBe(directoryPath);
    const project = added.project;
    if (!project?.projectKey) {
      throw new Error(`The daemon added ${directoryPath} without a project key`);
    }
    return {
      projectKey: project.projectKey,
      cleanup: async () => {
        await client.removeProject(project.projectId).catch(() => undefined);
        await client.close().catch(() => undefined);
        await removeParentDirectory().catch(() => undefined);
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await removeParentDirectory().catch(() => undefined);
    throw error;
  }
}

async function expectProjectRow(page: Page, projectKey: string): Promise<void> {
  const row = page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(projectKey)}`);
  await expect(row).toBeVisible({ timeout: 60_000 });
}

async function expectAppShellRendered(page: Page): Promise<void> {
  await expect(page.getByText("Paseo ran into a problem.")).toHaveCount(0);
}

// A project view key carries the project's path, so a directory whose name ends
// in a space produces a key that ends in a space. The sidebar order store used
// to trim it on write, which left the reconcile effect writing a new order on
// every render until React tore the app down with "Maximum update depth
// exceeded" on every load (#4880).
test("a project whose folder name ends in a space renders in the sidebar", async ({ page }) => {
  const project = await seedProjectNamedWithTrailingSpace();

  try {
    await gotoAppShell(page);

    await expectProjectRow(page, project.projectKey);
    await expectAppShellRendered(page);
  } finally {
    await project.cleanup();
  }
});
