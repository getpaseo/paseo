import { existsSync } from "node:fs";
import path from "node:path";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  closeBranchPicker,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  delayBrowserAgentCreatedStatus,
  expectComposerGithubAttachmentPill,
  expectNewWorkspaceProjectSelected,
  expectPickerClosed,
  expectPickerOpen,
  expectPickerSelected,
  expectStartingRefPickerTriggerPr,
  openGlobalNewWorkspaceComposer,
  openBranchPicker,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  selectBranchInPicker,
  selectGitHubPrInPicker,
  selectPickerOptionByKeyboard,
  submitNewWorkspacePrompt,
} from "./helpers/new-workspace";
import { createTempGitRepo, readWorktreeBranchInfo } from "./helpers/workspace";
import { createTempGithubRepo, hasGithubAuth } from "./helpers/github-fixtures";
import { getServerId } from "./helpers/server-id";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "./helpers/workspace-ui";

interface WorkspaceStatusGroupEvent {
  rowTestId: string;
  bucket: string;
  indicatorTestId: string | null;
  label: string;
  at: number;
}

async function switchSidebarToStatusGrouping(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-grouping-selector").click();
  await page.getByTestId("sidebar-grouping-status").click();
  await expect(page.getByTestId("sidebar-status-group-done")).toBeVisible({ timeout: 30_000 });
}

async function startTrackingSidebarStatusGroups(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    interface StatusGroupEvent {
      rowTestId: string;
      bucket: string;
      indicatorTestId: string | null;
      label: string;
      at: number;
    }
    const win = window as typeof window & {
      __workspaceStatusGroupEvents?: StatusGroupEvent[];
      __workspaceStatusGroupObserver?: MutationObserver;
    };
    win.__workspaceStatusGroupEvents = [];
    win.__workspaceStatusGroupObserver?.disconnect();

    const capture = () => {
      const events = win.__workspaceStatusGroupEvents;
      if (!events) return;
      const groups = document.querySelectorAll<HTMLElement>(
        '[data-testid^="sidebar-status-group-"]',
      );
      for (const group of groups) {
        const groupTestId = group.getAttribute("data-testid") ?? "";
        const bucket = groupTestId.replace("sidebar-status-group-", "");
        const label = group.textContent ?? "";
        const block = group.parentElement?.parentElement;
        if (!block) continue;
        const rows = block.querySelectorAll<HTMLElement>('[data-testid^="sidebar-workspace-row-"]');
        for (const row of rows) {
          const rowTestId = row.getAttribute("data-testid");
          if (!rowTestId) continue;
          const indicatorTestId =
            row
              .querySelector<HTMLElement>('[data-testid^="workspace-status-indicator-"]')
              ?.getAttribute("data-testid") ?? null;
          const last = events.at(-1);
          if (
            last?.rowTestId === rowTestId &&
            last.bucket === bucket &&
            last.indicatorTestId === indicatorTestId
          ) {
            continue;
          }
          events.push({ rowTestId, bucket, indicatorTestId, label, at: performance.now() });
        }
      }
    };

    capture();
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    win.__workspaceStatusGroupObserver = observer;
  });
}

async function getTrackedSidebarStatusGroups(
  page: import("@playwright/test").Page,
): Promise<WorkspaceStatusGroupEvent[]> {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __workspaceStatusGroupEvents?: WorkspaceStatusGroupEvent[];
    };
    return win.__workspaceStatusGroupEvents ?? [];
  });
}

async function waitForWorkspaceStatusGroupEvent(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
  bucket: string;
}) {
  await input.page.waitForFunction(
    ({ expectedRowTestId, expectedBucket }) => {
      const win = window as typeof window & {
        __workspaceStatusGroupEvents?: WorkspaceStatusGroupEvent[];
      };
      for (const event of win.__workspaceStatusGroupEvents ?? []) {
        if (event.rowTestId === expectedRowTestId && event.bucket === expectedBucket) {
          return true;
        }
      }
      return false;
    },
    { expectedRowTestId: input.rowTestId, expectedBucket: input.bucket },
    { timeout: 30_000 },
  );
}

async function expectWorkspaceStatusGroupEvents(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
  includes: string;
  excludes: string;
  includesIndicator?: string;
  excludesIndicator?: string;
}) {
  await waitForWorkspaceStatusGroupEvent({
    page: input.page,
    rowTestId: input.rowTestId,
    bucket: input.includes,
  });
  const createdWorkspaceEvents = (await getTrackedSidebarStatusGroups(input.page)).filter(
    (event) => event.rowTestId === input.rowTestId,
  );
  expect(createdWorkspaceEvents.map((event) => event.bucket)).toContain(input.includes);
  expect(createdWorkspaceEvents.filter((event) => event.bucket === input.excludes)).toEqual([]);
  if (input.includesIndicator) {
    expect(createdWorkspaceEvents.map((event) => event.indicatorTestId)).toContain(
      input.includesIndicator,
    );
  }
  if (input.excludesIndicator) {
    expect(
      createdWorkspaceEvents.filter((event) => event.indicatorTestId === input.excludesIndicator),
    ).toEqual([]);
  }
}

