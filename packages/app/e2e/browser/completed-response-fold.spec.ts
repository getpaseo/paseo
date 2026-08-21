import { test, expect } from "../support/fixtures";
import { openSettings } from "../support/helpers/app";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openSettingsSection } from "../support/helpers/settings";

test("opts into folded response summaries without hiding the final answer", async ({ page }) => {
  test.setTimeout(60_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "completed-response-fold-",
    title: "Completed response fold",
    model: "ten-second-stream",
    initialPrompt: "Exercise completed response folding.",
  });

  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    const activitySummary = page.locator('[data-testid^="completed-response-fold-"]').first();
    const openingAnswer = page
      .getByText(/The change should keep scroll-to-bottom working when the user is at the bottom/)
      .first();
    const trailingAnswer = page.getByText("(end of synthetic stream)", { exact: true });
    const toolRows = page.getByTestId("tool-call-group").or(page.getByTestId("tool-call-badge"));

    await expect(activitySummary).toHaveCount(0);
    const timelineUrl = page.url();
    await openSettings(page);
    await openSettingsSection(page, "appearance");
    const collapseCompletedResponses = page.getByRole("switch", {
      name: "Collapse completed responses",
    });
    await expect(collapseCompletedResponses).not.toBeChecked();
    await collapseCompletedResponses.click();
    await expect(collapseCompletedResponses).toBeChecked();
    await page.goto(timelineUrl);
    await expectComposerVisible(page);

    await expect(activitySummary).toBeVisible();
    await expect(activitySummary).toContainText(/\d+ tool calls?/);
    await expect(activitySummary).toHaveAccessibleName(/^Show /);
    await expect(activitySummary.getByTestId("tool-call-activity-icons")).toBeVisible();
    await expect(openingAnswer).toBeVisible();
    await expect(trailingAnswer).toBeVisible();
    await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
    await expect(toolRows).toHaveCount(0);

    await activitySummary.click();
    await expect(activitySummary).toHaveAccessibleName(/^Hide /);
    await expect(page.getByText("Cycle 1", { exact: true })).toBeVisible();
    await expect(toolRows.first()).toBeVisible();
    await expect(openingAnswer).toBeVisible();
    await expect(trailingAnswer).toBeVisible();

    await activitySummary.click();
    await expect(activitySummary).toHaveAccessibleName(/^Show /);
    await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
    await expect(toolRows).toHaveCount(0);
    await expect(openingAnswer).toBeVisible();
    await expect(trailingAnswer).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});
