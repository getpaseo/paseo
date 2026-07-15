import { test, expect } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { injectDesktopBridge, waitForDirectoryDialog } from "./helpers/desktop-updates";
import { expectOpenedProject } from "./helpers/project-picker-ui";
import { getServerId } from "./helpers/server-id";

test.skip(process.env.E2E_DESKTOP_RUNTIME !== "1", "requires Metro's Electron platform overlay");

test("Browse opens the folder selected by the desktop dialog", async ({
  page,
  projectPickerFixture,
}) => {
  await injectDesktopBridge(page, {
    serverId: getServerId(),
    manageBuiltInDaemon: false,
    dialogOpenResult: projectPickerFixture.projectPath,
  });
  await gotoAppShell(page);

  await page.getByTestId("sidebar-add-project").click();
  const browse = page.getByRole("button", { name: /^Browse/ });
  await expect(browse).toBeVisible({ timeout: 30_000 });
  await browse.click();

  const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
  projectPickerFixture.rememberProjectId(projectId);
});

test("canceling Browse returns to the Add Project methods", async ({
  page,
  projectPickerFixture,
}) => {
  await injectDesktopBridge(page, {
    serverId: getServerId(),
    manageBuiltInDaemon: false,
    dialogOpenResult: null,
  });
  await gotoAppShell(page);

  await page.getByTestId("sidebar-add-project").click();
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
