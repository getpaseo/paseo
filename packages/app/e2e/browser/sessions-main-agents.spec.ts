import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { openSessions, resetSeededPageState } from "../support/helpers/archive-tab";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";

const NONCE = `hsm${randomUUID().replaceAll("-", "").slice(0, 8)}`;

const TITLES = {
  mainOne: `${NONCE} Main one`,
  childOne: `${NONCE} Child one`,
  mainTwo: `${NONCE} Main two`,
  childTwo: `${NONCE} Child two`,
} as const;

async function createMockAgent(
  client: SeedDaemonClient,
  input: {
    cwd: string;
    workspaceId: string;
    title: string;
    labels?: Record<string, string>;
  },
): Promise<string> {
  const created = await client.createAgent({
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    title: input.title,
    ...(input.labels ? { labels: input.labels } : {}),
  });
  await client.waitForAgentUpsert(created.id, (agent) => agent.status === "idle", 30_000);
  return created.id;
}

function historyRows(page: Page) {
  return page.getByRole("button").filter({ hasText: NONCE });
}

test.describe("History main-agent filter", () => {
  test.describe.configure({ timeout: 300_000 });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps only main agents at ${viewport.width}px`, async ({ page }) => {
      const workspace = await seedWorkspace({ repoPrefix: "sessions-main-agents-" });
      const parentAgentId = await createMockAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: TITLES.mainOne,
      });
      await createMockAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: TITLES.childOne,
        labels: { "paseo.parent-agent-id": parentAgentId },
      });
      const secondParentAgentId = await createMockAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: TITLES.mainTwo,
      });
      await createMockAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: TITLES.childTwo,
        labels: { "paseo.parent-agent-id": secondParentAgentId },
      });

      try {
        await resetSeededPageState(page);
        await openSessions(page);
        await page.setViewportSize(viewport);

        await expect(historyRows(page)).toHaveCount(4, { timeout: 30_000 });
        await page.getByTestId("sessions-agent-scope-main").click();

        await expect(historyRows(page)).toHaveCount(2, { timeout: 30_000 });
        await expect(page.getByText(TITLES.mainOne)).toBeVisible();
        await expect(page.getByText(TITLES.mainTwo)).toBeVisible();
        await expect(page.getByText(TITLES.childOne)).toHaveCount(0);
        await expect(page.getByText(TITLES.childTwo)).toHaveCount(0);

        await page.getByTestId("sessions-agent-scope-all").click();
        await expect(historyRows(page)).toHaveCount(4, { timeout: 30_000 });
      } finally {
        await workspace.cleanup().catch(() => undefined);
      }
    });
  }
});
