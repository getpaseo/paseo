import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "../support/fixtures";
import {
  askClaudeToRunWorkflow,
  expectWorkflowCompleted,
  expectWorkflowRunning,
  openWorkflowTimeline,
} from "../support/helpers/claude-workflow";
import { cleanupRewindFlow, launchAgent, type AgentHandle } from "../support/helpers/rewind-flow";

// Claude Code currently gates the Workflow tool behind its own rollout. The real-provider test
// opts in explicitly so it tests Paseo's integration rather than the account's rollout cohort.
process.env.CLAUDE_CODE_WORKFLOWS = "1";

const WORKFLOW_SCRIPT = path.resolve(__dirname, "../fixtures/claude-workflow/one-child.js");

test.describe("real Claude workflow subagent row", () => {
  test.setTimeout(300_000);

  test("shows a real Claude workflow running and completed through the generic subagent UI", async ({
    page,
  }, testInfo) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-claude-workflow-row-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({ page, provider: "claude", cwd, mode: "full-access" });

      await test.step("ask Claude to run the workflow", async () => {
        await askClaudeToRunWorkflow(handle!, WORKFLOW_SCRIPT);
        await expectWorkflowRunning(page);
        await page.screenshot({ path: testInfo.outputPath("workflow-running.png") });
      });

      await test.step("see the workflow finish without leaving a running row", async () => {
        await expectWorkflowCompleted(page);
        await page.screenshot({ path: testInfo.outputPath("workflow-completed.png") });
      });

      await test.step("open the workflow through the existing provider-subagent pane", async () => {
        await openWorkflowTimeline(page);
        await page.screenshot({ path: testInfo.outputPath("workflow-timeline.png") });
      });
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
