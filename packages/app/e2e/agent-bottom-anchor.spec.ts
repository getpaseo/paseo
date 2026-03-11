import { test, expect, type Page } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import {
  connectDaemonClient,
  createReplyTurn,
  expectDetachedFromBottom,
  expectNearBottom,
  getChatContainerKey,
  readScrollMetrics,
  scrollUpFromBottom,
  seedBottomAnchorAgent,
  waitForAgentReady,
  waitForContentGrowth,
} from "./helpers/agent-bottom-anchor";

test.describe.configure({ timeout: 180000 });

async function openWorkspaceAgentTab(page: Page, agentId: string) {
  const tab = page.getByTestId(`workspace-tab-agent_${agentId}`).first();
  await expect(tab).toBeVisible({ timeout: 30000 });
  const trigger = tab.getByRole("button").first();
  const clickableTarget = (await trigger.count()) > 0 ? trigger : tab;
  await clickableTarget.scrollIntoViewIfNeeded();
  await clickableTarget.click({ timeout: 5000 });
}

function buildWorkspaceDraftUrl(workspaceUrl: string) {
  return `${workspaceUrl}?open=${encodeURIComponent("draft:new")}`;
}

test("direct load and refresh land at the bottom for history-backed chats", async ({
  page,
}) => {
  const repo = await createTempGitRepo("paseo-e2e-bottom-anchor-direct-");
  const client = await connectDaemonClient();

  try {
    const agent = await seedBottomAnchorAgent({
      client,
      cwd: repo.path,
      title: `bottom-anchor-direct-${Date.now()}`,
      turnCount: 4,
    });

    await page.goto(agent.url, { waitUntil: "domcontentloaded" });
    await openWorkspaceAgentTab(page, agent.id);
    await waitForAgentReady(page, agent.expectedTailText);
    await expectNearBottom(page);

    await page.reload({ waitUntil: "commit" });
    await openWorkspaceAgentTab(page, agent.id);
    await waitForAgentReady(page, agent.expectedTailText);
    await expectNearBottom(page);
  } finally {
    await client.close().catch(() => undefined);
    await repo.cleanup();
  }
});

test("revisiting a loaded chat restores bottom anchoring", async ({
  page,
}) => {
  const repo = await createTempGitRepo("paseo-e2e-bottom-anchor-switch-");
  const client = await connectDaemonClient();

  try {
    const agent = await seedBottomAnchorAgent({
      client,
      cwd: repo.path,
      title: `bottom-anchor-switch-${Date.now()}`,
      turnCount: 4,
    });

    await page.goto(agent.url, { waitUntil: "domcontentloaded" });
    await openWorkspaceAgentTab(page, agent.id);
    await waitForAgentReady(page, agent.expectedTailText);
    await expectNearBottom(page);

    await page.goto(buildWorkspaceDraftUrl(agent.workspaceUrl), {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible({
      timeout: 30000,
    });

    await openWorkspaceAgentTab(page, agent.id);
    await waitForAgentReady(page, agent.expectedTailText);
    await expectNearBottom(page);
  } finally {
    await client.close().catch(() => undefined);
    await repo.cleanup();
  }
});

test("sticky mode stays pinned through composer growth and viewport resize, but detached mode does not fight streamed updates", async ({
  page,
}) => {
  const repo = await createTempGitRepo("paseo-e2e-bottom-anchor-sticky-");
  const client = await connectDaemonClient();

  try {
    const agent = await seedBottomAnchorAgent({
      client,
      cwd: repo.path,
      title: `bottom-anchor-sticky-${Date.now()}`,
      turnCount: 10,
      lineCount: 24,
    });

    await page.setViewportSize({ width: 1320, height: 920 });
    await page.goto(agent.url, { waitUntil: "domcontentloaded" });
    await openWorkspaceAgentTab(page, agent.id);
    await waitForAgentReady(page, agent.expectedTailText);
    await expectNearBottom(page);

    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.click();
    for (let index = 0; index < 6; index += 1) {
      await composer.pressSequentially(`composer growth line ${index + 1}`);
      if (index < 5) {
        await page.keyboard.press("Shift+Enter");
      }
    }
    await expectNearBottom(page);
    await expect(page.getByTestId("scroll-to-bottom-button")).toHaveCount(0);

    await page.setViewportSize({ width: 1040, height: 760 });
    await expect(page.getByTestId(`workspace-tab-agent_${agent.id}`).first()).toBeVisible({
      timeout: 30000,
    });
    await waitForAgentReady(page, agent.expectedTailText);
    await expectNearBottom(page);

    await scrollUpFromBottom(page, 720);
    await expectDetachedFromBottom(page);
    const beforeExternalUpdate = await readScrollMetrics(page);

    const externalTurn = createReplyTurn(`external-stream-${Date.now()}`);
    await client.sendAgentMessage(agent.id, externalTurn.message);
    await waitForContentGrowth(page, beforeExternalUpdate.contentHeight);
    const finish = await client.waitForFinish(agent.id, 120000);
    expect(finish.status).toBe("idle");
    await expectDetachedFromBottom(page);
  } finally {
    await client.close().catch(() => undefined);
    await repo.cleanup();
  }
});

test("web partial virtualization keeps bottom anchoring stable across direct load, refresh, and resize", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as typeof window & {
      __PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD?: number;
      __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: number;
    }).__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD = 6;
    (window as typeof window & {
      __PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD?: number;
      __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: number;
    }).__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS = 4;
  });

  const repo = await createTempGitRepo("paseo-e2e-bottom-anchor-virtualized-");
  const client = await connectDaemonClient();

  try {
    const agent = await seedBottomAnchorAgent({
      client,
      cwd: repo.path,
      title: `bottom-anchor-virtualized-${Date.now()}`,
      turnCount: 4,
    });

    await page.goto(agent.url, { waitUntil: "domcontentloaded" });
    await openWorkspaceAgentTab(page, agent.id);
    await waitForAgentReady(page, agent.expectedTailText);
    await expect
      .poll(async () => await getChatContainerKey(page))
      .toBe("web-partial-virtualized");
    await expectNearBottom(page);

    await page.reload({ waitUntil: "commit" });
    await openWorkspaceAgentTab(page, agent.id);
    await waitForAgentReady(page, agent.expectedTailText);
    await expect
      .poll(async () => await getChatContainerKey(page))
      .toBe("web-partial-virtualized");
    await expectNearBottom(page);

    await page.setViewportSize({ width: 780, height: 720 });
    await expectNearBottom(page);
  } finally {
    await client.close().catch(() => undefined);
    await repo.cleanup();
  }
});
