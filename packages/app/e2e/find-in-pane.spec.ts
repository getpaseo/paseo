import { expect, test, type Page } from "./fixtures";
import { waitForTabBar } from "./helpers/launcher";
import {
  connectTerminalClient,
  setupDeterministicPrompt,
  waitForTerminalContent,
} from "./helpers/terminal-perf";
import { createTempGitRepo } from "./helpers/workspace";
import { openFileExplorer, openFileFromExplorer } from "./helpers/file-explorer";
import {
  connectWorkspaceSetupClient,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
} from "./helpers/workspace-setup";
import { buildHostWorkspaceRoute } from "../src/utils/host-routes";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

function findShortcut(): string {
  return process.platform === "darwin" ? "Meta+f" : "Control+f";
}

async function navigateToWorkspaceViaSidebar(page: Page, workspaceId: string): Promise<void> {
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await waitForTabBar(page);
}

async function openFind(page: Page): Promise<void> {
  await page.keyboard.press(findShortcut());
  await expect(page.getByTestId("pane-find-bar")).toBeVisible({ timeout: 10_000 });
}

async function typeFindQuery(page: Page, query: string): Promise<void> {
  const input = page.getByTestId("pane-find-input");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(query);
}

test.describe("in-pane find", () => {
  test("walks chat, file, terminal, split-pane, and browser-web find flows in the running app", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    const client = await connectWorkspaceSetupClient();
    const agentClient = await connectTerminalClient();
    const repo = await createTempGitRepo("find-pane-qa-", {
      files: [
        {
          path: "src/find-target.txt",
          content: [
            "alpha needle first",
            "beta without match",
            "gamma NEEDLE second",
            "delta needle third",
            "",
          ].join("\n"),
        },
      ],
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const workspaceResult = await client.openProject(repo.path);
      if (!workspaceResult.workspace) {
        throw new Error(workspaceResult.error ?? `Failed to open project ${repo.path}`);
      }

      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspaceResult.workspace.id);

      await openFileExplorer(page);
      await openFileFromExplorer(page, "src");
      await openFileFromExplorer(page, "find-target.txt");
      await expect(page.getByTestId("workspace-file-pane")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("workspace-file-pane").click();

      await openFind(page);
      await typeFindQuery(page, "needle");
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-next").click();
      await expect(page.getByText("2 / 3")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-prev").click();
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-input").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("2 / 3")).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Shift+Enter");
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await typeFindQuery(page, "missing-value");
      await expect(page.getByText("No matches")).toBeVisible({ timeout: 10_000 });
      await typeFindQuery(page, "");
      await expect(page.getByText("0 / 0")).toBeVisible({ timeout: 10_000 });
      await typeFindQuery(page, "needle");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("pane-find-bar")).toHaveCount(0);
      await testInfo.attach("file-find-walkthrough", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.getByLabel("Split pane right").filter({ visible: true }).last().click();
      await expect(page.getByTestId("workspace-tabs-row").filter({ visible: true })).toHaveCount(2);
      await page.getByTestId("workspace-new-terminal").filter({ visible: true }).last().click();
      const splitTerminal = page.getByTestId("terminal-surface").last();
      await expect(splitTerminal).toBeVisible({ timeout: 20_000 });
      await splitTerminal.click();
      await setupDeterministicPrompt(page, `SPLIT_FIND_READY_${Date.now()}`);
      await splitTerminal.pressSequentially("printf 'split needle one\\nsplit needle two\\n'\n", {
        delay: 0,
      });
      await waitForTerminalContent(page, (text) => text.includes("split needle two"), 10_000);
      await openFind(page);
      await typeFindQuery(page, "needle");
      await expect(page.getByText(/[1-9] \/ [1-9]/)).toBeVisible({
        timeout: 10_000,
      });
      await page.getByTestId("workspace-file-pane").click();
      await expect(page.getByTestId("pane-find-bar")).toHaveCount(0);
      await openFind(page);
      await typeFindQuery(page, "needle");
      await expect(page.getByText("1 / 3")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-close").click();
      await expect(page.getByTestId("pane-find-bar")).toHaveCount(0);
      await testInfo.attach("terminal-find-walkthrough", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await testInfo.attach("split-pane-focus-switching", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      const agent = await agentClient.createAgent({
        provider: "mock",
        cwd: repo.path,
        title: "Find pane QA",
        modeId: "load-test",
        model: "ten-second-stream",
        initialPrompt: "chat needle alpha",
      });
      await page.goto(
        `${buildHostWorkspaceRoute(getServerId(), repo.path)}?open=${encodeURIComponent(
          `agent:${agent.id}`,
        )}`,
      );
      await expect(page.getByText("chat needle alpha").first()).toBeVisible({
        timeout: 30_000,
      });
      await page.getByText("chat needle alpha").first().click();
      await openFind(page);
      await typeFindQuery(page, "needle");
      await expect(page.getByText(/[1-9] \/ [1-9]/)).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("pane-find-next").click();
      await page.getByTestId("pane-find-prev").click();
      await page.getByTestId("pane-find-close").click();
      await expect(page.getByTestId("pane-find-bar")).toHaveCount(0);
      await testInfo.attach("chat-find-walkthrough", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.getByTestId("workspace-header-menu-trigger").click();
      const browserMenuItem = page.getByTestId("workspace-header-new-browser");
      if (await browserMenuItem.isVisible().catch(() => false)) {
        await browserMenuItem.click();
        await expect(
          page.getByText("Open this workspace in Electron to use the built-in browser."),
        ).toBeVisible({ timeout: 10_000 });
        await page.keyboard.press(findShortcut());
        await expect(page.getByTestId("pane-find-bar")).toHaveCount(0);
        await testInfo.attach("browser-web-fallback", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      } else {
        await testInfo.attach("browser-web-fallback", {
          body: "Browser tab creation is not exposed in this browser-web runtime.",
          contentType: "text/plain",
        });
      }
    } finally {
      await agentClient.close();
      await client.close();
      await repo.cleanup();
    }
  });
});
