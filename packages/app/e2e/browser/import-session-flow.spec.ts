import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { copyFile, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import type { FetchRecentProviderSessionsRequestMessage } from "@getpaseo/protocol/messages";
import { expect, test, type Page } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { ImportSessionFlow } from "../support/helpers/import-session";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  connectNewWorkspaceDaemonClient,
  loadSessionMessageReaders,
  openProjectViaDaemon,
  type OpenedProject,
} from "../support/helpers/new-workspace";
import { createTempDirectory, createTempGitRepo } from "../support/helpers/workspace";

const SCREENSHOT_DIRECTORY = path.join(
  process.env.HOME ?? tmpdir(),
  ".paseo/plans/import-session-ux",
);
const claudeConfigDirectory = mkdtempSync(path.join(tmpdir(), "paseo-import-flow-claude-"));
const brokenProvider = "broken-acp";

const disabledProviders = {
  codex: { enabled: false },
  copilot: { enabled: false },
  omp: { enabled: false },
  opencode: { enabled: false },
  pi: { enabled: false },
  antigravity: { enabled: false },
  muse: { enabled: false },
};

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        ...disabledProviders,
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

test("shows listing failure details beside healthy sessions and retries the failed provider", async ({
  page,
}, testInfo) => {
  const frames = await loadSessionMessageReaders();
  const requests: FetchRecentProviderSessionsRequestMessage[] = [];
  const completed = new Set<string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const request = frames.client(payload);
      if (request?.type === "fetch_recent_provider_sessions_request") {
        requests.push(request);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const response = frames.server(payload);
      if (response?.type === "fetch_recent_provider_sessions_response") {
        completed.add(response.payload.requestId);
      }
    });
  });
  const flow = new ImportSessionFlow(page);
  for (const width of [1280, 390]) {
    await flow.openWorkspace(scenario.project.workspaceId, { width, height: 844 });
    await flow.openGlobally();
    await flow.expectProviderError("Broken ACP");
    const healthySession = page.getByTestId(
      `import-session-session-claude-${scenario.importSessionId}`,
    );
    await expect(healthySession).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`listing-failure-${width}.png`) });
    await expect(page.getByTestId("import-session-provider-errors")).toContainText(
      "missing-agent-command",
    );

    const requestOffset = requests.length;
    await flow.retryProvider(brokenProvider, "Broken ACP");
    await expect
      .poll(() => requests.slice(requestOffset).map((request) => request.providers))
      .toEqual([[brokenProvider]]);
    const retriedRequest = requests[requestOffset];
    if (!retriedRequest) throw new Error("Retry did not send a provider listing request");
    await expect.poll(() => completed.has(retriedRequest.requestId)).toBe(true);
    await expect(page.getByTestId(`import-session-retry-${brokenProvider}`)).toBeEnabled();
    await expect(page.getByTestId("import-session-provider-errors")).toContainText(
      "missing-agent-command",
    );
    await expect(healthySession).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`listing-failure-retry-${width}.png`) });
    await flow.close();
  }
});

