import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

test("a paseo:// agent link in chat opens that agent in the app", async ({ page }) => {
  const target = await seedMockAgentWorkspace({
    repoPrefix: "agent-deep-link-target-",
    title: "Linked agent",
  });
  const link = buildAgentDeepLink({ serverId: getServerId(), agentId: target.agentId });
  const source = await seedMockAgentWorkspace({
    repoPrefix: "agent-deep-link-source-",
    title: "Coordinator",
    initialPrompt: "Hand off to the other session",
    featureValues: { mockAssistantResponse: `Done, see [the linked agent](${link}).` },
  });
  try {
    await source.client.waitForFinish(source.agentId, 30_000);
    await openAgentRoute(page, source);

    await page
      .getByTestId("assistant-message")
      .getByRole("link", { name: "the linked agent", exact: true })
      .click();

    const targetWorkspaceRoute = buildHostWorkspaceRoute(getServerId(), target.workspaceId);
    await page.waitForURL((url) => url.pathname === targetWorkspaceRoute);
    await expect(page.getByTestId(`workspace-tab-agent_${target.agentId}`)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("agent-deep-link-opened.png") });
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});
