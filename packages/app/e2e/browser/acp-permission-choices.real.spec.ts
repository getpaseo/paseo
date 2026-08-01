import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { submitMessage } from "../support/helpers/composer";
import { choosePermissionAction, expectPermissionActions } from "../support/helpers/permissions";
import {
  cleanupRewindFlow,
  launchAgent,
  type AgentHandle,
  type RewindFlowProvider,
} from "../support/helpers/rewind-flow";

const QUESTION = "Which option should I choose?";
const OPTIONS = ["Alpha", "Beta", "Gamma"];

async function askAgentToOfferChoices(handle: AgentHandle): Promise<void> {
  await submitMessage(
    handle.page,
    `Use your built-in question tool now. Ask exactly "${QUESTION}" with exactly three choices named Alpha, Beta, and Gamma. Do not answer the question yourself. After I choose, reply exactly SELECTED_<CHOICE>, replacing <CHOICE> with my selection.`,
  );
}

async function expectAgentToResumeWithSelection(handle: AgentHandle, selection: string) {
  const finish = await handle.client.waitForFinish(handle.agentId, 240_000);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeFalsy();
  await expect(
    handle.page
      .getByTestId("assistant-message")
      .filter({ hasText: `SELECTED_${selection}` })
      .last(),
  ).toBeVisible({ timeout: 30_000 });
}

async function capturePermissionChoices(page: Page, outputPath: string) {
  await page.screenshot({ path: outputPath });
  await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Beta" })).toBeVisible();
}

test.describe("real ACP permission choices", () => {
  test.setTimeout(600_000);

  test("Kimi renders its question choices and resumes with the selected option", async ({
    page,
  }, testInfo) => {
    const provider = "kimi" satisfies RewindFlowProvider;
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-acp-question-kimi-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({ page, provider, cwd, mode: "full-access" });
      await askAgentToOfferChoices(handle);
      await expectPermissionActions(page, OPTIONS);
      const screenshotPath = testInfo.outputPath("kimi-permission-choices.png");
      await capturePermissionChoices(page, screenshotPath);
      await testInfo.attach("Kimi permission choices", {
        path: screenshotPath,
        contentType: "image/png",
      });
      await choosePermissionAction(page, "Beta");
      await expectAgentToResumeWithSelection(handle, "BETA");
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
