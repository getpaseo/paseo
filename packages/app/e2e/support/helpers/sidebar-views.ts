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
      "const cleanups = [",
      'client.addSidebarView({ id: "broken", title: "Broken example", Component() { throw new Error("View failed"); } });\n  const cleanups = [',
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
    async exerciseExamples() {
      await choose("Example agents");
      await expect(
        visibleTestId(page, "plugin-sidebar-view").getByText("Respond", { exact: true }),
      ).toBeVisible();
      await choose("Example nested agents");
      await expectPlugin();
      await choose("Example label folders");
      const slot = visibleTestId(page, "plugin-sidebar-view");
      await slot
        .getByRole("button", { name: `Move workspace ${workspaceId}`, exact: true })
        .click();
      await slot.getByRole("button", { name: "Move to Inbox", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await client.fetchWorkspaces()).entries.find((item) => item.id === workspaceId)
              ?.labels,
        )
        .toContain("Inbox");
      await slot
        .getByRole("button", { name: `Move workspace ${workspaceId}`, exact: true })
        .click();
      await slot.getByRole("button", { name: "Move to Later", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await client.fetchWorkspaces()).entries.find((item) => item.id === workspaceId)
              ?.labels,
        )
        .toEqual(["Later"]);
      await client.setWorkspaceLabel({
        workspaceId,
        label: { name: "Unlabelled", color: "red" },
        assigned: true,
      });
      // Wait for the named label folder alongside the built-in unlabelled bucket.
      // Counts alone can match stale Inbox/Later rows from the preceding move.
      await expect(
        slot.getByRole("button", { name: "Toggle Unlabelled", exact: true }),
      ).toHaveCount(2);
      // Observe both label rows before removing Later so a stale single row
      // cannot satisfy the final readiness check.
      const moveWorkspace = slot.getByRole("button", {
        name: `Move workspace ${workspaceId}`,
        exact: true,
      });
      await expect(moveWorkspace).toHaveCount(2);
      await client.setWorkspaceLabel({
        workspaceId,
        label: { name: "Later", color: "red" },
        assigned: false,
      });
      await expect
        .poll(
          async () =>
            (await client.fetchWorkspaces()).entries.find((item) => item.id === workspaceId)
              ?.labels,
        )
        .toEqual(["Unlabelled"]);
      // The daemon reply does not guarantee the browser has applied the removal.
      await expect(moveWorkspace).toHaveCount(1);
      await moveWorkspace.click();
      await slot.getByRole("button", { name: "Move to Inbox", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await client.fetchWorkspaces()).entries.find((item) => item.id === workspaceId)
              ?.labels,
        )
        .toEqual(["Inbox"]);
    },
    async exerciseTerminals() {
      await choose("Example terminals");
      const slot = visibleTestId(page, "plugin-sidebar-view");
      await slot
        .getByRole("button", { name: `Terminals on ${getServerId()}`, exact: true })
        .click();
      await expect(slot.getByText("No terminals", { exact: true })).toBeVisible();
      const workspace = (await client.fetchWorkspaces()).entries.find(
        (item) => item.id === workspaceId,
      )!;
      const created = await client.createTerminal(
        workspace.workspaceDirectory,
        "Sidebar terminal",
        undefined,
        { workspaceId },
      );
      if (!created.terminal) throw new Error(created.error ?? "Terminal creation failed");
      try {
        await expect(
          slot.getByTestId(`sidebar-terminal-open-${created.terminal.id}`),
        ).toBeVisible();
        await slot.getByTestId(`sidebar-terminal-open-${created.terminal.id}`).click();
        await expect(page.getByTestId("terminal-surface").first()).toBeVisible();
        await slot.getByTestId(`sidebar-terminal-kill-${created.terminal.id}`).click();
        await expect
          .poll(async () => (await client.listTerminals()).terminals.map((item) => item.id))
          .not.toContain(created.terminal!.id);
        await expect(slot.getByText("No terminals", { exact: true })).toBeVisible();
      } finally {
        await client.killTerminal(created.terminal.id);
      }
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
