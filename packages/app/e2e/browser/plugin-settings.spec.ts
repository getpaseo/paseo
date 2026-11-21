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
  openPluginsPage,
  expectActionsMenuWithoutSettings,
  expectSettingsFollowPluginSwitch,
  expectSettingsHidden,
  expectSettingsTab,
  openTabbedSettings,
  selectSettingsTab,
  openTabbedSettingsLink,
  expectNamedPluginRow,
} from "../support/helpers/plugin-settings";
import { test as serialTest, expect } from "../support/fixtures";
import {
  installBrowserSerial,
  openBrowserSerial,
  openBrowserSerialFromSidebar,
  startSerialAgentTool,
} from "../support/helpers/browser-serial";

serialTest(
  "browser serial loads its production adapter without opening a device",
  async ({ page }, testInfo) => {
    const plugin = await installBrowserSerial("browser");
    try {
      await openBrowserSerialFromSidebar(page);
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
    serialTest.use({ viewport: { width: viewport.width, height: viewport.height } });
    serialTest(
      "browser serial hands the same device and endpoint between host tools",
      async ({ page }, testInfo) => {
        const plugin = await installBrowserSerial("echo");
        let tool: Awaited<ReturnType<typeof startSerialAgentTool>> | undefined;
        const tools: Awaited<ReturnType<typeof startSerialAgentTool>>[] = [];
        try {
          await page.emulateMedia({ colorScheme: "dark" });
          await openBrowserSerialFromSidebar(page, viewport.name === "compact");
          await page
            .getByRole("button", { name: "Choose and forward device", exact: true })
            .click();
          await expect(page.getByText(/^Host TCP: 127\.0\.0\.1:/)).toBeVisible();
          tool = await startSerialAgentTool(page);
          tools.push(tool);
          await expect(
            page.getByText("Host tool connected. Binary data flows in both directions."),
          ).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath("serial-dark.png") });
          const endpoint = await page.getByText(/^Host TCP:/).textContent();
          if (!endpoint) throw new Error("Missing serial TCP endpoint");
          await tool.release();
          await tool.expectDisconnected();
          await expect(
            page.getByText("Waiting for an agent tool to connect to this TCP endpoint."),
          ).toBeVisible();
          await expect(page.getByText(endpoint, { exact: true })).toBeVisible();
          tool = await startSerialAgentTool(page, endpoint, false);
          tools.push(tool);
          await expect(
            page.getByText("Host tool connected. Binary data flows in both directions."),
          ).toBeVisible();
          await page.getByRole("button", { name: "Release host tool", exact: true }).click();
          await tool.expectDisconnected();
          await expect(
            page.getByText("Waiting for an agent tool to connect to this TCP endpoint."),
          ).toBeVisible();
          await expect(page.getByText(endpoint, { exact: true })).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath("handoff-waiting.png") });
          tool = await startSerialAgentTool(page, endpoint, false);
          tools.push(tool);
          await expect(
            page.getByText("Host tool connected. Binary data flows in both directions."),
          ).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath("handoff-connected.png") });
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
          for (const owned of tools) await owned.cleanup();
          await plugin.cleanup();
        }
      },
    );
  });
}

serialTest(
  "browser serial keeps the device usable after a host release failure",
  async ({ page }, testInfo) => {
    const plugin = await installBrowserSerial("echo", true);
    let tool: Awaited<ReturnType<typeof startSerialAgentTool>> | undefined;
    try {
      await openBrowserSerial(page);
      await page.getByRole("button", { name: "Choose and forward device", exact: true }).click();
      tool = await startSerialAgentTool(page);
      await expect(
        page.getByText("Host tool connected. Binary data flows in both directions."),
      ).toBeVisible();
      const release = page.getByRole("button", { name: "Release host tool", exact: true });
      await release.click();
      await expect(page.getByText(/Host tool release failed\./)).toBeVisible();
      await expect(release).toBeEnabled();
      await expect(page.getByText(/^Host TCP:/)).toBeVisible();
      await expect(
        page.getByText("Host tool connected. Binary data flows in both directions."),
      ).toBeVisible();
      await release.click();
      await expect(page.getByText(/Host tool release failed\./)).toBeVisible();
      await expect(release).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath("handoff-release-error.png") });
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await tool.expectDisconnected();
    } finally {
      await tool?.cleanup();
      await plugin.cleanup();
    }
  },
);

serialTest(
  "browser serial keeps forwarding while away and restores its session on return",
  async ({ page }, testInfo) => {
    const plugin = await installBrowserSerial("echo");
    let tool: Awaited<ReturnType<typeof startSerialAgentTool>> | undefined;
    try {
      await openBrowserSerial(page);
      await page.getByRole("button", { name: "Baud rate: 115200", exact: true }).click();
      await page.getByRole("menuitem", { name: "9600", exact: true }).click();
      await page.getByRole("button", { name: "Choose and forward device", exact: true }).click();
      const endpoint = await page.getByText(/^Host TCP: 127\.0\.0\.1:/).textContent();
      if (!endpoint) throw new Error("Missing serial TCP endpoint");
      await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
      await page.getByTestId("settings-back-to-workspace").click();
      await expect(page.getByRole("button", { name: "USB serial", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("serial-sidebar.png") });
      // Connect and transfer bytes while the device screen is unmounted.
      tool = await startSerialAgentTool(page, endpoint);
      await page.getByRole("button", { name: "USB serial", exact: true }).click();
      await expect(page.getByText(endpoint, { exact: true })).toBeVisible();
      await expect(page.getByText("USB 1209:0001", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Baud rate: 9600", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByText("Host tool connected. Binary data flows in both directions."),
      ).toBeVisible();
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.getByText(endpoint, { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByText(endpoint, { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(page.getByText(endpoint, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("serial-return.png") });
      await page.reload();
      await tool.expectDisconnected();
      await expect(page.getByText(/^Host TCP:/)).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Choose and forward device", exact: true }),
      ).toBeEnabled();
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

test("Back to plugins returns from a plugin page", async ({ page }) => {
  await openDisplaySettings(page);
  await returnToPluginsPage(page);
});

test("plugin pages open from their row and show a tab per settings screen", async ({ page }) => {
  await openPluginsPage(page);
  await test.step("plugin rows show the display name", async () => {
    await expectNamedPluginRow(page);
  });
  await test.step("the row opens the plugin's page", async () => {
    await openTabbedSettings(page);
  });
  await test.step("the page's menu keeps only plugin actions", async () => {
    await expectActionsMenuWithoutSettings(page);
  });
  await test.step("tabs switch between the plugin's settings screens", async () => {
    await selectSettingsTab(page, "Advanced");
    await selectSettingsTab(page, "General");
    await returnToPluginsPage(page);
  });
  await test.step("turning a plugin off removes its settings from its page", async () => {
    await expectSettingsFollowPluginSwitch(page);
  });
});

test("a settings screen link opens its tab, unavailable while the plugin is off", async ({
  page,
  settingsPlugin,
}) => {
  await openTabbedSettingsLink(page, "Advanced");
  await settingsPlugin.disablePlugin("settings-tabs");
  await expectSettingsUnavailable(page);
  await settingsPlugin.enablePlugin("settings-tabs");
  await expectSettingsTab(page, "Advanced");
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
    await expectSettingsHidden(page);
    await settingsPlugin.enablePlugin("settings-example");
    await reloadSavedDisplaySettings(page);
  });
});
