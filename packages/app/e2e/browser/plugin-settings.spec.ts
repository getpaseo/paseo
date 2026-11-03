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
  expectNoSettingsCogWithoutScreens,
  openTabbedSettings,
  selectSettingsTab,
  openTabbedSettingsLink,
  expectSettingsTooltip,
  expectNamedPluginRow,
} from "../support/helpers/plugin-settings";

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

test("plugin settings open from the cog and show a tab per screen", async ({ page }) => {
  await openPluginsPage(page);
  await test.step("plugin rows show the display name", async () => {
    await expectNamedPluginRow(page);
  });
  await test.step("the cog explains itself", async () => {
    await expectSettingsTooltip(page);
  });
  await test.step("the actions menu keeps only plugin actions", async () => {
    await expectActionsMenuWithoutSettings(page);
  });
  await test.step("tabs switch between the plugin's settings screens", async () => {
    await openTabbedSettings(page);
    await selectSettingsTab(page, "Advanced");
    await selectSettingsTab(page, "General");
    await returnToPluginsPage(page);
  });
  await test.step("a plugin without settings screens shows no cog", async () => {
    await expectNoSettingsCogWithoutScreens(page);
  });
});

test("a settings screen link opens its tab", async ({ page }) => {
  await openTabbedSettingsLink(page, "Advanced");
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
