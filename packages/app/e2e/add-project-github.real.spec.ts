import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import {
  addProjectFlow,
  addProjectFlowBack,
  addProjectFlowInput,
  chooseAddProjectMethod,
  expectAddProjectPage,
  expectNewWorkspaceForAddedProject,
  openAddProjectFlow,
} from "./helpers/add-project-flow";
import { gotoAppShell } from "./helpers/app";
import { createTempGithubRepo, hasGithubAuth, type GhRepoFixture } from "./helpers/github-fixtures";
import { expectOpenedProject } from "./helpers/project-picker-ui";
import { connectSeedClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

test.describe("Add Project GitHub flow", () => {
  test.describe.configure({ timeout: 300_000 });

  test("searches the host's repositories and clones into a clearly shown final path", async ({
    page,
  }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    let repository: GhRepoFixture | null = null;
    const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-github-clone-"));
    let projectId: string | null = null;

    try {
      repository = await createTempGithubRepo({ category: "add-project" });
      const checkoutPath = path.join(parentDirectory, repository.name);

      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "github");

      await addProjectFlowInput(page).fill("getpaseo/paseo");
      await expect(addProjectFlow(page).getByText("getpaseo/paseo", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await addProjectFlowInput(page).fill("");

      const repositoryRow = addProjectFlow(page).getByText(repository.fullName, { exact: true });
      await expect(repositoryRow).toBeVisible({ timeout: 30_000 });
      await repositoryRow.click();
      await expectAddProjectPage(page, "github-location");

      await addProjectFlowInput(page).fill(parentDirectory);
      await expect(addProjectFlow(page)).toContainText(checkoutPath, { timeout: 30_000 });

      await addProjectFlowBack(page).click();
      await expectAddProjectPage(page, "github-search");
      await expect(repositoryRow).toBeVisible();
      await repositoryRow.click();
      await expectAddProjectPage(page, "github-location");
      await expect(addProjectFlowInput(page)).toHaveValue(parentDirectory);

      await mkdir(checkoutPath);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("add-project-flow-error")).toHaveText(
        `Checkout path already exists: ${checkoutPath}`,
      );

      await rm(checkoutPath, { recursive: true });
      await page.keyboard.press("Enter");
      projectId = await expectOpenedProject(page, repository.name);
      await expectNewWorkspaceForAddedProject(page, {
        serverId: getServerId(),
        projectId,
        projectName: repository.name,
        projectPath: checkoutPath,
      });
      const client = await connectSeedClient();
      try {
        expect((await client.fetchWorkspaces({ filter: { projectId } })).entries).toEqual([]);
      } finally {
        await client.close();
      }
      await expect.poll(async () => (await stat(checkoutPath)).isDirectory()).toBe(true);
    } finally {
      if (projectId) {
        const client = await connectSeedClient();
        try {
          await client.removeProject(projectId).catch(() => undefined);
        } finally {
          await client.close();
        }
      }
      await repository?.cleanup();
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });
});
