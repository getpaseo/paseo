import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import {
  expandStatusProject,
  expectCollapsedProjectStatus,
  expectProjectStatusHidden,
  openAndCollapseStatusProject,
  seedStatusProject,
  startNeedsInputWorkspace,
} from "../helpers/project-status-badge";

const STATUS_RENDERER_SOURCE = `
import { View } from "react-native";
import type { PluginWorkspaceStatusRendererProps } from "@getpaseo/plugin/client";

function FixtureStatus({ statusDetails, activities, size, theme }: PluginWorkspaceStatusRendererProps) {
  const children = statusDetails?.subordinates.filter((item) => item.status === "running") ?? [];
  const members = (activities ?? []).flatMap((activity) =>
    (activity.items ?? []).map((item) => ({ id: activity.id + "/" + item.id, label: item.label })),
  );
  const summary = "roots:" + statusDetails?.roots.length + ";root:" + statusDetails?.rootStatus
    + ";native:" + statusDetails?.nativeStatus + ";children:" + children.length + ";members:" + members.length;
  return (
    <View testID="fixture-workspace-status" accessibilityLabel={summary} style={{ width: size, height: size, alignItems: "center", justifyContent: "center", gap: 2 }}>
      <View testID="fixture-status-root" style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.foregroundMuted }} />
      <View style={{ flexDirection: "row", gap: 1 }}>
        {children.map((item) => <View key={item.id} testID="fixture-status-child" accessibilityLabel={item.id} style={{ width: 4, height: 5, backgroundColor: "#8b5cf6" }} />)}
        {members.map((item) => <View key={item.id} testID="fixture-status-member" accessibilityLabel={item.label} style={{ width: 4, height: 5, backgroundColor: "#0ea5e9" }} />)}
      </View>
    </View>
  );
}

export default function(client) {
  return client.addWorkspaceStatusRenderer({ id: "fixture", Component: FixtureStatus });
}
`;

test("plugin activities keep idle workspaces running and yield to native needs-input", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const project = await seedStatusProject();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-activity-ui-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const pluginId = "workspace-activity-e2e";
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: pluginId, requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `export default function(server) {
    server.addWorkspaceActivity({ id: "tasks", workspaceId: ${JSON.stringify(project.seed.workspaceId)}, kind: "background-task", label: "Background tasks", count: 2, status: "running", icon: "Timer" });
    return () => {};
  }`,
  );
  try {
    await openAndCollapseStatusProject(page, project);
    await expectProjectStatusHidden(page, project);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const group = page.getByRole("group", { name: project.seed.projectDisplayName, exact: true });
    await expect(group.getByRole("status", { name: "Background tasks · 2" })).toBeVisible();
    await expect(group.getByTestId("project-status-indicator-plugin")).toBeVisible();
    await expandStatusProject(page, project);
    await expect(group.getByTestId("workspace-plugin-activities")).toHaveText(
      "Background tasks · 2",
    );
    await expect(group.getByTestId("workspace-status-indicator-plugin")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("workspace-background-tasks.png"),
      animations: "disabled",
    });

    await client.disablePlugin(pluginId);
    await expect(group.getByTestId("workspace-plugin-activities")).toHaveCount(0);
    await client.enablePlugin(pluginId);
    await expect(group.getByTestId("workspace-plugin-activities")).toBeVisible();
    await startNeedsInputWorkspace(project);
    await group
      .getByRole("button")
      .filter({ hasText: project.seed.projectDisplayName })
      .first()
      .click();
    await page.mouse.move(1200, 850);
    await expectCollapsedProjectStatus(page, project, "Needs input");
    await expect(group.getByTestId("project-status-indicator-plugin")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("workspace-native-priority.png"),
      animations: "disabled",
    });
  } finally {
    await client.removePlugin(pluginId).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await project.seed.cleanup().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace status renderer receives native state and task members and restores the default", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const project = await seedStatusProject();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-status-renderer-ui-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const pluginId = "workspace-status-renderer-e2e";
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: pluginId, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), STATUS_RENDERER_SOURCE);
  await writeFile(
    path.join(directory, "index.server.ts"),
    `export default function(server) {
    server.addWorkspaceActivity({ id: "tasks", workspaceId: ${JSON.stringify(project.seed.workspaceId)}, kind: "background-task", label: "Background tasks", status: "running", items: [{id:"build",label:"Build"},{id:"watch",label:"Watch"}] });
    return () => {};
  }`,
  );
  try {
    const parent = await project.seed.client.createAgent({
      provider: "mock",
      cwd: project.seed.repoPath,
      workspaceId: project.seed.workspaceId,
      title: "Idle root",
      modeId: "load-test",
      model: "thirty-minute-stream",
    });
    const child = await project.seed.client.createAgent({
      provider: "mock",
      cwd: project.seed.repoPath,
      workspaceId: project.seed.workspaceId,
      title: "Working child",
      modeId: "load-test",
      model: "thirty-minute-stream",
      labels: { "paseo.parent-agent-id": parent.id },
      initialPrompt: "keep streaming for the test",
    });
    await openAndCollapseStatusProject(page, project);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await expandStatusProject(page, project);
    const group = page.getByRole("group", { name: project.seed.projectDisplayName, exact: true });
    const row = group.getByRole("button", { name: /^Working workspace(?:,|$)/ });
    const renderer = row.getByTestId("fixture-workspace-status");
    await expect(renderer).toHaveAttribute(
      "aria-label",
      "roots:1;root:done;native:running;children:1;members:2",
    );
    await expect(renderer.getByTestId("fixture-status-root")).toBeVisible();
    await expect(renderer.getByTestId("fixture-status-child")).toHaveAttribute(
      "aria-label",
      "paseo/" + child.id,
    );
    await expect(renderer.getByTestId("fixture-status-member")).toHaveCount(2);
    await expect(renderer.getByTestId("fixture-status-member").nth(0)).toHaveAttribute(
      "aria-label",
      "Build",
    );
    await expect(renderer.getByTestId("fixture-status-member").nth(1)).toHaveAttribute(
      "aria-label",
      "Watch",
    );
    await row.screenshot({
      path: testInfo.outputPath("workspace-status-renderer.png"),
      animations: "disabled",
    });
    await page.screenshot({
      path: testInfo.outputPath("workspace-status-renderer-full-page.png"),
      fullPage: true,
      animations: "disabled",
    });
    await project.seed.client.cancelAgent(child.id);
    await expect(renderer).toHaveAttribute(
      "aria-label",
      "roots:1;root:done;native:done;children:0;members:2",
    );
    await expect(renderer.getByTestId("fixture-status-child")).toHaveCount(0);
    await expect(renderer.getByTestId("fixture-status-member")).toHaveCount(2);
    await row.screenshot({
      path: testInfo.outputPath("workspace-status-background-tasks.png"),
      animations: "disabled",
    });

    await writeFile(
      path.join(directory, "index.client.tsx"),
      `export default function(client) { return client.addWorkspaceStatusRenderer({ id: "broken", Component() { throw new Error("fixture renderer failed"); } }); }`,
    );
    await client.reloadPlugin(pluginId);
    await expect(row.getByTestId("fixture-workspace-status")).toHaveCount(0);
    await expect(row.getByTestId("workspace-status-indicator-plugin")).toBeVisible();
    await client.disablePlugin(pluginId);
    await expect(row.getByTestId("workspace-status-indicator-done")).toBeVisible();
  } finally {
    await client.removePlugin(pluginId).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await project.seed.cleanup().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
