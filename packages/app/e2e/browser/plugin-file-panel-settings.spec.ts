import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  BUILTIN_MARKDOWN_OPTION,
  MARKDOWN_PANEL_ID,
  PLUGIN_MARKDOWN_OPTION,
  SOURCE_OPTION,
  expectPluginMarkdown,
  filePanelPicker,
  installMarkdownPanelPlugin,
  openMarkdown,
  storedFilePanelAssociations,
} from "../support/helpers/markdown-file-panel-plugin";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSettingsSection } from "../support/helpers/settings";

const ASK_EVERY_TIME = "Ask every time";

function markdownRow(page: Page) {
  return page.getByTestId("file-panel-settings-row-ext:md");
}

function markdownDropdown(page: Page, value: string) {
  return markdownRow(page).getByRole("button", { name: `.md: ${value}`, exact: true });
}

function askAgain(page: Page) {
  return markdownRow(page).getByRole("button", { name: "Ask again for .md", exact: true });
}

async function openFilesSettings(page: Page) {
  await openSettings(page);
  await openSettingsSection(page, "files");
  await expect(page.getByTestId("file-panel-settings")).toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

async function expectMenuOpen(page: Page) {
  await expect(page.getByTestId("file-panel-settings-menu")).toHaveCSS("opacity", "1");
}

test("Settings > Files chooses which panel opens .md and asks again on request", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-settings-",
    repo: { files: [{ path: "notes.md", content: "# notes heading\n" }] },
  });
  const plugin = await installMarkdownPanelPlugin();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFilesSettings(page);

    // Nothing remembered: the row asks every time and has nothing to forget.
    await expect(markdownDropdown(page, ASK_EVERY_TIME)).toBeVisible({ timeout: 30_000 });
    await expect(askAgain(page)).toBeDisabled();
    await capture(page, testInfo, "file-panel-settings-wide");

    await markdownDropdown(page, ASK_EVERY_TIME).click();
    await expect(page.getByRole("menuitem", { name: BUILTIN_MARKDOWN_OPTION })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: PLUGIN_MARKDOWN_OPTION })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: SOURCE_OPTION })).toBeVisible();
    await expectMenuOpen(page);
    await capture(page, testInfo, "file-panel-settings-wide-menu");
    await page.getByRole("menuitem", { name: PLUGIN_MARKDOWN_OPTION }).click();
    await expect(markdownDropdown(page, PLUGIN_MARKDOWN_OPTION)).toBeVisible();
    await expect
      .poll(() => storedFilePanelAssociations(page))
      .toEqual({
        "ext:md": MARKDOWN_PANEL_ID,
      });
    await capture(page, testInfo, "file-panel-settings-wide-chosen");

    // The next open uses the plugin without asking.
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openMarkdown(page, "notes.md");
    await expectPluginMarkdown(page, "notes.md");
    await expect(filePanelPicker(page)).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/files");
    await expect(markdownDropdown(page, PLUGIN_MARKDOWN_OPTION)).toBeVisible({ timeout: 30_000 });
    await expect(askAgain(page)).toBeInViewport({ ratio: 1 });
    await capture(page, testInfo, "file-panel-settings-compact");
    await markdownDropdown(page, PLUGIN_MARKDOWN_OPTION).click();
    await expect(page.getByRole("menuitem", { name: SOURCE_OPTION })).toBeVisible();
    await expectMenuOpen(page);
    await capture(page, testInfo, "file-panel-settings-compact-menu");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: SOURCE_OPTION })).toBeHidden();

    // Ask again forgets the choice; the next open asks.
    await askAgain(page).click();
    await expect(markdownDropdown(page, ASK_EVERY_TIME)).toBeVisible();
    await expect.poll(() => storedFilePanelAssociations(page)).toEqual({});
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await expect(filePanelPicker(page)).toBeVisible({ timeout: 30_000 });
  } finally {
    await plugin.uninstall();
    await workspace.cleanup();
  }
});

test("Settings > Files explains where file panels come from when no plugin adds one", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/files");
  const empty = page.getByTestId("file-panel-settings-empty");
  await expect(empty).toHaveText("File panels appear here when a plugin adds one", {
    timeout: 30_000,
  });
  await capture(page, testInfo, "file-panel-settings-empty-wide");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(empty).toBeVisible();
  await capture(page, testInfo, "file-panel-settings-empty-compact");
});

test("Settings > Files offers Source in place of a panel no host has, and forgets it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ filePanelAssociations: { "ext:pdf": "plugin:none/none" } }),
    );
  });
  await page.goto("/settings/files");
  const row = page.getByTestId("file-panel-settings-row-ext:pdf");
  const dropdown = row.getByRole("button", { name: ".pdf: Not on a connected host" });
  await expect(dropdown).toBeEnabled({ timeout: 30_000 });
  await dropdown.click();
  await expect(page.getByRole("menuitem", { name: SOURCE_OPTION })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: SOURCE_OPTION })).toBeHidden();
  await row.getByRole("button", { name: "Ask again for .pdf", exact: true }).click();
  await expect(page.getByTestId("file-panel-settings-empty")).toBeVisible();
});
