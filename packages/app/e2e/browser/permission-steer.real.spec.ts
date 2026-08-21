import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import { waitForPermissionPrompt } from "../support/helpers/permissions";
import { cleanupRewindFlow, type AgentHandle, launchAgent } from "../support/helpers/rewind-flow";

const scenarios = [
  {
    provider: "claude" as const,
    providerConfig: { model: "haiku", modeId: "plan" },
    planPrompt:
      "Do not ask questions. Produce a concise plan to append the line 'Hello' to README.md, then present it for approval. Do not implement it.",
    planText: "README.md",
    steerPrompt: "Do not implement anything. Reply exactly CLAUDE_STEER_RECEIVED and stop.",
    reply: "CLAUDE_STEER_RECEIVED",
  },
  {
    provider: "codex" as const,
    providerConfig: { featureValues: { plan_mode: true } },
    planPrompt:
      "Produce a concise implementation plan with exactly these steps: Inspect permission steering; Implement permission steering; Verify permission steering. Do not implement it.",
    planText: "Inspect permission steering",
    steerPrompt: "Do not produce another plan. Reply exactly CODEX_STEER_RECEIVED and stop.",
    reply: "CODEX_STEER_RECEIVED",
  },
];

test.describe("composer steer supersedes plan approval", () => {
  for (const scenario of scenarios) {
    test(`${scenario.provider} keeps the rejected plan in the timeline`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(420_000);
      const cwd = realpathSync(
        mkdtempSync(path.join(tmpdir(), `paseo-permission-steer-${scenario.provider}-`)),
      );
      let handle: AgentHandle | undefined;

      try {
        handle = await launchAgent({
          page,
          provider: scenario.provider,
          cwd,
          mode: "full-access",
          providerConfig: scenario.providerConfig,
        });
        await submitMessage(page, scenario.planPrompt);
        await waitForPermissionPrompt(page, 180_000);

        const pendingPlan = page.getByTestId("permission-plan-card");
        await expect(pendingPlan).toContainText(scenario.planText);
        const pendingScreenshot = testInfo.outputPath(`${scenario.provider}-pending-plan.png`);
        await page.screenshot({ path: pendingScreenshot });
        await testInfo.attach(`${scenario.provider} pending plan`, {
          path: pendingScreenshot,
          contentType: "image/png",
        });

        await submitMessage(page, scenario.steerPrompt);
        await expect(pendingPlan).toHaveCount(0, { timeout: 30_000 });
        const rejectedPlan = page.getByTestId("timeline-plan-card");
        await expect(rejectedPlan).toBeVisible({ timeout: 30_000 });
        await expect(rejectedPlan).toContainText(scenario.planText);
        await expect(
          page.getByTestId("assistant-message").filter({ hasText: scenario.reply }),
        ).toBeVisible({
          timeout: 180_000,
        });

        const rejectedScreenshot = testInfo.outputPath(`${scenario.provider}-rejected-plan.png`);
        await page.screenshot({ path: rejectedScreenshot });
        await testInfo.attach(`${scenario.provider} rejected plan`, {
          path: rejectedScreenshot,
          contentType: "image/png",
        });
      } finally {
        await cleanupRewindFlow({ handle, cwd });
      }
    });
  }
});
