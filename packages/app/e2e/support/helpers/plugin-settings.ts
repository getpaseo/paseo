import { copyPluginExample } from "./plugin-fixture";
import { expect, test as base, type Page } from "../fixtures";
import { gotoAppShell, openSettings } from "./app";
import { goBackInSettings, openCompactSettings, openHostSection } from "./settings";
import { getServerId } from "./server-id";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";

type SettingsClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

export const test = base.extend<{ settingsPlugin: SettingsClient }>({
  settingsPlugin: [
    async ({ e2eWorker, page }, provide, testInfo) => {
      void e2eWorker;
      const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
      const previous = await client.getDaemonConfig();
      const example = await copyPluginExample("settings");
      try {
        await client.patchDaemonConfig({ pluginsEnabled: true });
        await client.installDirectoryPlugin(example.directory);
        await provide(client);
        await page.screenshot({ path: testInfo.outputPath("settings.png") });
      } finally {
        await client.removePlugin("settings-example");
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await client.close();
        await example.cleanup();
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
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Show metadata" })).toBeVisible();
}
export async function groupByWorkspace(page: Page) {
  await page.getByRole("button", { name: "Group agents by", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Show metadata" })).toBeVisible();
}
export async function expectSettingsUnavailable(page: Page) {
  await expect(
    page.getByText("This plugin settings screen is unavailable.", { exact: true }),
  ).toBeVisible();
}
