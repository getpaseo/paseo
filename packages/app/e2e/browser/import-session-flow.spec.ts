import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { copyFile, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import {
  connectNewWorkspaceDaemonClient,
  type OpenedProject,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";
import { createTempDirectory, createTempGitRepo } from "../support/helpers/workspace";

const SCREENSHOT_DIRECTORY = path.join(
  process.env.HOME ?? tmpdir(),
  ".paseo/plans/import-session-ux",
);
const claudeConfigDirectory = mkdtempSync(path.join(tmpdir(), "paseo-import-flow-claude-"));
const brokenProvider = "broken-acp";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: { enabled: false },
        copilot: { enabled: false },
        omp: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        [brokenProvider]: {
          extends: "acp",
          label: "Broken ACP",
          command: ["missing-agent-command", "acp"],
        },
      },
    },
  },
  e2eDaemonEnvironment: { CLAUDE_CONFIG_DIR: claudeConfigDirectory },
});

interface ImportFlowScenario {
  project: OpenedProject;
  projectName: string;
  projectRoot: string;
  worktreeDirectory: string;
  unrelatedDirectory: string;
  importSessionId: string;
  repoCleanup(): Promise<void>;
  unrelatedCleanup(): Promise<void>;
}

let scenario: ImportFlowScenario;
let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

test.setTimeout(120_000);

test.beforeAll(async () => {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  const repo = await createTempGitRepo("isf-", {
    originUrl: "https://github.com/paseo-e2e/import-session-fixture.git",
  });
  const unrelated = await createTempDirectory("isf-other-");
  const worktreeDirectory = path.join(repo.path, "worktrees", "review-fix");
  await mkdir(path.dirname(worktreeDirectory), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "review-fix", worktreeDirectory], {
    cwd: repo.path,
    stdio: "ignore",
  });

  client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const project = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!project.workspace) {
    throw new Error(project.error ?? "Failed to create the import-session fixture workspace");
  }
  const projects = await client.listProjects();
  const projectDescriptor = projects.projects.find(
    (candidate) => candidate.projectId === project.workspace?.projectId,
  );
  if (!projectDescriptor?.projectKey) {
    throw new Error("Fixture workspace has no project key");
  }

  const openedProject: OpenedProject = {
    workspaceId: project.workspace.id,
    projectId: project.workspace.projectId,
    projectKey: projectDescriptor.projectKey,
    projectDisplayName: project.workspace.projectDisplayName,
    workspaceName: project.workspace.name,
    workspaceDirectory: project.workspace.workspaceDirectory,
  };
  const importSessionId = "fixture-custom-title";
  await seedClaudeSessions({
    projectRoot: repo.path,
    worktreeDirectory,
    unrelatedDirectory: unrelated.path,
    importSessionId,
  });
  scenario = {
    project: openedProject,
    projectName: project.workspace.projectDisplayName,
    projectRoot: repo.path,
    worktreeDirectory,
    unrelatedDirectory: unrelated.path,
    importSessionId,
    repoCleanup: repo.cleanup,
    unrelatedCleanup: unrelated.cleanup,
  };
});

test.afterAll(async () => {
  await client?.removeProject(scenario?.project.projectId).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await scenario?.repoCleanup().catch(() => undefined);
  await scenario?.unrelatedCleanup().catch(() => undefined);
  await rm(claudeConfigDirectory, { recursive: true, force: true });
});

