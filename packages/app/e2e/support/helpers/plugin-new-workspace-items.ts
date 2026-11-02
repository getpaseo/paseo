import { expect, test, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import {
  archiveWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  submitNewWorkspacePrompt,
} from "./new-workspace";
import { copyPluginExample } from "./plugin-fixture";
import { getServerId } from "./server-id";
import { createTempGitRepo } from "./workspace";
import { waitForSidebarHydration } from "./workspace-ui";

const PLUGIN_ID = "new-workspace-issues-example";
const COMPACT = { width: 500, height: 800 };

/** Runs `run` on the New workspace screen with the new-workspace-issues example installed. */
export async function withNewWorkspaceIssuesExample(
  page: Page,
  options: { compact: boolean },
  run: (screen: {
    chooseWorktree(): Promise<void>;
    chooseIssue(label: string): Promise<void>;
    createWorkspace(): Promise<{ branch: string | null; metadata: unknown }>;
  }) => Promise<void>,
) {
  const client = await connectNewWorkspaceDaemonClient();
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("new-workspace-issues");
  const repo = await createTempGitRepo("new-workspace-issues-", { branches: ["main"] });
  let createdDirectory: string | null = null;
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    const project = await openProjectViaDaemon(client, repo.path);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    // The sidebar rows used to reach the screen exist only at desktop width.
    if (options.compact) await page.setViewportSize(COMPACT);
    await run({
      chooseWorktree: () =>
        test.step("choose a new worktree", async () => {
          await page.getByTestId("workspace-create-isolation-trigger").click();
          await page.getByTestId("workspace-create-isolation-worktree").click();
        }),
      chooseIssue: (label) =>
        test.step(`choose the issue "${label}"`, async () => {
          await page.getByRole("button", { name: "Issue", exact: true }).click();
          await page.getByText(label, { exact: true }).click();
        }),
      createWorkspace: () =>
        test.step("create the workspace and read what it carries", async () => {
          await submitNewWorkspacePrompt(page);
          const created = await assertNewWorkspaceSidebarAndHeader(page, {
            serverId: getServerId(),
            client,
            previousWorkspaceId: project.workspaceId,
            projectDisplayName: project.projectDisplayName,
            // The sidebar is closed at compact width.
            assertSidebarRow: !options.compact,
          });
          createdDirectory = created.workspaceDirectory;
          const { entries } = await client.fetchWorkspaces();
          const workspace = entries.find((entry) => entry.id === created.workspaceId);
          expect(workspace).toBeDefined();
          return {
            branch: workspace?.gitRuntime?.currentBranch ?? null,
            metadata: workspace?.metadata,
          };
        }),
    });
  } finally {
    if (createdDirectory) {
      await archiveWorkspaceFromDaemon(client, createdDirectory).catch(() => undefined);
    }
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
    await repo.cleanup();
  }
}
