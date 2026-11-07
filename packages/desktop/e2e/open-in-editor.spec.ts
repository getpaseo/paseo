import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { expandFolder, openFileExplorer } from "../../app/e2e/support/helpers/file-explorer";
import {
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  archiveWorkspaceFromDaemon,
} from "../../app/e2e/support/helpers/new-workspace";
import type { WithWorkspace } from "../../app/e2e/support/helpers/with-workspace";
import { selectWorkspaceInSidebar } from "../../app/e2e/support/helpers/sidebar";
import { installDesktopRuntime } from "./support/runtime";
import { clickSettingsBackToWorkspace } from "../../app/e2e/support/helpers/settings";

interface EditorOpenRecord {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

function requireE2EEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

async function readEditorOpenRecords(recordPath: string): Promise<EditorOpenRecord[]> {
  try {
    const contents = await readFile(recordPath, "utf8");
    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EditorOpenRecord);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function selectEditorTarget(page: Page, targetId: string): Promise<void> {
  await expect(page.getByRole("button", { name: /^Open workspace in / })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Choose editor", exact: true }).click();
  await expect(page.getByTestId("workspace-open-in-editor-menu")).toBeVisible();
  await page.getByTestId(`workspace-open-in-editor-item-${targetId}`).click();
}

async function expectPreferredEditor(page: Page, label: string): Promise<void> {
  await expect(
    page.getByRole("button", { name: `Open workspace in ${label}`, exact: true }),
  ).toBeVisible();
}

async function expectEditorOpened(input: {
  recordPath: string;
  editorId: string;
  path: string;
  afterCount: number;
}): Promise<void> {
  await expect
    .poll(
      async () => {
        const records = await readEditorOpenRecords(input.recordPath);
        return records
          .slice(input.afterCount)
          .some(
            (record) => record.editorId === input.editorId && record.workspacePath === input.path,
          );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function createEditorPreferenceFixture(page: Page, withWorkspace: WithWorkspace) {
  const serverId = requireE2EEnv("E2E_SERVER_ID");
  await installDesktopRuntime(page, {
    serverId,
    editorTargets: [
      {
        id: "cursor",
        label: "Cursor",
        kind: "editor",
        icon: { kind: "symbol", name: "terminal" },
      },
      {
        id: "vscode",
        label: "VS Code",
        kind: "editor",
        icon: { kind: "symbol", name: "terminal" },
      },
    ],
  });
  const projectA = await withWorkspace({ prefix: "editor-project-a-" });
  const projectB = await withWorkspace({ prefix: "editor-project-b-" });
  const client = await connectNewWorkspaceDaemonClient();
  const worktree = await createWorktreeViaDaemon(client, {
    cwd: projectA.repoPath,
    slug: "editor-preference-sibling",
  });
  return {
    projectA,
    projectB,
    worktree,
    async close() {
      try {
        await archiveWorkspaceFromDaemon(client, worktree.workspaceDirectory);
      } finally {
        await client.close();
      }
    },
  };
}

test.describe("Workspace open in editor", () => {
  test("keeps editor choices per project across switching, reload and worktrees", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const fixture = await createEditorPreferenceFixture(page, withWorkspace);
    const { projectA, projectB, worktree } = fixture;
    try {
      await projectA.navigateTo();
      await selectEditorTarget(page, "vscode");
      await expectPreferredEditor(page, "VS Code");
      await projectB.navigateTo();
      await expectPreferredEditor(page, "Cursor");
      await selectEditorTarget(page, "cursor");
      await projectA.navigateTo();
      await expectPreferredEditor(page, "VS Code");
      await selectWorkspaceInSidebar(page, worktree.workspaceId);
      await expectPreferredEditor(page, "VS Code");
      await selectEditorTarget(page, "cursor");
      await projectA.navigateTo();
      await expectPreferredEditor(page, "Cursor");
      await selectEditorTarget(page, "vscode");
      await page.reload();
      await expectPreferredEditor(page, "VS Code");
      await projectB.navigateTo();
      await expectPreferredEditor(page, "Cursor");
      await page.reload();
      await expectPreferredEditor(page, "Cursor");
      await projectA.navigateTo();
      await expectPreferredEditor(page, "VS Code");
    } finally {
      await fixture.close();
    }
  });

  test("opens a nested folder in the preferred editor", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);

    const serverId = requireE2EEnv("E2E_SERVER_ID");
    const recordPath = requireE2EEnv("E2E_EDITOR_RECORD_PATH");
    await rm(recordPath, { force: true });
    await installDesktopRuntime(page, {
      serverId,
      editorTargets: [
        {
          id: "android-studio",
          label: "Android Studio",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      editorRecordPath: recordPath,
    });

    const workspace = await withWorkspace({ prefix: "workspace-nested-editor-target-" });
    const childFolderName = "sample-android-app";
    const childFolderPath = path.join(workspace.repoPath, "repos", childFolderName);
    await mkdir(childFolderPath, { recursive: true });
    await workspace.navigateTo();

    await openFileExplorer(page);
    await expandFolder(page, "repos");
    await page.getByText(childFolderName, { exact: true }).click({ button: "right" });
    const openInEditor = page.getByTestId(/file-explorer-row-\d+-open-in-editor$/);
    await expect(openInEditor).toBeVisible({ timeout: 5_000 });
    await openInEditor.click();

    await expectEditorOpened({
      recordPath,
      editorId: "android-studio",
      path: childFolderPath,
      afterCount: 0,
    });
  });

  test("selects an editor without opening it", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);

    const serverId = requireE2EEnv("E2E_SERVER_ID");
    const recordPath = requireE2EEnv("E2E_EDITOR_RECORD_PATH");
    await rm(recordPath, { force: true });
    await installDesktopRuntime(page, {
      serverId,
      editorTargets: [
        {
          id: "cursor",
          label: "Cursor",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
        {
          id: "zed",
          label: "Zed",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      editorRecordPath: recordPath,
    });

    const workspace = await withWorkspace({ prefix: "workspace-editor-selection-" });
    await workspace.navigateTo();

    await selectEditorTarget(page, "zed");
    const primaryButton = page.getByTestId("workspace-open-in-editor-primary");
    await expect(primaryButton).toHaveAccessibleName("Open workspace in Zed");
    await expect(primaryButton).toBeEnabled();
    expect(await readEditorOpenRecords(recordPath)).toEqual([]);

    await primaryButton.click();
    await expectEditorOpened({
      recordPath,
      editorId: "zed",
      path: workspace.repoPath,
      afterCount: 0,
    });
  });

  test("keeps the selected editor target after leaving and returning to the workspace", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(90_000);

    const serverId = requireE2EEnv("E2E_SERVER_ID");
    const recordPath = requireE2EEnv("E2E_EDITOR_RECORD_PATH");
    await rm(recordPath, { force: true });
    await installDesktopRuntime(page, {
      serverId,
      editorTargets: [
        {
          id: "cursor",
          label: "Cursor",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
        {
          id: "vscode",
          label: "VS Code",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      editorRecordPath: recordPath,
    });

    const workspace = await withWorkspace({ prefix: "workspace-editor-target-" });
    await workspace.navigateTo();

    await selectEditorTarget(page, "vscode");
    await page.getByTestId("workspace-open-in-editor-primary").click();
    await expectEditorOpened({
      recordPath,
      editorId: "vscode",
      path: workspace.repoPath,
      afterCount: 0,
    });
    const recordsAfterSelection = (await readEditorOpenRecords(recordPath)).length;

    await openSettings(page);
    await clickSettingsBackToWorkspace(page);
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

    await page.getByTestId("workspace-open-in-editor-primary").click();
    await expectEditorOpened({
      recordPath,
      editorId: "vscode",
      path: workspace.repoPath,
      afterCount: recordsAfterSelection,
    });
    const recordsAfterReturnOpen = (await readEditorOpenRecords(recordPath)).length;

    await gotoAppShell(page);
    await workspace.navigateTo();
    await page.getByTestId("workspace-open-in-editor-primary").click();
    await expectEditorOpened({
      recordPath,
      editorId: "vscode",
      path: workspace.repoPath,
      afterCount: recordsAfterReturnOpen,
    });
  });
});
