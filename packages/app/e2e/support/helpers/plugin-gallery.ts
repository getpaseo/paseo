import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { expect, type Page } from "../fixtures";
import { getServerId } from "./server-id";
import { expectAppRoute } from "./route-assertions";
import { escapeRegex } from "./regex";

/**
 * Settings → Host → Plugins: the Installed and Browse tabs, the page menu, the install sheet and a
 * plugin's own page. Helpers that take a plugin name expect the manifest name, which is the plugin
 * ID when the manifest has none.
 */

export function pluginsRoute(serverId = getServerId()): string {
  return buildSettingsHostSectionRoute(serverId, "plugins");
}

export function pluginPageRoute(pluginId: string, serverId = getServerId()): string {
  return `${pluginsRoute(serverId)}/${encodeURIComponent(pluginId)}`;
}

/** Settings keeps the Plugins page mounted beneath a plugin's page, so read visible rows only. */
export function pluginRow(page: Page, pluginId: string) {
  return page.getByTestId(`plugin-row-${pluginId}`).filter({ visible: true });
}

function pluginSwitch(page: Page, name: string, action: "Disable" | "Enable") {
  return page.getByRole("switch", { name: `${name}: ${action}`, exact: true }).filter({
    visible: true,
  });
}

/**
 * A toast that times out stays in the page while it fades, so the next toast can share the screen
 * with it, even when both have the same text. The pattern matches case, so "Installed x" does not
 * match "Uninstalled x".
 */
export async function expectToast(page: Page, message: string): Promise<void> {
  const toast = page
    .getByTestId("app-toast-message")
    .filter({ hasText: new RegExp(escapeRegex(message)) })
    .first();
  await expect(toast).toBeVisible();
}

// Tabs and search

export async function selectInstalledTab(page: Page): Promise<void> {
  const tab = page.getByRole("button", { name: /^Installed/ });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

export async function searchInstalled(page: Page, query: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search installed", exact: true }).fill(query);
}

export async function clearSearch(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search installed", exact: true })).toHaveValue(
    "",
  );
}

// Installed rows

export async function expectPluginOn(page: Page, name: string): Promise<void> {
  await expect(pluginSwitch(page, name, "Disable")).toBeVisible();
  await expect(pluginSwitch(page, name, "Disable")).toBeEnabled();
}

export async function expectPluginOff(page: Page, name: string): Promise<void> {
  await expect(pluginSwitch(page, name, "Enable")).toBeVisible();
}

export async function turnPluginOff(page: Page, name: string): Promise<void> {
  await pluginSwitch(page, name, "Disable").click();
  await expectPluginOff(page, name);
}

export async function turnPluginOn(page: Page, name: string): Promise<void> {
  await pluginSwitch(page, name, "Enable").click();
  await expectPluginOn(page, name);
}

/** The switch stays disabled while an action on the plugin runs, so a second one cannot start. */
export async function expectPluginActionPending(page: Page, name: string): Promise<void> {
  await expect(pluginSwitch(page, name, "Disable")).toBeDisabled();
}

export async function expectPluginFailed(page: Page, pluginId: string): Promise<void> {
  await expect(pluginRow(page, pluginId).getByText("failed", { exact: true })).toBeVisible();
}

export async function expectPluginHealthy(page: Page, pluginId: string): Promise<void> {
  await expect(pluginRow(page, pluginId)).toBeVisible();
  await expect(pluginRow(page, pluginId).getByText("failed", { exact: true })).toHaveCount(0);
}

export async function expectPluginRemoved(page: Page, pluginId: string): Promise<void> {
  await expect(page.getByTestId(`plugin-row-${pluginId}`)).toHaveCount(0);
}

// Plugins on the host

function pluginsOffAlert(page: Page) {
  return page.getByRole("alert").filter({ hasText: "Plugins are off on" });
}

export async function expectPluginsOff(page: Page): Promise<void> {
  await expect(pluginsOffAlert(page)).toBeVisible();
}

export async function expectPluginsOn(page: Page): Promise<void> {
  await expect(pluginsOffAlert(page)).toHaveCount(0);
}

export async function turnOnPluginsFromAlert(page: Page): Promise<void> {
  await pluginsOffAlert(page).getByRole("button", { name: "Turn on", exact: true }).click();
  await expectPluginsOn(page);
}

// The page menu

function galleryMenu(page: Page) {
  return page.getByRole("button", { name: "More plugin actions", exact: true }).filter({
    visible: true,
  });
}

async function openGalleryMenu(page: Page): Promise<void> {
  await galleryMenu(page).click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
}