test("captures the compact import-session journey", async ({ page }, testInfo) => {
  await useViewport(page, { width: 390, height: 844 });
  await openWorkspace(page);

  await test.step("the mobile sidebar exposes import in its footer", async () => {
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    const importButton = page.getByTestId("sidebar-import-session");
    await expect(importButton).toHaveAccessibleName("Import session");
    await importButton.hover();
    await expect(page.getByText("Import session", { exact: true })).toBeVisible();
    await capture(page, testInfo, "01-mobile-sidebar-footer.png");
  });

  await test.step("the host-wide sheet is newest first and fits its provider filter", async () => {
    await page.getByTestId("sidebar-import-session").click();
    await expectImportSheet(page);
    await expect(page.getByTestId("import-session-scope")).toContainText("Sessions on");
    expect((await listRowTestIds(page)).slice(0, 3)).toEqual([
      rowTestId(scenario.importSessionId),
      rowTestId("fixture-worktree"),
      rowTestId("fixture-unrelated"),
    ]);
    await expect(rowFolder(page, scenario.importSessionId)).toHaveText(scenario.projectName);
    await expect(rowFolder(page, "fixture-worktree")).toHaveText(
      `${scenario.projectName} · worktrees/review-fix`,
    );
    await expect(rowFolder(page, "fixture-unrelated")).toHaveText(scenario.unrelatedDirectory);
    await expect(page.getByTestId("import-session-provider-errors")).toContainText(
      "Could not load Broken ACP sessions",
    );
    await expect(page.getByTestId("import-session-scope")).toBeInViewport();
    const providerFilter = page.getByRole("button", { name: "Filter: All" });
    await expect(providerFilter).toBeInViewport();
    const filterBounds = await providerFilter.boundingBox();
    expect(filterBounds?.x ?? 390).toBeGreaterThanOrEqual(0);
    expect((filterBounds?.x ?? 390) + (filterBounds?.width ?? 1)).toBeLessThanOrEqual(390);
    await page.getByTestId(rowTestId("fixture-unrelated")).scrollIntoViewIfNeeded();
    await capture(page, testInfo, "02-mobile-sheet-unscoped.png");
  });

  await test.step("search narrows across the fixture corpus", async () => {
    await expectImportSheet(page);
    await page.getByTestId("import-session-search").fill("invoice");
    await expect(page.getByText("Invoice migration plan", { exact: true })).toBeVisible();
    await expect(page.getByText("Root session 01", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("import-session-load-more")).toHaveCount(0);
    await capture(page, testInfo, "03-mobile-search-narrowed.png");
  });

  await test.step("load more grows the result set and then disappears", async () => {
    await expectImportSheet(page);
    await page.getByTestId("import-session-search").fill("");
    await expect(page.getByTestId("import-session-load-more")).toBeVisible();
    await capture(page, testInfo, "04-mobile-load-more-visible.png");
    await page.getByTestId("import-session-load-more").click();
    await expect(page.getByText("Root session 20", { exact: true })).toBeVisible();
    await expect(page.getByTestId("import-session-load-more")).toHaveCount(0);
    await capture(page, testInfo, "05-mobile-load-more-complete.png");
  });

  await test.step("one provider fails inline and Retry settles", async () => {
    await expectImportSheet(page);
    const errorBanner = page.getByTestId("import-session-provider-errors");
    await expect(errorBanner).toContainText("Could not load Broken ACP sessions");
    await page.getByTestId(`import-session-retry-${brokenProvider}`).click();
    await expect(page.getByTestId(`import-session-retry-${brokenProvider}`)).toBeEnabled();
    await expect(errorBanner).toContainText("Could not load Broken ACP sessions");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await capture(page, testInfo, "06-mobile-provider-error-retry.png");
  });

  await test.step("the selected row imports and opens the hydrated transcript", async () => {
    await expectImportSheet(page);
    const row = page.getByTestId(`import-session-session-claude-${scenario.importSessionId}`);
    await row.click();
    // The row's "Importing..." state lasts only until the import response, which
    // the fixture daemon returns in ~100 ms; the sheet's unit test holds that
    // response to assert it. Here only the outcome is observable.
    await expect(page.getByTestId("import-session-sheet")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("user-message")).toContainText("Review the invoice migration");
    await expect(page.getByTestId("assistant-message")).toContainText(
      "The fixture transcript is ready.",
    );
    await capture(page, testInfo, "08-mobile-agent-after-import.png");
  });

  await test.step("workspace actions start scoped and can widen to the host", async () => {
    await page.getByRole("button", { name: "Workspace actions" }).click();
    await page.getByTestId("workspace-header-import-agent").click();
    await expect(page.getByTestId("import-session-scope")).toHaveText("This workspace");
    await expect(page.getByTestId("import-session-scope")).toBeVisible();
    await expect(page.getByTestId("import-session-show-all")).toBeVisible();
    await expect(page.getByText("Workspace actions", { exact: true })).not.toBeVisible();
    await capture(page, testInfo, "09-mobile-workspace-scoped.png");
    await page.getByTestId("import-session-show-all").click();
    await expect(page.getByTestId("import-session-scope")).toContainText("Sessions on");
    await expect(rowFolder(page, "fixture-unrelated")).toHaveText(scenario.unrelatedDirectory);
    await capture(page, testInfo, "10-mobile-workspace-show-all.png");
  });
});

test("captures the desktop import sheet and command-center entry", async ({ page }, testInfo) => {
  await useViewport(page, { width: 1280, height: 800 });
  await openWorkspace(page);

  await test.step("desktop shows the flat host-wide sheet", async () => {
    await expect(page.getByTestId("sidebar-import-session")).toBeVisible();
    await page.getByTestId("sidebar-import-session").click();
    await expectImportSheet(page);
    // The compact test may already have imported the newest fixture row, so this
    // asserts recency as an ordering between two rows nothing imports.
    const rowIds = await listRowTestIds(page);
    expect(rowIds.indexOf(rowTestId("fixture-worktree"))).toBeGreaterThanOrEqual(0);
    expect(rowIds.indexOf(rowTestId("fixture-worktree"))).toBeLessThan(
      rowIds.indexOf(rowTestId("fixture-unrelated")),
    );
    await expect(rowFolder(page, "fixture-worktree")).toHaveText(
      `${scenario.projectName} · worktrees/review-fix`,
    );
    await page.getByTestId(rowTestId("fixture-unrelated")).scrollIntoViewIfNeeded();
    await capture(page, testInfo, "11-desktop-sheet-unscoped.png");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("import-session-sheet")).toHaveCount(0);
  });

  await test.step("import matches the command but not Home", async () => {
    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("import");
    await expect(panel.getByText("Import session", { exact: true })).toBeVisible();
    await expect(panel.getByText("Home", { exact: true })).toHaveCount(0);
    await capture(page, testInfo, "12-desktop-command-center-import.png");
  });
});

