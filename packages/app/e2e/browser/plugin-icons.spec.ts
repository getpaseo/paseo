import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

const PLUGIN_ID = "plugin-icons-e2e";
const SVG_PATH = "M4 12l5 5L20 6";

const pluginClientSource = `import React from "react";
import { Text, View } from "react-native";

const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="${SVG_PATH}" /></svg>';

function BadgeIcon({ size, color }) {
  return <View testID="plugin-component-icon" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

function Panel() {
  return <View><Text>Plugin icon panel</Text></View>;
}

const panels = [
  { id: "lucide", title: "Lucide icon panel", icon: "Scan" },
  { id: "svg", title: "SVG icon panel", icon: { svg: checkIcon } },
  { id: "component", title: "Component icon panel", icon: BadgeIcon },
];

export default function contribute(client) {
  for (const panel of panels) {
    client.addWorkspacePanel({ ...panel, context: "workspace", Component: Panel });
    client.addCommandCenterItem({
      id: panel.id,
      title: "Open " + panel.title,
      icon: panel.icon,
      context: "workspace",
      onSelect({ openPanel }) { openPanel(panel.id); },
    });
  }
  return () => {};
}`;

function pluginTab(page: Page, panelId: string): Locator {
  const identity = `${PLUGIN_ID.length}_${PLUGIN_ID}_${panelId.length}_${panelId}`;
  return page.getByTestId(`workspace-tab-plugin_workspace_${identity}`).filter({ visible: true });
}

async function runCommand(page: Page, title: string): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

test.describe("plugin icons", () => {
  test.describe.configure({ timeout: 180_000 });

  test("renders a Lucide name, inline SVG, and a component", async ({ page }, testInfo) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-icons-e2e-"));
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    const workspace = await seedWorkspace({ repoPrefix: "plugin-icons-" });
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), pluginClientSource);

    try {
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(directory);
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoAppShell(page);
      const target = { serverId: getServerId(), workspaceId: workspace.workspaceId };
      await waitForWorkspaceInSidebar(page, target);
      await switchWorkspaceViaSidebar({ page, ...target });

      await test.step("Command Center rows draw each icon form", async () => {
        const panel = await openCommandCenter(page);
        await panel.getByTestId("command-center-input").fill("icon panel");
        for (const title of ["Lucide icon panel", "SVG icon panel", "Component icon panel"]) {
          await expect(
            panel.getByRole("button", { name: `Open ${title}`, exact: true }),
          ).toBeVisible();
        }
        await expect(
          panel
            .getByRole("button", { name: "Open SVG icon panel", exact: true })
            .locator(`path[d="${SVG_PATH}"]`),
        ).toBeVisible();
        await expect(
          panel
            .getByRole("button", { name: "Open Component icon panel", exact: true })
            .getByTestId("plugin-component-icon"),
        ).toBeVisible();
        await capture(page, testInfo, "command-center-icons");
        await page.keyboard.press("Escape");
      });

      await test.step("workspace panel tabs draw each icon form", async () => {
        await runCommand(page, "Open Lucide icon panel");
        await runCommand(page, "Open SVG icon panel");
        await runCommand(page, "Open Component icon panel");
        await expect(pluginTab(page, "lucide").locator("svg")).toBeVisible();
        await expect(pluginTab(page, "svg").locator(`path[d="${SVG_PATH}"]`)).toBeVisible();
        await expect(
          pluginTab(page, "component").getByTestId("plugin-component-icon"),
        ).toBeVisible();
        await capture(page, testInfo, "workspace-tab-icons");
      });
    } finally {
      try {
        await client.removePlugin(PLUGIN_ID);
      } finally {
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await workspace.cleanup();
        await client.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
