import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./fixtures";
import {
  cleanupRewindFlow,
  launchAgent,
  sendMessage,
  type AgentHandle,
  type RewindFlowProvider,
} from "./helpers/rewind-flow";
import { openSubagentsTrack } from "./helpers/subagents";

interface ProviderSubagentCase {
  provider: RewindFlowProvider;
  sentinel: string;
  expectedName: string;
  prompt: string;
  providerConfig?: Parameters<typeof launchAgent>[0]["providerConfig"];
}

const cases: ProviderSubagentCase[] = [
  {
    provider: "claude",
    sentinel: "CLAUDE_CHILD_SENTINEL",
    expectedName: "sentinel_child",
    providerConfig: { model: "opus" },
    prompt:
      'Use Claude Code\'s native Task tool exactly once. Set its subagent_type input to "Explore" and its name input to "sentinel_child". Ask it to reply with exactly CLAUDE_CHILD_SENTINEL and do nothing else. Wait for it, then reply ROOT_DONE. Do not use Paseo tools.',
  },
  {
    provider: "codex",
    sentinel: "CODEX_CHILD_SENTINEL",
    expectedName: "Sentinel child",
    providerConfig: { extra: { codex: { features: { multi_agent_v2: true } } } },
    prompt:
      'Use the native collaboration.spawn_agent tool exactly once with task_name "sentinel_child" and fork_turns "none". Ask it to reply with exactly CODEX_CHILD_SENTINEL and do nothing else. Wait for it with collaboration.wait_agent, then reply ROOT_DONE. Do not use Paseo tools.',
  },
  {
    provider: "opencode",
    sentinel: "OPENCODE_CHILD_SENTINEL",
    expectedName: "Explore",
    prompt:
      "Use the task tool exactly once with the explore subagent. Ask it to reply with exactly OPENCODE_CHILD_SENTINEL and do nothing else. Wait for it, then reply ROOT_DONE.",
  },
];

test.describe("real provider subagent timelines", () => {
  test.setTimeout(600_000);

  for (const scenario of cases) {
    test(`${scenario.provider} exposes native child output from the subagent track`, async ({
      page,
    }) => {
      const cwd = realpathSync(
        mkdtempSync(path.join(tmpdir(), `paseo-provider-subagent-${scenario.provider}-`)),
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
        await openSubagentsTrack(page);

        const rows = page.locator('[data-testid^="subagents-track-row-"]');
        await expect(rows).toHaveCount(1, { timeout: 60_000 });
        await expect(rows.first()).toContainText(scenario.expectedName);
        await rows.first().click();

        const panel = page.getByTestId("provider-subagent-panel");
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect(
          panel.getByTestId("assistant-message").filter({ hasText: scenario.sentinel }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          panel.getByText("Start chatting with this agent...", { exact: true }),
        ).toHaveCount(0);

        await page.getByTestId(`workspace-tab-agent_${handle.agentId}`).first().click();
        await expect(
          page.getByTestId("assistant-message").filter({ hasText: "ROOT_DONE" }).last(),
        ).toBeVisible({ timeout: 60_000 });
        const archiveFinished = page.getByTestId("subagents-track-archive-finished");
        await expect(archiveFinished).toBeVisible({ timeout: 30_000 });
        await archiveFinished.click();
        await expect(rows).toHaveCount(0, { timeout: 30_000 });
      } finally {
        await cleanupRewindFlow({ handle, cwd });
      }
    });
  }
});
