import { mkdtempSync, realpathSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
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
    providerConfig: { model: "gpt-5.6-sol", featureValues: { plan_mode: true } },
    planPrompt:
      "Produce a concise implementation plan with exactly these steps: Inspect permission steering; Implement permission steering; Verify permission steering. Do not implement it.",
    planText: "Inspect permission steering",
    steerPrompt: "Do not produce another plan. Reply exactly CODEX_STEER_RECEIVED and stop.",
    reply: "CODEX_STEER_RECEIVED",
  },
];

async function readConversationOrder(page: Page, prompt: string, reply: string) {
  const plan = page.getByTestId("timeline-plan-card");
  const question = page.getByTestId("user-message").filter({ hasText: prompt });
  const answer = page.getByTestId("assistant-message").filter({ hasText: reply });
  const boxes = await Promise.all([
    plan.boundingBox(),
    question.boundingBox(),
    answer.boundingBox(),
  ]);
  return boxes
    .map((box, index) => {
      if (!box) throw new Error("Expected the plan, follow-up, and answer to be rendered");
      return { role: ["plan", "question", "answer"][index], y: box.y };
    })
    .sort((a, b) => a.y - b.y)
    .map((item) => item.role);
}

async function togglePlan(
  page: Page,
  testId: string,
  name: string,
  expanded: boolean,
): Promise<void> {
  const toggle = page.getByTestId(testId).getByRole("button", { name, exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
}

async function expectRejectedPlanCollapsed(page: Page): Promise<void> {
  await expect(
    page
      .getByTestId("timeline-plan-card")
      .getByRole("button", { name: "Rejected plan", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
}

async function reopenConversation(page: Page, reply: string): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("timeline-plan-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("assistant-message").filter({ hasText: reply })).toBeVisible();
}

type PlanScenario = (typeof scenarios)[number];
interface PlanSteer {
  page: Page;
  scenario: PlanScenario;
  testInfo: TestInfo;
}

async function withPlanSteer(context: PlanSteer, journey: () => Promise<void>): Promise<void> {
  const { page, scenario } = context;
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
    await journey();
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
}

async function reviewCollapsibleProposal({ page, scenario, testInfo }: PlanSteer): Promise<void> {
  await submitMessage(page, scenario.planPrompt);
  await waitForPermissionPrompt(page, 180_000);

  const pendingPlan = page.getByTestId("permission-plan-card");
  await expect(pendingPlan).toContainText(scenario.planText);
  await togglePlan(page, "permission-plan-card", "Plan", false);
  await expect(page.getByTestId("permission-request-deny")).toBeVisible();
  await togglePlan(page, "permission-plan-card", "Plan", true);
  const pendingScreenshot = testInfo.outputPath(`${scenario.provider}-pending-plan.png`);
  await page.screenshot({ path: pendingScreenshot });
  await testInfo.attach(`${scenario.provider} pending plan`, {
    path: pendingScreenshot,
    contentType: "image/png",
  });
}

async function rejectWithFollowUp({ page, scenario, testInfo }: PlanSteer): Promise<void> {
  await submitMessage(page, scenario.steerPrompt);
  await expect(page.getByTestId("permission-plan-card")).toHaveCount(0, { timeout: 30_000 });
  const rejectedPlan = page.getByTestId("timeline-plan-card");
  await expect(rejectedPlan).toBeVisible({ timeout: 30_000 });
  await expectRejectedPlanCollapsed(page);
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
  await expect(
    page.getByTestId("user-message").filter({ hasText: scenario.steerPrompt }),
  ).toBeVisible();
  expect
    .soft(await readConversationOrder(page, scenario.steerPrompt, scenario.reply))
    .toEqual(["plan", "question", "answer"]);
}

async function rereadRejectedPlan({ page, scenario, testInfo }: PlanSteer): Promise<void> {
  const rejectedPlan = page.getByTestId("timeline-plan-card");
  await togglePlan(page, "timeline-plan-card", "Rejected plan", true);
  await expect(rejectedPlan).toContainText(scenario.planText);
  await rejectedPlan.screenshot({
    path: testInfo.outputPath(`${scenario.provider}-expanded-rejected-plan.png`),
  });
  await togglePlan(page, "timeline-plan-card", "Rejected plan", false);
}

async function restoreConversationOrder({ page, scenario }: PlanSteer): Promise<void> {
  await reopenConversation(page, scenario.reply);
  await expectRejectedPlanCollapsed(page);
  expect(await readConversationOrder(page, scenario.steerPrompt, scenario.reply)).toEqual([
    "plan",
    "question",
    "answer",
  ]);
}

for (const scenario of scenarios) {
  test(`${scenario.provider} keeps the rejected plan in the timeline`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(420_000);
    const context = { page, scenario, testInfo };
    await withPlanSteer(context, async () => {
      await test.step("Review a collapsible proposal", () => reviewCollapsibleProposal(context));
      await test.step("Reject with a follow-up below the plan", () => rejectWithFollowUp(context));
      await test.step("Reopen the rejected plan", () => rereadRejectedPlan(context));
      await test.step("Keep conversation order after reload", () =>
        restoreConversationOrder(context));
    });
  });
}
