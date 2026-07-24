import { randomUUID } from "node:crypto";
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

/**
 * Shared e2e daemons keep leftover workspaces/agents across cases and retries.
 * Fixed titles ("Payments Refactor") made Cmd+K Enter land on a polluted row
 * with the same label but a different wks_* while the seeded row stayed visible.
 * Per-run ids keep filters and keyboard selection unambiguous.
 */
function uniqueRunLabels(prefix: string) {
  const runId = randomUUID().slice(0, 8);
  return {
    runId,
    workspaceTitle: `${prefix} ${runId}`,
    workspaceBranch: `feature/cmd-k-workspaces-${runId}`,
    agentTitle: `Fix checkout retries ${runId}`,
  };
}

test.describe("Command center workspaces", () => {
  test.describe.configure({ timeout: 180_000 });

  test("workspace results show their title, host, and branch and open the workspace", async ({
    page,
  }) => {
    const { workspaceTitle, workspaceBranch, agentTitle } = uniqueRunLabels("Payments Refactor");

    const seeded = await seedWorkspace({
      repoPrefix: "command-center-workspace-",
      title: workspaceTitle,
    });

    try {
      execFileSync("git", ["checkout", "-b", workspaceBranch], {
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
        title: agentTitle,
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
      await expect(row).toContainText(workspaceTitle);
      await expect(row).toContainText(workspaceBranch);

      // The subtitle disambiguates by project: host · project · branch (multi-host).
      const subtitle = row.getByTestId("command-center-workspace-subtitle");
      await expect(subtitle).toContainText(PRIMARY_HOST_LABEL);
      await expect(subtitle).toContainText(seeded.projectDisplayName);
      await expect(subtitle).toContainText(workspaceBranch);

      // The agent subtitle is unchanged by the shared-helper refactor.
      const agentRow = panel.getByTestId(`command-center-agent-${getServerId()}:${agent.id}`);
      await expect(agentRow).toContainText(agentTitle);
      await expect(agentRow).toContainText(PRIMARY_HOST_LABEL);
      await expect(agentRow).toContainText(workspaceTitle);
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

      await input.fill(workspaceBranch);
      await expect(row).toBeVisible();
      await expect(agentRow).not.toBeVisible();

      await input.fill(workspaceTitle);
      await expect(row).toBeVisible();
      await expect(agentRow).toBeVisible();

      await input.fill(seeded.repoPath);
      await expect(agentRow).toBeVisible();
      await expect(row).not.toBeVisible();

      // The project name is now part of the workspace searchText.
      await input.fill(seeded.projectDisplayName);
      await expect(row).toBeVisible();

      await input.fill(agentTitle);
      await expect(agentRow).toBeVisible();
      await expect(row).not.toBeVisible();

      await input.fill(workspaceTitle);
      await expect(row).toBeVisible();
      // Open via the seeded row's test id — not Enter on active highlight.
      // Enter follows preserveActiveResultId, which can still target a leftover
      // same-title result when the shared daemon is dirty; the testid is unique.
      await row.click();

      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), seeded.workspaceId), {
        timeout: 30_000,
      });
    } finally {
      await seeded.cleanup();
    }
  });

  test("single-host workspace subtitle omits the host and shows project · branch", async ({
    page,
  }) => {
    const { workspaceTitle, workspaceBranch } = uniqueRunLabels("Payments Refactor single");

    const seeded = await seedWorkspace({
      repoPrefix: "command-center-workspace-single-",
      title: workspaceTitle,
    });

    try {
      execFileSync("git", ["checkout", "-b", workspaceBranch], {
        cwd: seeded.repoPath,
        stdio: "ignore",
      });
      const refreshed = await seeded.client.checkoutRefresh(seeded.repoPath);
      if (!refreshed.success) {
        throw new Error(`Failed to refresh checkout: ${JSON.stringify(refreshed.error)}`);
      }

      // No secondary host: with a single host, the host label is gated away.
      await gotoAppShell(page);

      const panel = await openCommandCenter(page);
      const row = panel.getByTestId(
        `command-center-workspace-${getServerId()}:${seeded.workspaceId}`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });

      const subtitle = row.getByTestId("command-center-workspace-subtitle");
      await expect(subtitle).toHaveText(`${seeded.projectDisplayName} · ${workspaceBranch}`);
    } finally {
      await seeded.cleanup();
    }
  });
});
