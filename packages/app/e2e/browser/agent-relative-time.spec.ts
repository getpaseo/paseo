import { expect, test } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import { getServerId } from "../support/helpers/server-id";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { resetSeededPageState, openSessions } from "../support/helpers/archive-tab";
import { closeSidebarDisplayPreferences, openSidebarDisplayPage } from "../support/helpers/sidebar";

test("agent list age advances and command center says just now for a fresh agent", async ({
  page,
}) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "agent-relative-time-",
    title: "Relative time agent",
  });
  try {
    await session.client.waitForAgentUpsert(session.agentId, (agent) => agent.status === "idle");
    await resetSeededPageState(page);
    await page.clock.install({ time: Date.now() });
    await openSessions(page);

    const row = page.getByTestId(`agent-row-${getServerId()}-${session.agentId}`);
    await expect(row).toContainText("just now", { timeout: 30_000 });

    const commandCenter = await openCommandCenter(page);
    await commandCenter.getByTestId("command-center-input").fill("Relative time agent");
    const agentResult = commandCenter.getByTestId(
      `command-center-agent-${getServerId()}:${session.agentId}`,
    );
    await expect(agentResult.getByTestId("command-center-agent-subtitle")).toContainText(
      "just now",
    );
    await page.keyboard.press("Escape");

    await page.clock.fastForward("03:00");
    await expect(row).toContainText("3m ago");

    await openAgentRoute(page, session);
    await page.getByTestId(`workspace-tab-agent_${session.agentId}`).first().hover();
    await expect(page.getByTestId(`workspace-tab-tooltip-agent_${session.agentId}`)).toContainText(
      "3m ago",
    );

    await openSidebarDisplayPage(page, "sidebar-display-show");
    await page.getByRole("menuitem", { name: "Last activity", exact: true }).click();
    await closeSidebarDisplayPreferences(page);
    await expect(page.getByTestId("sidebar-workspace-timestamp").first()).toHaveText("3m");
  } finally {
    await session.cleanup();
  }
});
