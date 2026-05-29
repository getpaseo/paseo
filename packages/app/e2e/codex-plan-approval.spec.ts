import { expect, test } from "./fixtures";
import { allowPermission, waitForPermissionPrompt } from "./helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

test.describe("Codex plan approval", () => {
  test("shows a single actionable plan panel and removes it after implementation starts", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "codex-plan-approval-",
      title: "Codex plan approval e2e",
      initialPrompt: "Emit synthetic plan approval.",
    });

    try {
      await openAgentRoute(page, session);

      await waitForPermissionPrompt(page, 120_000);

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
