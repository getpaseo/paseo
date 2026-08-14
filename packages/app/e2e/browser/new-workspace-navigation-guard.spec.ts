import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  countWorkspaceAgents,
  countWorkspaceTerminals,
  delayBrowserWorkspaceCreatedResponse,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  waitForCreatedWorkspace,
} from "../support/helpers/new-workspace";
import { createTempGitRepo } from "../support/helpers/workspace";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { getServerId } from "../support/helpers/server-id";
import {
  expectTerminalOutputContains,
  expectWorkspaceOpensWithTerminalTab,
  fillTerminalPrompt,
  seedTerminalProfiles,
  selectLaunchOption,
  submitTerminalLaunch,
  type TerminalProfile,
} from "../support/helpers/new-workspace-launch";
import {
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

const PROMPT = "Hello from the navigation guard";

const NAVIGATION_SETTLE_MS = 5_000;

// The prompt is substituted in as `$0`, so it reaches the process exactly as typed. `sleep` holds
// the terminal open past the daemon polling this test does before it attaches — a process that has
// already exited has no output left to render.
const TERMINAL_PROFILE: TerminalProfile = {
  id: "e2e-nav-guard-echo",
  name: "Nav Guard Echo",
  command: "/bin/sh",
  args: ["-c", 'echo captured: "$0"; sleep 120', "{{{prompt}}}"],
};

test.describe("New workspace navigation guard", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceDirectory of createdWorktreeDirectories) {
        await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    await client?.close().catch(() => undefined);
  });

  test("stays put when creation resolves after the user moved on, and still starts the agent", async ({
    page,
  }) => {
    const serverId = getServerId();
    const tempRepo = await createTempGitRepo("new-workspace-nav-guard-");
    const createDelay = await delayBrowserWorkspaceCreatedResponse(page);

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);
      const knownWorkspaceIds = new Set(
        (await client.fetchWorkspaces()).entries.map((entry) => entry.id),
      );

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill(PROMPT);
      await page.getByTestId("message-input-root").getByRole("button", { name: "Create" }).click();

      // The daemon is still running `git worktree add`; leave before it answers.
      await createDelay.waitForCreateRequest();
      const originalRoute = buildHostWorkspaceRoute(serverId, openedProject.workspaceId);
      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      createDelay.release();

      // Wait for the agent the background path is responsible for creating, then prove the app
      // never followed it. Polling the daemon rather than the URL keeps this ordering explicit.
      const createdWorkspace = await waitForCreatedWorkspace(client, knownWorkspaceIds);
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      await expect
        .poll(() => countWorkspaceAgents(client, createdWorkspace.id), { timeout: 60_000 })
        .toBe(1);
      await expectAppRoute(page, originalRoute);

      // Opening the workspace shows one real agent tab — not an orphaned draft tab, which would
      // create a second agent on mount.
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: createdWorkspace.id });
      const deckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.id}`)
        .filter({ visible: true });
      await expect(deckEntry.locator('[data-testid^="workspace-tab-agent_"]')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(deckEntry.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
      await expect(deckEntry.getByText(PROMPT).first()).toBeVisible({ timeout: 30_000 });
      expect(await countWorkspaceAgents(client, createdWorkspace.id)).toBe(1);
    } finally {
      createDelay.release();
      await tempRepo.cleanup();
    }
  });

  test("stays put when a terminal launch resolves after the user moved on, and still spawns the terminal", async ({
    page,
  }) => {
    const serverId = getServerId();
    const tempRepo = await createTempGitRepo("new-workspace-nav-guard-terminal-");
    const profileSeed = await seedTerminalProfiles([TERMINAL_PROFILE]);
    const createDelay = await delayBrowserWorkspaceCreatedResponse(page);

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);
      const knownWorkspaceIds = new Set(
        (await client.fetchWorkspaces()).entries.map((entry) => entry.id),
      );

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectLaunchOption(page, TERMINAL_PROFILE.id);
      await fillTerminalPrompt(page, PROMPT);
      await submitTerminalLaunch(page);

      await createDelay.waitForCreateRequest();
      const originalRoute = buildHostWorkspaceRoute(serverId, openedProject.workspaceId);
      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      createDelay.release();

      const createdWorkspace = await waitForCreatedWorkspace(client, knownWorkspaceIds);
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      // Wait for the terminal, not just the workspace. The launch path spawns the terminal and
      // then navigates, so asserting the route on the workspace alone would race ahead of the
      // navigation this test exists to catch and pass either way.
      await expect
        .poll(() => countWorkspaceTerminals(client, createdWorkspace.id), { timeout: 60_000 })
        .toBe(1);
      // "Nothing navigated" is a negative, so it needs a window rather than a single poll, which
      // would pass on its first sample. The daemon lists the terminal before the browser has its
      // create response back, and the unguarded code navigates a couple of seconds after that.
      await page.waitForTimeout(NAVIGATION_SETTLE_MS);
      await expectAppRoute(page, originalRoute);

      // The terminal spawned with the prompt even though nothing navigated, and its tab opens on
      // its own when the workspace is finally visited.
      await switchWorkspaceViaSidebar({ page, serverId, workspaceId: createdWorkspace.id });
      await expectWorkspaceOpensWithTerminalTab(page);
      await expectTerminalOutputContains(page, `captured: ${PROMPT}`);
    } finally {
      createDelay.release();
      await profileSeed.restore();
      await tempRepo.cleanup();
    }
  });
});
