import { expect, test } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import { allowPermission, waitForPermissionPrompt } from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("Codex plan approval", () => {
  test("shows the empty prompt until a plan is requested, then shows one actionable plan", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "codex-plan-approval-",
      title: "Codex plan approval e2e",
    });

    try {
      await openAgentRoute(page, session);
      const emptyPrompt = page.getByText("Start chatting with this agent...", { exact: true });
      await expect(emptyPrompt).toBeVisible();
      await submitMessage(page, "Emit synthetic plan approval.");

      await waitForPermissionPrompt(page, 120_000);

      await expect(emptyPrompt).toHaveCount(0);
      await expect(page.getByTestId("permission-plan-card")).toHaveCount(1);
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);

      await allowPermission(page);

      await expect(page.getByTestId("permission-plan-card")).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });
});
