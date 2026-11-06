import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { copyPluginExample } from "./plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { seedWorkspace } from "./seed-client";
import { gotoWorkspace } from "./launcher";
import { openSidebarNavSettings, leaveSettings } from "./sidebar-nav-settings";
import { visibleTestId } from "./plugin-sidebar-items";
import { getServerId } from "./server-id";

export async function withSidebarViews(
  page: Page,
  run: (views: ReturnType<typeof sidebarViews>) => Promise<void>,
) {
  const example = await copyPluginExample("sidebar-views");
  const entry = path.join(example.directory, "index.client.tsx");
  const original = await readFile(entry, "utf8");
  await writeFile(
    entry,
    original.replace(
      "return client.addSidebarView",
      'client.addSidebarView({ id: "broken", title: "Broken example", Component() { throw new Error("View failed"); } });\n  return client.addSidebarView',
    ),
  );
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-views-",
    title: "Sidebar view workspace",
  });
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await run(sidebarViews(page, workspace.workspaceId, client));
  } finally {
    await client.removePlugin("sidebar-views");
    await client.close();
    await workspace.cleanup();
    await example.cleanup();
  }
}
function sidebarViews(
  page: Page,
  workspaceId: string,
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
) {
  const builtinRow = () =>
    visibleTestId(page, `sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  async function choose(title: string) {
    await openSidebarNavSettings(page);
    await page.getByRole("button", { name: /^View:/ }).click();
    await page.getByRole("menuitem", { name: title, exact: true }).click();
    await expect(page.getByRole("button", { name: `View: ${title}`, exact: true })).toBeVisible();
    await leaveSettings(page);
  }
  async function expectDefault() {
    await expect(builtinRow()).toBeVisible();
  }
  async function expectPlugin() {
    await expect(
      visibleTestId(page, "plugin-sidebar-view").getByText("Sidebar view workspace", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(builtinRow()).toHaveCount(0);
    await expect(visibleTestId(page, "sidebar-global-new-workspace")).toBeVisible();
    await expect(visibleTestId(page, "sidebar-settings")).toBeVisible();
  }
  return {
    expectDefault,
    async chooseWorkspaces() {
      await choose("Example workspaces");
      await expectPlugin();
    },
    async restoreDefault() {
      await choose("Default view");
      await expectDefault();
    },
    async recoverFromFailure() {
      await choose("Broken example");
      await expect(page.getByText("Sidebar view failed to load.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Use default view", exact: true }).click();
      await expectDefault();
    },
    async disableChosenView() {
      await client.disablePlugin("sidebar-views");
      await expectDefault();
      await openSidebarNavSettings(page);
      await expect(
        page.getByText("The selected view is unavailable or disabled. Showing Default view.", {
          exact: true,
        }),
      ).toBeVisible();
      await leaveSettings(page);
    },
  };
}
