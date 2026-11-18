import { expect, test } from "../support/fixtures";
import {
  createMockIdleAgent,
  openWorkspaceWithAgents,
  type ArchiveTabAgent,
} from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";

test("replays visited tabs and workspaces in both directions and branches on a new visit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const first = await seedWorkspace({ repoPrefix: "visit-history-first-" });
  const second = await seedWorkspace({ repoPrefix: "visit-history-second-" });
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
  } finally {
    await second.cleanup();
    await first.cleanup();
  }
});
