import { expect, type Page, type TestInfo } from "@playwright/test";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "./app";
import { installProviderUsageFixture } from "./provider-usage";
import { getServerId } from "./server-id";
import { openCompactSettings, openSettingsHostSection } from "./settings";

const bankedReset = {
  id: "reset-1",
  resetType: "codex_rate_limits",
  supportedByPlan: true,
  status: "available",
  grantedAt: "2026-09-01T00:00:00Z",
  expiresAt: "2099-10-01T00:00:00Z",
  title: "Referral reward",
  description: "One Codex usage reset",
};

function codexUsage(used: boolean) {
  return {
    fetchedAt: "2026-09-06T00:00:00Z",
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available" as const,
        planLabel: "Pro",
        windows: [{ id: "weekly", label: "Weekly", usedPct: used ? 0 : 100 }],
        bankedResets: {
          availableCount: used ? 0 : 1,
          error: null,
          credits: [{ ...bankedReset, status: used ? "redeemed" : "available" }],
        },
      },
    ],
  };
}

interface BankedResetScenario {
  narrow?: boolean;
  unavailableCredits?: boolean;
  supportsBankedResets?: boolean;
  failure?: "reset" | "reset-and-usage";
}

export async function openBankedResetManagement(page: Page, options: BankedResetScenario = {}) {
  const requests: Array<{ creditId: string; idempotencyKey: string }> = [];
  let finishConsume = () => {};
  const pendingConsume = new Promise<void>((resolve) => {
    finishConsume = resolve;
  });
  const initial = codexUsage(false);
  if (options.unavailableCredits) {
    initial.providers[0].bankedResets.credits = [
      { ...bankedReset, expiresAt: "2000-01-01T00:00:00Z" },
      { ...bankedReset, id: "reset-2", resetType: "future_reset" },
      { ...bankedReset, id: "reset-3", status: "redeeming" },
      { ...bankedReset, id: "reset-4", supportedByPlan: false },
    ];
  }
  let payloads: Parameters<typeof installProviderUsageFixture>[1] = options.failure
    ? [initial]
    : [initial, codexUsage(true)];
  if (options.failure === "reset-and-usage") {
    payloads = [
      initial,
      {
        fetchedAt: "2026-09-06T00:01:00Z",
        providers: [
          {
            providerId: "codex",
            displayName: "Codex",
            status: "error",
            planLabel: null,
            windows: [],
            error: "Usage temporarily unavailable",
          },
        ],
      },
    ];
  }
  const fixture = await installProviderUsageFixture(page, payloads, {
    supportsBankedResets: options.supportsBankedResets,
    consume: async (request) => {
      requests.push(request);
      if (options.failure) {
        if (requests.length === 1)
          return { error: "Codex request timed out. Refresh usage before retrying." };
        return { outcome: "already_redeemed" };
      }
      await pendingConsume;
      return { outcome: "reset" };
    },
  });
  if (options.narrow) await page.setViewportSize({ width: 390, height: 844 });
  await gotoAppShell(page);
  if (options.narrow) await openCompactSettings(page, buildOpenProjectRoute());
  else await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "usage");
  const card = page.getByTestId("provider-usage-card");
  const useReset = card.getByRole("button", { name: "Use reset", exact: true });
  return {
    async expectAvailable() {
      await expect(card.getByText("1 available", { exact: true })).toBeVisible();
      await expect(card.getByText("Referral reward", { exact: true })).toBeVisible();
      await expect(card.getByText(/Expires.*2099/)).toBeVisible();
    },
    async cancelRedemption() {
      page.once("dialog", (dialog) => dialog.dismiss());
      await useReset.click();
      await expect(useReset).toBeEnabled();
      expect(requests).toEqual([]);
    },
    async redeem() {
      page.once("dialog", (dialog) => dialog.accept());
      await useReset.click();
    },
    async expectPending() {
      await expect.poll(() => requests.map((request) => request.creditId)).toEqual(["reset-1"]);
      await expect(useReset).toBeDisabled();
    },
    async completeRedemption() {
      finishConsume();
    },
    async expectUsed() {
      await fixture.waitForRequestCount(2);
      await expect(
        card.getByText("Banked reset used. Codex usage limits have been reset."),
      ).toBeVisible();
      await expect(card.getByText("0 available", { exact: true })).toBeVisible();
      await expect(card.getByText("Used", { exact: true })).toBeVisible();
      await expect(card.getByText("0%", { exact: true })).toBeVisible();
      expect(requests).toHaveLength(1);
    },
    async expectRetryableError() {
      await expect(
        card.getByText("Codex request timed out. Refresh usage before retrying."),
      ).toBeVisible();
      await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expect(card.getByText(/requestType=|code=codex_banked_reset_failed/)).toHaveCount(0);
      if (options.failure === "reset-and-usage") {
        await expect(card.getByText("Usage temporarily unavailable")).toBeVisible();
      }
    },
    async retry() {
      page.once("dialog", (dialog) => dialog.accept());
      await card.getByRole("button", { name: "Retry", exact: true }).click();
    },
    async expectRetryReusesAttempt() {
      await expect(card.getByText("This banked reset has already been used.")).toBeVisible();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[0].idempotencyKey).not.toBe("");
    },
    async expectUnavailableCredits() {
      for (const label of ["Expired", "Unsupported", "Processing", "Not supported by plan"]) {
        await expect(card.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(useReset).toHaveCount(0);
    },
    async expectHostUpdateRequired() {
      await expect(card.getByText("Update this host to manage banked resets.")).toBeVisible();
      await expect(useReset).toHaveCount(0);
    },
    async expectReadableResetControls() {
      const details = [
        card.getByText("Referral reward", { exact: true }),
        card.getByText("One Codex usage reset", { exact: true }),
        card.getByText(/Expires.*2099/),
      ];
      await expect(useReset).toBeInViewport({ ratio: 1 });
      await expect(useReset).toBeEnabled();
      const button = await useReset.boundingBox();
      expect(button).not.toBeNull();
      for (const detail of details) {
        await expect(detail).toBeVisible();
        await expect(detail).toBeInViewport({ ratio: 1 });
        const bounds = await detail.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(button!.x);
        expect(
          await detail.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const content = range.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            return (
              content.left >= box.left - 1 &&
              content.right <= box.right + 1 &&
              content.top >= box.top - 1 &&
              content.bottom <= box.bottom + 1 &&
              element.scrollWidth <= element.clientWidth + 1
            );
          }),
        ).toBe(true);
      }
      const viewport = page.viewportSize()!;
      expect(button!.x).toBeGreaterThanOrEqual(0);
      expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
    },
    async capture(testInfo: TestInfo, name: string) {
      await testInfo.attach(name, {
        body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
        contentType: "image/png",
      });
    },
  };
}
