import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import {
  expectSettingsHeader,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

async function openMetadataGenerationSettings(page: Page) {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "metadata");
  await expectSettingsHeader(page, "Metadata");
}

async function openManualMetadataModelPicker(page: Page) {
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  await page.getByRole("button", { name: /Select model/ }).click();
}

test("chooses a metadata model and can return to automatic selection", async ({
  page,
}, testInfo) => {
  await openMetadataGenerationSettings(page);

  // The section explains itself through the header's info tooltip, not a paragraph.
  await expect(page.getByTestId("metadata-generation-settings-info")).toHaveAccessibleName(
    "About Metadata generation",
  );
  await expect(page.getByRole("button", { name: "Automatic", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.screenshot({
    path: testInfo.outputPath("metadata-automatic.png"),
    fullPage: true,
  });

  await openManualMetadataModelPicker(page);
  await page.getByText("Mock Load Test", { exact: true }).click();
  await expect(page.getByText("Ten second stream", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("metadata-model-picker.png"),
    fullPage: true,
  });
  await page.getByText("Ten second stream", { exact: true }).click();

  await expect(page.getByRole("button", { name: /Ten second stream/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: /Ten second stream/ })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("metadata-manual-persisted.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await page.reload();

  await expect(page.getByRole("button", { name: "Automatic", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: /Ten second stream/ })).toHaveCount(0);
});

test("replaces only the first configured metadata model", async ({ page }) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();

  try {
    await client.patchDaemonConfig({
      metadataGeneration: {
        providers: [
          { provider: "mock", model: "five-minute-stream" },
          { provider: "mock", model: "thirty-minute-stream" },
        ],
      },
    });
    await openMetadataGenerationSettings(page);

    await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await openManualMetadataModelPicker(page);
    await page.getByText("Ten second stream", { exact: true }).click();

    await expect
      .poll(async () => (await client.getDaemonConfig()).config.metadataGeneration.providers)
      .toEqual([
        { provider: "mock", model: "ten-second-stream" },
        { provider: "mock", model: "thirty-minute-stream" },
      ]);
  } finally {
    try {
      await client.patchDaemonConfig({
        metadataGeneration: {
          providers: previousConfig.config.metadataGeneration.providers,
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }
});

test("persists Simplified Chinese workspace title language without clearing metadata models", async ({
  page,
}, testInfo) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();

  try {
    await client.patchDaemonConfig({
      metadataGeneration: {
        providers: [{ provider: "mock", model: "ten-second-stream" }],
      },
    });
    await openMetadataGenerationSettings(page);

    await page.getByRole("button", { name: "Title language", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "简体中文 - Simplified Chinese", exact: true })
      .click();

    await expect
      .poll(async () => (await client.getDaemonConfig()).config.metadataGeneration)
      .toEqual({
        providers: [{ provider: "mock", model: "ten-second-stream" }],
        titleLanguage: "zh-CN",
      });
    await page.reload();
    await expect(page.getByRole("button", { name: "Title language", exact: true })).toContainText(
      "简体中文 - Simplified Chinese",
    );
    await page.screenshot({
      path: testInfo.outputPath("metadata-title-language.png"),
      fullPage: true,
    });
  } finally {
    try {
      await client.patchDaemonConfig({
        metadataGeneration: {
          providers: previousConfig.config.metadataGeneration.providers,
          titleLanguage: previousConfig.config.metadataGeneration.titleLanguage,
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }
});
