import { expect, test } from "../support/fixtures";
import { allowPermission, waitForPermissionPrompt } from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

test("approval uses launch history after the profile is deleted", async ({ page }) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "plan-launch-history" });
  const previous = await client.getDaemonConfig();
  await client.patchDaemonConfig({
    agentProfiles: [
      {
        id: "qa-planner",
        name: "QA Planner",
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
        postApprovalModeId: "approved-mode",
      },
    ],
  });
  const session = await seedMockAgentWorkspace({
    repoPrefix: "plan-launch-history-",
    title: "Approval history",
    launchProfileId: "qa-planner",
    initialPrompt: "Emit synthetic plan approval.",
  });
  try {
    await openAgentRoute(page, session);
    const card = page.getByTestId("timeline-plan-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await client.patchDaemonConfig({ agentProfiles: [] });
    await page.reload();
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    await expect
      .poll(
        async () => (await client.fetchAgent({ agentId: session.agentId }))?.agent.currentModeId,
      )
      .toBe("approved-mode");
    await page.reload();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('--name="my repo"');
    await expect(card.getByRole("button")).toHaveText(["Copy"]);
  } finally {
    await session.cleanup();
    await client.patchDaemonConfig({ agentProfiles: previous.config.agentProfiles ?? [] });
    await client.close();
  }
});

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
      await expect(page.getByTestId("plan-action-status")).toContainText(
        "Requested mock permission response failure",
        { timeout: 25_000 },
      );
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1);
      await expect(page.getByTestId("permission-request-accept")).toHaveText("Approve");
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
  for (const behavior of ["allow", "follow-up"] as const) {
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
        else
          await session.client.sendAgentMessage(
            session.agentId,
            "Revise this plan with a smaller scope.",
          );

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
