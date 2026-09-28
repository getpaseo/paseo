import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { ImportSessionFlow } from "../support/helpers/import-session";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
  type OpenedProject,
} from "../support/helpers/new-workspace";
import { createTempDirectory, createTempGitRepo } from "../support/helpers/workspace";

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
  reuseTarget: OpenedProject;
  projectName: string;
  projectRoot: string;
  worktreeDirectory: string;
  unrelatedDirectory: string;
  importSessionId: string;
  importSessionTimestamp: number;
  repoCleanup(): Promise<void>;
  unrelatedCleanup(): Promise<void>;
}

let scenario: ImportFlowScenario;
let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

test.setTimeout(120_000);

test.beforeAll(async () => {
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
  const reuseTarget = await openProjectViaDaemon(client, unrelated.path);
  const importSessionId = "fixture-custom-title";
  const importSessionTimestamp = await seedClaudeSessions({
    projectRoot: repo.path,
    worktreeDirectory,
    unrelatedDirectory: unrelated.path,
    importSessionId,
  });
  scenario = {
    project: openedProject,
    reuseTarget,
    projectName: project.workspace.projectDisplayName,
    projectRoot: repo.path,
    worktreeDirectory,
    unrelatedDirectory: unrelated.path,
    importSessionId,
    importSessionTimestamp,
    repoCleanup: repo.cleanup,
    unrelatedCleanup: unrelated.cleanup,
  };
});

test.afterAll(async () => {
  await client?.removeProject(scenario?.project.projectId).catch(() => undefined);
  await client?.removeProject(scenario?.reuseTarget.projectId).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await scenario?.repoCleanup().catch(() => undefined);
  await scenario?.unrelatedCleanup().catch(() => undefined);
  await rm(claudeConfigDirectory, { recursive: true, force: true });
});

test("filters cached sessions before searching a persistent miss", async ({ page }, testInfo) => {
  const requests: Array<{ query: string; providers: string }> = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame: { message?: { type?: string; query?: string; providers?: string[] } } =
        JSON.parse(payload);
      if (frame.message?.type === "fetch_recent_provider_sessions_request")
        requests.push({
          query: frame.message.query ?? "",
          providers: (frame.message.providers ?? []).join(","),
        });
    }),
  );
  const flow = new ImportSessionFlow(page);
  await flow.openWorkspace(scenario.project.workspaceId, { width: 390, height: 844 });
  await flow.openGlobally();
  await flow.expectRows({
    first: [scenario.importSessionId, "fixture-worktree", "fixture-unrelated"],
  });
  await flow.expectProviderError("Broken ACP");
  expect(requests.length).toBeGreaterThan(0);
  const initialRequests = [...requests];
  await page.clock.install();
  await flow.search("invoice");
  await page.clock.runFor(600);
  expect(requests).toEqual(initialRequests);
  await page.getByTestId("import-session-search").fill("no-such-session");
  await page.clock.runFor(200);
  expect(requests).toEqual(initialRequests);
  await flow.search("invoice");
  await page.clock.runFor(600);
  expect(requests).toEqual(initialRequests);
  await page.getByTestId("import-session-search").fill("fixture item 20");
  await page.clock.runFor(450);
  await expect(page.getByText("Root session 20", { exact: true })).toBeVisible();
  expect(
    requests
      .filter((request) => request.query === "fixture item 20")
      .map((request) => request.providers)
      .sort(),
  ).toEqual([...new Set(initialRequests.map((request) => request.providers))].sort());
  await page.getByTestId("import-session-search").fill("item 20");
  await page.clock.runFor(600);
  expect(requests.filter((request) => request.query === "item 20")).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("cached-session-search.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("import-session-sheet")).toHaveCount(0);
});

test("an open Import Session row keeps its age current", async ({ page }) => {
  await page.clock.install({ time: scenario.importSessionTimestamp + 60_000 });
  const flow = new ImportSessionFlow(page);
  await flow.openWorkspace(scenario.project.workspaceId, { width: 390, height: 844 });
  await flow.openGlobally();

  const row = page.getByTestId(`import-session-session-claude-${scenario.importSessionId}`);
  await expect(row).toContainText("1m ago");
  await page.clock.fastForward("03:00");
  await expect(row).toContainText("4m ago");
});

