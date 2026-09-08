import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  cleanupRewindFlow,
  launchAgent,
  sendMessage,
  type AgentHandle,
} from "../support/helpers/rewind-flow";

const GREETING = "Say hello back.";

test.use({ e2eInjectPaseoTools: true });

function verificationPrompt(workspacePath: string): string {
  return [
    "Use Paseo tools to perform this exact UI verification.",
    "Do not edit files or run shell commands. Every prompt below is intentionally non-actionable.",
    `1. Create a local workspace at ${workspacePath} titled "Presentation QA workspace".`,
    `2. In that workspace, create a codex/gpt-5.4-mini agent titled "Greeting child" with the initial prompt "${GREETING}".`,
    `3. Create a schedule named "Greeting schedule" with prompt "${GREETING}", cron "0 0 1 1 *", timezone "Europe/Berlin", provider "codex/gpt-5.4-mini", cwd ${workspacePath}, maxRuns 1, and expiresIn "1h". Delete that schedule using its returned id.`,
    `4. Create a heartbeat named "Greeting heartbeat" with prompt "${GREETING}", cron "0 0 1 1 *", timezone "Europe/Berlin", maxRuns 1, and expiresIn "1h". Delete that heartbeat using its returned id.`,
    `5. After the child agent finishes, send it the follow-up prompt "${GREETING}" synchronously.`,
    "6. Archive the workspace from step 1.",
    "7. Reply with exactly TOOL_CALL_QA_DONE.",
    "Use each named Paseo tool exactly once except for the matching schedule and heartbeat deletion tools.",
  ].join(" ");
}

async function expandedToolCall(page: Page, label: string): Promise<Locator> {
  const badge = page.getByTestId("tool-call-badge").filter({ hasText: label }).last();
  await expect(badge).toBeVisible({ timeout: 30_000 });
  await badge.scrollIntoViewIfNeeded();
  await badge.click();
  return badge;
}

async function captureToolCall(
  page: Page,
  testInfo: TestInfo,
  input: { label: string; artifact: string; expectedText: Array<string | RegExp> },
): Promise<void> {
  const badge = await expandedToolCall(page, input.label);
  for (const text of input.expectedText) {
    await expect(badge).toContainText(text);
  }
  const screenshot = testInfo.outputPath(`${input.artifact}.png`);
  await badge.screenshot({ path: screenshot });
  await testInfo.attach(input.artifact, { path: screenshot, contentType: "image/png" });
  await badge.click();
}

async function runPresentationJourney(handle: AgentHandle, workspacePath: string): Promise<void> {
  await sendMessage(handle, verificationPrompt(workspacePath));
  await expect(
    handle.page.getByTestId("assistant-message").filter({ hasText: "TOOL_CALL_QA_DONE" }).last(),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("real Codex Paseo tool-call presentation", () => {
  test.setTimeout(600_000);

  test("renders owned tool inputs and results as readable text", async ({ page }, testInfo) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-tool-call-presentation-")));
    const childWorkspacePath = path.join(cwd, "presentation-workspace");
    mkdirSync(childWorkspacePath);
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({ page, provider: "codex", cwd, mode: "full-access" });
      await runPresentationJourney(handle, childWorkspacePath);
      await page.setViewportSize({ width: 1280, height: 1600 });

      await captureToolCall(page, testInfo, {
        label: "Create workspace",
        artifact: "create-workspace-presentation",
        expectedText: ["Details", "Presentation QA workspace", childWorkspacePath, "local"],
      });
      await captureToolCall(page, testInfo, {
        label: "Create agent",
        artifact: "create-agent-prompt-presentation",
        expectedText: ["Prompt", GREETING, "Greeting child", "codex/gpt-5.4-mini", "Result"],
      });
      await captureToolCall(page, testInfo, {
        label: "Send agent prompt",
        artifact: "send-prompt-presentation",
        expectedText: ["Prompt", GREETING, "Agent", "Result"],
      });
      await captureToolCall(page, testInfo, {
        label: "Create schedule",
        artifact: "schedule-presentation",
        expectedText: [
          "Prompt",
          GREETING,
          "0 0 1 1 *",
          "Europe/Berlin",
          "Greeting schedule",
          "Result",
        ],
      });
      await captureToolCall(page, testInfo, {
        label: "Create heartbeat",
        artifact: "heartbeat-presentation",
        expectedText: [
          "Prompt",
          GREETING,
          "0 0 1 1 *",
          "Europe/Berlin",
          "Greeting heartbeat",
          "Result",
        ],
      });
      await captureToolCall(page, testInfo, {
        label: "Archive workspace",
        artifact: "archive-workspace-presentation",
        expectedText: ["Details", "Workspace", "Result", "Removed directory"],
      });
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
