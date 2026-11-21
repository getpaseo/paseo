import { expect, test } from "../support/fixtures";
import {
  createMockIdleAgent,
  openWorkspaceWithAgents,
  type ArchiveTabAgent,
} from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import {
  BOTS_PLUGIN_ID,
  headerRow,
  installSidebarPlugins,
} from "../support/helpers/plugin-sidebar-items";

test("replays tabs, workspaces and plugin screens in both directions", async ({ page }) => {
  test.setTimeout(120_000);
  const first = await seedWorkspace({ repoPrefix: "visit-history-first-" });
  const second = await seedWorkspace({ repoPrefix: "visit-history-second-" });
  const plugins = await installSidebarPlugins();
  const tab = (agent: ArchiveTabAgent) =>
    page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true });
  const expectSelected = (agent: ArchiveTabAgent) =>
    expect(tab(agent)).toHaveAttribute("aria-selected", "true");
  const selectTab = (agent: ArchiveTabAgent) => tab(agent).click({ position: { x: 12, y: 13 } });

  try {
    const alpha = await createMockIdleAgent(first.client, {
      cwd: first.repoPath,
      workspaceId: first.workspaceId,
      title: "Alpha",
    });
    const beta = await createMockIdleAgent(first.client, {
      cwd: first.repoPath,
      workspaceId: first.workspaceId,
      title: "Beta",
    });
    const gamma = await createMockIdleAgent(second.client, {
      cwd: second.repoPath,
      workspaceId: second.workspaceId,
      title: "Gamma",
    });
    await openWorkspaceWithAgents(page, [gamma, alpha, beta]);
    await expectSelected(beta);
    await selectTab(alpha);
    await expectSelected(alpha);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: second.workspaceId,
    });
    await expectSelected(gamma);

    await page.keyboard.press("Alt+[");
    await expectSelected(alpha);
    await page.keyboard.press("Alt+[");
    await expectSelected(beta);
    await page.keyboard.press("Alt+]");
    await expectSelected(alpha);
    await page.keyboard.press("Alt+]");
    await expectSelected(gamma);

    await page.keyboard.press("Alt+[");
    await expectSelected(alpha);
    await selectTab(beta);
    await expectSelected(beta);
    await page.keyboard.press("Alt+]");
    await expectSelected(beta);
    await page.keyboard.press("Alt+[");
    await expectSelected(alpha);

    await test.step("restore full-page plugin screens and their parameters", async () => {
      const openSettings = async () => {
        await page.getByTestId("sidebar-settings").filter({ visible: true }).first().click();
        await expect(page).toHaveURL(/\/settings/);
      };
      const expectBot = (id: string) =>
        expect(
          page.getByText(`Bot screen: ${id}`, { exact: true }).filter({ visible: true }),
        ).toBeVisible();
      await headerRow(page, BOTS_PLUGIN_ID, "bots-bot-1").click();
      await expectBot("bot-1");
      await headerRow(page, BOTS_PLUGIN_ID, "bots-bot-2").click();
      await expectBot("bot-2");
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: first.workspaceId,
      });
      await expectSelected(alpha);

      await page.keyboard.press("Alt+[");
      await expectBot("bot-2");
      await page.keyboard.press("Alt+[");
      await expectBot("bot-1");
      await page.keyboard.press("Alt+]");
      await expectBot("bot-2");
      await page.keyboard.press("Alt+]");
      await expectSelected(alpha);

      await openSettings();
      await page.keyboard.press("Alt+[");
      await expectSelected(alpha);
      await page.keyboard.press("Alt+]");
      await expectSelected(alpha);
      await page.keyboard.press("Alt+[");
      await expectBot("bot-2");
      await openSettings();
      await page.keyboard.press("Alt+[");
      await expectBot("bot-2");
      await page.keyboard.press("Alt+]");
      await expectSelected(alpha);
    });
  } finally {
    await plugins.cleanup();
    await second.cleanup();
    await first.cleanup();
  }
});