export async function expectGalleryMenuWithoutSourceInstall(page: Page): Promise<void> {
  await openGalleryMenu(page);
  await expect(page.getByRole("menuitem", { name: "Turn off plugins", exact: true })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Install from source", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
}

export async function turnOffPluginsFromMenu(page: Page): Promise<void> {
  await openGalleryMenu(page);
  await page.getByRole("menuitem", { name: "Turn off plugins", exact: true }).click();
  await expectToast(page, "Plugins disabled");
  await expectPluginsOff(page);
}

export async function turnOnPluginsFromMenu(page: Page): Promise<void> {
  await openGalleryMenu(page);
  await page.getByRole("menuitem", { name: "Turn on plugins", exact: true }).click();
  await expectToast(page, "Plugins enabled");
  await expectPluginsOn(page);
}

// Install from source

function sourceField(page: Page) {
  return page.getByRole("textbox", { name: "Plugin source", exact: true });
}

export async function openSourceInstall(page: Page): Promise<void> {
  await openGalleryMenu(page);
  await page.getByRole("menuitem", { name: "Install from source", exact: true }).click();
  await expect(sourceField(page)).toBeVisible();
}

export async function expectSourceInstallTurnsPluginsOn(page: Page): Promise<void> {
  await expect(
    page.getByText("Plugins are not sandboxed. Installing also turns plugins on.", {
      exact: true,
    }),
  ).toBeVisible();
}

export async function submitSourceInstall(page: Page, source: string): Promise<void> {
  await sourceField(page).fill(source);
  await page.getByRole("button", { name: "Install", exact: true }).click();
}

/** A failed install keeps the sheet open with the source, so the user can correct it. */
export async function expectSourceInstallFailed(
  page: Page,
  source: string,
  message: string,
): Promise<void> {
  await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
  await expect(sourceField(page)).toHaveValue(source);
}

export async function expectSourceInstalled(page: Page, name: string): Promise<void> {
  await expectToast(page, `Installed ${name}`);
  await expect(sourceField(page)).toHaveCount(0);
}

export async function installFromSource(page: Page, source: string, name: string): Promise<void> {
  await openSourceInstall(page);
  await submitSourceInstall(page, source);
  await expectSourceInstalled(page, name);
}

// Updates

function updateRow(page: Page, pluginId: string) {
  return page.getByTestId(`plugin-update-${pluginId}`).filter({ visible: true });
}

export async function updatePlugin(page: Page, pluginId: string): Promise<void> {
  await updateRow(page, pluginId).getByRole("button", { name: "Update", exact: true }).click();
  await expectToast(page, `${pluginId} updated`);
  await expect(page.getByTestId(`plugin-update-${pluginId}`)).toHaveCount(0);
}

export async function expectUpdateAvailable(page: Page, pluginId: string): Promise<void> {
  await expect(updateRow(page, pluginId)).toBeVisible();
}

// A plugin's page

export function pluginPageName(page: Page) {
  return page.getByTestId("plugin-page-name").filter({ visible: true });
}

/** Opens the plugin's page from its row on the Installed tab. */
export async function openPluginPage(page: Page, name: string, pluginId = name): Promise<void> {
  await pluginRow(page, pluginId).getByText(name, { exact: true }).click();
  await expect(pluginPageName(page)).toHaveText(name);
}

export async function backToPlugins(page: Page, pluginId: string): Promise<void> {
  await page.getByRole("button", { name: "Back to plugins", exact: true }).click();
  await expect(pluginRow(page, pluginId)).toBeVisible();
}

export async function openPluginPageActions(page: Page, name: string): Promise<void> {
  await page
    .getByRole("button", { name: `Actions for ${name}`, exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
}

export async function selectPluginPageAction(
  page: Page,
  name: string,
  action: "Reload" | "Logs" | "Uninstall",
): Promise<void> {
  await openPluginPageActions(page, name);
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

export async function reloadPluginFromPage(page: Page, name: string): Promise<void> {
  await selectPluginPageAction(page, name, "Reload");
  await expectToast(page, `Reloaded ${name}`);
}

export async function openPluginLogs(page: Page, name: string): Promise<void> {
  await selectPluginPageAction(page, name, "Logs");
  await expect(page.getByRole("dialog")).toContainText(`Logs: ${name}`);
}

export async function closePluginLogs(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Uninstall confirms first; uninstalling a plugin that is not in the directory returns to Plugins. */
export async function removePluginFromPage(page: Page, name: string): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
  await selectPluginPageAction(page, name, "Uninstall");
  await expectToast(page, `Uninstalled ${name}`);
  await expect(pluginPageName(page)).toHaveCount(0);
}

export async function expectPluginsRoute(page: Page): Promise<void> {
  await expectAppRoute(page, pluginsRoute());
}
