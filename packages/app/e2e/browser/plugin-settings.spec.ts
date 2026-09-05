import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openHostSection } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";

const directory = path.resolve(__dirname, "../../../../plugin-examples/settings");

async function openDisplaySettings(page: Page) {
  await openSettings(page);
  await openHostSection(page, getServerId(), "plugins");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Show metadata" })).toBeVisible();
}
async function groupByWorkspace(page: Page) {
  await page.getByRole("button", { name: "Group agents by", exact: true }).click();
  await page.getByRole("menuitem", { name: "Workspace", exact: true }).click();
  await expect(page.getByText("Grouped by workspace", { exact: true })).toBeVisible();
}
async function editTitle(page: Page, title: string) {
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await page.getByRole("textbox", { name: "Monitor title", exact: true }).fill(title);
}
async function saveTitle(page: Page) {
  await page.getByRole("button", { name: "Save title", exact: true }).click();
}

test("contributed settings compose native controls, persist, recover, and fit compact layout", async ({
  page,
}, testInfo) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await gotoAppShell(page);
    await openDisplaySettings(page);
    await groupByWorkspace(page);
    await page.getByRole("switch", { name: "Show metadata" }).click();
    await expect(page.getByText("Metadata hidden", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("settings-wide.png") });
    await page.reload();
    await expect(page.getByText("Grouped by workspace", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Show metadata" })).not.toBeChecked();

    await editTitle(page, "");
    await saveTitle(page);
    await expect(page.getByText(/Enter a title/).first()).toBeVisible();
    await page.getByRole("textbox", { name: "Monitor title", exact: true }).fill("My monitor");
    await saveTitle(page);
    await expect(page.getByText("My monitor", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Monitor title", exact: true })).toHaveCount(0);

    await editTitle(page, "Unsaved title");
    const peer = await page.context().newPage();
    await peer.goto(page.url());
    await peer.getByRole("switch", { name: "Show metadata" }).click();
    await expect(page.getByText("Metadata visible", { exact: true })).toBeVisible();
    await saveTitle(page);
    await expect(page.getByText(/Settings changed on another client/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Monitor title", exact: true })).toHaveValue(
      "Unsaved title",
    );
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await peer.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("switch", { name: "Show metadata" })).toBeVisible();
    await groupByWorkspace(page);
    await page.screenshot({ path: testInfo.outputPath("settings-compact.png") });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await client.disablePlugin("settings-example");
    await expect(
      page.getByText("This plugin settings screen is unavailable.", { exact: true }),
    ).toBeVisible();
    await client.enablePlugin("settings-example");
    await expect(page.getByText("My monitor", { exact: true })).toBeVisible();
  } finally {
    await client.removePlugin("settings-example");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
  }
});
