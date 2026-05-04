import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import {
  archiveAgentFromDaemon,
  connectArchiveTabDaemonClient,
  createIdleAgent,
  openWorkspaceWithAgents,
} from "./helpers/archive-tab";
import { waitForTabBar, expectAgentTabActive } from "./helpers/launcher";
import { createTempGitRepo } from "./helpers/workspace";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

async function pressSettingsToggleShortcut(page: import("@playwright/test").Page) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+Comma`);
}

async function expectSendBehavior(
  page: import("@playwright/test").Page,
  expected: "interrupt" | "queue",
) {
  await expect
    .poll(async () => {
      const raw = await page.evaluate(() => localStorage.getItem("@paseo:app-settings"));
      if (!raw) {
        return null;
      }
      return (JSON.parse(raw) as { sendBehavior?: string }).sendBehavior ?? null;
    })
    .toBe(expected);
}

async function openAgentRouteAndExpectFocused(input: {
  page: import("@playwright/test").Page;
  serverId: string;
  workspaceId: string;
  agentId: string;
}) {
  await input.page.goto(
    buildHostAgentDetailRoute(input.serverId, input.agentId, input.workspaceId),
  );
  await input.page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForTabBar(input.page);
  await expectAgentTabActive(input.page, input.agentId);
}

test.describe("Settings toggle tab regression", () => {
  test.describe.configure({ timeout: 180_000 });

  test("toggling settings after changing a setting returns to the same workspace tab", async ({
    page,
  }) => {
    const serverId = getServerId();
    const client = await connectArchiveTabDaemonClient();
    const repo = await createTempGitRepo("settings-toggle-tab-");
    const agentIds: string[] = [];

    try {
      const firstAgent = await createIdleAgent(client, {
        cwd: repo.path,
        title: `settings-toggle-a-${Date.now()}`,
      });
      const secondAgent = await createIdleAgent(client, {
        cwd: repo.path,
        title: `settings-toggle-b-${Date.now()}`,
      });
      agentIds.push(firstAgent.id, secondAgent.id);

      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);
      await waitForTabBar(page);
      await expectAgentTabActive(page, secondAgent.id);

      await pressSettingsToggleShortcut(page);
      await expect(page).toHaveURL(/\/settings\/general$/);

      await page.getByRole("button", { name: "Queue", exact: true }).click();
      await expectSendBehavior(page, "queue");
      await page.getByRole("button", { name: "Interrupt", exact: true }).click();
      await expectSendBehavior(page, "interrupt");

      await pressSettingsToggleShortcut(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, repo.path));
      await waitForTabBar(page);
      await expectAgentTabActive(page, secondAgent.id);

      await page.reload();
      await waitForTabBar(page);
      await expectAgentTabActive(page, secondAgent.id);
    } finally {
      for (const agentId of agentIds) {
        await archiveAgentFromDaemon(client, agentId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup();
    }
  });

  test("refresh after navigating between agent routes keeps the latest agent focused", async ({
    page,
  }) => {
    const serverId = getServerId();
    const client = await connectArchiveTabDaemonClient();
    const repo = await createTempGitRepo("agent-route-refresh-");
    const agentIds: string[] = [];

    try {
      const firstAgent = await createIdleAgent(client, {
        cwd: repo.path,
        title: `agent-route-refresh-a-${Date.now()}`,
      });
      const secondAgent = await createIdleAgent(client, {
        cwd: repo.path,
        title: `agent-route-refresh-b-${Date.now()}`,
      });
      agentIds.push(firstAgent.id, secondAgent.id);

      await openAgentRouteAndExpectFocused({
        page,
        serverId,
        workspaceId: repo.path,
        agentId: firstAgent.id,
      });
      await openAgentRouteAndExpectFocused({
        page,
        serverId,
        workspaceId: repo.path,
        agentId: secondAgent.id,
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await page.reload();
        await waitForTabBar(page);
        await expectAgentTabActive(page, secondAgent.id);
      }
    } finally {
      for (const agentId of agentIds) {
        await archiveAgentFromDaemon(client, agentId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup();
    }
  });
});
