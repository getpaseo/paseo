import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base } from "./fixtures";
import { connectNewWorkspaceDaemonClient, openProjectViaDaemon } from "./helpers/new-workspace";
import { createTempGitRepo } from "./helpers/workspace";
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
    const client = await connectNewWorkspaceDaemonClient();
    const repo = await createTempGitRepo("projects-settings-", {
      paseoConfig: initialPaseoConfig,
    });
    const openedProject = await openProjectViaDaemon(client, repo.path);

    await provide({
      name: openedProject.projectDisplayName,
      path: repo.path,
    });

    await client.close();
    // Defensive: restore directory write permission in case the test left it blocked
    // (write_failed test), so that repo.cleanup() can remove files inside.
    await chmod(repo.path, 0o755).catch(() => undefined);
    await repo.cleanup();
  },
  gitlabRemoteProject: async ({ page: _page }, provide) => {
    const client = await connectNewWorkspaceDaemonClient();
    const repo = await createTempGitRepo("projects-settings-gitlab-", {
      paseoConfig: initialPaseoConfig,
      originUrl: "https://gitlab.com/acme/app.git",
    });
    const openedProject = await openProjectViaDaemon(client, repo.path);

    await provide({
      name: openedProject.projectDisplayName,
      path: repo.path,
    });

    await client.close();
    await repo.cleanup();
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

test.describe("Projects settings", () => {
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
    expect(gitlabRemoteProject.name).toBe("acme/app");
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
    // Drop the WS connection the moment a read_project_config_request is sent.
    // Subsequent connections are proxied transparently so Reload can succeed.
    await installReadTransportFailure(page);

    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);

    await expectProjectSettingsError(page, "transport");
    await expectProjectSettingsFormHidden(page);

    // The client reconnects after a ~1.5 s backoff; retry Reload until refetch succeeds.
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