async function submitNewWorkspaceWithoutPrompt(page: import("@playwright/test").Page) {
  const createButton = page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create" });
  await expect(createButton).toBeVisible({ timeout: 30_000 });
  await createButton.click();
}

test.describe("New workspace flow", () => {
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

  test("sidebar workspace navigation updates URL and header", async ({ page }) => {
    const serverId = getServerId();

    const firstRepo = await createTempGitRepo("workspace-nav-a-");
    const secondRepo = await createTempGitRepo("workspace-nav-b-");

    try {
      const firstWorkspace = await openProjectViaDaemon(client, firstRepo.path);
      const secondWorkspace = await openProjectViaDaemon(client, secondRepo.path);
      localWorkspaceIds.add(firstWorkspace.workspaceId);
      localWorkspaceIds.add(secondWorkspace.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
    } finally {
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });

  test("same-project workspaces switch content without requiring refresh", async ({ page }) => {
    const serverId = getServerId();

    const repo = await createTempGitRepo("workspace-nav-same-project-");

    try {
      const rootWorkspace = await openProjectViaDaemon(client, repo.path);
      const worktreeWorkspace = await createWorktreeViaDaemon(client, {
        cwd: repo.path,
        slug: `nav-${Date.now()}`,
      });
      localWorkspaceIds.add(rootWorkspace.workspaceId);
      createdWorktreeDirectories.add(worktreeWorkspace.workspaceDirectory);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: worktreeWorkspace.workspaceName,
        subtitle: worktreeWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
        selected: false,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
        selected: false,
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("global new workspace uses the last active project and creates one agent tab", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

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

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(createdWorkspace.workspaceId).not.toBe(openedProject.workspaceId);
      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const createdWorkspaceRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`,
      );
      await expect(createdWorkspaceRow).toBeVisible({ timeout: 30_000 });

      await expectWorkspaceHeader(page, {
        title: createdWorkspace.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const agentTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]');
      await expect(agentTabs).toHaveCount(1, { timeout: 30_000 });

      // Workspace setup may auto-open a setup tab that steals focus,
      // hiding the agent panel (display:none removes it from the
      // accessibility tree). Click the agent tab to ensure it's active.
      await agentTabs.first().click();

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("redirects to the optimistic draft tab before agent creation resolves", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-optimistic-");
    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

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
      await composer.fill("Hello from e2e");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      await agentCreatedDelay.waitForCreateRequest();
      await agentCreatedDelay.waitForDelayedCreatedStatus();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const draftTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-draft_"]');
      await expect(draftTabs).toHaveCount(1, { timeout: 30_000 });
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(0);

      agentCreatedDelay.release();
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(1, { timeout: 30_000 });
    } finally {
      agentCreatedDelay.release();
      await tempRepo.cleanup();
    }
  });

  test("new workspace with initial agent never appears in the Done status group", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-optimistic-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

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

      await switchSidebarToStatusGrouping(page);
      await startTrackingSidebarStatusGroups(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "running",
        excludes: "done",
        includesIndicator: "workspace-status-indicator-running",
      });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("new workspace without an initial agent appears in the Done status group", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-empty-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

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

      await switchSidebarToStatusGrouping(page);
      await startTrackingSidebarStatusGroups(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspaceWithoutPrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "done",
        excludes: "running",
        excludesIndicator: "workspace-status-indicator-loading",
      });
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "done",
        excludes: "running",
        excludesIndicator: "workspace-status-indicator-running",
      });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected branch becomes the base of a new workspace worktree", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-ref-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

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
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(existsSync(createdWorkspace.workspaceDirectory)).toBe(true);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: createdWorkspace.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe(path.basename(createdWorkspace.workspaceDirectory));
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("branch picker opens via keyboard and selects the filtered option on Enter", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("picker-keyboard-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      await openBranchPicker(page);
      await expectPickerOpen(page);
      await selectPickerOptionByKeyboard(page, "dev");
      await expectPickerSelected(page, "dev");
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("branch picker closes on Escape without selecting an option", async ({ page }) => {
    const tempRepo = await createTempGitRepo("picker-escape-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      await openBranchPicker(page);
      await expectPickerOpen(page);
      await closeBranchPicker(page);
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected GitHub PR shows PR context in the trigger and composer", async ({ page }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-ref",
      prs: [{ title: "Review selected start ref", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;

    try {
      const openedProject = await openProjectViaDaemon(client, pr.localPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);

      await expectStartingRefPickerTriggerPr(page, {
        number: pr.number,
        title: pr.title,
        headRef: pr.branch,
      });
      await expectComposerGithubAttachmentPill(page, {
        number: pr.number,
        title: pr.title,
      });
    } finally {
      await ghRepo.cleanup();
    }
  });
});
