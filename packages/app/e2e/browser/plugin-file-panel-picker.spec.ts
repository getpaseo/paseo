import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import { expectFileTabOpen, openFileExplorer } from "../support/helpers/file-explorer";
import {
  BUILTIN_MARKDOWN_OPTION,
  MARKDOWN_PANEL_ID,
  PLUGIN_MARKDOWN_OPTION,
  expectBuiltinMarkdown,
  expectPluginMarkdown,
  filePanelPicker,
  installMarkdownPanelPlugin,
  openMarkdown,
  storedFilePanelAssociations,
} from "../support/helpers/markdown-file-panel-plugin";

async function choosePanel(page: Page, option: string, options: { remember: boolean }) {
  await page.getByRole("radio", { name: option, exact: true }).click();
  if (options.remember) {
    await page.getByRole("checkbox", { name: "Don't ask me again", exact: true }).click();
  }
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(filePanelPicker(page)).toBeHidden();
}

async function openWithFromTabMenu(page: Page, name: string, option: string) {
  await page.getByTestId(`workspace-tab-file_${name}`).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with…" }).hover();
  await page.getByRole("menuitem", { name: option }).click();
}

async function toggleAlwaysUseFromTabMenu(page: Page, name: string) {
  await openWithFromTabMenu(page, name, "Always use for .md");
}

/** The built-in panel's toolbar control between its Preview and Source views. */
function viewControl(page: Page) {
  return page.getByTestId("file-preview-mode").filter({ visible: true });
}

async function selectFileView(page: Page, view: "Preview" | "Source") {
  const option = viewControl(page).getByRole("button", { name: view, exact: true });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

async function expectNoOpenWith(page: Page, name: string) {
  await page.getByTestId(`workspace-tab-file_${name}`).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open with…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

test("opens Markdown with the built-in panel and its Preview and Source without asking", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-builtins-",
    repo: { files: [{ path: "notes.md", content: "# notes heading\n" }] },
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openMarkdown(page, "notes.md");
    await expectBuiltinMarkdown(page, "notes heading");
    await expect(viewControl(page).getByRole("button")).toHaveText(["Preview", "Source"]);
    await expect(filePanelPicker(page)).toBeHidden();
    await expectNoOpenWith(page, "notes.md");
    await capture(page, testInfo, "file-panel-builtins-wide");

    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toBeVisible();
    await selectFileView(page, "Preview");
    await expectBuiltinMarkdown(page, "notes heading");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectBuiltinMarkdown(page, "notes heading");
    await expect(
      viewControl(page).getByRole("button", { name: "Source", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(filePanelPicker(page)).toBeHidden();
    await capture(page, testInfo, "file-panel-builtins-compact");
  } finally {
    await workspace.cleanup();
  }
});

test("asks once which panel opens Markdown and remembers it when told to", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-picker-",
    repo: {
      files: ["first", "second", "third", "fourth"].map((name) => ({
        path: `${name}.md`,
        content: `# ${name} heading\n`,
      })),
    },
  });
  const plugin = await installMarkdownPanelPlugin();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    // First open: the built-in renders under the picker.
    await openMarkdown(page, "first.md");
    await expect(filePanelPicker(page)).toBeVisible();
    await expect(page.getByRole("radio", { name: BUILTIN_MARKDOWN_OPTION })).toBeChecked();
    await expect(page.getByRole("radio", { name: PLUGIN_MARKDOWN_OPTION })).not.toBeChecked();
    await expect(page.getByRole("radio")).toHaveCount(2);
    await expectBuiltinMarkdown(page, "first heading");
    await capture(page, testInfo, "file-panel-picker-wide");

    // Don't ask me again: the plugin renders and later opens use it silently.
    await choosePanel(page, PLUGIN_MARKDOWN_OPTION, { remember: true });
    await expectPluginMarkdown(page, "first.md");
    expect(await storedFilePanelAssociations(page)).toEqual({ "ext:md": MARKDOWN_PANEL_ID });
    await openMarkdown(page, "second.md");
    await expectPluginMarkdown(page, "second.md");
    await expect(filePanelPicker(page)).toBeHidden();

    // Forgetting from the tab menu keeps the tab on the plugin.
    await toggleAlwaysUseFromTabMenu(page, "second.md");
    await expect.poll(() => storedFilePanelAssociations(page)).toEqual({});
    await expectPluginMarkdown(page, "second.md");

    // An unremembered choice applies to this tab only; the next open asks again.
    await openMarkdown(page, "third.md");
    await expect(filePanelPicker(page)).toBeVisible();
    await choosePanel(page, PLUGIN_MARKDOWN_OPTION, { remember: false });
    await expectPluginMarkdown(page, "third.md");
    expect(await storedFilePanelAssociations(page)).toEqual({});

    // "Open with…" switches the open tab back to the built-in in place, with its own views.
    await openWithFromTabMenu(page, "third.md", BUILTIN_MARKDOWN_OPTION);
    await expectBuiltinMarkdown(page, "third heading");
    await expectFileTabOpen(page, "third.md");
    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toBeVisible();
    await selectFileView(page, "Preview");
    await expectBuiltinMarkdown(page, "third heading");

    // Dismissing keeps the built-in; reopening the tab after a reload asks again.
    await openMarkdown(page, "fourth.md");
    await expect(filePanelPicker(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(filePanelPicker(page)).toBeHidden();
    await expectBuiltinMarkdown(page, "fourth heading");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(filePanelPicker(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Use", exact: true })).toBeInViewport({
      ratio: 1,
    });
    await capture(page, testInfo, "file-panel-picker-compact");
  } finally {
    await plugin.uninstall();
    await workspace.cleanup();
  }
});
