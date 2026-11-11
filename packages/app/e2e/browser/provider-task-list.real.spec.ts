import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import {
  cleanupRewindFlow,
  launchAgent,
  sendMessage,
  type AgentHandle,
  type RewindFlowProvider,
} from "../support/helpers/rewind-flow";
import {
  expectCompletedTaskActivity,
  expectTaskListEntries,
  openCompletedTaskList,
} from "../support/helpers/task-list";
import { submitMessage } from "../support/helpers/composer";

interface TaskScenario {
  provider: RewindFlowProvider;
  entries: [string, string];
  prompt: string;
  providerConfig?: Parameters<typeof launchAgent>[0]["providerConfig"];
}

const scenarios: TaskScenario[] = [
  {
    provider: "claude",
    entries: ["Claude inventory alpha", "Claude inventory beta"],
    providerConfig: { model: "opus" },
    prompt:
      "Use TaskCreate to create exactly two tasks named Claude inventory alpha and Claude inventory beta. Use TaskUpdate to mark each in_progress and then completed. Do not use subagents, shell commands, or edit files. Finish with TASKS_COMPLETE.",
  },
  {
    provider: "codex",
    entries: ["Codex inventory alpha", "Codex inventory beta"],
    prompt:
      "Use update_plan to track exactly two steps named Codex inventory alpha and Codex inventory beta. Move each through in_progress and completed. Do not use subagents, shell commands, or edit files. Finish with TASKS_COMPLETE.",
  },
  {
    provider: "opencode",
    entries: ["OpenCode inventory alpha", "OpenCode inventory beta"],
    prompt:
      "Use TodoWrite to track exactly two tasks named OpenCode inventory alpha and OpenCode inventory beta. Move each through in_progress and completed. Do not use subagents, shell commands, or edit files. Finish with TASKS_COMPLETE.",
  },
];

test.describe("real provider composer task lists", () => {
  test.setTimeout(600_000);

  for (const scenario of scenarios) {
    test(`${scenario.provider} shows native task progress above the composer`, async ({
      page,
    }, testInfo) => {
      const cwd = realpathSync(
        mkdtempSync(path.join(tmpdir(), `paseo-task-list-${scenario.provider}-`)),
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
        await sendMessage(handle, scenario.prompt);
        await openCompletedTaskList(page, scenario.entries.length);
        await expectTaskListEntries(page, scenario.entries);
        await expectCompletedTaskActivity(page, scenario.entries);
        await expect(page.getByText("TaskUpdate", { exact: true })).toHaveCount(0);
        await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);

        const screenshot = testInfo.outputPath(`${scenario.provider}-composer-tasks.png`);
        await page.screenshot({ path: screenshot });
        await testInfo.attach(`${scenario.provider} composer tasks`, {
          path: screenshot,
          contentType: "image/png",
        });
      } finally {
        await cleanupRewindFlow({ handle, cwd });
      }
    });
  }

  test("Codex genuine Plan mode keeps the existing plan card", async ({ page }, testInfo) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-genuine-codex-plan-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({
        page,
        provider: "codex",
        cwd,
        mode: "full-access",
        providerConfig: { featureValues: { plan_mode: true } },
      });
      await submitMessage(
        page,
        "Produce a concise implementation plan with exactly these steps: Inspect genuine plan boundary; Implement genuine plan boundary; Verify genuine plan boundary. Do not implement it.",
      );

      const planCard = page.getByTestId("permission-plan-card");
      await expect(planCard).toBeVisible({ timeout: 120_000 });
      await expect(planCard).toContainText("Inspect genuine plan boundary");
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);

      const screenshot = testInfo.outputPath("codex-genuine-plan.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("Codex genuine plan", { path: screenshot, contentType: "image/png" });
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
