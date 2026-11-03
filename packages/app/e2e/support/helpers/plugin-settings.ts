import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyPluginExample, pluginRequirements } from "./plugin-fixture";
import { expect, test as base, type Page } from "../fixtures";
import { gotoAppShell, openSettings } from "./app";
import { goBackInSettings, openCompactSettings, openHostSection } from "./settings";
import { getServerId } from "./server-id";
import { expectAppRoute } from "./route-assertions";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";

type SettingsClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

const TABBED_PLUGIN_ID = "settings-tabs";
/** Two settings screens, so the settings page shows a tab per screen. */
const TABBED_SOURCE = `import React from "react";
import { Text, View } from "react-native";
import { defineTranslations, useTranslation } from "@getpaseo/plugin/client";

const messages = defineTranslations({ resources: { en: { icon: "advanced-tab-icon" } } });

function General({ theme }) {
  return <Text style={{ color: theme.colors.foreground }}>General settings body</Text>;
}

function Advanced({ theme }) {
  return <Text style={{ color: theme.colors.foreground }}>Advanced settings body</Text>;
}

// Component icons run with the plugin's runtime; one that throws costs its tab only the icon.
function TranslatedIcon({ color, size }) {
  const { t } = useTranslation(messages);
  return <View testID={t("icon")} aria-hidden style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

function BrokenIcon() {
  throw new Error("Settings tab icon exploded");
}

export default function contribute(client) {
  client.addSettingsScreen({ id: "general", title: "General", icon: BrokenIcon, Component: General });
  client.addSettingsScreen({ id: "advanced", title: "Advanced", icon: TranslatedIcon, Component: Advanced });
  return () => {};
}
`;

async function writeTabbedPlugin() {
  const directory = await mkdtemp(path.join(tmpdir(), `paseo-${TABBED_PLUGIN_ID}-`));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: TABBED_PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), TABBED_SOURCE);
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export const test = base.extend<{ settingsPlugin: SettingsClient }>({
  settingsPlugin: [
    async ({ e2eWorker, page }, provide, testInfo) => {
      void e2eWorker;
      const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
      const previous = await client.getDaemonConfig();
      const example = await copyPluginExample("settings");
      const tabbed = await writeTabbedPlugin();
      try {
        await client.patchDaemonConfig({ pluginsEnabled: true });
        await client.installDirectoryPlugin(example.directory);
        await client.installDirectoryPlugin(tabbed.directory);
        await provide(client);
        await page.screenshot({ path: testInfo.outputPath("settings.png") });
      } finally {
        await client.removePlugin("settings-example");
        await client.removePlugin(TABBED_PLUGIN_ID);
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await client.close();
        await example.cleanup();
        await tabbed.cleanup();
      }
    },
    { auto: true },
  ],
});

