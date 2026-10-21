import {
  test,
  openDisplaySettings,
  openCompactDisplaySettings,
  groupByWorkspace,
  hideMetadata,
  reloadSavedDisplaySettings,
  editTitle,
  replaceTitle,
  saveTitle,
  expectTitleRequired,
  expectSavedTitle,
  changeMetadataFromAnotherClient,
  expectConflictPreservesDraft,
  discardTitle,
  returnAndReopenSettings,
  returnToPluginsPage,
  expectSettingsUnavailable,
} from "../support/helpers/plugin-settings";
import { test as serialTest, expect } from "../support/fixtures";
import {
  installBrowserSerial,
  openBrowserSerial,
  startSerialAgentTool,
} from "../support/helpers/browser-serial";

serialTest(
  "browser serial loads its production adapter without opening a device",
  async ({ page }, testInfo) => {
    const plugin = await installBrowserSerial("browser");
    try {
      await openBrowserSerial(page);
      await expect(page.getByText("No device selected", { exact: true })).toBeVisible();
      await expect(page.getByText(/^Host TCP:/)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("serial-idle.png") });
    } finally {
      await plugin.cleanup();
    }
  },
);

for (const viewport of [
  { name: "wide", width: 1440, height: 1000 },
  { name: "compact", width: 390, height: 844 },
]) {
  serialTest.describe(`browser serial ${viewport.name}`, () => {
    // Changing layout shells remounts settings and intentionally ends sessions.
    // Exercise each shell from the start rather than resizing an active session.
    serialTest.use({ viewport: { width: viewport.width, height: viewport.height } });
    serialTest(
      "browser serial forwards a synthetic USB port to a real host tool and disconnects",
      async ({ page }, testInfo) => {
        const plugin = await installBrowserSerial("echo");
        let tool: Awaited<ReturnType<typeof startSerialAgentTool>> | undefined;
        try {
          await page.emulateMedia({ colorScheme: "dark" });
          await openBrowserSerial(page, viewport.name === "compact");
          await page
            .getByRole("button", { name: "Choose and forward device", exact: true })
            .click();
          await expect(page.getByText(/^Host TCP: 127\.0\.0\.1:/)).toBeVisible();
          tool = await startSerialAgentTool(page);
          await expect(
            page.getByText("Host tool connected. Binary data flows in both directions."),
          ).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath("serial-dark.png") });
          await page.getByRole("button", { name: "Disconnect", exact: true }).click();
          await tool.expectDisconnected();
          await expect(page.getByText(/^Host TCP:/)).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Choose and forward device", exact: true }),
          ).toBeEnabled();
          await page.getByRole("button", { name: "Forget device", exact: true }).click();
          await expect(page.getByText("No device selected", { exact: true })).toBeVisible();
          await page.emulateMedia({ colorScheme: "light" });
          await page.screenshot({ path: testInfo.outputPath("serial-light.png") });
        } finally {
          await tool?.cleanup();
          await plugin.cleanup();
        }
      },
    );
  });
}

serialTest(
  "browser serial closes the host tool when its settings screen unmounts",
  async ({ page }) => {
    const plugin = await installBrowserSerial("echo");
    let tool: Awaited<ReturnType<typeof startSerialAgentTool>> | undefined;
    try {
      await openBrowserSerial(page);
      await page.getByRole("button", { name: "Choose and forward device", exact: true }).click();
      tool = await startSerialAgentTool(page);
      await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
      await tool.expectDisconnected();
    } finally {
      await tool?.cleanup();
      await plugin.cleanup();
    }
  },
);

serialTest(
  "browser serial releases the host tool when the plugin is disabled",
  async ({ page }) => {
    const plugin = await installBrowserSerial("echo");
    let tool: Awaited<ReturnType<typeof startSerialAgentTool>> | undefined;
    try {
      await openBrowserSerial(page);
      await page.getByRole("button", { name: "Choose and forward device", exact: true }).click();
      tool = await startSerialAgentTool(page);
      await plugin.disable();
      await tool.expectDisconnected();
      await expectSettingsUnavailable(page);
    } finally {
      await tool?.cleanup();
      await plugin.cleanup();
    }
  },
);

for (const failure of [
  { hardware: "cancel", message: "No port selected." },
  { hardware: "open-failure", message: "The serial device is already in use." },
] as const) {
  serialTest(`browser serial shows ${failure.hardware} and allows retry`, async ({ page }) => {
    const plugin = await installBrowserSerial(failure.hardware);
    try {
      await openBrowserSerial(page);
      const choose = page.getByRole("button", { name: "Choose and forward device", exact: true });
      await choose.click();
      await expect(page.getByText(failure.message, { exact: true })).toBeVisible();
      await expect(page.getByText(/^Host TCP:/)).toHaveCount(0);
      await expect(choose).toBeEnabled();
      await choose.click();
      await expect(page.getByText(failure.message, { exact: true })).toBeVisible();
      await expect(choose).toBeEnabled();
    } finally {
      await plugin.cleanup();
    }
  });
}

test("display preferences survive a reload", async ({ page }) => {
  await openDisplaySettings(page);
  await groupByWorkspace(page);
  await hideMetadata(page);
  await reloadSavedDisplaySettings(page);
});

test("invalid titles stay editable until a valid title is saved", async ({ page }) => {
  await openDisplaySettings(page);
  await editTitle(page, "");
  await saveTitle(page);
  await expectTitleRequired(page);
  await replaceTitle(page, "My monitor");
  await saveTitle(page);
  await expectSavedTitle(page, "My monitor");
});

test("another client's save preserves a conflicting draft", async ({ page }) => {
  await openDisplaySettings(page);
  await editTitle(page, "Unsaved title");
  await changeMetadataFromAnotherClient(page);
  await saveTitle(page);
  await expectConflictPreservesDraft(page, "Unsaved title");
  await discardTitle(page);
});

test("Back to plugins returns from a plugin settings screen", async ({ page }) => {
  await openDisplaySettings(page);
  await returnToPluginsPage(page);
});

test.describe("compact plugin settings", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Back and plugin re-enable restore the settings screen", async ({
    page,
    settingsPlugin,
  }) => {
    await openCompactDisplaySettings(page);
    await groupByWorkspace(page);
    await hideMetadata(page);
    await returnAndReopenSettings(page);
    await settingsPlugin.disablePlugin("settings-example");
    await expectSettingsUnavailable(page);
    await settingsPlugin.enablePlugin("settings-example");
    await reloadSavedDisplaySettings(page);
  });
});
