import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "../support/fixtures";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  seedProjectForWorkspaceSetup,
} from "../support/helpers/workspace-setup";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

test("configured launches appear in the shared workspace run menu", async ({ page }) => {
  test.setTimeout(90_000);
  const client = await connectWorkspaceSetupClient();
  const repo = await createTempGitRepo("workspace-launches-", {
    paseoConfig: {
      worktree: {
        servicePorts: { blockSize: 4 },
      },
      launches: {
        worker: { command: 'node -e "setInterval(() => {}, 60_000)"' },
        dev: {
          command:
            "node -e \"const http = require('node:http'); const net = require('node:net'); const base = Number(process.env.PASEO_PORT_BASE); http.createServer((_, res) => res.end('ok')).listen(base, '127.0.0.1'); net.createServer().listen(base + 2, '127.0.0.1'); setInterval(() => {}, 60_000)\"",
        },
      },
      scripts: {
        web: { type: "service", command: "npm run web" },
        typecheck: { command: "npm run typecheck" },
      },
    },
  });

  try {
    await seedProjectForWorkspaceSetup(client, repo.path);
    const workspace = await createWorkspaceThroughDaemon(client, {
      cwd: repo.path,
      worktreeSlug: `workspace-launches-${Date.now()}`,
    });

    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
    await waitForWorkspaceTabsVisible(page);

    const runButton = page.getByTestId("workspace-scripts-button");
    await expect(runButton).toBeVisible({ timeout: 30_000 });
    await expect(runButton).toHaveAccessibleName("Run workspace commands");
    await expect(page.getByTestId("workspace-launches-button")).toHaveCount(0);
    await runButton.click();

    await expect(page.getByTestId("workspace-scripts-menu")).toBeVisible();
    await expect(page.getByTestId("workspace-launches-section")).toBeVisible();
    await expect(page.getByTestId("workspace-scripts-services-section")).toBeVisible();
    await expect(page.getByTestId("workspace-scripts-scripts-section")).toBeVisible();
    await expect(page.getByTestId("workspace-launches-item-dev")).toBeVisible();
    await expect(page.getByTestId("workspace-launches-start-dev")).toBeVisible();

    await page.getByTestId("workspace-launches-start-dev").click();
    await expect(page.getByTestId("workspace-launches-stop-dev")).toBeVisible({
      timeout: 30_000,
    });

    await expect(page.getByTestId("workspace-launches-status-dev")).toHaveText("Running");
    await expect(page.getByTestId("workspace-launches-view-dev")).toHaveText("Output");
    await expect(page.getByTestId("workspace-launches-start-worker")).toHaveText("Switch");
    await expect(page.getByTestId("workspace-launches-start-worker")).toHaveAccessibleName(
      "Stop dev and start worker",
    );

    const portRange = page.getByTestId("workspace-launches-port-range");
    await expect(portRange).toHaveText(/^ports \d+–\d+$/, { timeout: 30_000 });
    const portRangeMatch = /^ports (\d+)–\d+$/.exec((await portRange.textContent()) ?? "");
    if (!portRangeMatch) {
      throw new Error("Expected launch port range");
    }
    const portBase = Number(portRangeMatch[1]);
    const launch = page.getByTestId("workspace-launches-item-dev");

    await expect(page.getByTestId("workspace-launches-open-dev-dev:p0")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("workspace-launches-route-dev:p0").click();
    await expect(page.getByTestId("workspace-launches-route-dev:p0-direct")).toBeVisible();
    await page.getByTestId("workspace-launches-route-dev:p0-direct").click();
    await expect(launch).toContainText(String(portBase));
    await expect(launch).toContainText(String(portBase + 2));
    await expect(launch).toContainText("TCP");

    await page.getByTestId("workspace-launches-start-worker").click();
    await expect(page.getByTestId("workspace-launches-stop-worker")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("workspace-launches-stop-dev")).toHaveCount(0);
    await expect(page.getByTestId("workspace-launches-open-dev-dev:p0")).toHaveCount(0);
    await expect(page.getByTestId("workspace-launches-item-worker")).toContainText(
      "No listening ports detected yet",
    );
    await expect(portRange).toHaveText(new RegExp(`^ports ${portBase}–`));
    await page.screenshot({ path: test.info().outputPath("run-menu.png") });
    await page.getByTestId("workspace-launches-stop-worker").click();
    await expect(page.getByTestId("workspace-launches-stop-worker")).toHaveCount(0);
    await expect(page.getByTestId("workspace-launches-start-dev")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await client.close();
    await repo.cleanup();
  }
});

test("launch errors persist until users dismiss them or retry successfully", async ({ page }) => {
  test.setTimeout(90_000);
  const client = await connectWorkspaceSetupClient();
  const invalidConfig = {
    worktree: {
      servicePorts: { range: "41000-41000", blockSize: 2 },
    },
    launches: {
      dev: {
        command: 'node -e "setInterval(() => {}, 60_000)"',
      },
    },
  };
  const validConfig = {
    worktree: {
      servicePorts: { blockSize: 1 },
    },
    launches: invalidConfig.launches,
  };
  const repo = await createTempGitRepo("workspace-launch-errors-", {
    paseoConfig: invalidConfig,
  });

  try {
    await seedProjectForWorkspaceSetup(client, repo.path);
    const workspace = await createWorkspaceThroughDaemon(client, {
      cwd: repo.path,
      worktreeSlug: `workspace-launch-errors-${Date.now()}`,
    });

    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
    await waitForWorkspaceTabsVisible(page);

    const runButton = page.getByTestId("workspace-scripts-button");
    const menu = page.getByTestId("workspace-scripts-menu");
    const launchError = page.getByTestId("workspace-launches-error-dev");
    await runButton.click();
    await page.getByTestId("workspace-launches-start-dev").click();
    await expect(launchError).toContainText(
      "Workspace port block size 2 does not fit in configured range 41000-41000",
      { timeout: 30_000 },
    );

    await runButton.click();
    await expect(menu).toBeHidden({ timeout: 30_000 });
    await runButton.click();
    await expect(launchError).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("workspace-launches-dismiss-error-dev").click();
    await expect(launchError).toHaveCount(0);

    await page.getByTestId("workspace-launches-start-dev").click();
    await expect(launchError).toBeVisible({ timeout: 30_000 });
    await writeFile(join(repo.path, "paseo.json"), JSON.stringify(validConfig, null, 2));
    await page.getByTestId("workspace-launches-retry-dev").click();
    await expect(page.getByTestId("workspace-launches-stop-dev")).toBeVisible({
      timeout: 30_000,
    });
    await expect(launchError).toHaveCount(0);

    await page.getByTestId("workspace-launches-stop-dev").click();
    await expect(page.getByTestId("workspace-launches-start-dev")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await client.close();
    await repo.cleanup();
  }
});
