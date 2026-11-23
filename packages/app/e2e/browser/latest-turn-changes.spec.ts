import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenterWithShortcut } from "../support/helpers/command-center";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { buildAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const pluginDirectory = process.env.PASEO_TURN_CHANGES_PLUGIN;
const stockVersion = "0.17.0-beta.1";
const viewports = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

async function openPluginPanel(page: Page) {
  await openCommandCenterWithShortcut(page);
  const panel = page.getByTestId("command-center-panel");
  await panel.getByTestId("command-center-input").fill("Open latest turn changes");
  await panel.getByRole("button", { name: "Open latest turn changes", exact: true }).click();
}

for (const stock of [false, true]) {
  test(`reviews a settled turn on ${stock ? "stock Paseo" : "the patched daemon"}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(
      stock && !pluginDirectory,
      "A plugin checkout is required for the optional stock comparison",
    );
    const serverId = stock ? "e2e-stock-turn-changes" : "e2e-core-turn-changes";
    const daemon = await startIsolatedHostDaemon(serverId, {
      config: {
        pluginsEnabled: Boolean(pluginDirectory),
        ...(!stock ? { agents: { latestTurnChanges: true } } : {}),
      },
      publishedVersion: stock ? stockVersion : undefined,
    });
    try {
      const client = await connectDaemonClient<DaemonClient>({
        port: daemon.port,
        clientIdPrefix: serverId,
      });
      try {
        if (pluginDirectory) {
          const plugin = await client.installDirectoryPlugin(pluginDirectory);
          expect(plugin.status).toBe("running");
        }
        const agent = await seedMockAgentWorkspace({
          port: daemon.port,
          repoPrefix: "paseo-latest-turn-e2e-",
          title: "Latest turn demo",
          model: "ten-second-stream",
        });
        try {
          await writeFile(path.join(agent.cwd, "already-dirty.txt"), "before turn\n");
          await agent.client.sendAgentMessage(agent.agentId, "Review the worktree");
          await agent.client.waitForAgentUpsert(
            agent.agentId,
            (state) => state.status === "running",
          );
          if (stock) {
            // The old hook returns as soon as it is scheduled. Give it a quiet baseline.
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
          await writeFile(path.join(agent.cwd, "during-turn.txt"), "during this turn\n");
          await agent.client.waitForFinish(agent.agentId, 25_000);
          if (!stock) await verifyRestart(daemon, client, agent.agentId);

          await page.setViewportSize(viewports[0]);
          await gotoAppShell(page);
          const host = buildSeededHost({
            serverId,
            label: "Turn changes demo",
            endpoint: `127.0.0.1:${daemon.port}`,
            nowIso: new Date().toISOString(),
          });
          await page.evaluate((extraHost) => {
            localStorage.setItem("@paseo:e2e-extra-hosts", JSON.stringify([extraHost]));
          }, host);
          const route = buildAgentRoute(agent.workspaceId, agent.agentId, serverId);
          await verifyViews(page, route, stock);
        } finally {
          await agent.cleanup();
        }
      } finally {
        await client.close();
      }
    } finally {
      await daemon.close();
    }
  });
}

async function verifyRestart(daemon: IsolatedHostDaemon, client: DaemonClient, agentId: string) {
  const original = (await client.fetchAgent({ agentId }))?.agent.latestTurnChanges;
  expect(original?.turnId).toBeTruthy();
  await daemon.restart();
  const reopened = await connectDaemonClient<DaemonClient>({
    port: daemon.port,
    clientIdPrefix: `${daemon.serverId}-restart`,
  });
  try {
    expect((await reopened.fetchAgent({ agentId }))?.agent.latestTurnChanges).toEqual(original);
  } finally {
    await reopened.close();
  }
}

async function openDemoAgent(page: Page, route: string) {
  await page.goto(route);
  await page.waitForURL((url) => !url.searchParams.has("open"), { timeout: 30_000 });
}

async function verifyViews(page: Page, route: string, stock: boolean) {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await openDemoAgent(page, route);
    const agentAction = page.getByTestId("agent-open-latest-turn").filter({ visible: true });
    if (stock) {
      await expect(agentAction).toHaveCount(0);
    } else {
      await agentAction.click();
      const diff = page.getByTestId("latest-turn-changes").filter({ visible: true });
      await expect(diff.getByTestId("diff-file-0")).toHaveAccessibleName(/during-turn\.txt/);
      await expect(diff.getByTestId("diff-file-1")).toHaveCount(0);
      await expect(diff.getByTestId("git-diff-canvas")).toBeVisible();
    }

    if (pluginDirectory) {
      await openDemoAgent(page, route);
      await openPluginPanel(page);
      await expect(page.getByText(/A\s+during-turn\.txt/).first()).toBeVisible();
      await expect(page.getByText(/\+during this turn/)).toBeVisible();
      await expect(page.getByText("Approximate timing")).toHaveCount(stock ? 1 : 0);
      await expect(page.getByText(/already-dirty\.txt/)).toHaveCount(0);
    }
  }
}
