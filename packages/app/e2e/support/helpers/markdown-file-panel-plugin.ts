import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { pluginRequirements } from "./plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { expectFileTabOpen, openFileFromExplorer } from "./file-explorer";

/** A directory plugin whose "Rich Markdown" file panel claims `.md`, next to the built-in. */
export const MARKDOWN_PANEL_PLUGIN_ID = "file-panel-picker-e2e";
export const MARKDOWN_PANEL_ID = `plugin:${MARKDOWN_PANEL_PLUGIN_ID}/rich-markdown`;
export const BUILTIN_MARKDOWN_OPTION = "Markdown — Paseo";
export const PLUGIN_MARKDOWN_OPTION = `Rich Markdown — ${MARKDOWN_PANEL_PLUGIN_ID}`;
export const SOURCE_OPTION = "Source — Paseo";

const SOURCE = `import React from "react";
import { Text, View } from "react-native";
function RichMarkdown({ file }) {
  return <View><Text>Rich Markdown plugin: {file.name}</Text></View>;
}
export default function contribute(client) {
  client.addFilePanel({ id: "rich-markdown", title: "Rich Markdown", icon: "FileType",
    files: { extensions: ["md"] }, Component: RichMarkdown });
  return () => {};
}`;

/** Enables plugins on the test daemon and installs the plugin; `uninstall` restores both. */
export async function installMarkdownPanelPlugin(): Promise<{ uninstall(): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-markdown-file-panel-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const uninstall = async () => {
    await client.removePlugin(MARKDOWN_PANEL_PLUGIN_ID);
    await client.patchDaemonConfig({
      pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
    });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: MARKDOWN_PANEL_PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), SOURCE);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
  } catch (error) {
    await uninstall();
    throw error;
  }
  return { uninstall };
}

export function filePanelPicker(page: Page) {
  return page.getByText("Open .md files with", { exact: true });
}

export async function openMarkdown(page: Page, name: string): Promise<void> {
  await openFileFromExplorer(page, name);
  await expectFileTabOpen(page, name);
}

export async function expectBuiltinMarkdown(page: Page, heading: string): Promise<void> {
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

export async function expectPluginMarkdown(page: Page, name: string): Promise<void> {
  await expect(page.getByText(`Rich Markdown plugin: ${name}`, { exact: true })).toBeVisible();
}

export async function storedFilePanelAssociations(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
    return settings.filePanelAssociations ?? {};
  });
}
