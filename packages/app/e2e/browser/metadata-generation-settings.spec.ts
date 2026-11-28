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
  await openHostSection(page, serverId, "workspaces");
  await expectSettingsHeader(page, "Workspaces");
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

test("saves and clears host-wide metadata instructions without overwriting providers", async ({
  page,
}, testInfo) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();

  try {
    await client.patchDaemonConfig({
      metadataGeneration: {
        providers: [{ provider: "mock", model: "ten-second-stream" }],
        instructions: "",
      },
    });
    await openMetadataGenerationSettings(page);

    const instructionsRow = page.getByTestId("metadata-generation-instructions-row");
    await expect(instructionsRow).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("metadata-instructions-tucked-empty.png"),
      fullPage: true,
    });

    await instructionsRow.click();

    const instructionsSheet = page.getByTestId("metadata-generation-instructions-sheet");
    const instructionsInput = page.getByTestId("metadata-generation-instructions-input");
    const saveButton = page.getByTestId("metadata-generation-instructions-save");

    await expect(instructionsSheet).toBeVisible();
    await expect(saveButton).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath("metadata-instructions-sheet-empty.png"),
      fullPage: true,
      animations: "disabled",
    });

    await instructionsInput.fill("Write in Simplified Chinese. Do not use em dashes.");
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(instructionsSheet).toHaveCount(0);
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.metadataGeneration)
      .toEqual({
        providers: [{ provider: "mock", model: "ten-second-stream" }],
        instructions: "Write in Simplified Chinese. Do not use em dashes.",
      });

    await page.reload();
    await expect(
      page
        .getByTestId("metadata-generation-instructions-row")
        .getByText("Write in Simplified Chinese. Do not use em dashes."),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("metadata-instructions-tucked-saved.png"),
      fullPage: true,
    });

    // Verify compact layout keeps the tucked row and bottom sheet clean.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("metadata-generation-instructions-row")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("metadata-instructions-compact-row.png"),
      fullPage: true,
    });
    await page.getByTestId("metadata-generation-instructions-row").click();
    await expect(page.getByTestId("metadata-generation-instructions-input")).toHaveValue(
      "Write in Simplified Chinese. Do not use em dashes.",
    );
    await page.screenshot({
      path: testInfo.outputPath("metadata-instructions-compact-sheet.png"),
      fullPage: true,
    });

    await page.getByTestId("metadata-generation-instructions-input").fill("");
    await expect(page.getByTestId("metadata-generation-instructions-save")).toBeEnabled();
    await page.getByTestId("metadata-generation-instructions-save").click();

    await expect(page.getByTestId("metadata-generation-instructions-sheet")).toHaveCount(0);
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.metadataGeneration)
      .toEqual({
        providers: [{ provider: "mock", model: "ten-second-stream" }],
      });
  } finally {
    try {
      await client.patchDaemonConfig({
        metadataGeneration: {
          providers: previousConfig.config.metadataGeneration.providers,
          instructions: previousConfig.config.metadataGeneration.instructions ?? "",
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }
});
