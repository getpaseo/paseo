import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { fillComposerDraft, submitMessage } from "../support/helpers/composer";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
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

async function simulateLegacyHostAndReviewRetry(page: Page): Promise<() => void> {
  let advertisePlanReview = false;
  let failNextReview = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string" && !advertisePlanReview) {
        const envelope = JSON.parse(message);
        if (envelope.message?.payload?.status === "server_info") {
          delete envelope.message.payload.features?.planReview;
          browser.send(JSON.stringify(envelope));
          return;
        }
      }
      browser.send(message);
    });
    browser.onMessage((message) => {
      if (typeof message === "string" && failNextReview) {
        const { message: request } = JSON.parse(message);
        if (request?.type === "agent.plan.review.request") {
          failNextReview = false;
          browser.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "agent.plan.review.response",
                payload: {
                  agentId: request.agentId,
                  requestId: request.requestId,
                  error: "Could not send feedback. Try again.",
                },
              },
            }),
          );
          return;
        }
      }
      server.send(message);
    });
  });
  return () => {
    advertisePlanReview = true;
  };
}

async function capturePlanReview(plan: Locator, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await plan.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function expectApprovedPlanInTimeline(page: Page): Promise<void> {
  const approvedPlan = page.getByRole("button", { name: "Approved plan", exact: true });
  const timeline = page.getByTestId("agent-chat-scroll");
  await expect
    .poll(async () => {
      if (await approvedPlan.isVisible()) return true;
      await timeline.evaluate((element) => {
        element.scrollTop -= element.clientHeight / 2;
      });
      return false;
    })
    .toBe(true);
}

test.describe("plan review actions", () => {
  for (const scenario of scenarios) {
    test(`${scenario.provider} revises before approval and applies implementation notes`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(360_000);
      const enablePlanReview =
        scenario.provider === "codex" ? await simulateLegacyHostAndReviewRetry(page) : null;
      if (scenario.provider === "claude") {
        await page.setViewportSize({ width: 390, height: 844 });
      }
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-plan-review-")));
      const readme = path.join(cwd, "README.md");
      let handle: AgentHandle | undefined;
      try {
        handle = await launchAgent({
          page,
          provider: scenario.provider,
          cwd,
          mode: "full-access",
          providerConfig: scenario.providerConfig,
        });
        const original = readFileSync(readme, "utf8");
        await fillComposerDraft(
          page,
          "Present a concise plan to append FIRST_PLAN_MARKER to README.md. Include the literal marker in the plan and use relative paths. Do not implement or ask clarification.",
        );
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const plan = page.getByTestId("permission-plan-card");
        await expect(plan).toContainText("FIRST_PLAN_MARKER", { timeout: 120_000 });
        const addFeedback = plan.getByRole("button", { name: "Add feedback", exact: true });
        if (enablePlanReview) {
          await expect(addFeedback).toHaveCount(0);
          await expect(plan.getByTestId("permission-request-deny")).toBeVisible();
          await expect(plan.getByRole("button", { name: "Implement", exact: true })).toBeVisible();
          enablePlanReview();
          await page.reload();
        }
        await expect(addFeedback).toBeVisible({ timeout: 30_000 });
        await expect(plan.getByTestId("permission-request-deny")).toBeVisible();
        await expect(plan.getByTestId("permission-request-accept")).toBeVisible();
        await capturePlanReview(plan, testInfo, "plan-review-actions");
        const input = page.getByTestId("plan-review-input");
        const requestChanges = page.getByTestId("plan-review-submit-changes");
        const implementWithNotes = page.getByTestId("plan-review-submit-implementation");

        await addFeedback.click();
        await expect(input).toBeFocused();
        await expect(addFeedback).toHaveCount(0);
        await expect(plan).toContainText("FIRST_PLAN_MARKER");
        await expect(input).toHaveAttribute("placeholder", "Give feedback on the plan");
        await expect(requestChanges).toBeDisabled();
        await expect(implementWithNotes).toBeDisabled();
        if (scenario.provider === "claude") {
          await capturePlanReview(plan, testInfo, "empty-plan-review-editor");
        }
        await input.fill("   ");
        await expect(requestChanges).toBeDisabled();
        await expect(implementWithNotes).toBeDisabled();
        const revision =
          "Change the marker to REVISED_PLAN_MARKER. Include it in the revised plan.";
        await input.fill(revision);
        await plan.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(input).toHaveCount(0);
        await expect(plan).toContainText("FIRST_PLAN_MARKER");

        await addFeedback.click();
        await expect(input).toHaveValue(revision);
        await capturePlanReview(plan, testInfo, "shared-plan-review-editor");
        await requestChanges.click();
        if (scenario.provider === "codex") {
          await expect(plan.getByTestId("plan-review-error")).toContainText("Try again");
          await expect(input).toHaveValue(revision);
          await requestChanges.click();
        }
        await expect(plan).toContainText("REVISED_PLAN_MARKER", { timeout: 120_000 });
        await expectRejectedPlanCollapsed(page);
        await togglePlan(page, "timeline-plan-card", "Rejected plan", true);
        await expect(page.getByTestId("timeline-plan-card")).toContainText("FIRST_PLAN_MARKER");
        await togglePlan(page, "timeline-plan-card", "Rejected plan", false);
        expect(readFileSync(readme, "utf8")).toBe(original);

        await addFeedback.click();
        await expect(input).toHaveValue("");
        await input.fill(
          "Append FINAL_PLAN_MARKER instead of REVISED_PLAN_MARKER.\nKeep all existing lines.",
        );
        await implementWithNotes.click();
        await expect(
          page.getByTestId("user-message").filter({ hasText: "FINAL_PLAN_MARKER" }),
        ).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(
            () => {
              const updated = readFileSync(readme, "utf8");
              return {
                existing: updated.slice(0, original.length),
                appended: updated.slice(original.length).trim(),
              };
            },
            { timeout: 120_000 },
          )
          .toEqual({ existing: original, appended: "FINAL_PLAN_MARKER" });
        await expect(plan).toHaveCount(0);
        await expectApprovedPlanInTimeline(page);
      } finally {
        await cleanupRewindFlow({ handle, cwd });
      }
    });
  }
});
