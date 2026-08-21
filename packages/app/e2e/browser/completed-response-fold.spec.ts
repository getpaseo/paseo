import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("keeps the complete final answer visible while settled response work is folded", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "completed-response-fold-",
    title: "Completed response fold",
    model: "ten-second-stream",
    initialPrompt: "Exercise completed response folding.",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ collapseCompletedResponses: true }),
      );
    });
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    const showWork = page.getByRole("button", { name: "Show work", exact: true });
    const openingAnswer = page
      .getByText(/The change should keep scroll-to-bottom working when the user is at the bottom/)
      .first();
    const trailingAnswer = page.getByText("(end of synthetic stream)", { exact: true });
    const toolRows = page.getByTestId("tool-call-group").or(page.getByTestId("tool-call-badge"));

    await expect(showWork).toBeVisible();
    await expect(openingAnswer).toBeVisible();
    await expect(trailingAnswer).toBeVisible();
    await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
    await expect(toolRows).toHaveCount(0);

    await showWork.click();
    const hideWork = page.getByRole("button", { name: "Hide work", exact: true });
    await expect(hideWork).toBeVisible();
    await expect(page.getByText("Cycle 1", { exact: true })).toBeVisible();
    await expect(toolRows.first()).toBeVisible();
    await expect(openingAnswer).toBeVisible();
    await expect(trailingAnswer).toBeVisible();

    await hideWork.click();
    await expect(showWork).toBeVisible();
    await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
    await expect(toolRows).toHaveCount(0);
    await expect(openingAnswer).toBeVisible();
    await expect(trailingAnswer).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});
