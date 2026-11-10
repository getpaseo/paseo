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

// The app is compact below the `md` breakpoint (600) in styles/unistyles.ts.
const COMPACT_VIEWPORT_MAX_WIDTH = 599;
function isCompactViewport(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) <= COMPACT_VIEWPORT_MAX_WIDTH;
}

const TABBED_PLUGIN_ID = "settings-tabs";
const TABBED_PLUGIN_NAME = "Tabbed settings";
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

const MEMORY_PLUGIN_ID = "settings-memory";
const MEMORY_PLUGIN_NAME = "Memory tools";
const MEMORY_SCREEN_TITLE = "Memory";
/** One settings screen. The manifest name is deliberately different from the screen title. */
const MEMORY_SOURCE = `import React from "react";
import { Text } from "react-native";

function Memory({ theme }) {
  return <Text style={{ color: theme.colors.foreground }}>Memory settings body</Text>;
}

export default function contribute(client) {
  client.addSettingsScreen({ id: "memory", title: "Memory", icon: "Settings", Component: Memory });
  return () => {};
}
`;

async function writeSyntheticPlugin(id: string, name: string, source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `paseo-${id}-`));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, name, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), source);
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function writeTabbedPlugin() {
  return writeSyntheticPlugin(TABBED_PLUGIN_ID, TABBED_PLUGIN_NAME, TABBED_SOURCE);
}

function writeMemoryPlugin() {
  return writeSyntheticPlugin(MEMORY_PLUGIN_ID, MEMORY_PLUGIN_NAME, MEMORY_SOURCE);
}

