import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import {
  cleanupRewindFlow,
  launchAgent,
  sendMessage,
  type AgentHandle,
  type RewindFlowProvider,
} from "../support/helpers/rewind-flow";
import { openSubagentsTrack } from "../support/helpers/subagents";

interface ProviderSubagentCase {
  provider: RewindFlowProvider;
  sentinel: string;
  expectedName: string;
  expectedSubtitle?: RegExp;
  expectsUserMessage?: boolean;
  prompt: string;
  providerConfig?: Parameters<typeof launchAgent>[0]["providerConfig"];
}

const cases: ProviderSubagentCase[] = [
  {
    provider: "claude",
    sentinel: "CLAUDE_CHILD_SENTINEL",
    expectedName: "sentinel_child",
    providerConfig: { model: "claude-sonnet-5" },
    prompt:
      'Use Claude Code\'s native Task tool exactly once. Set its subagent_type input to "Explore" and its name input to "sentinel_child". Ask it to reply with exactly CLAUDE_CHILD_SENTINEL and do nothing else. Wait for it, then reply ROOT_DONE. Do not use Paseo tools.',
  },
  {
    provider: "codex",
    sentinel: "CODEX_CHILD_SENTINEL",
    expectedName: "Sentinel child",
    providerConfig: { providerOptions: { features: { multi_agent_v2: true } } },
    prompt:
      'Use the native collaboration.spawn_agent tool exactly once with task_name "sentinel_child" and fork_turns "none". Ask it to reply with exactly CODEX_CHILD_SENTINEL and do nothing else. Wait for it with collaboration.wait_agent, then reply ROOT_DONE. Do not use Paseo tools.',
  },
  {
    provider: "opencode",
    sentinel: "OPENCODE_CHILD_SENTINEL",
    expectedName: "Verify OpenCode descriptor",
    expectedSubtitle: /explore · gpt-5\.4(?: · [^\n·]+)? · \d+(?:\.\d+)?k? tokens/i,
    providerConfig: { model: "openai/gpt-5.4" },
    prompt:
      'Use the task tool exactly once with description "Verify OpenCode descriptor" and the explore subagent. Ask it to reply with exactly OPENCODE_CHILD_SENTINEL and do nothing else. Wait for it, then reply ROOT_DONE.',
  },
];

test.describe("real provider subagent timelines", () => {
  test.setTimeout(600_000);

  for (const scenario of cases) {
    test(`${scenario.provider} exposes native child output from the subagent track`, async ({
      page,
    }, testInfo) => {
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
        if (scenario.expectedSubtitle) {
          await expect(rows.first()).toContainText(scenario.expectedSubtitle);
          const desktopTrackScreenshot = testInfo.outputPath(
            `${scenario.provider}-subagent-track-desktop.png`,
          );
          await page.screenshot({ path: desktopTrackScreenshot });
          await testInfo.attach(`${scenario.provider} subagent track desktop`, {
            path: desktopTrackScreenshot,
            contentType: "image/png",
          });
        }
        await rows.first().click();

        // Choosing a row is a menu selection: the track panel goes with it.
        await expect(page.getByTestId("subagents-track-header-panel")).toBeHidden();

        const panel = page.getByTestId("provider-subagent-panel");
        await expect(panel).toBeVisible({ timeout: 30_000 });
        if (scenario.expectedSubtitle) {
          await expect(page.getByTestId("provider-subagent-pane-subtitle")).toHaveText(
            scenario.expectedSubtitle,
          );
          const desktopScreenshot = testInfo.outputPath(
            `${scenario.provider}-subagent-desktop.png`,
          );
          await page.screenshot({ path: desktopScreenshot });
          await testInfo.attach(`${scenario.provider} subagent desktop`, {
            path: desktopScreenshot,
            contentType: "image/png",
          });
          await page.setViewportSize({ width: 494, height: 862 });
          await expect(page.getByTestId("provider-subagent-pane-subtitle")).toHaveText(
            scenario.expectedSubtitle,
          );
          const compactScreenshot = testInfo.outputPath(
            `${scenario.provider}-subagent-compact.png`,
          );
          await page.screenshot({ path: compactScreenshot });
          await testInfo.attach(`${scenario.provider} subagent compact`, {
            path: compactScreenshot,
            contentType: "image/png",
          });
          await page.setViewportSize({ width: 1280, height: 720 });
        }
        if (scenario.expectsUserMessage !== false) {
          await expect(
            panel.getByTestId("user-message").filter({ hasText: scenario.sentinel }),
          ).toBeVisible({ timeout: 30_000 });
        }
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
        // Opening the subagent's tab closed the panel with the parent's pane.
        await openSubagentsTrack(page);
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

test.describe("real Claude nested subagent ownership", () => {
  test.setTimeout(600_000);

  test("keeps a grandchild and its background notification with their direct owners", async ({
    page,
  }, testInfo) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-claude-nested-ui-")));
    let handle: AgentHandle | undefined;
    const prompt =
      "You are ROOT_OWNER. Use Claude Code's native Agent tool exactly once, never Paseo tools. " +
      "Name the agent direct_owner and give it this complete task: You are DIRECT_OWNER. Use " +
      "Claude Code's native Agent tool exactly once. Name that agent nested_owner and give it " +
      "this complete task: You are NESTED_OWNER. Use Bash exactly once to run `sleep 2; printf " +
      "'NESTED_BACKGROUND_SENTINEL\\n'` with run_in_background true. Wait for the background " +
      "command's completion notification, then reply exactly NESTED_DONE. Wait for nested_owner " +
      "to finish, then reply exactly DIRECT_DONE. Wait for direct_owner to finish, then reply " +
      "exactly ROOT_DONE.";

    try {
      handle = await launchAgent({
        page,
        provider: "claude",
        cwd,
        mode: "full-access",
        providerConfig: { model: "claude-sonnet-5" },
      });
      await sendMessage(handle, prompt);
      await expect(
        page.getByTestId("assistant-message").filter({ hasText: "ROOT_DONE" }).last(),
      ).toBeVisible({ timeout: 120_000 });

      await expect(page.getByText("Task notification", { exact: true })).toHaveCount(0);
      await openSubagentsTrack(page);
      const rootRows = page.locator('[data-testid^="subagents-track-row-"]');
      await expect(rootRows).toHaveCount(1);
      await expect(rootRows.first()).toContainText("direct_owner");
      await rootRows.first().click();

      const directPanel = page.getByTestId("provider-subagent-panel");
      await expect(directPanel).toBeVisible();
      await directPanel.getByTestId("subagents-track-header").click();
      const nestedRows = page.locator('[data-testid^="subagents-track-row-"]');
      await expect(nestedRows).toHaveCount(1);
      await expect(nestedRows.first()).toContainText("nested_owner");

      const hierarchyScreenshot = testInfo.outputPath("claude-nested-ownership-after-tree.png");
      await page.screenshot({ path: hierarchyScreenshot });
      await testInfo.attach("Claude nested ownership after: tree", {
        path: hierarchyScreenshot,
        contentType: "image/png",
      });

      await nestedRows.first().click();
      const nestedPanel = page.locator('[data-testid="provider-subagent-panel"]:visible');
      await expect(nestedPanel.getByText("Task notification", { exact: true })).toBeVisible();
      await expect(nestedPanel).toContainText("NESTED_BACKGROUND_SENTINEL");

      const timelineScreenshot = testInfo.outputPath("claude-nested-ownership-after-timeline.png");
      await page.screenshot({ path: timelineScreenshot });
      await testInfo.attach("Claude nested ownership after: timeline", {
        path: timelineScreenshot,
        contentType: "image/png",
      });
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