test("captures the compact import-session journey", async ({ page }, testInfo) => {
  const flow = new ImportSessionFlow(page);
  await flow.openWorkspace(scenario.project.workspaceId, { width: 390, height: 844 });

  await test.step("the new workspace screen offers import at the top", async () => {
    await flow.revealNewWorkspaceEntryPoint();
    await capture(page, testInfo, "01-mobile-new-workspace-import.png");
  });

  await test.step("the host-wide sheet is newest first and fits its provider filter", async () => {
    await flow.openFromNewWorkspace();
    await flow.expectScope("Sessions on", false);
    await flow.expectRows({
      first: [scenario.importSessionId, "fixture-worktree", "fixture-unrelated"],
      folders: [
        [scenario.importSessionId, scenario.projectName],
        ["fixture-worktree", `${scenario.projectName} · worktrees/review-fix`],
        ["fixture-unrelated", scenario.reuseTarget.projectDisplayName],
      ],
    });
    await flow.expectProviderError("Broken ACP");
    await flow.expectProviderFilterFits(390);
    await flow.revealSession("fixture-unrelated");
    await capture(page, testInfo, "02-mobile-sheet-unscoped.png");
  });

  await test.step("search narrows across the fixture corpus", async () => {
    await flow.search("invoice");
    await capture(page, testInfo, "03-mobile-search-narrowed.png");
  });

  await test.step("load more grows the result set and then disappears", async () => {
    await flow.resetSearch();
    await capture(page, testInfo, "04-mobile-load-more-visible.png");
    await flow.loadMore();
    await capture(page, testInfo, "05-mobile-load-more-complete.png");
  });

  await test.step("one provider fails inline and Retry settles", async () => {
    await flow.retryProvider(brokenProvider, "Broken ACP");
    await capture(page, testInfo, "06-mobile-provider-error-retry.png");
  });

  await test.step("the selected row imports and opens the hydrated transcript", async () => {
    await flow.importSession(scenario.importSessionId);
    await flow.expectTranscript("Review the invoice migration", "The fixture transcript is ready.");
    await capture(page, testInfo, "08-mobile-agent-after-import.png");
  });

  await test.step("workspace actions start scoped and can widen to the host", async () => {
    await flow.openFromWorkspaceHeader();
    await capture(page, testInfo, "09-mobile-workspace-scoped.png");
    await flow.showAll();
    await flow.expectRows({
      folders: [["fixture-unrelated", scenario.reuseTarget.projectDisplayName]],
    });
    await capture(page, testInfo, "10-mobile-workspace-show-all.png");

    await flow.importSession("fixture-root-03");
    await flow.expectImportedIntoWorkspace(
      scenario.reuseTarget.workspaceId,
      "Review fixture item 3",
    );
  });
});

test("captures the desktop import sheet and command-center entry", async ({ page }, testInfo) => {
  const flow = new ImportSessionFlow(page);
  await flow.openWorkspace(scenario.project.workspaceId, {
    width: 1280,
    height: 800,
  });

  await test.step("desktop shows the flat host-wide sheet", async () => {
    await flow.openGlobally();
    // The compact test may already have imported the newest fixture row, so this
    // asserts recency as an ordering between two rows nothing imports.
    await flow.expectRows({
      before: ["fixture-worktree", "fixture-unrelated"],
      folders: [["fixture-worktree", `${scenario.projectName} · worktrees/review-fix`]],
    });
    await flow.revealSession("fixture-unrelated");
    await capture(page, testInfo, "11-desktop-sheet-unscoped.png");
    await flow.close();
  });

  await test.step("import matches the command but not Home", async () => {
    await flow.expectCommandCenterMatch();
    await capture(page, testInfo, "12-desktop-command-center-import.png");
  });
});

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const outputPath = testInfo.outputPath(name);
  await page.screenshot({ path: outputPath, fullPage: true });
}

async function seedClaudeSessions(input: {
  projectRoot: string;
  worktreeDirectory: string;
  unrelatedDirectory: string;
  importSessionId: string;
}): Promise<number> {
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
  return newest;
}
