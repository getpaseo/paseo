import { expect, test } from "../support/fixtures";
import { allowPermission, waitForPermissionPrompt } from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("Codex plan approval", () => {
  test("keeps a failed plan action visible and retries", async ({ page }) => {
    test.setTimeout(120_000);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "plan-retry-",
      title: "Plan retry",
      initialPrompt: "Emit synthetic plan approval.",
      featureValues: { mockPermissionResponseFailures: 1 },
    });
    try {
      await openAgentRoute(page, session);
      await waitForPermissionPrompt(page);
      await page.getByTestId("permission-request-accept").click();
      await expect(page.getByTestId("permission-request-error")).toBeVisible({ timeout: 25_000 });
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1);
      await expect(page.getByTestId("permission-request-accept")).toHaveText("Implement");
      await expect(page.getByTestId("permission-request-accept")).toBeEnabled();
      await page.getByTestId("permission-request-accept").click();
      await expect(page.getByTestId("permission-request-accept")).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1);
    } finally {
      await session.cleanup();
    }
  });
  for (const behavior of ["allow", "deny"] as const) {
    test(`keeps one canonical plan after ${behavior} and reload`, async ({ page }) => {
      test.setTimeout(180_000);

      const session = await seedMockAgentWorkspace({
        repoPrefix: "codex-plan-approval-",
        title: "Codex plan approval e2e",
        initialPrompt: "Emit synthetic plan approval.",
      });

      try {
        await openAgentRoute(page, session);

        await waitForPermissionPrompt(page, 120_000);

        await expect(page.getByTestId("permission-plan-card")).toHaveCount(0);
        await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1);
        const planText = await page.getByTestId("timeline-plan-card").innerText();
        expect(planText).toContain('--name="my repo"');

        if (behavior === "allow") await allowPermission(page);
        else await page.getByTestId("permission-request-deny").click();

        await expect(page.getByTestId("permission-plan-card")).toHaveCount(0, {
          timeout: 30_000,
        });
        await expect(page.getByTestId("permission-request-accept")).toHaveCount(0);
        await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1);
        await expect(page.getByTestId("timeline-plan-card")).toContainText('--name="my repo"');
        await page.reload();
        await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1);
        await expect(page.getByTestId("permission-request-accept")).toHaveCount(0);
      } finally {
        await session.cleanup();
      }
    });
  }
});
