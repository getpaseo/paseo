import { test, expect } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import {
  expectNewWorkspaceForAddedProject,
  openAddProjectFlow,
} from "../../app/e2e/support/helpers/add-project-flow";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { waitForConnectedHost } from "../../app/e2e/support/helpers/hosts";
import { expectOpenedProject } from "../../app/e2e/support/helpers/project-picker-ui";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { connectSeedClient } from "../../app/e2e/support/helpers/seed-client";
import { installDesktopRuntime, waitForDirectoryDialog } from "./support/runtime";

test("CLI project launch opens a workspace after cold startup", async ({
  page,
  projectPickerFixture,
  e2eWorkerClient,
}) => {
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    pendingOpenProjectPath: projectPickerFixture.projectPath,
  });
  await gotoAppShell(page);
  await expect(page).toHaveURL(/\/workspace\//u, { timeout: 30_000 });
  const workspaces = (await e2eWorkerClient.fetchWorkspaces()).entries.filter(
    (workspace) => workspace.workspaceDirectory === projectPickerFixture.projectPath,
  );
  expect(workspaces).toHaveLength(1);
  const workspace = workspaces[0];
  projectPickerFixture.rememberProjectId(workspace.projectId);
  const workspaceUrl = new RegExp(`/workspace/${workspace.id}(?:[/?#]|$)`, "u");
  await expect(page).toHaveURL(workspaceUrl);
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.id}`);
  await expect(row).toBeVisible();

  // Reload models a second window receiving the same CLI path.
  await page.reload();
  await expect(page).toHaveURL(workspaceUrl, { timeout: 30_000 });
  await expect(page.getByText(`Opened ${workspace.name}`, { exact: true })).toBeVisible();
  await expect(row).toBeVisible();
  expect(
    (await e2eWorkerClient.fetchWorkspaces({ filter: { projectId: workspace.projectId } })).entries,
  ).toHaveLength(1);
});

test("CLI project launch reports a missing folder", async ({ page, projectPickerFixture }) => {
  const missingPath = `${projectPickerFixture.projectPath}/missing`;
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    pendingOpenProjectPath: missingPath,
  });
  await gotoAppShell(page);
  await expect(page.getByText(`Unable to open ${missingPath}:`, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
});

test("Browse opens the folder selected by the desktop dialog", async ({
  page,
  projectPickerFixture,
}) => {
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    manageBuiltInDaemon: false,
    dialogOpenResult: projectPickerFixture.projectPath,
  });
  await gotoAppShell(page);
  await waitForConnectedHost(page, {
    serverId: getServerId(),
    endpoint: `localhost:${getE2EDaemonPort()}`,
  });

  await openAddProjectFlow(page);
  const browse = page.getByRole("button", { name: /^Browse/ });
  await expect(browse).toBeVisible({ timeout: 30_000 });
  await browse.click();
  const dialogOptions = await waitForDirectoryDialog(page);
  expect(dialogOptions).toEqual({
    createDirectory: true,
    directory: true,
    multiple: false,
  });

  const projectId = await expectOpenedProject(page);
  projectPickerFixture.rememberProjectId(projectId);
  await expectNewWorkspaceForAddedProject(page, {
    serverId: getServerId(),
    projectId,
    projectName: projectPickerFixture.projectName,
    projectPath: projectPickerFixture.projectPath,
  });
  const client = await connectSeedClient();
  try {
    expect((await client.fetchWorkspaces({ filter: { projectId } })).entries).toEqual([]);
  } finally {
    await client.close();
  }
});

test("canceling Browse returns to the Add Project methods", async ({
  page,
  projectPickerFixture,
}) => {
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    manageBuiltInDaemon: false,
    dialogOpenResult: null,
  });
  await gotoAppShell(page);
  await waitForConnectedHost(page, {
    serverId: getServerId(),
    endpoint: `localhost:${getE2EDaemonPort()}`,
  });

  await openAddProjectFlow(page);
  const browse = page.getByRole("button", { name: /^Browse/ });
  await expect(browse).toBeVisible({ timeout: 30_000 });
  await browse.click();

  const dialogOptions = await waitForDirectoryDialog(page);
  expect(dialogOptions).toEqual({
    createDirectory: true,
    directory: true,
    multiple: false,
  });
  await expect(browse).toBeVisible();
  await expect(
    page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: projectPickerFixture.projectName }),
  ).toHaveCount(0);
});
