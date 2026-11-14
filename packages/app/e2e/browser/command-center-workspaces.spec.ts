import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { expectAgentTabActive } from "../support/helpers/launcher";
import {
  commandCenterSection,
  expectCommandCenterTab,
  openCommandCenter,
  selectCommandCenterTab,
} from "../support/helpers/command-center";
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

  test("workspace results overlay live status", async ({ page }) => {
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
      // Recent workspaces leaves out the open one; the Workspaces tab lists every workspace.
      await selectCommandCenterTab(panel, "Workspaces");
      const row = panel.getByTestId(
        `command-center-workspace-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(row.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
      await workspace.client.cancelAgent(workspace.agentId);
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
      await selectCommandCenterTab(panel, "Workspaces");
      const row = panel.getByTestId(
        `command-center-workspace-${getServerId()}:${seeded.workspaceId}`,
      );
      const agentLine = row.getByTestId("command-center-workspace-agent");
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(WORKSPACE_TITLE);
      await expect(row).toContainText(WORKSPACE_BRANCH);

      // The subtitle disambiguates by project: host · project · branch (multi-host).
      const subtitle = row.getByTestId("command-center-workspace-subtitle");
      await expect(subtitle).toContainText(PRIMARY_HOST_LABEL);
      await expect(subtitle).toContainText(seeded.projectDisplayName);
      await expect(subtitle).toContainText(WORKSPACE_BRANCH);
      await expect(agentLine).toHaveCount(0);

      await test.step("a workspace matches on its own fields", async () => {
        const input = panel.getByTestId("command-center-input");
        for (const query of [
          PRIMARY_HOST_LABEL,
          WORKSPACE_BRANCH,
          WORKSPACE_TITLE,
          seeded.projectDisplayName,
        ]) {
          await input.fill(query);
          await expect(row).toBeVisible();
          await expect(agentLine).toHaveCount(0);
        }
        // `cwd` is never shown, so it must never match.
        await input.fill(seeded.repoPath);
        await expect(row).not.toBeVisible();
      });

      await test.step("an agent title finds its workspace and names the agent", async () => {
        await panel.getByTestId("command-center-input").fill(AGENT_TITLE);
        await expect(agentLine).toHaveText(AGENT_TITLE);
        await expect(panel.getByText("Agents", { exact: true })).toHaveCount(0);
        await page.keyboard.press("Enter");
        await expectAgentTabActive(page, agent.id);
      });

      await test.step("a workspace match opens the workspace", async () => {
        const searchAgain = await openCommandCenter(page);
        await expectCommandCenterTab(searchAgain, "All");
        await searchAgain.getByTestId("command-center-input").fill(WORKSPACE_TITLE);
        await page.keyboard.press("Enter");
        await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), seeded.workspaceId), {
          timeout: 30_000,
        });
      });
    } finally {
      await seeded.cleanup();
    }
  });

  test("All leads with the three most recent workspaces other than the open one", async ({
    page,
  }) => {
    const older = [];
    for (const title of ["Recent oldest", "Recent third", "Recent second", "Recent newest"]) {
      older.push(await seedWorkspace({ repoPrefix: "command-center-recent-", title }));
    }
    const current = await seedWorkspace({
      repoPrefix: "command-center-recent-",
      title: "Open one",
    });
    try {
      await page.goto(buildHostWorkspaceRoute(getServerId(), current.workspaceId));
      const panel = await openCommandCenter(page);
      await expectCommandCenterTab(panel, "All");
      await expect(commandCenterSection(panel, "Recent workspaces")).toBeVisible();
      const rowOf = (workspaceId: string) =>
        panel.getByTestId(`command-center-workspace-${getServerId()}:${workspaceId}`);

      await expect(rowOf(older[3].workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(rowOf(older[2].workspaceId)).toBeVisible();
      await expect(rowOf(older[1].workspaceId)).toBeVisible();
      await expect(rowOf(older[0].workspaceId)).toHaveCount(0);
      await expect(rowOf(current.workspaceId)).toHaveCount(0);
      await expect(commandCenterSection(panel, "Workspaces")).toHaveCount(0);

      // The newest recent workspace is selected, so Enter goes straight back to it.
      await page.keyboard.press("Enter");
      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), older[3].workspaceId), {
        timeout: 30_000,
      });
    } finally {
      for (const seeded of [current, ...older]) await seeded.cleanup();
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
      await createIdleAgent(seeded.client, {
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
      await agentSearch
        .getByTestId(`command-center-workspace-${getServerId()}:${seeded.workspaceId}`)
        .getByTestId("command-center-workspace-agent")
        .click();
      await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message agent...", exact: true }),
      ).toBeVisible();
    } finally {
      await seeded.cleanup();
    }
  });
});