export async function openDisplaySettings(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openPluginScreen(page);
}
export async function openCompactDisplaySettings(page: Page) {
  await gotoAppShell(page);
  await openCompactSettings(page, new URL(page.url()).pathname);
  await openPluginScreen(page);
}
async function openPluginScreen(page: Page) {
  await openHostSection(page, getServerId(), "plugins");
  await openSettingsFromCog(page);
}
async function openSettingsFromCog(page: Page) {
  await page.getByRole("button", { name: "Settings for settings-example", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Show metadata" })).toBeVisible();
  // A plugin with one settings screen shows no tabs.
  await expect(page.getByTestId("plugin-settings-tabs")).toHaveCount(0);
}
export async function openPluginsPage(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openHostSection(page, getServerId(), "plugins");
}
export async function expectActionsMenuWithoutSettings(page: Page) {
  await page.getByRole("button", { name: "Actions for settings-example", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Reload", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Display", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
}
export async function expectNoSettingsCogWithoutScreens(page: Page) {
  await page.getByRole("switch", { name: "settings-example: Disable" }).click();
  await expect(page.getByRole("switch", { name: "settings-example: Enable" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Settings for settings-example", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("switch", { name: "settings-example: Enable" }).click();
  await expect(
    page.getByRole("button", { name: "Settings for settings-example", exact: true }),
  ).toBeVisible();
}
export async function openTabbedSettings(page: Page) {
  await page.getByRole("button", { name: `Settings for ${TABBED_PLUGIN_ID}`, exact: true }).click();
  await expectSettingsTab(page, "General");
  // The Advanced icon reads the plugin's translations; the General icon throws and is dropped.
  await expect(page.getByTestId("advanced-tab-icon")).toBeVisible();
}
function settingsTab(page: Page, title: string) {
  return page.getByTestId("plugin-settings-tabs").getByRole("button", { name: title, exact: true });
}
export async function selectSettingsTab(page: Page, title: "General" | "Advanced") {
  await settingsTab(page, title).click();
  await expectSettingsTab(page, title);
}
export async function expectSettingsTab(page: Page, title: "General" | "Advanced") {
  const other = title === "General" ? "Advanced" : "General";
  await expect(settingsTab(page, title)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(`${title} settings body`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${other} settings body`, { exact: true })).toHaveCount(0);
  await expectAppRoute(
    page,
    `${buildSettingsHostSectionRoute(getServerId(), "plugins")}/${TABBED_PLUGIN_ID}/${title.toLowerCase()}`,
  );
}
export async function openTabbedSettingsLink(page: Page, title: "General" | "Advanced") {
  await gotoAppShell(page);
  await page.goto(
    `${buildSettingsHostSectionRoute(getServerId(), "plugins")}/${TABBED_PLUGIN_ID}/${title.toLowerCase()}`,
  );
  await expectSettingsTab(page, title);
}
export async function groupByWorkspace(page: Page) {
  await page.getByRole("button", { name: /^Group agents by:/ }).click();
  await page.getByRole("menuitem", { name: "Workspace", exact: true }).click();
  await expect(page.getByText("Grouped by workspace", { exact: true })).toBeVisible();
}
export async function hideMetadata(page: Page) {
  await page.getByRole("switch", { name: "Show metadata" }).click();
  await expect(page.getByText("Metadata hidden", { exact: true })).toBeVisible();
}
export async function reloadSavedDisplaySettings(page: Page) {
  await page.reload();
  await expect(page.getByText("Grouped by workspace", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Show metadata" })).not.toBeChecked();
}
export async function editTitle(page: Page, title: string) {
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await replaceTitle(page, title);
}
export async function replaceTitle(page: Page, title: string) {
  await page.getByRole("textbox", { name: "Monitor title", exact: true }).fill(title);
}
export async function saveTitle(page: Page) {
  await page.getByRole("button", { name: "Save title", exact: true }).click();
}
export async function expectTitleRequired(page: Page) {
  await expect(page.getByText(/Enter a title/).first()).toBeVisible();
}
export async function expectSavedTitle(page: Page, title: string) {
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Monitor title", exact: true })).toHaveCount(0);
}
export async function changeMetadataFromAnotherClient(page: Page) {
  const peer = await page.context().newPage();
  try {
    await peer.goto(page.url());
    await hideMetadata(peer);
    await expect(page.getByText("Metadata hidden", { exact: true })).toBeVisible();
  } finally {
    await peer.close();
  }
}
export async function expectConflictPreservesDraft(page: Page, title: string) {
  await expect(page.getByText(/Settings changed on another client/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Monitor title", exact: true })).toHaveValue(
    title,
  );
}
export async function discardTitle(page: Page) {
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expectSavedTitle(page, "Agent monitor");
}
export async function returnAndReopenSettings(page: Page) {
  await goBackInSettings(page);
  await openSettingsFromCog(page);
}
export async function returnToPluginsPage(page: Page) {
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  await expectAppRoute(page, buildSettingsHostSectionRoute(getServerId(), "plugins"));
  await expect(
    page.getByRole("button", { name: "Actions for settings-example", exact: true }),
  ).toBeVisible();
}
export async function expectSettingsUnavailable(page: Page) {
  await expect(
    page.getByText("This plugin settings screen is unavailable.", { exact: true }),
  ).toBeVisible();
}
