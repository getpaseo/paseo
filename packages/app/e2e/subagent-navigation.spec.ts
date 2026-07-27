import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { test, type Page } from "./fixtures";
import { expectWorkspaceTabVisible } from "./helpers/archive-tab";
import { daemonWsRoutePattern } from "./helpers/daemon-port";
import { expectAgentTabActive } from "./helpers/launcher";
import { openAgentRoute } from "./helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import {
  expectSubagentRowVisible,
  openSubagentsTrack,
  seedParentWithCrossWorkspaceSubagent,
  seedParentWithSubagent,
} from "./helpers/subagents";

function omitAgentWorkspaceId(value: unknown, agentId: string): boolean {
  if (Array.isArray(value)) {
    return value.reduce((changed, entry) => omitAgentWorkspaceId(entry, agentId) || changed, false);
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  let changed = false;
  if (record.id === agentId && "workspaceId" in record) {
    delete record.workspaceId;
    changed = true;
  }
  for (const entry of Object.values(record)) {
    changed = omitAgentWorkspaceId(entry, agentId) || changed;
  }
  return changed;
}

async function installMissingAgentWorkspaceFixture(page: Page, agentId: string): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        ws.send(message);
        return;
      }

      try {
        const parsed = JSON.parse(message) as unknown;
        if (omitAgentWorkspaceId(parsed, agentId)) {
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch {
        // Forward non-JSON frames unchanged.
      }
      ws.send(message);
    });
  });
}

test.describe("Subagent navigation", () => {
  let workspace: SeededWorkspace;

  test.beforeAll(async () => {
    workspace = await seedWorkspace({ repoPrefix: "subagent-navigation-" });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  test("opens a subagent without workspace metadata in the parent workspace", async ({ page }) => {
    const childCwd = join(workspace.repoPath, "nested", "child");
    await mkdir(childCwd, { recursive: true });
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Navigation parent",
      childTitle: "Navigation child",
      childCwd,
    });
    await installMissingAgentWorkspaceFixture(page, agents.child.id);

    await openAgentRoute(page, {
      workspaceId: agents.workspaceId,
      agentId: agents.parent.id,
    });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await page.getByTestId(`subagents-track-row-${agents.child.id}`).click();

    await expectWorkspaceTabVisible(page, agents.child.id);
    await expectAgentTabActive(page, agents.child.id);
  });

  test("opens a cross-workspace subagent in its own workspace", async ({ page }) => {
    const agents = await seedParentWithCrossWorkspaceSubagent(workspace, {
      parentTitle: "Cross-workspace parent",
      childTitle: "Cross-workspace child",
    });

    await openAgentRoute(page, {
      workspaceId: agents.parent.workspaceId,
      agentId: agents.parent.id,
    });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await page.getByTestId(`subagents-track-row-${agents.child.id}`).click();

    await page.waitForURL((url) => url.pathname.includes(`/workspace/${agents.child.workspaceId}`));
    await expectWorkspaceTabVisible(page, agents.child.id);
    await expectAgentTabActive(page, agents.child.id);
  });
});
