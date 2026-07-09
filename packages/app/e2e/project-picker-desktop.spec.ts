import { test, expect } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { injectDesktopBridge, waitForDirectoryDialog } from "./helpers/desktop-updates";
import {
  getProjectPickerFixture,
  removeProjectPickerFixture,
} from "./helpers/project-picker-fixture";
import { connectSeedClient, type SeedDaemonClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

test.skip(process.env.E2E_DESKTOP_RUNTIME !== "1", "requires Metro's Electron platform overlay");

test("Browse opens the folder selected by the desktop dialog", async ({ page }) => {
  const fixture = getProjectPickerFixture();
  let client: SeedDaemonClient | null = null;
  let projectId: string | null = null;

  try {
    client = await connectSeedClient();
    await injectDesktopBridge(page, {
      serverId: getServerId(),
      manageBuiltInDaemon: false,
      dialogOpenResult: fixture.projectPath,
    });
    await gotoAppShell(page);

    await page.getByTestId("sidebar-add-project").click();
    const browse = page.getByRole("button", { name: "Browse…" });
    await expect(browse).toBeVisible({ timeout: 30_000 });
    await browse.click();

    const projectRow = page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: fixture.projectName })
      .first();
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    const testId = await projectRow.getAttribute("data-testid");
    if (!testId) {
      throw new Error("Opened project row is missing its data-testid");
    }
    projectId = testId.replace("sidebar-project-row-", "");
  } finally {
    if (client) {
      try {
        await removeProjectPickerFixture(client, fixture, projectId);
      } finally {
        await client.close();
      }
    }
  }
});

test("Browse owns Enter without opening the active typed path", async ({ page }) => {
  const fixture = getProjectPickerFixture();

  let client: SeedDaemonClient | null = null;
  try {
    client = await connectSeedClient();
    await injectDesktopBridge(page, {
      serverId: getServerId(),
      manageBuiltInDaemon: false,
      dialogOpenResult: null,
    });
    await gotoAppShell(page);

    await page.getByTestId("sidebar-add-project").click();
    const input = page.getByPlaceholder("Type a directory path...");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(fixture.projectPath);

    const browse = page.getByRole("button", { name: "Browse…" });
    await expect(browse).toBeVisible({ timeout: 30_000 });
    await browse.press("Enter");

    const dialogOptions = await waitForDirectoryDialog(page);
    expect(dialogOptions).toEqual({
      directory: true,
      multiple: false,
    });
    await expect(input).toBeVisible();
    await expect(
      page
        .locator('[data-testid^="sidebar-project-row-"]')
        .filter({ hasText: fixture.projectName }),
    ).toHaveCount(0);
  } finally {
    if (client) {
      try {
        await removeProjectPickerFixture(client, fixture);
      } finally {
        await client.close();
      }
    }
  }
});
