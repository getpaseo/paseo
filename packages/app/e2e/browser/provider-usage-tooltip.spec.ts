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
  test("shows the active provider's session usage below the mobile context meter", async ({
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
      await usageFixture.waitForRequestCount(1);

      const sessionUsage = page.getByTestId("provider-usage-mobile-session");
      await expect(sessionUsage).toBeVisible({
        timeout: 10_000,
      });
      await expect(sessionUsage.getByText("Session", { exact: true })).toBeVisible();
      await expect(sessionUsage.getByText("42% used", { exact: true })).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes usage when the context meter is opened", async ({ page }) => {
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
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 64 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const meter = page.getByTestId("context-window-meter");

      await usageFixture.waitForRequestCount(1);
      await expect(page.getByTestId("provider-usage-mobile-session")).toContainText("41% used", {
        timeout: 10_000,
      });

      await meter.click();
      await usageFixture.waitForRequestCount(2);
      expect(usageFixture.requestCount()).toBe(2);
      await expect(page.getByTestId("provider-usage-mobile-session")).toContainText("64% used");
    } finally {
      await session.cleanup();
    }
  });
});
