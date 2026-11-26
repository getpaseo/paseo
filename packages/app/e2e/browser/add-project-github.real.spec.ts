import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import {
  addProjectFlow,
  addProjectFlowInput,
  chooseAddProjectLocation,
  chooseAddProjectTab,
  expectNewWorkspaceForAddedProject,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";
import {
  createTempGithubRepo,
  hasGithubAuth,
  type GhRepoFixture,
} from "../support/helpers/github-fixtures";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

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
      await chooseAddProjectTab(page, "clone");

      await addProjectFlowInput(page).fill("getpaseo/paseo");
      await expect(addProjectFlow(page).getByText("getpaseo/paseo", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await addProjectFlowInput(page).fill(repository.fullName);

      const repositoryRow = addProjectFlow(page).getByText(repository.fullName, { exact: true });
      await expect(repositoryRow).toBeVisible({ timeout: 30_000 });
      await repositoryRow.click();
      await chooseAddProjectLocation(page, parentDirectory);
      await expect(page.getByTestId("add-project-flow-location")).toContainText(
        path.join(path.basename(parentDirectory), repository.name),
      );
      await addProjectFlowInput(page).focus();

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
