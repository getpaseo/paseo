import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { visibleTestId } from "../support/helpers/plugin-sidebar-items";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { closeSidebarDisplayPreferences, openSidebarDisplayPage } from "../support/helpers/sidebar";
import { leaveSettings, openSidebarNavSettings } from "../support/helpers/sidebar-nav-settings";

const PLUGIN_ID = "sidebar-view-badges-e2e";
const VIEW_TITLE = "Badge rows";

// Badge items plus a sidebar view that draws its own rows with them: every item, then a chosen
// subset in its own order, and the item list itself.
const PLUGIN_SOURCE = `import { useWorkspaceRowBadgeItems, useWorkspaces } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge, WorkspaceRowBadges } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";

const PLUGIN = "${PLUGIN_ID}";

function Review() {
  return <WorkspaceRowBadge icon="Eye" label="In review" tone="warning" />;
}

function Docs() {
  return <WorkspaceRowBadge icon="BookOpen" label="Docs" />;
}

function Rows() {
  const items = useWorkspaceRowBadgeItems();
  const workspaces = useWorkspaces({ orderBy: "name" });
  return (
    <View>
      <Text testID="badge-items">
        {items.map((item) => item.title + " on " + item.hostIds.join("+")).join(", ") || "No badge items"}
      </Text>
      {workspaces.map((workspace) => (
        <View key={workspace.key}>
          <View testID={"all-" + workspace.id} style={{ flexDirection: "row", gap: 6 }}>
            <WorkspaceRowBadges workspace={workspace} />
          </View>
          <View testID={"chosen-" + workspace.id} style={{ flexDirection: "row", gap: 6 }}>
            <WorkspaceRowBadges workspace={workspace} items={[PLUGIN + "/docs", "missing/item", PLUGIN + "/review"]} />
          </View>
        </View>
      ))}
    </View>
  );
}

export default function contribute(client) {
  const cleanups = [
    client.addWorkspaceRowBadgeItem({ id: "review", title: "Review state", icon: "Eye", Component: Review }),
    client.addWorkspaceRowBadgeItem({ id: "docs", title: "Docs state", icon: "BookOpen", Component: Docs }),
    client.addSidebarView({ id: "rows", title: "${VIEW_TITLE}", Component: Rows }),
  ];
  return () => {
    for (const cleanup of cleanups) void cleanup();
  };
}
`;

async function chooseView(page: Page, title: string) {
  await openSidebarNavSettings(page);
  await page.getByRole("button", { name: /^View:/ }).click();
  await page.getByRole("menuitem", { name: title, exact: true }).click();
  await expect(page.getByRole("button", { name: `View: ${title}`, exact: true })).toBeVisible();
  await leaveSettings(page);
}

async function toggleShowItem(page: Page, label: string) {
  await openSidebarDisplayPage(page, "sidebar-display-show");
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await closeSidebarDisplayPreferences(page);
}

test("a sidebar view draws and lists plugin row badges, following their Show toggles", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-view-badges-",
    title: "Badge view workspace",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-sidebar-view-badges-"));
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), PLUGIN_SOURCE);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);

    const slot = () => visibleTestId(page, "plugin-sidebar-view");
    const all = () => slot().getByTestId(`all-${workspace.workspaceId}`);
    const chosen = () => slot().getByTestId(`chosen-${workspace.workspaceId}`);
    const items = () => slot().getByTestId("badge-items");

    await test.step("the view lists every item and draws all of them, or the chosen ones in its order", async () => {
      await chooseView(page, VIEW_TITLE);
      await expect(items()).toHaveText(
        `Review state on ${getServerId()}, Docs state on ${getServerId()}`,
      );
      await expect(all()).toHaveText("In reviewDocs");
      await expect(chosen()).toHaveText("DocsIn review");
      await expect(all().getByLabel("In review", { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("sidebar-view-badges.png") });
    });

    await test.step("an item switched off in Show leaves the list and every row", async () => {
      await chooseView(page, "Default view");
      await toggleShowItem(page, "Review state");
      await chooseView(page, VIEW_TITLE);
      await expect(items()).toHaveText(`Docs state on ${getServerId()}`);
      await expect(all()).toHaveText("Docs");
      await expect(chosen()).toHaveText("Docs");
      await page.screenshot({ path: info.outputPath("sidebar-view-badges-hidden.png") });
    });

    await test.step("switching it back on restores it", async () => {
      await chooseView(page, "Default view");
      await toggleShowItem(page, "Review state");
      await chooseView(page, VIEW_TITLE);
      await expect(all()).toHaveText("In reviewDocs");
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await workspace.cleanup();
  }
});
