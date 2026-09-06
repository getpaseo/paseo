import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgent(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

test.describe("provider usage tooltip", () => {
  test("shows the active provider's usage when the mobile context meter opens", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: 42,
                remainingPct: 58,
                resetsAt: "2026-06-19T05:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      expect(usageFixture.requestCount()).toBe(0);

      await page.getByTestId("context-window-meter").click();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Mock provider", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Test plan")).toBeVisible();
      await expect(page.getByText("Session", { exact: true })).toBeVisible();
      await expect(page.getByText("42% used", { exact: true })).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("does not show provider usage without context telemetry", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 37 }],
          },
        ],
      },
    ]);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "provider-usage-no-context-",
      title: "Provider usage without context telemetry",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await expect(page.getByTestId("context-window-meter")).toHaveCount(0);
      expect(usageFixture.requestCount()).toBe(0);
    } finally {
      await session.cleanup();
    }
  });
});
