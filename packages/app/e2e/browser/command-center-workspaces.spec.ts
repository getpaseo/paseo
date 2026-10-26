import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { openCommandCenter } from "../support/helpers/command-center";
import { addOfflineHostAndReload } from "../support/helpers/hosts";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedRunningMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

const PRIMARY_HOST_LABEL = "Primary Host";
const SECONDARY_HOST_ID = "host-command-center-workspaces-secondary";
const WORKSPACE_TITLE = "Payments Refactor";
const WORKSPACE_BRANCH = "feature/cmd-k-workspaces";
const AGENT_TITLE = "Fix checkout retries";

test.describe("Command center workspaces", () => {
  test.describe.configure({ timeout: 180_000 });

  test("agent and workspace results retain their icons and overlay live status", async ({
    page,
  }) => {
    const workspace = await seedRunningMockAgentWorkspace({
      repoPrefix: "command-center-status-",
      title: "Review checkout retries",
      model: "five-minute-stream",
      initialPrompt: "Keep working on checkout retries",
    });
    try {
      await openAgentRoute(page, workspace);
      await expectAgentTabActive(page, workspace.agentId);
      const panel = await openCommandCenter(page);
      const agent = panel.getByTestId(`command-center-agent-${getServerId()}:${workspace.agentId}`);
      const row = panel.getByTestId(
        `command-center-workspace-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(agent.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
      await expect(row.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
      await expect(agent.getByRole("img", { name: "Mock agent" })).toBeVisible();
      await workspace.client.cancelAgent(workspace.agentId);
      await expect(agent.getByRole("progressbar")).toHaveCount(0);
      await expect(row.getByRole("progressbar")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

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
      await expect(row).toContainText(WORKSPACE_BRANCH);

      // The subtitle disambiguates by project: host · project · branch (multi-host).
      const subtitle = row.getByTestId("command-center-workspace-subtitle");
      await expect(subtitle).toContainText(PRIMARY_HOST_LABEL);
      await expect(subtitle).toContainText(seeded.projectDisplayName);
      await expect(subtitle).toContainText(WORKSPACE_BRANCH);

      // The agent subtitle is unchanged by the shared-helper refactor.
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

      // The project name is now part of the workspace searchText.
      await input.fill(seeded.projectDisplayName);
      await expect(row).toBeVisible();

      await input.fill(AGENT_TITLE);
      await expect(agentRow).toBeVisible();
      await expect(row).not.toBeVisible();

      await input.fill(WORKSPACE_TITLE);
      await page.keyboard.press("Enter");

      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), seeded.workspaceId), {
        timeout: 30_000,
      });

      await test.step("find an agent and open its workspace tab", async () => {
        const agentPanel = await openCommandCenter(page);
        await agentPanel.getByTestId("command-center-input").fill(AGENT_TITLE);
        await page.keyboard.press("Enter");
        await expectAgentTabActive(page, agent.id);
      });
    } finally {
      await seeded.cleanup();
    }
  });

  test("single-host workspace subtitle omits the host and shows project · branch", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({
      repoPrefix: "command-center-workspace-single-",
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

      // No secondary host: with a single host, the host label is gated away.
      await gotoAppShell(page);

      const panel = await openCommandCenter(page);
      const row = panel.getByTestId(
        `command-center-workspace-${getServerId()}:${seeded.workspaceId}`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });

      const subtitle = row.getByTestId("command-center-workspace-subtitle");
      await expect(subtitle).toHaveText(`${seeded.projectDisplayName} · ${WORKSPACE_BRANCH}`);
    } finally {
      await seeded.cleanup();
    }
  });
});

test.describe("Compact sidebar inspection", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function openSidebar(page: import("@playwright/test").Page) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await expect(page.getByTestId("sidebar-search")).toBeVisible();
  }

  async function expectSidebarPreserved(page: import("@playwright/test").Page) {
    await expect(page.getByRole("button", { name: "Close menu", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("sidebar-search")).toBeVisible();
  }

  test("canceling Search retains the compact sidebar", async ({ page }) => {
    await gotoAppShell(page);
    await openSidebar(page);
    await openCommandCenter(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-center-panel")).not.toBeVisible();
    await expectSidebarPreserved(page);
  });
  test("canceling Import session retains the compact sidebar", async ({ page }) => {
    await gotoAppShell(page);
    await openSidebar(page);
    await page
      .getByTestId("sidebar-project-empty-state")
      .getByRole("button", { name: "Import session", exact: true })
      .click();
    await expect(page.getByTestId("import-session-sheet")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByTestId("import-session-sheet")).not.toBeVisible();
    await expectSidebarPreserved(page);
  });

  test("Search reveals the same workspace and a selected root agent", async ({ page }) => {
    const seeded = await seedWorkspace({
      repoPrefix: "compact-search-destination-",
      title: "Compact destination",
    });
    try {
      const agent = await createIdleAgent(seeded.client, {
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: "Compact root agent",
      });
      await page.goto(buildHostWorkspaceRoute(getServerId(), seeded.workspaceId));
      await openSidebar(page);
      const search = await openCommandCenter(page);
      await search.getByTestId("command-center-input").fill("Compact destination");
      await search
        .getByTestId(`command-center-workspace-${getServerId()}:${seeded.workspaceId}`)
        .click();
      await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), seeded.workspaceId));
      await openSidebar(page);
      const agentSearch = await openCommandCenter(page);
      await agentSearch.getByTestId("command-center-input").fill("Compact root agent");
      await agentSearch.getByTestId(`command-center-agent-${getServerId()}:${agent.id}`).click();
      await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message agent...", exact: true }),
      ).toBeVisible();
    } finally {
      await seeded.cleanup();
    }
  });
});
