import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../../src/utils/host-routes";
import { createTempGitRepo } from "./workspace";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  seedProjectForWorkspaceSetup,
} from "./workspace-setup";
import { waitForWorkspaceTabsVisible } from "./workspace-tabs";
import { getServerId } from "./server-id";

const configuredLaunches = {
  worker: { command: 'node -e "setInterval(() => {}, 60_000)"' },
  dev: {
    command:
      "node -e \"const http = require('node:http'); const net = require('node:net'); const base = Number(process.env.PASEO_PORT_BASE); http.createServer((_, res) => res.end('ok')).listen(base, '127.0.0.1'); net.createServer().listen(base + 2, '127.0.0.1'); setInterval(() => {}, 60_000)\"",
  },
};

export async function verifyConfiguredWorkspaceLaunches(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  const client = await connectWorkspaceSetupClient();
  const repo = await createTempGitRepo("workspace-launches-", {
    paseoConfig: {
      worktree: { servicePorts: { blockSize: 4 } },
      launches: configuredLaunches,
      scripts: {
        web: { type: "service", command: "npm run web" },
        typecheck: { command: "npm run typecheck" },
      },
    },
  });

  try {
    const workspace = await createLaunchWorkspace(client, repo.path, "workspace-launches");
    await openWorkspaceRunMenu(page, workspace.id);
    await expectConfiguredLaunchMenu(page);
    await startLaunch(page, "dev");
    const portBase = await expectRunningDevLaunch(page);
    await openDevLaunchDirectRoute(page);
    await expectDevLaunchEndpoints(page, portBase);
    await switchToWorkerLaunch(page, portBase);
    await page.screenshot({ path: testInfo.outputPath("run-menu.png") });
    await stopLaunch(page, "worker");
  } finally {
    await client.close();
    await repo.cleanup();
  }
}

export async function verifyWorkspaceLaunchErrorRecovery(page: Page): Promise<void> {
  const invalidConfig = {
    worktree: { servicePorts: { range: "41000-41000", blockSize: 2 } },
    launches: { dev: configuredLaunches.dev },
  };
  const validConfig = {
    worktree: { servicePorts: { blockSize: 1 } },
    launches: invalidConfig.launches,
  };
  const client = await connectWorkspaceSetupClient();
  const repo = await createTempGitRepo("workspace-launch-errors-", { paseoConfig: invalidConfig });

  try {
    const workspace = await createLaunchWorkspace(client, repo.path, "workspace-launch-errors");
    await openWorkspaceRunMenu(page, workspace.id);
    await expectLaunchError(page);
    await dismissLaunchErrorAfterMenuReopen(page);
    await expectLaunchError(page);
    await writeFile(join(repo.path, "paseo.json"), JSON.stringify(validConfig, null, 2));
    await retryLaunch(page, "dev");
    await stopLaunch(page, "dev");
  } finally {
    await client.close();
    await repo.cleanup();
  }
}

async function createLaunchWorkspace(
  client: Awaited<ReturnType<typeof connectWorkspaceSetupClient>>,
  repoPath: string,
  slugPrefix: string,
): Promise<{ id: string }> {
  await seedProjectForWorkspaceSetup(client, repoPath);
  return createWorkspaceThroughDaemon(client, {
    cwd: repoPath,
    worktreeSlug: `${slugPrefix}-${Date.now()}`,
  });
}

async function openWorkspaceRunMenu(page: Page, workspaceId: string): Promise<void> {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
  await waitForWorkspaceTabsVisible(page);
  const runButton = page.getByTestId("workspace-scripts-button");
  await expect(runButton).toBeVisible({ timeout: 30_000 });
  await expect(runButton).toHaveAccessibleName("Run workspace commands");
  await runButton.click();
}

async function expectConfiguredLaunchMenu(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-launches-button")).toHaveCount(0);
  await expect(page.getByTestId("workspace-scripts-menu")).toBeVisible();
  await expect(page.getByTestId("workspace-launches-section")).toBeVisible();
  await expect(page.getByTestId("workspace-scripts-services-section")).toBeVisible();
  await expect(page.getByTestId("workspace-scripts-scripts-section")).toBeVisible();
  await expect(page.getByTestId("workspace-launches-item-dev")).toBeVisible();
  await expect(page.getByTestId("workspace-launches-start-dev")).toBeVisible();
}

