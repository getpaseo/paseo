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
  prompt: string;
  providerConfig?: Parameters<typeof launchAgent>[0]["providerConfig"];
}

const cases: ProviderSubagentCase[] = [
  {
    provider: "claude",
    sentinel: "CLAUDE_CHILD_SENTINEL",
    providerConfig: { model: "opus" },
    prompt:
      "Use the Task tool exactly once with the Explore subagent. Ask it to reply with exactly CLAUDE_CHILD_SENTINEL and do nothing else. Wait for it, then reply ROOT_DONE.",
  },
  {
    provider: "codex",
    sentinel: "CODEX_CHILD_SENTINEL",
    providerConfig: { extra: { codex: { features: { multi_agent_v2: true } } } },
    prompt:
      'Use collaboration.spawn_agent exactly once with task_name "sentinel_child" and fork_turns "none". Ask it to reply with exactly CODEX_CHILD_SENTINEL and do nothing else. Wait for it with collaboration.wait_agent, then reply ROOT_DONE.',
  },
  {
    provider: "opencode",
    sentinel: "OPENCODE_CHILD_SENTINEL",
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
        await rows.first().click();

        const panel = page.getByTestId("provider-subagent-panel");
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect(
          panel.getByTestId("assistant-message").filter({ hasText: scenario.sentinel }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          panel.getByText("Start chatting with this agent...", { exact: true }),
        ).toHaveCount(0);
      } finally {
        await cleanupRewindFlow({ handle, cwd });
      }
    });
  }
});
