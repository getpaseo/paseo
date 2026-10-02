import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { gotoWorkspace } from "./launcher";
import { buildAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";
import { ensureExplorerSidebar } from "./workspace-tabs";

type ExplorerPanelWorkspace = Awaited<ReturnType<typeof seedWorkspace>>;

async function writePanelPlugin(id: string, title: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-explorer-menu-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `
import React from "react";
import { Text } from "react-native";
export default function contribute(client) {
  client.addWorkspacePanel({ id: "review", title: ${JSON.stringify(title)}, icon: "Blocks", context: "workspace", locations: ["workspace", "explorer"], Component: ({ workspaceId }) => <Text>{${JSON.stringify(title)} + " workspace " + workspaceId}</Text> });
  client.addWorkspacePanel({ id: "summary", title: ${JSON.stringify(`${title} summary`)}, icon: "Blocks", context: "workspace", locations: ["explorer"], Component: () => <Text>Summary content</Text> });
  client.addWorkspacePanel({ id: "main", title: ${JSON.stringify(`${title} main only`)}, icon: "Blocks", context: "workspace", Component: () => null });
  client.addWorkspacePanel({ id: "agent", title: ${JSON.stringify(`${title} agent`)}, icon: "Blocks", context: "agent", locations: ["explorer"], Component: () => null });
  return () => {};
}`,
  );
  return directory;
}

async function openExplorerMenu(page: Page) {
  const explorer = await ensureExplorerSidebar(page);
  await explorer.getByRole("button", { name: "New tab", exact: true }).click();
  const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("opacity", "1");
  return menu;
}

async function launchExplorerView(page: Page, name: string | RegExp) {
  const menu = await openExplorerMenu(page);
  await menu.getByRole("menuitem", { name, exact: true }).click();
  await expect(menu).not.toBeVisible();
}

export async function withExplorerPanelPlugins(
  page: Page,
  run: (workspace: ExplorerPanelWorkspace) => Promise<void>,
) {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const workspace = await seedWorkspace({ repoPrefix: "explorer-plugin-menu-" });
  const first = await writePanelPlugin("explorer-review", "Review");
  const second = await writePanelPlugin("explorer-other", "Other review");
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(first);
    await client.installDirectoryPlugin(second);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);

    await run(workspace);
  } finally {
    await client.removePlugin("explorer-review");
    await client.removePlugin("explorer-other");
    await client.patchDaemonConfig({
      pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
    });
    await client.close();
    await workspace.cleanup();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
}

export async function expectWorkspacePanelsInExplorerLauncher(page: Page) {
  const menu = await openExplorerMenu(page);
  await expect(menu.getByRole("menuitem", { name: "Review", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Review agent", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Review main only", exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
}

export async function openWorkspacePanelFromExplorerMenu(
  page: Page,
  workspace: ExplorerPanelWorkspace,
  testInfo: TestInfo,
) {
  const menu = await openExplorerMenu(page);
  await testInfo.attach("explorer-panel-menu", {
    body: await page.screenshot({ path: testInfo.outputPath("explorer-panel-menu.png") }),
    contentType: "image/png",
  });
  await expect(menu.getByRole("menuitem", { name: "Review", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Other review", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Review summary", exact: true })).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Other review summary", exact: true }),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: "Review", exact: true }).click();
  await expect(
    page.getByText(`Review workspace ${workspace.workspaceId}`, { exact: true }),
  ).toBeVisible();
}

export async function expectIndependentExplorerPanelTabs(
  page: Page,
  workspace: ExplorerPanelWorkspace,
) {
  await launchExplorerView(page, "Other review");
  await expect(
    page.getByText(`Other review workspace ${workspace.workspaceId}`, { exact: true }),
  ).toBeVisible();
  await launchExplorerView(page, "Review summary");
  const tabs = page.getByTestId("workspace-explorer-sidebar").getByTestId("workspace-tabs-row");
  await expect(tabs.getByRole("button", { name: "Review", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Other review", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Review summary", exact: true })).toBeVisible();
  await tabs
    .getByRole("button", { name: "Review", exact: true })
    .click({ button: "right", position: { x: 12, y: 13 } });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(tabs.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
  await expect(tabs.getByRole("button", { name: "Other review", exact: true })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Review summary", exact: true })).toBeVisible();
  await launchExplorerView(page, /^Files/);
  await launchExplorerView(page, /^Files/);
  await expect(
    tabs.getByRole("button", { name: "Browse workspace files", exact: true }),
  ).toHaveCount(3);
}

export async function expectExplorerPanelWithFocusedAgent(
  page: Page,
  workspace: ExplorerPanelWorkspace,
  testInfo: TestInfo,
) {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Focused agent",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  await page.goto(buildAgentRoute(workspace.workspaceId, agent.id));
  await expect(
    page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }),
  ).toHaveAttribute("aria-selected", "true");
  const menu = await openExplorerMenu(page);
  await expect(menu.getByRole("menuitem", { name: "Review agent", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Other review agent", exact: true })).toHaveCount(
    0,
  );
  await menu.getByRole("menuitem", { name: "Review", exact: true }).click();
  await expect(
    page.getByText(`Review workspace ${workspace.workspaceId}`, { exact: true }),
  ).toBeVisible();
  await testInfo.attach("workspace-panel-with-focused-agent", {
    body: await page.screenshot({
      path: testInfo.outputPath("workspace-panel-with-focused-agent.png"),
    }),
    contentType: "image/png",
  });
}
