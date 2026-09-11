import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";

test("file menu contributions open and update a workspace panel", async ({ page }, testInfo) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const workspace = await seedWorkspace({ repoPrefix: "plugin-file-menu-" });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-file-menu-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "file-menu-test",
      requirements: pluginRequirements,
    }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `
import React, { useSyncExternalStore } from "react";
import { Text } from "react-native";
let selection = null;
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
function Panel({ workspaceId }) {
  const current = useSyncExternalStore(subscribe, () => selection);
  return <Text testID="selected-plugin-file">{current ? workspaceId + ":" + current.path + ":" + current.sequence : "No selection"}</Text>;
}
export default function contribute(client) {
  client.addWorkspacePanel({ id: "reader", title: "File reader", icon: "BookOpen", context: "workspace", Component: Panel });
  client.addFileMenuItem({ id: "read", title: "Read in plugin", icon: "BookOpen", onSelect(ctx) {
    ctx.openPanel("reader", { location: "workspace" });
    selection = { path: ctx.file.path, sequence: (selection?.sequence ?? 0) + 1 };
    listeners.forEach(listener => listener());
  }});
  return () => {};
}`,
  );
  let installed = false;
  try {
    await writeFile(path.join(workspace.repoPath, "first.ts"), "export const first = 1;\n");
    await writeFile(path.join(workspace.repoPath, "second.ts"), "export const second = 2;\n");
    await mkdir(path.join(workspace.repoPath, "folder"));
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    installed = true;
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    const openMenu = async (name: string) => {
      await page
        .getByTestId("file-explorer-tree-scroll")
        .getByText(name, { exact: true })
        .first()
        .click({ button: "right" });
      const menu = page.getByTestId(/file-explorer-row-\d+-context-menu$/);
      await expect(menu).toBeVisible();
      return menu;
    };
    for (const [index, name] of ["first.ts", "second.ts", "second.ts"].entries()) {
      const menu = await openMenu(name);
      if (index === 0)
        await testInfo.attach("file-menu", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      await menu.getByRole("menuitem", { name: "Read in plugin", exact: true }).click();
      await expect(page.getByTestId("selected-plugin-file")).toHaveText(
        `${workspace.workspaceId}:${name}:${index + 1}`,
      );
      await expect(page.getByTestId("selected-plugin-file")).toHaveCount(1);
      await expect(
        page
          .getByTestId("workspace-tab-plugin_workspace_14_file-menu-test_6_reader")
          .filter({ visible: true }),
      ).toHaveCount(1);
    }
    const folderMenu = await openMenu("folder");
    await expect(
      folderMenu.getByRole("menuitem", { name: "Read in plugin", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await testInfo.attach("selected-file-panel", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await client.removePlugin("file-menu-test");
    installed = false;
    const unloadedMenu = await openMenu("first.ts");
    await expect(
      unloadedMenu.getByRole("menuitem", { name: "Read in plugin", exact: true }),
    ).toHaveCount(0);
  } finally {
    if (installed) await client.removePlugin("file-menu-test");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await workspace.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
