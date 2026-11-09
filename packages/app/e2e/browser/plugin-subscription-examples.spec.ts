import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

async function runCommand(page: Page, title: string): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

/** Installs a plugin example, opens a seeded workspace, and runs `exercise` against them. */
async function withExample(
  page: Page,
  example: { name: string; id: string },
  exercise: (workspace: SeededWorkspace) => Promise<void>,
): Promise<void> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const copy = await copyPluginExample(example.name);
  const workspace = await seedWorkspace({ repoPrefix: `${example.name}-` });
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(copy.directory);
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoAppShell(page);
    const target = { serverId: getServerId(), workspaceId: workspace.workspaceId };
    await waitForWorkspaceInSidebar(page, target);
    await switchWorkspaceViaSidebar({ page, ...target });
    await exercise(workspace);
  } finally {
    try {
      await client.removePlugin(example.id);
    } finally {
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
      await workspace.cleanup();
      await client.close();
      await copy.cleanup();
    }
  }
}

test.describe("plugin subscriptions", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a panel follows events the daemon pushes as files change", async ({ page }) => {
    await withExample(page, { name: "diff-watch", id: "diff-watch" }, async (workspace) => {
      await runCommand(page, "Open live changes");
      await expect(page.getByText("No changes", { exact: true })).toBeVisible();

      await writeFile(path.join(workspace.repoPath, "pushed.txt"), "from the test\n");
      await expect(page.getByText("1 file changed", { exact: true })).toBeVisible();
      await expect(page.getByText("pushed.txt", { exact: true })).toBeVisible();
    });
  });

  test("a panel plays streamed bytes and sends bytes back", async ({ page }) => {
    await withExample(page, { name: "media-stream", id: "media-stream" }, async () => {
      await runCommand(page, "Open media stream");
      await expect(page.getByText("live", { exact: true })).toBeVisible();
      await expect(page.getByText(/^[1-9]\d* video frames/)).toBeVisible();

      await page.getByRole("button", { name: "Send this frame back", exact: true }).click();
      await expect(
        page.getByText(/^The daemon received [1-9]\d* bytes, sha256 [0-9a-f]{12}$/),
      ).toBeVisible();
    });
  });
});
