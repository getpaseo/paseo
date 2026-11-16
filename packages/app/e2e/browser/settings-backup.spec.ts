import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { expectSettingsHeader, openSettingsSection } from "../support/helpers/settings";

async function openBackupSettings(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "backup");
  await expectSettingsHeader(page, "Backup");
}

test("exports this device and its host, then restores the host's settings from the file", async ({
  page,
}, testInfo) => {
  const serverId = getServerId();
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = (await client.getDaemonConfig()).config.appendSystemPrompt ?? "";

  try {
    await client.patchDaemonConfig({ appendSystemPrompt: "Written before the export." });
    await openBackupSettings(page);
    await expect(page.getByTestId(`backup-export-host-${serverId}`)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.screenshot({ path: testInfo.outputPath("backup-section.png"), fullPage: true });

    const download = page.waitForEvent("download");
    await page.getByTestId("backup-export-action").getByRole("button").click();
    const file = await download;
    const contents = await readFile(await file.path(), "utf8");
    const backup = JSON.parse(contents);
    expect(backup).toMatchObject({ format: "paseo-backup", version: 1 });
    expect(backup.hosts).toEqual([
      expect.objectContaining({
        serverId,
        document: expect.objectContaining({
          config: expect.objectContaining({
            agentBehavior: expect.objectContaining({
              appendSystemPrompt: "Written before the export.",
            }),
          }),
        }),
      }),
    ]);
    expect(contents).not.toContain('"password"');
    await expect(page.getByTestId("backup-export-feedback")).toHaveText(
      `Saved ${file.suggestedFilename()}`,
    );

    await client.patchDaemonConfig({ appendSystemPrompt: "Changed after the export." });

    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("backup-import-action").getByRole("button").click();
    await (
      await chooser
    ).setFiles({
      name: file.suggestedFilename(),
      mimeType: "application/json",
      buffer: Buffer.from(contents),
    });

    const sheet = page.getByTestId("backup-import-sheet");
    await expect(sheet).toBeVisible();
    const behavior = sheet.getByTestId("backup-import-section-agentBehavior");
    await expect(behavior).toHaveAttribute("aria-checked", "true");
    await expect(behavior).toContainText("Replaces appendSystemPrompt");
    await page.screenshot({ path: testInfo.outputPath("backup-import-preview.png") });

    await sheet.getByTestId("backup-import-apply").click();
    const results = sheet.getByTestId("backup-import-results");
    await expect(results).toContainText("Agent behavior");
    await expect(results).toContainText("Applied");
    await page.screenshot({ path: testInfo.outputPath("backup-import-results.png") });

    await expect
      .poll(async () => (await client.getDaemonConfig()).config.appendSystemPrompt)
      .toBe("Written before the export.");
    await sheet.getByTestId("backup-import-done").click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await client.patchDaemonConfig({ appendSystemPrompt: previous });
    await client.close().catch(() => undefined);
  }
});

test("keeps the results open when the import changes the theme", async ({ page }, testInfo) => {
  await openBackupSettings(page);

  const download = page.waitForEvent("download");
  await page.getByTestId("backup-export-action").getByRole("button").click();
  const file = await download;
  const backup = JSON.parse(await readFile(await file.path(), "utf8"));
  // A theme change remounts every screen below the appearance boundary, the Backup screen included.
  backup.device.appSettings.theme = "midnight";
  delete backup.device.hosts;
  backup.hosts = [];

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("backup-import-action").getByRole("button").click();
  await (
    await chooser
  ).setFiles({
    name: "theme-change.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  const sheet = page.getByTestId("backup-import-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("backup-import-apply").click();

  const results = sheet.getByTestId("backup-import-results");
  await expect(results).toContainText("Appearance and app preferences");
  await expect(results).toContainText("Applied");
  await page.screenshot({ path: testInfo.outputPath("backup-import-theme-results.png") });

  await sheet.getByTestId("backup-import-done").click();
  await expect(sheet).toHaveCount(0);
});

test("keeps unticked parts when the system switches between light and dark", async ({ page }) => {
  // The default theme follows the system, and a colour change remounts every screen.
  await page.emulateMedia({ colorScheme: "light" });
  await openBackupSettings(page);

  const download = page.waitForEvent("download");
  await page.getByTestId("backup-export-action").getByRole("button").click();
  const file = await download;

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("backup-import-action").getByRole("button").click();
  await (await chooser).setFiles(await file.path());

  const sheet = page.getByTestId("backup-import-sheet");
  const appearance = sheet.getByTestId("backup-import-device-appSettings");
  await expect(appearance).toHaveAttribute("aria-checked", "true");
  await appearance.click();
  await expect(appearance).toHaveAttribute("aria-checked", "false");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(sheet.getByTestId("backup-import-device-appSettings")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.screenshot({ path: test.info().outputPath("backup-import-after-dark.png") });
});

test("keeps an unreadable file's error visible and opens nothing", async ({ page }) => {
  await openBackupSettings(page);

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("backup-import-action").getByRole("button").click();
  await (
    await chooser
  ).setFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "paseo-host-config", version: 1 })),
  });

  await expect(page.getByTestId("backup-import-feedback")).toHaveText(
    'This file is not a Paseo backup (format "paseo-backup").',
  );
  await expect(page.getByTestId("backup-import-sheet")).toHaveCount(0);
});
