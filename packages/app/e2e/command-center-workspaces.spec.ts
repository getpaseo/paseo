import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { createIdleAgent } from "./helpers/archive-tab";
import { openCommandCenter } from "./helpers/command-center";
import { addOfflineHostAndReload } from "./helpers/hosts";
import { expectAppRoute } from "./helpers/route-assertions";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

const PRIMARY_HOST_LABEL = "Primary Host";
const SECONDARY_HOST_ID = "host-command-center-workspaces-secondary";
const WORKSPACE_TITLE = "Payments Refactor";
const WORKSPACE_BRANCH = "feature/cmd-k-workspaces";
const AGENT_TITLE = "Fix checkout retries";

test.describe("Command center workspaces", () => {
  test.describe.configure({ timeout: 180_000 });

  test("workspace results show their title, host, and branch and open the workspace", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({
      repoPrefix: "command-center-workspace-",
      title: WORKSPACE_TITLE,
    });

    try {
      execFileSync("git", ["checkout", "-b", WORKSPACE_BRANCH], {
        cwd: seeded.repoPath,
        stdio: "ignore",
      });
      const refreshed = await seeded.client.checkoutRefresh(seeded.repoPath);
      if (!refreshed.success) {
        throw new Error(`Failed to refresh checkout: ${JSON.stringify(refreshed.error)}`);
      }
      const agent = await createIdleAgent(seeded.client, {
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: AGENT_TITLE,
      });

      await gotoAppShell(page);
      await addOfflineHostAndReload(page, {
        serverId: SECONDARY_HOST_ID,
        label: "Secondary Host",
        primaryLabel: PRIMARY_HOST_LABEL,
      });

      const panel = await openCommandCenter(page);
      const row = panel.getByTestId(
        `command-center-workspace-${getServerId()}:${seeded.workspaceId}`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(WORKSPACE_TITLE);
      await expect(row).toContainText(PRIMARY_HOST_LABEL);
      await expect(row).toContainText(WORKSPACE_BRANCH);

      const agentRow = panel.getByTestId(`command-center-agent-${getServerId()}:${agent.id}`);
      await expect(agentRow).toContainText(AGENT_TITLE);
      await expect(agentRow).toContainText(PRIMARY_HOST_LABEL);
      await expect(agentRow).toContainText(WORKSPACE_TITLE);
      await expect(agentRow).not.toContainText(seeded.repoPath);

      const workspaceSectionTop = await panel
        .getByText("Workspaces", { exact: true })
        .evaluate((element) => element.getBoundingClientRect().top);
      const agentSectionTop = await panel
        .getByText("Agents", { exact: true })
        .evaluate((element) => element.getBoundingClientRect().top);
      expect(workspaceSectionTop).toBeLessThan(agentSectionTop);

      const input = panel.getByTestId("command-center-input");
      await input.fill(PRIMARY_HOST_LABEL);
      await expect(row).toBeVisible();
      await expect(agentRow).toBeVisible();

      await input.fill(WORKSPACE_BRANCH);
      await expect(row).toBeVisible();
      await expect(agentRow).not.toBeVisible();

      await input.fill(WORKSPACE_TITLE);
      await expect(row).toBeVisible();
      await expect(agentRow).toBeVisible();

      await input.fill(seeded.repoPath);
      await expect(agentRow).toBeVisible();
      await expect(row).not.toBeVisible();

      await input.fill(AGENT_TITLE);
      await expect(agentRow).toBeVisible();
      await expect(row).not.toBeVisible();

      await input.fill(WORKSPACE_TITLE);
      await page.keyboard.press("Enter");

      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), seeded.workspaceId), {
        timeout: 30_000,
      });
    } finally {
      await seeded.cleanup();
    }
  });
});
