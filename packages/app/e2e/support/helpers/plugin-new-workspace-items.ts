import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type Page } from "@playwright/test";
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

/** Presses Create, typing the prompt first unless the test wants an empty one. */
async function submitCreate(page: Page, prompt: string | undefined) {
  if (prompt !== "") return submitNewWorkspacePrompt(page, prompt);
  await page.getByTestId("message-input-root").getByRole("button", { name: "Create" }).click();
}

/** An item that sets the branch and metadata from its mount effect, before the user touches anything. */
async function replaceWithMountEffectItem(directory: string) {
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `import { useEffect } from "react";
import { useNewWorkspace } from "@getpaseo/plugin/client";
import { Action } from "@getpaseo/plugin/client/ui";
function OnMount() {
  const newWorkspace = useNewWorkspace();
  useEffect(() => {
    void newWorkspace.setBranch("set-on-mount");
    void newWorkspace.setMetadata({ "new-workspace-issues.issue": "ON-MOUNT" });
  }, []);
  return <Action title="Mount" icon="Flag" onPress={() => {}} />;
}
export default function contribute(client) {
  client.addNewWorkspaceItem({ id: "on-mount", Component: OnMount });
  return () => {};
}
`,
  );
}

type Client = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

/** The daemon fills in the git runtime after it creates the workspace, so wait for the branch. */
async function readCreatedWorkspace(client: Client, workspaceId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { entries } = await client.fetchWorkspaces();
    const workspace = entries.find((entry) => entry.id === workspaceId);
    const branch = workspace?.gitRuntime?.currentBranch ?? null;
    if (workspace && branch) return { branch, metadata: workspace.metadata };
    if (Date.now() > deadline) throw new Error(`Workspace ${workspaceId} never reported a branch`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const PLUGIN_ID = "new-workspace-issues-example";
const COMPACT = { width: 500, height: 800 };

/** Runs `run` on the New workspace screen with the new-workspace-issues example installed. */
export async function withNewWorkspaceIssuesExample(
  page: Page,
  options: { compact: boolean; detachedHead?: boolean; setsOnMount?: boolean },
  run: (screen: {
    chooseWorktree(): Promise<void>;
    chooseIssue(label: string): Promise<void>;
    createWorkspace(options?: { prompt?: string }): Promise<{ branch: string; metadata: unknown }>;
  }) => Promise<void>,
) {
  const client = await connectNewWorkspaceDaemonClient();
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("new-workspace-issues");
  if (options.setsOnMount) await replaceWithMountEffectItem(example.directory);
  const repo = await createTempGitRepo("new-workspace-issues-", { branches: ["main"] });
  let createdDirectory: string | null = null;
  try {
    // A detached HEAD leaves the screen with no default base to branch off.
    if (options.detachedHead) execFileSync("git", ["checkout", "--detach"], { cwd: repo.path });
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
      createWorkspace: (createOptions) =>
        test.step("create the workspace and read what it carries", async () => {
          await submitCreate(page, createOptions?.prompt);
          const created = await assertNewWorkspaceSidebarAndHeader(page, {
            serverId: getServerId(),
            client,
            previousWorkspaceId: project.workspaceId,
            projectDisplayName: project.projectDisplayName,
            // The sidebar is closed at compact width.
            assertSidebarRow: !options.compact,
          });
          createdDirectory = created.workspaceDirectory;
          return readCreatedWorkspace(client, created.workspaceId);
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
