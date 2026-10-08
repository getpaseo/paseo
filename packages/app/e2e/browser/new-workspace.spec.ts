import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  closeBranchPicker,
  connectNewWorkspaceDaemonClient,
  loadSessionMessageReaders,
  createWorktreeViaDaemon,
  delayBrowserAgentCreatedStatus,
  expectComposerGithubAttachmentPill,
  expectNewWorkspaceProjectSelected,
  expectPickerClosed,
  expectPickerOpen,
  expectPickerSelected,
  expectStartingRefPickerTriggerPr,
  fillNewWorkspaceDraft,
  openGlobalNewWorkspaceComposer,
  openBranchPicker,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  pasteGithubPrUrl,
  captureStartingRefPicker,
  expectStartingRefRows,
  startingRefRow,
  submitNewWorkspaceEmpty,
  searchAndSelectBranchInPicker,
  selectBranchInPicker,
  selectGitHubPrInPicker,
  selectPickerOptionByKeyboard,
  selectWorkspaceIsolation,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import {
  commitLocalOnly,
  createTempGitRepo,
  readRepoRef,
  readWorktreeBaseMetadata,
  readWorktreeBranchInfo,
  trackForkUpstream,
} from "../support/helpers/workspace";
import {
  createLocalGithubPrFixture,
  cloneGithubRepoDefaultBranchOnly,
  createTempGithubRepo,
  hasGithubAuth,
  type LocalGhPrFixture,
} from "../support/helpers/github-fixtures";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { getE2EDaemonPort, daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { chooseAddProjectMethod, expectAddProjectPage } from "../support/helpers/add-project-flow";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";
import { dropFileOnComposer, expectAttachmentPill } from "../support/helpers/composer";

const BACKGROUND_RESOLUTION_FILE = {
  name: "background-context.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ composer: "background-resolution" })),
};

interface WorkspaceStatusGroupEvent {
  rowTestId: string;
  bucket: string;
  indicatorTestId: string | null;
  label: string;
  at: number;
}

interface AdoptedAgentSession {
  page: Page;
  workspaceId: string;
  agentTitle: string;
}

/** Verifies the adopted workspace exposes its first agent in the desktop tab strip. */
async function expectDesktopAdoptedAgent({
  page,
  workspaceId,
}: AdoptedAgentSession): Promise<void> {
  const adoptedDeck = page
    .getByTestId(`workspace-deck-entry-${getServerId()}:${workspaceId}`)
    .filter({ visible: true });
  await expect(adoptedDeck.locator('[data-testid^="workspace-tab-agent_"]')).toHaveCount(1, {
    timeout: 30_000,
  });
}

/** Verifies the adopted workspace's single agent in the compact switcher, then dismisses it. */
async function expectCompactAdoptedAgent({ page, agentTitle }: AdoptedAgentSession): Promise<void> {
  const switcher = page.getByRole("button", { name: "Switch tabs (1 open)", exact: true });
  await expect(switcher).toBeVisible();
  await switcher.click();

  // First-agent conversion preserves its draft tab ID, so identify the session by title.
  const sessionMenu = page.locator('[data-testid^="workspace-tab-menu-"][data-testid$="-trigger"]');
  await expect(sessionMenu).toHaveCount(1);
  await expect(sessionMenu).toBeVisible();
  await expect(page.getByText(agentTitle, { exact: true }).last()).toBeVisible();
  await page
    .getByRole("button", { name: "Bottom sheet backdrop" })
    .first()
    .click({ position: { x: 12, y: 12 } });
  await expect(sessionMenu).toHaveCount(0);
}

async function switchSidebarToStatusGrouping(page: import("@playwright/test").Page) {
  await selectSidebarStatusGrouping(page);
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
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-testid"],
    });
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

/** Holds real list responses so the form's pending state can be verified deterministically. */
async function holdWorktreeListResponses(page: import("@playwright/test").Page) {
  const frames = await loadSessionMessageReaders();
  let held = true;
  let requestCount = 0;
  const forwards: Array<() => void> = [];
  let observed: () => void = () => {};
  const responseSeen = new Promise<void>((resolve) => {
    observed = resolve;
  });
  // Delay real host responses, keeping every Git result and error authoritative.
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (frames.client(message)?.type === "paseo_worktree_list_request") requestCount += 1;
      server.send(message);
    });
    server.onMessage((message) => {
      if (held && frames.server(message)?.type === "paseo_worktree_list_response") {
        forwards.push(() => ws.send(message));
        observed();
        return;
      }
      ws.send(message);
    });
  });
  return {
    waitForResponse: responseSeen,
    requestCount: () => requestCount,
    release() {
      held = false;
      for (const forward of forwards.splice(0)) forward();
    },
  };
}

