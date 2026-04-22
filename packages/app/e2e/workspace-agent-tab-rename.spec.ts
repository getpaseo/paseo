import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import {
  connectArchiveTabDaemonClient,
  createIdleAgent,
  expectWorkspaceTabVisible,
} from "./helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";

type UpdateAgentFrame = {
  agentId: string;
  name: string;
  requestId: string;
};

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set (expected from Playwright globalSetup).");
  }
  return serverId;
}

function captureUpdateAgentFrames(page: Page): UpdateAgentFrame[] {
  const captured: UpdateAgentFrame[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const raw = frame.payload;
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        const outer = JSON.parse(text) as {
          type?: string;
          message?: {
            type?: string;
            agentId?: unknown;
            name?: unknown;
            requestId?: unknown;
          };
        };
        const inner = outer.message;
        if (outer.type === "session" && inner?.type === "update_agent_request") {
          captured.push({
            agentId: String(inner.agentId ?? ""),
            name: String(inner.name ?? ""),
            requestId: String(inner.requestId ?? ""),
          });
        }
      } catch {
        // Ignore non-JSON and binary frames.
      }
    });
  });
  return captured;
}

async function openAgentTabContextMenu(page: Page, agentId: string): Promise<void> {
  const tab = page.getByTestId(`workspace-tab-agent_${agentId}`).first();
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click({ button: "right" });

  const contextMenu = page.getByTestId(`workspace-tab-context-agent_${agentId}`);
  await expect(contextMenu).toBeVisible({ timeout: 10_000 });
}

async function invokeRenameFromAgentContextMenu(page: Page, agentId: string): Promise<void> {
  await openAgentTabContextMenu(page, agentId);
  const renameItem = page.getByTestId(`workspace-tab-context-agent_${agentId}-rename`);
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();
}

function renameModalInput(page: Page, agentId: string) {
  return page.getByTestId(`workspace-tab-rename-modal-agent-${agentId}-input`);
}

function renameModalSubmit(page: Page, agentId: string) {
  return page.getByTestId(`workspace-tab-rename-modal-agent-${agentId}-submit`);
}

async function openAgentInWorkspace(page: Page, agent: { id: string; cwd: string }) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.cwd));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, agent.id);
}

test.describe("Workspace agent tab rename", () => {
  test("right-click rename sends update_agent_request and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const client = await connectArchiveTabDaemonClient();
    const repo = await createTempGitRepo("workspace-agent-rename-");

    try {
      const initialTitle = `agent-rename-${randomUUID().slice(0, 8)}`;
      const agent = await createIdleAgent(client, {
        cwd: repo.path,
        title: initialTitle,
      });

      const updateFrames = captureUpdateAgentFrames(page);

      await openAgentInWorkspace(page, agent);

      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
      await expect(tab).toContainText(initialTitle, { timeout: 15_000 });

      await invokeRenameFromAgentContextMenu(page, agent.id);

      const input = renameModalInput(page, agent.id);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);

      const renamed = "My Renamed Agent";
      await input.fill(renamed);
      await expect(input).toHaveValue(renamed);

      await renameModalSubmit(page, agent.id).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText(renamed, { timeout: 15_000 });

      expect(updateFrames.length).toBeGreaterThan(0);
      const lastFrame = updateFrames.at(-1);
      expect(lastFrame?.agentId).toBe(agent.id);
      expect(lastFrame?.name).toBe(renamed);
      expect(lastFrame?.requestId.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