export const test = base.extend<{ settingsPlugin: SettingsClient }>({
  settingsPlugin: [
    async ({ e2eWorker, page }, provide, testInfo) => {
      void e2eWorker;
      const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
      const previous = await client.getDaemonConfig();
      const example = await copyPluginExample("settings");
      const tabbed = await writeTabbedPlugin();
      const memory = await writeMemoryPlugin();
      try {
        await client.patchDaemonConfig({ pluginsEnabled: true });
        await client.installDirectoryPlugin(example.directory);
        await client.installDirectoryPlugin(tabbed.directory);
        await client.installDirectoryPlugin(memory.directory);
        await provide(client);
        await page.screenshot({ path: testInfo.outputPath("settings.png") });
      } finally {
        await client.removePlugin("settings-example");
        await client.removePlugin(TABBED_PLUGIN_ID);
        await client.removePlugin(MEMORY_PLUGIN_ID);
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await client.close();
        await example.cleanup();
        await tabbed.cleanup();
        await memory.cleanup();
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
export async function openMemorySettings(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openMemoryPluginScreen(page);
}
export async function openCompactMemorySettings(page: Page) {
  await gotoAppShell(page);
  await openCompactSettings(page, new URL(page.url()).pathname);
  await openMemoryPluginScreen(page);
}
async function openMemoryPluginScreen(page: Page) {
  await openHostSection(page, getServerId(), "plugins");
  await settingsButton(page, MEMORY_PLUGIN_ID).click();
  await expect(page.getByText("Memory settings body", { exact: true })).toBeVisible();
  await expect(page.getByTestId("plugin-settings-tabs")).toHaveCount(0);
}
export async function expectMemorySettingsHeader(page: Page) {
  await expectSettingsHeader(page, MEMORY_SCREEN_TITLE);
  // The manifest name and plugin id stay out of the header, including the id prefix.
  await expect(
    page.getByText(MEMORY_PLUGIN_NAME, { exact: true }).filter({ visible: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(MEMORY_PLUGIN_ID, { exact: true }).filter({ visible: true }),
  ).toHaveCount(0);
}
/**
 * A plugin screen has one Back control. On desktop it sits in the detail pane; the sidebar's
 * workspace exit returns when the plugin screen is closed.
 */
export async function expectSinglePluginBackControl(page: Page) {
  if (isCompactViewport(page)) {
    await expect(
      page.getByRole("button", { name: "Back", exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Back to plugins", exact: true }).filter({ visible: true }),
    ).toHaveCount(0);
    return;
  }
  const sidebar = page.getByTestId("settings-sidebar").filter({ visible: true });
  await expect(sidebar.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  const pane = page.getByTestId("settings-detail-pane").filter({ visible: true });
  await expect(pane.getByRole("button", { name: "Back to plugins", exact: true })).toHaveCount(1);
  await expect(pane.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
}
export async function returnFromMemoryToPlugins(page: Page) {
  if (isCompactViewport(page)) {
    await page.getByRole("button", { name: "Back", exact: true }).filter({ visible: true }).click();
  } else {
    await page
      .getByTestId("settings-detail-pane")
      .filter({ visible: true })
      .getByRole("button", { name: "Back to plugins", exact: true })
      .click();
  }
  await expectAppRoute(page, buildSettingsHostSectionRoute(getServerId(), "plugins"));
  await expect(settingsButton(page, MEMORY_PLUGIN_ID)).toBeVisible();
  if (!isCompactViewport(page)) {
    await expect(page.getByTestId("settings-back-to-workspace")).toBeVisible();
  }
}
/** The cog on a plugin's row. Its label is "Settings"; the row tells plugins apart. */
function settingsButton(page: Page, pluginId: string) {
  return page
    .getByTestId(`plugin-row-${pluginId}`)
    .filter({ visible: true })
    .getByRole("button", { name: "Settings", exact: true });
}
async function openSettingsFromCog(page: Page) {
  await settingsButton(page, "settings-example").click();
  await expect(page.getByRole("switch", { name: "Show metadata" })).toBeVisible();
  // A plugin with one settings screen shows no tabs, so the header names the screen.
  await expect(page.getByTestId("plugin-settings-tabs")).toHaveCount(0);
  await expectSettingsHeader(page, "Display");
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
  await expect(settingsButton(page, "settings-example")).toHaveCount(0);
  await page.getByRole("switch", { name: "settings-example: Enable" }).click();
  await expect(settingsButton(page, "settings-example")).toBeVisible();
}
export async function expectSettingsTooltip(page: Page) {
  await settingsButton(page, "settings-example").hover();
  await expect(page.getByRole("tooltip")).toHaveText("Settings");
  await page.mouse.move(0, 0);
}
/** A manifest `name` titles the row and its controls; the id stays visible beneath it. */
export async function expectNamedPluginRow(page: Page) {
  const row = page.getByTestId(`plugin-row-${TABBED_PLUGIN_ID}`).filter({ visible: true });
  await expect(row.getByText(TABBED_PLUGIN_NAME, { exact: true })).toBeVisible();
  await expect(row.getByText(TABBED_PLUGIN_ID, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("switch", { name: `${TABBED_PLUGIN_NAME}: Disable`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Actions for ${TABBED_PLUGIN_NAME}`, exact: true }),
  ).toBeVisible();
}
export async function openTabbedSettings(page: Page) {
  await settingsButton(page, TABBED_PLUGIN_ID).click();
  await expectSettingsTab(page, "General");
  // The Advanced icon reads the plugin's translations; the General icon throws and is dropped.
  await expect(page.getByTestId("advanced-tab-icon")).toBeVisible();
  await expectSinglePluginBackControl(page);
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
  // The header names the plugin by its manifest name; the tab names the screen.
  await expectSettingsHeader(page, TABBED_PLUGIN_NAME);
  await expectSinglePluginBackControl(page);
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
async function expectSettingsHeader(page: Page, title: string) {
  // Settings keeps the Plugins page mounted beneath, so read the visible title only.
  await expect(
    page.getByTestId("settings-detail-header-title").filter({ visible: true }),
  ).toHaveText(title);
}
export async function expectSettingsUnavailable(page: Page) {
  await expect(
    page.getByText("This plugin settings screen is unavailable.", { exact: true }),
  ).toBeVisible();
}
