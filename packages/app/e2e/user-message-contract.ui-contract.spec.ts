import { expect, test, type Page } from "./fixtures";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { connectTerminalClient } from "./helpers/terminal-perf";
import { createTempGitRepo } from "./helpers/workspace";
import {
  composerLocator,
  expectComposerEditable,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
} from "./helpers/composer";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

async function openAgent(page: Page, input: { cwd: string; agentId: string }): Promise<void> {
  const agentUrl = `${buildHostWorkspaceRoute(
    getServerId(),
    input.cwd,
  )}?open=${encodeURIComponent(`agent:${input.agentId}`)}`;
  await page.goto(agentUrl);
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await expectComposerVisible(page);
}

async function expectUserMessageCount(page: Page, expected: number): Promise<void> {
  await expect(page.getByTestId("user-message")).toHaveCount(expected, { timeout: 15_000 });
}

async function expectIdleComposer(page: Page): Promise<void> {
  await expectComposerEditable(page);
  await expect(page.getByRole("button", { name: /stop|cancel/i })).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function expectNoLoadingRegressionAfterIdle(page: Page): Promise<void> {
  await expectIdleComposer(page);
  await page.waitForTimeout(1_000);
  await expectIdleComposer(page);
}

test.describe("User message UI contract", () => {
  test("dedupes mock provider user_message echoes across multi-turn sends", async ({ page }) => {
    const repo = await createTempGitRepo("user-message-contract-e2e-");
    const client = await connectTerminalClient();
    const prompts = [
      "emit 1 coalesced agent stream updates for user message contract turn one.",
      "emit 1 coalesced agent stream updates for user message contract turn two.",
      "emit 1 coalesced agent stream updates for user message contract turn three.",
    ];

    try {
      await client.openProject(repo.path);
      const agent = await client.createAgent({
        provider: "mock",
        cwd: repo.path,
        title: "User message contract e2e",
        modeId: "load-test",
        model: "ten-second-stream",
      });
      await openAgent(page, { cwd: repo.path, agentId: agent.id });

      for (let index = 0; index < prompts.length; index += 1) {
        const prompt = prompts[index]!;
        await submitMessage(page, prompt);
        await expect(page.getByText(prompt, { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("stress-update-0", { exact: true }).first()).toBeVisible({
          timeout: 15_000,
        });
        await expectUserMessageCount(page, index + 1);
        await expectNoLoadingRegressionAfterIdle(page);
      }

      await fillComposerDraft(page, "append");
      await composerLocator(page).evaluate((element) => element.blur());
      await expectUserMessageCount(page, 3);
      await expectIdleComposer(page);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
