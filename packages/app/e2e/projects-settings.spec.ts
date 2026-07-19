import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Page } from "./fixtures";
import { connectSeedClient, seedWorkspace } from "./helpers/seed-client";
import {
  blockPaseoConfigWrites,
  bumpPaseoConfigOnDisk,
  clickReloadProjectSettings,
  clickRetryProjectSettingsSave,
  clickSaveProjectSettings,
  corruptPaseoConfig,
  editWorktreeSetup,
  expectEmptyScriptList,
  expectHostIndicatorVisible,
  expectHostPickerHidden,
  expectNoEditableTarget,
  expectNoProjectSettingsError,
  expectProjectSettingsError,
  expectProjectSettingsFormHidden,
  expectProjectSettingsFormVisible,
  expectSaveButtonDisabled,
  expectScriptRowCount,
  expectWriteFailedCalloutActions,
  installDaemonConnectionGate,
  installReadTransportFailure,
  navigateToProjectSettings,
  openProjectSettings,
  openProjects,
  removeProjectScript,
  restorePaseoConfig,
  unblockPaseoConfigWrites,
} from "./helpers/project-settings";
import { gotoAppShell } from "./helpers/app";
import {
  addProjectFlowInput,
  chooseAddProjectMethod,
  openAddProjectFlow,
} from "./helpers/add-project-flow";
import { createTempGitRepo } from "./helpers/workspace";

const updatedSetup = ["npm install", "npm run build"];

interface ProjectsSettingsProject {
  name: string;
  path: string;
}

interface ProjectsSettingsFixtures {
  editableProject: ProjectsSettingsProject;
  gitlabRemoteProject: ProjectsSettingsProject;
}

const initialPaseoConfig = {
  worktree: {
    setup: ["echo initial setup"],
    teardown: "echo cleanup",
    customWorktreeField: "preserved",
  },
  scripts: {
    dev: {
      command: "npm run dev",
      type: "server",
      port: 3000,
      customScriptField: "preserved",
    },
  },
  customTopLevelField: "preserved",
};

const test = base.extend<ProjectsSettingsFixtures>({
  editableProject: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({
      repoPrefix: "projects-settings-",
      repo: { paseoConfig: initialPaseoConfig },
    });

    await provide({
      name: workspace.projectDisplayName,
      path: workspace.repoPath,
    });

    // Defensive: restore directory write permission in case the test left it blocked
    // (write_failed test), so that cleanup can remove files inside.
    await chmod(workspace.repoPath, 0o755).catch(() => undefined);
    await workspace.cleanup();
  },
  gitlabRemoteProject: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({
      repoPrefix: "projects-settings-gitlab-",
      repo: {
        paseoConfig: initialPaseoConfig,
        originUrl: "https://gitlab.com/acme/app.git",
      },
    });

    await provide({
      name: workspace.projectDisplayName,
      path: workspace.repoPath,
    });

    await workspace.cleanup();
  },
});

async function expectProjectConfigSaved(project: ProjectsSettingsProject): Promise<void> {
  await expect
    .poll(
      async () => {
        const contents = await readProjectConfigFile(project);
        return JSON.parse(contents) as unknown;
      },
      {
        timeout: 30_000,
      },
    )
    .toMatchObject({
      worktree: {
        setup: updatedSetup,
        teardown: initialPaseoConfig.worktree.teardown,
        customWorktreeField: initialPaseoConfig.worktree.customWorktreeField,
      },
      scripts: {
        dev: {
          command: initialPaseoConfig.scripts.dev.command,
          type: initialPaseoConfig.scripts.dev.type,
          port: initialPaseoConfig.scripts.dev.port,
          customScriptField: initialPaseoConfig.scripts.dev.customScriptField,
        },
      },
      customTopLevelField: initialPaseoConfig.customTopLevelField,
    });

  const savedConfig = await readProjectConfigFile(project);
  expect(savedConfig).toBe(`${JSON.stringify(JSON.parse(savedConfig), null, 2)}\n`);
}

async function readProjectConfigFile(project: ProjectsSettingsProject): Promise<string> {
  return readFile(path.join(project.path, "paseo.json"), "utf8");
}

async function addProjectFromSidebar(page: Page, projectPath: string): Promise<string> {
  await openAddProjectFlow(page);
  await chooseAddProjectMethod(page, "directory-search");

  const input = addProjectFlowInput(page);
  await input.fill(projectPath);
  await page.keyboard.press("Enter");

  const projectRow = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: path.basename(projectPath) })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });

  const testId = await projectRow.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  return testId!.replace("sidebar-project-row-", "");
}