test("Import Session keeps listings tied to their host during a switch and a pending import", async ({
  page,
}) => {
  const secondaryHost = await startIsolatedHostDaemon("import-session-secondary", {
    config: {
      agents: {
        providers: {
          ...disabledProviders,
          claude: { enabled: false },
          [brokenProvider]: {
            extends: "acp",
            label: "Broken ACP",
            command: ["missing-secondary-command", "acp"],
          },
        },
      },
    },
  });
  try {
    const gate = await installDaemonWebSocketGate(page);
    const flow = new ImportSessionFlow(page);
    await flow.openWorkspace(scenario.project.workspaceId, { width: 1280, height: 844 });
    await addConnectedHostAndReload(page, {
      serverId: secondaryHost.serverId,
      port: secondaryHost.port,
      label: "Second import host",
      primaryLabel: "First import host",
    });

    await flow.chooseHostForImport("First import host");
    await expect(page.getByText(/missing-agent-command/)).toBeVisible();
    await flow.close();

    await flow.chooseHostForImport("Second import host");
    await expect(page.getByText(/missing-secondary-command/)).toBeVisible();
    await expect(page.getByText(/missing-agent-command/)).toHaveCount(0);
    await flow.close();

    await test.step("returning to the original host omits the session imported during the switch", async () => {
      const sessionId = "fixture-root-04";
      await flow.chooseHostForImport("First import host");
      gate.holdNextClientRequest("import_agent_request");
      await flow.startImport(sessionId);
      await gate.waitForHeldClientRequest();

      await flow.close();
      await flow.chooseHostForImport("Second import host");
      await flow.expectProviderError("Broken ACP");
      gate.releaseHeldClientRequest();
      await flow.expectClosed();

      await flow.chooseHostForImport("First import host");
      await flow.revealSession("fixture-worktree");
      await flow.expectSessionUnavailable(sessionId);
      await flow.close();
      await flow.expectTranscript("Review fixture item 4", "Fixture response 4");
    });
  } finally {
    await secondaryHost.close();
  }
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
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
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

test("large import lists keep mounted rows bounded and remain scrollable", async ({
  page,
}, testInfo) => {
  const fixtureDirectory = path.join(claudeConfigDirectory, "projects", "virtualization-fixture");
  await mkdir(fixtureDirectory, { recursive: true });
  try {
    const newest = Date.now();
    for (let index = 0; index < 200; index += 1) {
      const id = `virtualized-${String(index).padStart(3, "0")}`;
      const file = path.join(fixtureDirectory, `${id}.jsonl`);
      await writeFile(
        file,
        `${JSON.stringify({
          type: "user",
          sessionId: id,
          cwd: index % 2 === 0 ? scenario.projectRoot : scenario.worktreeDirectory,
          message: {
            role: "user",
            content: `Virtualized session ${index}${index % 3 === 0 ? " with a longer preview that wraps onto a second line in a compact sheet" : ""}`,
          },
        })}\n`,
      );
      const timestamp = new Date(newest - index * 10);
      await utimes(file, timestamp, timestamp);
    }
    for (const width of [1280, 390]) {
      const flow = new ImportSessionFlow(page);
      await flow.openWorkspace(scenario.project.workspaceId, { width, height: 844 });
      await flow.openGlobally();
      const rows = page.locator('[data-testid^="import-session-session-"]');
      const scrollToEnd = async (end = true) => {
        // Scroll the body's real overflow element. Virtual rows need not exist yet.
        await rows.first().evaluate((row, atEnd) => {
          let element = row.parentElement;
          while (element && !["auto", "scroll"].includes(getComputedStyle(element).overflowY)) {
            element = element.parentElement;
          }
          if (!element) throw new Error("Import list has no scroll owner");
          element.scrollTop = atEnd ? element.scrollHeight : 0;
          element.dispatchEvent(new Event("scroll"));
        }, end);
      };
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const loadMore = page.getByTestId("import-session-load-more");
        await expect(async () => {
          await scrollToEnd();
          await expect(loadMore).toBeInViewport({ timeout: 500 });
        }).toPass({ timeout: 10_000 });
        await loadMore.click();
        if (pageIndex < 2) await expect(loadMore).toBeEnabled();
      }
      await expect(async () => {
        await scrollToEnd();
        await expect(
          page.getByTestId("import-session-session-claude-virtualized-199"),
        ).toBeInViewport({ timeout: 500 });
      }).toPass({ timeout: 10_000 });
      await expect.poll(() => rows.count()).toBeLessThan(100);
      await page.screenshot({ path: testInfo.outputPath(`virtualized-${width}.png`) });
      if (width === 1280) {
        const row = (index: number) =>
          page.getByTestId(
            `import-session-session-claude-virtualized-${String(index).padStart(3, "0")}`,
          );
        await expect(async () => {
          await scrollToEnd(false);
          await expect(row(0)).toBeInViewport({ timeout: 500 });
        }).toPass({ timeout: 10_000 });
        await row(0).focus();
        for (let index = 1; index <= 30; index += 1) {
          await page.keyboard.press("Tab");
          await expect(row(index)).toBeFocused();
        }
        for (let index = 29; index >= 15; index -= 1) {
          await page.keyboard.press("Shift+Tab");
          await expect(row(index)).toBeFocused();
        }
        const list = page.getByTestId("import-session-list");
        const scrollWithKey = async (event: "scroll" | "scrollend", key: string) => {
          const listener = await list.evaluateHandle((node, eventName) => {
            const promise = new Promise<void>((resolve) => {
              node.addEventListener(eventName, () => resolve(), { once: true });
            });
            return { promise };
          }, event);
          try {
            await page.keyboard.press(key);
            await listener.evaluate((value) => value.promise);
          } finally {
            await listener.dispose();
          }
        };
        const beforePageDown = await list.evaluate((node) => node.scrollTop);
        await scrollWithKey("scroll", "PageDown");
        await expect
          .poll(() => list.evaluate((node) => node.scrollTop))
          .toBeGreaterThan(beforePageDown);
        await expect(row(15)).toBeFocused();
        await page.keyboard.press("End");
        await expect(row(15)).toBeFocused();
        await expect(row(199)).toBeInViewport();
        // Home must remain at the first row after the native page scroll ends.
        await scrollWithKey("scrollend", "Home");
        await expect(row(0)).toBeInViewport();
        await expect(row(15)).toBeFocused();

        await page.keyboard.press("End");
        await expect(row(199)).toBeInViewport();
        await row(199).focus();
        await scrollWithKey("scroll", "PageUp");
        await page.keyboard.press("Home");
        await expect(row(0)).toBeInViewport();
        await scrollWithKey("scrollend", "End");
        await expect(row(199)).toBeInViewport();
        await expect(row(199)).toBeFocused();
        await testInfo.attach("keyboard-scroll-owner", {
          body: JSON.stringify(
            await list.evaluate((node) => ({
              focusedRow: document.activeElement?.getAttribute("data-testid"),
              scrollTop: node.scrollTop,
              scrollHeight: node.scrollHeight,
              clientHeight: node.clientHeight,
            })),
          ),
          contentType: "application/json",
        });
        await page.screenshot({ path: testInfo.outputPath("virtualized-keyboard-end.png") });
        await page.keyboard.press("Home");
        await expect(row(0)).toBeInViewport();
      }
      await flow.close();
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

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
}): Promise<number> {
  const sessions: {
    cwd: string;
    id: string;
    title: string;
    prompt: string;
    answer?: string;
  }[] = [
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
      ...(index === 3 ? { answer: "Fixture response 4" } : {}),
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