async function startLaunch(page: Page, launchName: string): Promise<void> {
  await page.getByTestId(`workspace-launches-start-${launchName}`).click();
  await expect(page.getByTestId(`workspace-launches-stop-${launchName}`)).toBeVisible({
    timeout: 30_000,
  });
}

async function stopLaunch(page: Page, launchName: string): Promise<void> {
  await page.getByTestId(`workspace-launches-stop-${launchName}`).click();
  await expect(page.getByTestId(`workspace-launches-stop-${launchName}`)).toHaveCount(0);
  await expect(page.getByTestId(`workspace-launches-start-${launchName}`)).toBeVisible({
    timeout: 30_000,
  });
}

async function expectRunningDevLaunch(page: Page): Promise<number> {
  await expect(page.getByTestId("workspace-launches-status-dev")).toHaveText("Running");
  await expect(page.getByTestId("workspace-launches-view-dev")).toHaveText("Output");
  await expect(page.getByTestId("workspace-launches-start-worker")).toHaveText("Switch");
  await expect(page.getByTestId("workspace-launches-start-worker")).toHaveAccessibleName(
    "Stop dev and start worker",
  );
  return readLaunchPortBase(page);
}

async function readLaunchPortBase(page: Page): Promise<number> {
  const portRange = page.getByTestId("workspace-launches-port-range");
  await expect(portRange).toHaveText(/^ports \d+–\d+$/, { timeout: 30_000 });
  const text = await portRange.textContent();
  const match = /^ports (\d+)–\d+$/.exec(text ?? "");
  if (!match) {
    throw new Error("Expected launch port range");
  }
  return Number(match[1]);
}

async function openDevLaunchDirectRoute(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-launches-open-dev-dev:p0")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("workspace-launches-route-dev:p0").click();
  await expect(page.getByTestId("workspace-launches-route-dev:p0-direct")).toBeVisible();
  await page.getByTestId("workspace-launches-route-dev:p0-direct").click();
}

async function expectDevLaunchEndpoints(page: Page, portBase: number): Promise<void> {
  const launch = page.getByTestId("workspace-launches-item-dev");
  await expect(launch).toContainText(String(portBase));
  await expect(launch).toContainText(String(portBase + 2));
  await expect(launch).toContainText("TCP");
}

async function switchToWorkerLaunch(page: Page, portBase: number): Promise<void> {
  await startLaunch(page, "worker");
  await expect(page.getByTestId("workspace-launches-stop-dev")).toHaveCount(0);
  await expect(page.getByTestId("workspace-launches-open-dev-dev:p0")).toHaveCount(0);
  await expect(page.getByTestId("workspace-launches-item-worker")).toContainText(
    "No listening ports detected yet",
  );
  await expect(page.getByTestId("workspace-launches-port-range")).toHaveText(
    new RegExp(`^ports ${portBase}–`),
  );
}

async function expectLaunchError(page: Page): Promise<void> {
  await page.getByTestId("workspace-launches-start-dev").click();
  await expect(page.getByTestId("workspace-launches-error-dev")).toContainText(
    "Workspace port block size 2 does not fit in configured range 41000-41000",
    { timeout: 30_000 },
  );
}

async function dismissLaunchErrorAfterMenuReopen(page: Page): Promise<void> {
  const runButton = page.getByTestId("workspace-scripts-button");
  await runButton.click();
  await expect(page.getByTestId("workspace-scripts-menu")).toBeHidden({ timeout: 30_000 });
  await runButton.click();
  await expect(page.getByTestId("workspace-launches-error-dev")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("workspace-launches-dismiss-error-dev").click();
  await expect(page.getByTestId("workspace-launches-error-dev")).toHaveCount(0);
}

async function retryLaunch(page: Page, launchName: string): Promise<void> {
  await page.getByTestId(`workspace-launches-retry-${launchName}`).click();
  await expect(page.getByTestId(`workspace-launches-stop-${launchName}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId(`workspace-launches-error-${launchName}`)).toHaveCount(0);
}
