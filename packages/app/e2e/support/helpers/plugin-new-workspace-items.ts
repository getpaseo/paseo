import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import {
  archiveWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  expectWorkspaceIsolationSelected,
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
    void newWorkspace.setIsolation("worktree");
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

/**
 * An item whose search depends on the project: it answers with the project's name, and never
 * answers for the project named "other", so a list that still shows the first project's answer
 * there is stale.
 */
async function replaceWithProjectSearchItem(directory: string) {
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `import { useNewWorkspace } from "@getpaseo/plugin/client";
import { Combobox } from "@getpaseo/plugin/client/ui";
function ProjectIssues() {
  const { project } = useNewWorkspace();
  const name = project?.name ?? "";
  return (
    <Combobox
      title="Issue"
      icon="CircleDot"
      value={null}
      search={() =>
        name.includes("other")
          ? new Promise(() => {})
          : Promise.resolve([{ id: name, label: "Issue of " + name }])
      }
      onSelect={() => {}}
    />
  );
}
export default function contribute(client) {
  client.addNewWorkspaceItem({ id: "project-issues", Component: ProjectIssues });
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
  options: {
    compact: boolean;
    detachedHead?: boolean;
    setsOnMount?: boolean;
    /** Installs an item whose Issue list depends on the project instead of the example's. */
    searchesByProject?: boolean;
    /** A second project the screen can switch to. */
    otherProject?: boolean;
  },
  run: (screen: {
    chooseWorktree(): Promise<void>;
    chooseIssue(label: string): Promise<void>;
    createWorkspace(options?: { prompt?: string }): Promise<{ branch: string; metadata: unknown }>;
    switchToOtherProject(): Promise<void>;
    openIssueList(): Promise<void>;
    closeIssueList(): Promise<void>;
    /** The Issue list shows `text`, or does not show it when `shown` is false. */
    expectIssueListText(text: string, shown: boolean): Promise<void>;
    /** The name the first project's items read as `project.name`. */
    firstProjectName: string;
    expectIsolation(isolation: "local" | "worktree"): Promise<void>;
    /** Removes the plugin, leaves the screen, and opens New workspace for the project again. */
    reopenWithoutPlugin(): Promise<void>;
  }) => Promise<void>,
) {
  const client = await connectNewWorkspaceDaemonClient();
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("new-workspace-issues");
  if (options.searchesByProject) await replaceWithProjectSearchItem(example.directory);
  if (options.setsOnMount) await replaceWithMountEffectItem(example.directory);
  const repo = await createTempGitRepo("new-workspace-issues-", { branches: ["main"] });
  const otherRepo = options.otherProject
    ? await createTempGitRepo("new-workspace-other-", { branches: ["main"] })
    : null;
  let createdDirectory: string | null = null;
  try {
    // A detached HEAD leaves the screen with no default base to branch off.
    if (options.detachedHead) execFileSync("git", ["checkout", "--detach"], { cwd: repo.path });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    const project = await openProjectViaDaemon(client, repo.path);
    const other = otherRepo ? await openProjectViaDaemon(client, otherRepo.path) : null;
    let target = project;
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
      firstProjectName: project.projectDisplayName,
      openIssueList: () =>
        test.step("open the Issue list", async () => {
          await page.getByRole("button", { name: "Issue", exact: true }).click();
        }),
      closeIssueList: () => test.step("close the Issue list", () => page.keyboard.press("Escape")),
      expectIssueListText: (text, shown) =>
        test.step(`the Issue list ${shown ? "shows" : "does not show"} "${text}"`, async () => {
          const list = page.getByTestId("combobox-desktop-container").last();
          await expect(list.getByText(text, { exact: true })).toHaveCount(shown ? 1 : 0);
        }),
      switchToOtherProject: () =>
        test.step("switch to the other project", async () => {
          if (!other) throw new Error("Open the example with otherProject to switch projects");
          await page.getByRole("button", { name: "Workspace project" }).click();
          await page
            .getByTestId("combobox-desktop-container")
            .last()
            .getByText(other.projectDisplayName, { exact: true })
            .click();
          await expect(page.getByRole("button", { name: "Workspace project" })).toContainText(
            other.projectDisplayName,
          );
          target = other;
        }),
      expectIsolation: (isolation) =>
        test.step(`the screen is on ${isolation}`, () =>
          expectWorkspaceIsolationSelected(page, isolation)),
      reopenWithoutPlugin: () =>
        test.step("reopen the screen without the plugin", async () => {
          await client.removePlugin(PLUGIN_ID);
          // Leaving the screen drops its in-memory choice, so only the saved preference is left.
          await page.goBack();
          await expect(page.getByTestId("workspace-create-isolation-trigger")).toHaveCount(0);
          await openNewWorkspaceComposer(page, project);
          await expect(page.getByRole("button", { name: "Mount", exact: true })).toHaveCount(0);
        }),
      createWorkspace: (createOptions) =>
        test.step("create the workspace and read what it carries", async () => {
          await submitCreate(page, createOptions?.prompt);
          const created = await assertNewWorkspaceSidebarAndHeader(page, {
            serverId: getServerId(),
            client,
            previousWorkspaceId: target.workspaceId,
            projectDisplayName: target.projectDisplayName,
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
    await otherRepo?.cleanup();
  }
}