function rowTestId(providerHandleId: string): string {
  return `import-session-session-claude-${providerHandleId}`;
}

function rowFolder(page: Page, providerHandleId: string) {
  return page.getByTestId(`import-session-row-folder-claude-${providerHandleId}`);
}

/** The rendered row order, which the flat list keys to recency. */
async function listRowTestIds(page: Page): Promise<Array<string | null>> {
  return await page
    .locator('[data-testid^="import-session-session-claude-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
}

async function useViewport(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
}

async function openWorkspace(page: Page): Promise<void> {
  await gotoAppShell(page);
  await page.goto(buildHostWorkspaceRoute(getServerId(), scenario.project.workspaceId));
  await expect(page.getByRole("button", { name: "Workspace actions" })).toBeVisible({
    timeout: 30_000,
  });
}

async function expectImportSheet(page: Page) {
  const sheet = page.getByTestId("import-session-sheet");
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText("Loading sessions...", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  return sheet;
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const outputPath = testInfo.outputPath(name);
  await page.screenshot({ path: outputPath, fullPage: true });
  await copyFile(outputPath, path.join(SCREENSHOT_DIRECTORY, name));
}

async function seedClaudeSessions(input: {
  projectRoot: string;
  worktreeDirectory: string;
  unrelatedDirectory: string;
  importSessionId: string;
}): Promise<void> {
  const sessions = [
    {
      cwd: input.projectRoot,
      id: input.importSessionId,
      title: "Invoice migration plan",
      prompt: "Review the invoice migration",
      answer: "The fixture transcript is ready.",
    },
    {
      cwd: input.worktreeDirectory,
      id: "fixture-worktree",
      title: "Review worktree fix",
      prompt: "Check the worktree import flow",
    },
    {
      cwd: input.unrelatedDirectory,
      id: "fixture-unrelated",
      title: "Unrelated directory notes",
      prompt: "Review the unrelated directory",
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      cwd: [input.projectRoot, input.worktreeDirectory, input.unrelatedDirectory][index % 3]!,
      id: `fixture-root-${String(index + 1).padStart(2, "0")}`,
      title: `Root session ${String(index + 1).padStart(2, "0")}`,
      prompt: index === 7 ? "Investigate invoice rendering" : `Review fixture item ${index + 1}`,
    })),
  ];
  const newest = Date.now() - 60_000;
  for (const [index, session] of sessions.entries()) {
    const projectDirectory = path.join(
      claudeConfigDirectory,
      "projects",
      session.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    await mkdir(projectDirectory, { recursive: true });
    const sessionPath = path.join(projectDirectory, `${session.id}.jsonl`);
    const records = [
      {
        type: "user",
        uuid: `${session.id}-user`,
        message: { role: "user", content: session.prompt },
        cwd: session.cwd,
        sessionId: session.id,
      },
      ...(session.answer
        ? [
            {
              type: "assistant",
              uuid: `${session.id}-assistant`,
              message: {
                role: "assistant",
                content: [{ type: "text", text: session.answer }],
              },
              cwd: session.cwd,
              sessionId: session.id,
            },
          ]
        : []),
      { type: "custom-title", customTitle: session.title, sessionId: session.id },
    ];
    await writeFile(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const timestamp = new Date(newest - index * 60_000);
    await utimes(sessionPath, timestamp, timestamp);
  }
}