/** Selects either the new-branch intent or an existing branch from the combined picker. */
async function selectWorkspaceBranchChoice(page: Page, label: string): Promise<void> {
  await page.getByTestId("new-workspace-branch-picker-trigger").click();
  const option = page
    .getByRole("button", { name: label, exact: true })
    .and(page.locator(':not([data-testid^="sidebar-workspace-row-"])'));
  await expect(option).toBeVisible();
  await option.click();
}

test.describe("New workspace flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const localProjectIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();
  const localGithubFixtures = new Set<LocalGhPrFixture>();

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
      for (const projectId of localProjectIds) {
        await client.removeProject(projectId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    localProjectIds.clear();
    await client?.close().catch(() => undefined);
  });

  test.afterAll(async () => {
    for (const fixture of localGithubFixtures) {
      await fixture.cleanup();
    }
    localGithubFixtures.clear();
  });

  test("Local shows its current branch on desktop and compact layouts", async ({
    page,
  }, testInfo) => {
    const repo = await createTempGitRepo("worktree-options-local-");
    const opened = await openProjectViaDaemon(client, repo.path);
    localProjectIds.add(opened.projectId);
    localWorkspaceIds.add(opened.workspaceId);
    try {
      await gotoAppShell(page);
      const query = new URLSearchParams({
        serverId: getServerId(),
        projectId: opened.projectId,
        dir: repo.path,
        name: opened.projectDisplayName,
      });
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`/new?${query.toString()}`);
        const trigger = page.getByTestId("workspace-create-isolation-trigger");
        await expect(trigger).toHaveText("Local · main");
        await trigger.click();
        const localOption = page.getByTestId("workspace-create-isolation-local");
        await expect(localOption).toContainText("Local · main");
        await page.screenshot({ path: testInfo.outputPath(`local-${viewport.width}.png`) });
        await localOption.click();
        await expect(trigger).toHaveText("Local · main");
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("new worktree options show loading and retry failed enumeration without losing edits", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("worktree-options-loading-");
    const movedPath = `${repo.path}-moved`;
    const opened = await openProjectViaDaemon(client, repo.path);
    localProjectIds.add(opened.projectId);
    localWorkspaceIds.add(opened.workspaceId);
    const listDelay = await holdWorktreeListResponses(page);
    try {
      await gotoAppShell(page);
      const query = new URLSearchParams({
        serverId: getServerId(),
        projectId: opened.projectId,
        dir: repo.path,
        name: opened.projectDisplayName,
      });
      await page.goto(`/new?${query.toString()}`);
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toHaveText(
        "Local · main",
      );
      expect(listDelay.requestCount()).toBe(0);
      await page.getByTestId("workspace-create-isolation-trigger").click();
      await listDelay.waitForResponse;
      expect(listDelay.requestCount()).toBe(1);
      await expect(page.getByText("Loading worktrees…", { exact: true })).toBeVisible();
      listDelay.release();
      await expect(page.getByText(`main · ${repo.path}`, { exact: true })).toBeVisible();
      await page.getByTestId("workspace-create-isolation-worktree").click();
      await page.getByTestId("new-workspace-branch-name").fill("retained-branch");
      await page.getByTestId("new-workspace-worktree-name").fill("retained-name");
      renameSync(repo.path, movedPath);
      await submitNewWorkspaceEmpty(page);
      await expect(page.getByTestId("new-workspace-worktree-list-error")).toBeVisible();
      await expect(page.getByTestId("new-workspace-branch-name")).toHaveValue("retained-branch");
      await expect(page.getByTestId("new-workspace-worktree-name")).toHaveValue("retained-name");
      await page.getByTestId("workspace-create-isolation-trigger").click();
      await expect(page.getByText("Retry loading worktrees", { exact: true })).toBeVisible();
      renameSync(movedPath, repo.path);
      await page.getByText("Retry loading worktrees", { exact: true }).click();
      await expect(page.getByTestId("new-workspace-worktree-list-error")).toHaveCount(0);
      await expect(page.getByText(`main · ${repo.path}`, { exact: true })).toBeVisible();
      await page.getByTestId("workspace-create-isolation-worktree").click();
      renameSync(repo.path, movedPath);
      await submitNewWorkspaceEmpty(page);
      await expect(page.getByTestId("new-workspace-worktree-list-error")).toBeVisible();
      await selectWorkspaceIsolation(page, "local");
      await expect(page.getByTestId("new-workspace-worktree-list-error")).toHaveCount(0);
      renameSync(movedPath, repo.path);
      const beforeLocalCreate = listDelay.requestCount();
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      expect(listDelay.requestCount()).toBe(beforeLocalCreate);
    } finally {
      if (existsSync(movedPath)) renameSync(movedPath, repo.path);
      await repo.cleanup();
    }
  });

  for (const { viewport, expectAgentSession } of [
    {
      viewport: { width: 1440, height: 1000 },
      expectAgentSession: expectDesktopAdoptedAgent,
    },
    {
      viewport: { width: 390, height: 844 },
      expectAgentSession: expectCompactAdoptedAgent,
    },
  ]) {
    test(`new worktree options create exact branches and reuse checkouts at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const repo = await createTempGitRepo("worktree-options-", {
        branches: ["Release/1.2", "other"],
      });
      const opened = await openProjectViaDaemon(client, repo.path);
      localProjectIds.add(opened.projectId);
      localWorkspaceIds.add(opened.workspaceId);
      try {
        await gotoAppShell(page);
        const openForm = async () => {
          const query = new URLSearchParams({
            serverId: getServerId(),
            projectId: opened.projectId,
            dir: repo.path,
            name: opened.projectDisplayName,
          });
          await page.goto(`/new?${query.toString()}`);
          await selectWorkspaceIsolation(page, "worktree");
        };
        await openForm();
        const branchName = page.getByTestId("new-workspace-branch-name");
        const worktreeName = page.getByTestId("new-workspace-worktree-name");
        const modeControl = page.getByTestId("new-workspace-branch-picker-trigger");
        const refControl = page.getByTestId("new-workspace-ref-picker-trigger");
        const isolationControl = page.getByTestId("workspace-create-isolation-trigger");
        await expect(modeControl).toHaveText("New branch");
        await expect(refControl).toContainText("from main");
        expect(
          await worktreeName.evaluate((element) =>
            Boolean(
              element.compareDocumentPosition(
                document.querySelector('[data-testid="new-workspace-branch-name"]')!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          ),
        ).toBe(true);
        // The mode decision precedes the branch picker on both layout surfaces.
        expect(
          await isolationControl.evaluate((element) =>
            Boolean(
              element.compareDocumentPosition(
                document.querySelector('[data-testid="new-workspace-branch-picker-trigger"]')!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          ),
        ).toBe(true);
        expect(
          await modeControl.evaluate((element) =>
            Boolean(
              element.compareDocumentPosition(
                document.querySelector('[data-testid="new-workspace-ref-picker-trigger"]')!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          ),
        ).toBe(true);
        await branchName.fill("Feature/New.Branch");
        await expect(worktreeName).toHaveValue("feature-new-branch");
        await worktreeName.fill("chosen-name");
        await branchName.fill("Feature/Changed.Branch");
        await expect(worktreeName).toHaveValue("chosen-name");
        await worktreeName.fill("../invalid");
        await submitNewWorkspaceEmpty(page);
        await expect(page.getByTestId("new-workspace-create-error")).toContainText(
          "Worktree name must use lowercase letters",
        );
        await expect(branchName).toHaveValue("Feature/Changed.Branch");
        await worktreeName.fill("chosen-name");
        await page.screenshot({ path: testInfo.outputPath(`new-branch-${viewport.width}.png`) });
        await submitNewWorkspaceEmpty(page);
        await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
        const created = (await client.fetchWorkspaces()).entries.find(
          (entry) => path.basename(entry.workspaceDirectory) === "chosen-name",
        );
        expect(created).toBeDefined();
        // Git runtime snapshots refresh asynchronously; verify the actual checkout.
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: created!.workspaceDirectory,
          })
            .toString()
            .trim(),
        ).toBe("Feature/Changed.Branch");
        createdWorktreeDirectories.add(created!.workspaceDirectory);

        await openForm();
        await branchName.fill("collision-branch");
        await worktreeName.fill("chosen-name");
        await submitNewWorkspaceEmpty(page);
        await expect(page.getByTestId("new-workspace-create-error")).toContainText(
          "Worktree directory already exists:",
        );
        await expect(worktreeName).toHaveValue("chosen-name");
        await selectWorkspaceBranchChoice(page, "Release/1.2");
        await expect(branchName).toHaveCount(0);
        await expect(refControl).toHaveCount(0);
        await expect(worktreeName).toHaveValue("chosen-name");
        await selectWorkspaceBranchChoice(page, "New branch");
        await expect(refControl).toContainText("from Release/1.2");
        await expect(branchName).toHaveValue("collision-branch");
        await expect(worktreeName).toHaveValue("chosen-name");
        // A fresh form has an untouched default, unlike the failed draft above.
        await openForm();
        await selectWorkspaceBranchChoice(page, "Release/1.2");
        await expect(branchName).toHaveCount(0);
        await expect(refControl).toHaveCount(0);
        await expect(modeControl).toHaveText("Release/1.2");
        await expect(worktreeName).toHaveValue("release-1-2");
        await page.screenshot({
          path: testInfo.outputPath(`existing-branch-${viewport.width}.png`),
        });
        await submitNewWorkspaceEmpty(page);
        await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
        const checkout = (await client.fetchWorkspaces()).entries.find(
          (entry) => path.basename(entry.workspaceDirectory) === "release-1-2",
        );
        expect(checkout).toBeDefined();
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: checkout!.workspaceDirectory,
          })
            .toString()
            .trim(),
        ).toBe("Release/1.2");
        createdWorktreeDirectories.add(checkout!.workspaceDirectory);

        await openForm();
        await selectWorkspaceBranchChoice(page, "Release/1.2");
        await expect(branchName).toHaveCount(0);
        await expect(refControl).toHaveCount(0);
        await submitNewWorkspaceEmpty(page);
        await expect(page.getByTestId("new-workspace-create-error")).toContainText(
          "Branch already checked out at",
        );
        const before = execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: repo.path,
        }).toString();
        await page.getByTestId("workspace-create-isolation-trigger").click();
        await page
          .getByText(`Release/1.2 · ${checkout!.workspaceDirectory}`, { exact: true })
          .click();
        await expect(worktreeName).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(`existing-worktree-${viewport.width}.png`),
        });
        // Adoption must start the first agent in the selected checkout, not just create a record.
        await submitNewWorkspacePrompt(page, "First agent in the existing worktree");
        await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
        const adoptedWorkspaceId = new URL(page.url()).pathname.split("/workspace/")[1];
        await expect
          .poll(async () => {
            const entries = (await client.fetchWorkspaces()).entries;
            for (const entry of entries) {
              if (entry.id === adoptedWorkspaceId) return entry.workspaceDirectory;
            }
            return null;
          })
          .toBe(checkout!.workspaceDirectory);
        await expect
          .poll(async () => {
            const entries = (await client.fetchAgents({ scope: "active" })).entries;
            const directories: string[] = [];
            for (const entry of entries) {
              if (entry.agent.workspaceId === adoptedWorkspaceId) {
                directories.push(entry.agent.cwd);
              }
            }
            return directories;
          })
          .toEqual([checkout!.workspaceDirectory]);
        const adoptedAgents = (await client.fetchAgents({ scope: "active" })).entries.filter(
          (entry) => entry.agent.workspaceId === adoptedWorkspaceId,
        );
        expect(adoptedAgents).toHaveLength(1);
        expect(adoptedAgents[0].agent.cwd).toBe(checkout!.workspaceDirectory);
        await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible({
          timeout: 30_000,
        });
        await expectAgentSession({
          page,
          workspaceId: adoptedWorkspaceId,
          agentTitle: adoptedAgents[0].agent.title!,
        });
        expect(
          execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo.path }).toString(),
        ).toBe(before);
        expect(
          (await client.fetchWorkspaces()).entries.filter(
            (entry) => entry.workspaceDirectory === checkout!.workspaceDirectory,
          ),
        ).toHaveLength(2);
      } finally {
        await repo.cleanup();
      }
    });
  }

  test("new worktree branch choices follow the selected repository", async ({ page }) => {
    const first = await createTempGitRepo("worktree-options-first-", { branches: ["first-only"] });
    const second = await createTempGitRepo("worktree-options-second-", {
      branches: ["second-only"],
    });
    try {
      const firstProject = await openProjectViaDaemon(client, first.path);
      const secondProject = await openProjectViaDaemon(client, second.path);
      for (const opened of [firstProject, secondProject]) {
        localProjectIds.add(opened.projectId);
        localWorkspaceIds.add(opened.workspaceId);
      }
      await gotoAppShell(page);
      const query = new URLSearchParams({
        serverId: getServerId(),
        projectId: firstProject.projectId,
        dir: first.path,
        name: firstProject.projectDisplayName,
      });
      await page.goto(`/new?${query.toString()}`);
      await selectWorkspaceIsolation(page, "worktree");
      await selectWorkspaceBranchChoice(page, "first-only");
      await page.getByTestId("new-workspace-worktree-name").fill("retained-name");
      await page.getByTestId("new-workspace-project-picker-trigger").click();
      await page.getByPlaceholder("Search projects").fill(secondProject.projectDisplayName);
      await page
        .getByTestId("combobox-desktop-container")
        .getByText(secondProject.projectDisplayName, { exact: true })
        .click();
      await expect(page.getByTestId("new-workspace-branch-picker-trigger")).toHaveText(
        "New branch",
      );
      await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText("from main");
      await expect(page.getByTestId("new-workspace-worktree-name")).toHaveValue("retained-name");
      await page.getByTestId("new-workspace-branch-picker-trigger").click();
      await expect(page.getByRole("button", { name: "second-only", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "first-only", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.getByTestId("new-workspace-branch-name").fill("new-repository-branch");
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      const created = (await client.fetchWorkspaces()).entries.find(
        (entry) => path.basename(entry.workspaceDirectory) === "retained-name",
      );
      expect(created).toBeDefined();
      createdWorktreeDirectories.add(created!.workspaceDirectory);
      expect(readRepoRef(second.path, "new-repository-branch")).toBe(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: created!.workspaceDirectory })
          .toString()
          .trim(),
      );
      expect(
        execFileSync("git", ["branch", "--list", "new-repository-branch"], { cwd: first.path })
          .toString()
          .trim(),
      ).toBe("");
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("adds a project from the selected empty host", async ({ page }) => {
    const repo = await createTempGitRepo("new-workspace-project-picker-");
    const primaryServerId = getServerId();
    const emptyServerId = "empty-new-workspace-host";

    try {
      const openedProject = await openProjectViaDaemon(client, repo.path);
      localWorkspaceIds.add(openedProject.workspaceId);
      await seedSavedSettingsHosts(page, [
        {
          serverId: primaryServerId,
          label: "Primary host",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: emptyServerId,
          label: "Empty host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      const projectTrigger = page.getByTestId("new-workspace-project-picker-trigger");
      await projectTrigger.click();
      await page.getByPlaceholder("Search projects").fill("no matching project");
      await expect(page.getByTestId("new-workspace-project-picker-add-project")).toBeVisible();
      await page.keyboard.press("Escape");

      await page.getByTestId("host-picker-trigger").click();
      await page.getByTestId(`new-workspace-host-picker-option-${emptyServerId}`).click();
      await expect(projectTrigger).toContainText("Choose project");
      await projectTrigger.click();

      const addProject = page.getByTestId("new-workspace-project-picker-add-project");
      await expect(addProject).toContainText("Add project");
      await expect(addProject).toContainText(/(?:⌘|Ctrl\+)O/);
      await addProject.click();

      await expectAddProjectPage(page, "method");
      await chooseAddProjectMethod(page, "directory-search");
    } finally {
      await repo.cleanup();
    }
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
      await selectWorkspaceIsolation(page, "worktree");
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

  // The starting ref the daemon actually cuts from is the thing that broke: the picker said
  // one ref and the worktree was created from another. Every assertion here reads the
  // created worktree's commits or its recorded base, never the trigger text alone.
  test.describe("default starting ref", () => {
    async function openWorktreeComposerForRepo(
      page: import("@playwright/test").Page,
      repoPath: string,
    ) {
      const openedProject = await openProjectViaDaemon(client, repoPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      return openedProject;
    }

    async function createWorktreeAndRead(
      page: import("@playwright/test").Page,
      openedProject: Awaited<ReturnType<typeof openProjectViaDaemon>>,
    ) {
      await submitNewWorkspaceEmpty(page);
      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);
      return {
        ...createdWorkspace,
        branchInfo: await readWorktreeBranchInfo({
          worktreePath: createdWorkspace.workspaceDirectory,
        }),
      };
    }

    test("branches off the upstream when the local branch is ahead and the picker is untouched", async ({
      page,
    }) => {
      const tempRepo = await createTempGitRepo("ref-default-ahead-", { withRemote: true });

      try {
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);
        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(originHead)).toBe(true);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(false);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off the local ref when the local row is chosen explicitly", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-local-pick-", { withRemote: true });

      try {
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        await expectStartingRefRows(page, [
          "main, origin branch",
          "main, local branch, 2 commits ahead of origin main",
        ]);
        const screenshotPath = testInfo.outputPath("ref-picker-local-ahead.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: local ahead of upstream", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await startingRefRow(page, "main, local branch, 2 commits ahead of origin main").click();
        await expectPickerSelected(page, "main (local)");

        const created = await createWorktreeAndRead(page, openedProject);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(true);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off a fork's upstream remote and records the branch name", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-fork-", { withRemote: true });

      try {
        const upstreamHead = await trackForkUpstream(tempRepo.path);
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        // Branch suggestions only know about origin, so the upstream the fork actually
        // tracks gets its own row rather than silently sharing origin's. Two rows reading
        // "main" is the ambiguity this whole change exists to remove.
        await expectStartingRefRows(page, [
          "main (upstream), upstream branch",
          "main, origin branch",
        ]);
        await expectPickerSelected(page, "main (upstream)");
        const screenshotPath = testInfo.outputPath("ref-picker-fork.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: fork tracking upstream/main", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await closeBranchPicker(page);

        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(upstreamHead)).toBe(true);
        expect(upstreamHead).not.toBe(originHead);
        // The name is what the UI shows; the ref is what resolves back to this commit.
        expect(await readWorktreeBaseMetadata(created.workspaceDirectory)).toEqual({
          baseRefName: "main",
          baseRef: "refs/remotes/upstream/main",
        });
      } finally {
        await tempRepo.cleanup();
      }
    });
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
      await selectWorkspaceIsolation(page, "worktree");

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
      await selectWorkspaceIsolation(page, "worktree");

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
      await selectWorkspaceIsolation(page, "worktree");
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

  test("pasted GitHub PR replaces a selected branch and creates its worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "main");

    await pasteGithubPrUrl(page, context, pr.url);

    const createButton = page.getByTestId("workspace-create-submit");
    await expect(createButton).toBeDisabled();
    await expect(createButton.getByRole("progressbar")).toHaveCount(0);

    await dropFileOnComposer(page, BACKGROUND_RESOLUTION_FILE);
    await expectAttachmentPill(page, "composer-file-attachment-pill");

    await expectComposerGithubAttachmentPill(page, {
      number: pr.number,
      title: pr.title,
    });
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const branchInfo = await readWorktreeBranchInfo({
      worktreePath: worktree.workspaceDirectory,
    });
    expect(branchInfo.currentBranch).toBe(pr.branch);
    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
  });

  test("branches remain searchable after a pasted PR and determine the created worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await pasteGithubPrUrl(page, context, pr.url);
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await openStartingRefPicker(page);
    await searchAndSelectBranchInPicker(page, "main");
    await expectPickerSelected(page, "main");
    await fillNewWorkspaceDraft(page, `${pr.url}\nKeep this checkout on main`);
    await expectPickerSelected(page, "main");
    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(false);
  });

  test("selected GitHub PR creates the worktree from the PR head even when the head branch is not fetched", async ({
    page,
  }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-worktree",
      prs: [{ title: "Checkout PR worktree", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;
    const mainCheckout = await cloneGithubRepoDefaultBranchOnly(ghRepo);

    try {
      const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);
      await submitNewWorkspaceWithoutPrompt(page);

      const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(worktree.workspaceDirectory);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: worktree.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe(pr.branch);
      expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
    } finally {
      await mainCheckout.cleanup();
      await ghRepo.cleanup();
    }
  });
});
