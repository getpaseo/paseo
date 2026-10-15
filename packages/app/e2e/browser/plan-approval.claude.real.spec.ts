import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import {
  allowPermission,
  denyPermission,
  waitForPermissionPrompt,
} from "../support/helpers/permissions";
import {
  assertComposerIdle,
  cleanupRewindFlow,
  launchAgent,
  type AgentHandle,
} from "../support/helpers/rewind-flow";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";

const PLAN_PROMPT =
  "Propose a concise plan to append one line Hello to README.md. Present it for approval using ExitPlanMode. Do not ask questions. Only implement after approval. If the plan is rejected, reply PLAN_REJECTED and stop without proposing another plan. After implementing an approved plan, reply PLAN_IMPLEMENTED.";

async function requestPlan(page: Page, prompt: string): Promise<void> {
  await submitMessage(page, prompt);
  await waitForPermissionPrompt(page, 180_000);
  await expect(page.getByTestId("permission-plan-card")).toContainText("README.md");
}

function planWithOutcome(page: Page, label: string) {
  return page
    .getByTestId("timeline-plan-card")
    .filter({ has: page.getByRole("button", { name: label, exact: true }) });
}

async function expectPlanOutcome(page: Page, label: string, expanded: boolean): Promise<void> {
  const card = planWithOutcome(page, label);
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("button", { name: label, exact: true })).toHaveAttribute(
    "aria-expanded",
    String(expanded),
  );
}

async function toggleRecordedPlan(page: Page, label: string, expanded: boolean): Promise<void> {
  await planWithOutcome(page, label).getByRole("button", { name: label, exact: true }).click();
  await expectPlanOutcome(page, label, expanded);
}

async function expectClaudeReply(page: Page, marker: string): Promise<void> {
  await expect(page.getByTestId("assistant-message").filter({ hasText: marker })).toBeVisible({
    timeout: 180_000,
  });
  await assertComposerIdle({ page });
}

async function restartIsolatedDaemon(): Promise<void> {
  const port = Number(getE2EDaemonPort());
  expect([6767, 6768]).not.toContain(port);
  const client = await connectDaemonClient<{
    connect(): Promise<void>;
    close(): Promise<void>;
    getDaemonStatus(): Promise<{ pid: number }>;
    restartServer(reason: string): Promise<unknown>;
  }>({ port, clientIdPrefix: "plan-history-restart" });
  try {
    const before = (await client.getDaemonStatus()).pid;
    await client.restartServer("Verify plan history replay in the isolated Playwright daemon");
    await expect
      .poll(
        async () => {
          try {
            return (await client.getDaemonStatus()).pid;
          } catch {
            return before;
          }
        },
        { timeout: 60_000 },
      )
      .not.toBe(before);
  } finally {
    await client.close();
  }
}

async function expectRecordedPlans(page: Page): Promise<void> {
  await expect(page.getByTestId("timeline-plan-card")).toHaveCount(2, { timeout: 60_000 });
  await expectPlanOutcome(page, "Rejected plan", false);
  await expectPlanOutcome(page, "Approved plan", true);
}

interface PlanReview {
  page: Page;
  cwd: string;
  testInfo: TestInfo;
}

async function withPlanReview(
  page: Page,
  testInfo: TestInfo,
  review: (context: PlanReview) => Promise<void>,
): Promise<void> {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-plan-lifecycle-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({
      page,
      provider: "claude",
      cwd,
      mode: "full-access",
      providerConfig: { model: "haiku", modeId: "plan" },
    });
    await review({ page, cwd, testInfo });
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
}

async function rejectPlanWithoutImplementing({ page, cwd, testInfo }: PlanReview): Promise<void> {
  await requestPlan(page, PLAN_PROMPT);
  await denyPermission(page);
  await expectClaudeReply(page, "PLAN_REJECTED");
  await expectPlanOutcome(page, "Rejected plan", false);
  await toggleRecordedPlan(page, "Rejected plan", true);
  await expect(planWithOutcome(page, "Rejected plan")).toContainText("README.md");
  await page.screenshot({ path: testInfo.outputPath("button-rejected-plan-expanded.png") });
  await toggleRecordedPlan(page, "Rejected plan", false);
  expect(readFileSync(path.join(cwd, "README.md"), "utf8")).not.toContain("Hello");
}

async function approveFreshPlanAndImplement({ page, cwd, testInfo }: PlanReview): Promise<void> {
  await requestPlan(page, `Propose the plan again for a fresh approval. ${PLAN_PROMPT}`);
  await allowPermission(page);
  await expectClaudeReply(page, "PLAN_IMPLEMENTED");
  expect(readFileSync(path.join(cwd, "README.md"), "utf8")).toContain("Hello");
  await expectRecordedPlans(page);
  await toggleRecordedPlan(page, "Approved plan", false);
  await toggleRecordedPlan(page, "Approved plan", true);
  await page.screenshot({ path: testInfo.outputPath("approved-plan.png") });
}

async function restoreReadablePlanHistory({ page, testInfo }: PlanReview): Promise<void> {
  await restartIsolatedDaemon();
  await page.reload();
  await expectRecordedPlans(page);
  await toggleRecordedPlan(page, "Rejected plan", true);
  await expect(planWithOutcome(page, "Rejected plan")).toContainText("README.md");
  await toggleRecordedPlan(page, "Rejected plan", false);
  await page.screenshot({ path: testInfo.outputPath("restored-plans.png") });
}

test("Claude button rejection and approval preserve collapsible plans after daemon restart", async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  await withPlanReview(page, testInfo, async (review) => {
    await test.step("Reject a plan without implementing it", () =>
      rejectPlanWithoutImplementing(review));
    await test.step("Approve and implement a fresh plan", () =>
      approveFreshPlanAndImplement(review));
    await test.step("Restore readable plans after daemon restart", () =>
      restoreReadablePlanHistory(review));
  });
});
