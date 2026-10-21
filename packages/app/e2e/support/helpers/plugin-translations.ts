import { hideDeveloperToasts } from "../developer-ui.mjs";
import { seedWorkspace } from "./seed-client";
import { buildAgentRoute } from "./mock-agent";
import { openCommandCenter } from "./command-center";
import type { TestInfo, BrowserContext } from "@playwright/test";
import { expect, type Page } from "../fixtures";
import { gotoAppShell, openSettings } from "./app";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { copyPluginExample } from "./plugin-fixture";

async function chooseChinese(page: Page) {
  await openSettings(page);
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "简体中文 - Simplified Chinese", exact: true }).click();
  await page.goBack();
}

async function chooseEnglish(page: Page) {
  await page.getByTestId("sidebar-settings").click();
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 英语", exact: true }).click();
  await page.goBack();
}

async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  await info.attach(name, { path: file, contentType: "image/png" });
}

export async function verifyPluginTranslations(page: Page, info: TestInfo) {
  const example = await copyPluginExample("translations");
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const browser = page.context().browser();
  if (!browser) throw new Error("Translation isolation requires a browser");
  let secondContext: BrowserContext | undefined;
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Workspace notes", exact: true }).click();
    await expect(page.getByText("App language: en", { exact: true })).toBeVisible();
    await page
      .getByRole("textbox", { name: "Your draft", exact: true })
      .fill("Remember the language switch");
    await capture(page, info, "01-english-draft");
    await page.getByRole("button", { name: "Preview draft", exact: true }).click();
    await expect(page.getByRole("button", { name: "Close preview", exact: true })).toBeVisible();
    await capture(page, info, "02-english-preview");
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    secondContext = await browser.newContext({
      storageState: await page.context().storageState(),
      viewport: { width: 1440, height: 1000 },
    });
    const second = await secondContext.newPage();
    await hideDeveloperToasts(second);
    await second.goto(page.url());
    await expect(second.getByText("App language: en", { exact: true })).toBeVisible();
    await chooseChinese(second);
    await expect(second.getByText("应用语言：zh-CN", { exact: true })).toBeVisible();
    await second
      .getByRole("textbox", { name: "你的草稿", exact: true })
      .fill("A separate client draft");
    await expect(page.getByText("App language: en", { exact: true })).toBeVisible();
    await expect(page.getByTestId("plugin-surface-title")).toHaveText("Workspace notes");
    await capture(second, info, "03-independent-chinese-client");
    await chooseChinese(page);
    await expect(page.getByRole("textbox", { name: "你的草稿", exact: true })).toHaveValue(
      "Remember the language switch",
    );
    await expect(page.getByTestId("plugin-surface-title")).toHaveText("工作区笔记");
    await expect(page.getByText("应用语言：zh-CN", { exact: true })).toBeVisible();
    await expect(
      page.getByText("This English-only message demonstrates fallback.", { exact: true }),
    ).toBeVisible();
    await capture(page, info, "04-chinese-draft-preserved");
    await page.getByRole("button", { name: "预览草稿", exact: true }).click();
    await expect(page.getByText("草稿预览", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "关闭预览", exact: true })).toBeVisible();
    await capture(page, info, "05-chinese-preview");
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await chooseEnglish(page);
    await expect(page.getByRole("textbox", { name: "Your draft", exact: true })).toHaveValue(
      "Remember the language switch",
    );
    await expect(page.getByTestId("plugin-surface-title")).toHaveText("Workspace notes");
    await expect(second.getByRole("textbox", { name: "你的草稿", exact: true })).toHaveValue(
      "A separate client draft",
    );
    await capture(page, info, "06-return-to-english-draft-preserved");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(page.getByText("1 note", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Your draft", exact: true }).fill("Second note");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(page.getByText("2 notes", { exact: true })).toBeVisible();
  } finally {
    await secondContext?.close().catch(() => undefined);
    await client.removePlugin("translation-notes").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
  }
}

export async function verifyPluginToolTranslations(page: Page, info: TestInfo) {
  const workspace = await seedWorkspace({
    repoPrefix: "translation-tools-",
    title: "Notes translation QA",
  });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Notes",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const example = await copyPluginExample("translations");
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await page.goto(buildAgentRoute(workspace.workspaceId, agent.id));
    const commandCenter = await openCommandCenter(page);
    await commandCenter.getByTestId("command-center-input").fill("Show notes tools");
    await commandCenter.getByRole("button", { name: "Show notes tools", exact: true }).click();
    const tools = page
      .getByRole("toolbar", { name: "Workspace actions", exact: true })
      .getByRole("button", { name: "Notes tools", exact: true });
    await tools.hover();
    await expect(page.getByRole("tooltip")).toContainText("Notes tools");
    await capture(page, info, "07-english-tooltip");
    await tools.click();
    await page.getByRole("menuitem", { name: "Open notes panel", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Your draft", exact: true })
      .fill("A workspace panel draft");
    await chooseChinese(page);
    await expect(page.getByRole("textbox", { name: "你的草稿", exact: true })).toHaveValue(
      "A workspace panel draft",
    );
    const translatedTools = page
      .getByRole("toolbar")
      .getByRole("button", { name: "笔记工具", exact: true });
    await translatedTools.hover();
    await expect(page.getByRole("tooltip")).toContainText("笔记工具");
    await capture(page, info, "08-chinese-tooltip-and-panel-draft");
    await translatedTools.click();
    await expect(page.getByRole("menuitem", { name: "打开笔记面板", exact: true })).toBeVisible();
    await capture(page, info, "09-chinese-menu");
    await page.keyboard.press("Escape");
  } finally {
    await client.removePlugin("translation-notes").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
    await workspace.cleanup();
  }
}