async function openProjectSettingsFromSidebar(page: Page, projectId: string): Promise<void> {
  const projectRow = page.getByTestId(`sidebar-project-row-${projectId}`);
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const kebab = page.getByTestId(`sidebar-project-kebab-${projectId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const openSettingsItem = page.getByTestId(`sidebar-project-menu-open-settings-${projectId}`);
  await expect(openSettingsItem).toBeVisible({ timeout: 10_000 });
  await openSettingsItem.click();
}

test.describe("Projects settings", () => {
  test("freshly-added project with no workspace is editable from the sidebar without a reload", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("projects-settings-empty-");
    const client = await connectSeedClient();
    let projectId: string | null = null;

    try {
      await gotoAppShell(page);

      projectId = await addProjectFromSidebar(page, repo.path);
      await openProjectSettingsFromSidebar(page, projectId);

      await expectProjectSettingsFormVisible(page);
      await expect(page.getByTestId("project-settings-back-button")).not.toBeVisible();
    } finally {
      if (projectId) {
        await client.removeProject(projectId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("user edits worktree setup from the projects page", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await editWorktreeSetup(page, updatedSetup);
    await clickSaveProjectSettings(page);
    await expectProjectConfigSaved(editableProject);
  });

  test("user edits worktree setup on a non-GitHub remote project", async ({
    page,
    gitlabRemoteProject,
  }) => {
    expect(gitlabRemoteProject.name).toBe(path.basename(gitlabRemoteProject.path));
    await openProjects(page);
    await openProjectSettings(page, gitlabRemoteProject.name);
    await editWorktreeSetup(page, updatedSetup);
    await clickSaveProjectSettings(page);
    await expectProjectConfigSaved(gitlabRemoteProject);
  });
});

test.describe("Projects settings — error UX", () => {
  test("stale-write callout appears on save, disables save, and reload clears it", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    // Bump the file on disk so the daemon detects a revision mismatch on save.
    await bumpPaseoConfigOnDisk(editableProject.path);

    await clickSaveProjectSettings(page);

    await expectProjectSettingsError(page, "stale");
    await expectSaveButtonDisabled(page);

    await clickReloadProjectSettings(page);

    await expectNoProjectSettingsError(page, "stale");
    await expectProjectSettingsFormVisible(page);
  });

  test("invalid paseo.json shows read-error callout, reload after fix shows form", async ({
    page,
    editableProject,
  }) => {
    await corruptPaseoConfig(editableProject.path);

    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);

    await expectProjectSettingsError(page, "invalid");
    await expectProjectSettingsFormHidden(page);

    // Restore a valid config so the reload succeeds.
    await restorePaseoConfig(editableProject.path, initialPaseoConfig);

    await clickReloadProjectSettings(page);

    await expectNoProjectSettingsError(page, "invalid");
    await expectProjectSettingsFormVisible(page);
  });

  test("write_failed callout appears on save with blocked directory, retry re-attempts, reload clears it", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    await blockPaseoConfigWrites(editableProject.path);

    await clickSaveProjectSettings(page);

    await expectProjectSettingsError(page, "write_failed");
    await expectWriteFailedCalloutActions(page);

    await clickRetryProjectSettingsSave(page);
    await expectProjectSettingsError(page, "write_failed");

    await unblockPaseoConfigWrites(editableProject.path);
    await clickReloadProjectSettings(page);
    await expectNoProjectSettingsError(page, "write_failed");
    await expectProjectSettingsFormVisible(page);
  });

  test("read-transport failure shows callout, reload recovers", async ({
    page,
    editableProject,
  }) => {
    // Reject read_project_config_request calls until the user clicks Reload.
    // This keeps automatic reconnect refetches from racing past the callout.
    const transportFailure = await installReadTransportFailure(page);

    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);

    await expectProjectSettingsError(page, "transport");
    await expectProjectSettingsFormHidden(page);

    // Retry Reload until the refetch wins any in-flight error-state rendering.
    transportFailure.allowRecovery();
    await expect(async () => {
      await clickReloadProjectSettings(page);
      await expectNoProjectSettingsError(page, "transport", 3_000);
    }).toPass({ timeout: 15_000 });
    await expectProjectSettingsFormVisible(page);
  });

  test("project settings shows no-target state when daemon connection drops", async ({
    page,
    editableProject,
  }) => {
    const gate = await installDaemonConnectionGate(page);

    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    // Closing with code 1001 (Going Away) transitions DaemonClient to "error" state.
    // The NoEditableTarget UI renders via isHostGone check regardless of state.
    await gate.drop();

    await expectNoEditableTarget(page);
  });

  test("single-host project renders static host indicator, not a picker chip", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    await expectHostIndicatorVisible(page);
    await expectHostPickerHidden(page);
  });

  test("script removal via kebab menu removes the row from the form", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    await expectScriptRowCount(page, 1);

    await removeProjectScript(page, "dev");

    await expectScriptRowCount(page, 0);
    await expectEmptyScriptList(page);
  });
});
