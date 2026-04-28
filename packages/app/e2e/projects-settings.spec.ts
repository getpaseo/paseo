import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Page } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { connectNewWorkspaceDaemonClient, openProjectViaDaemon } from "./helpers/new-workspace";
import { createTempGitRepo } from "./helpers/workspace";

const updatedSetup = ["npm install", "npm run build"];

interface ProjectsSettingsProject {
  name: string;
  path: string;
}

interface ProjectsSettingsFixtures {
  editableProject: ProjectsSettingsProject;
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
    await repo.cleanup();
  },
});

async function openProjects(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await page.getByTestId("settings-projects").click();
  await expect(page).toHaveURL(/\/settings\/projects$/);
}

async function openProjectSettings(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Edit ${projectName}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toBeVisible({
    timeout: 30_000,
  });
}

async function editWorktreeSetup(page: Page, setupCommands: string[]): Promise<void> {
  await page
    .getByRole("textbox", { name: "Worktree setup commands" })
    .fill(setupCommands.join("\n"));
}

async function saveProjectConfig(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save project config" }).click();
}

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
    await saveProjectConfig(page);
    await expectProjectConfigSaved(editableProject);
  });
});
