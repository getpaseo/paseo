import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

import { launchAgent, sendMessage, type AgentHandle } from "./rewind-flow";
import { openSubagentsTrack } from "./subagents";

const NESTED_OWNERSHIP_PROMPT =
  "You are ROOT_OWNER. Use Claude Code's native Agent tool exactly once, never Paseo tools. " +
  "Name the agent direct_owner and give it this complete task: You are DIRECT_OWNER. Use " +
  "Claude Code's native Agent tool exactly once. Name that agent nested_owner and give it " +
  "this complete task: You are NESTED_OWNER. Use Bash exactly once to run `sleep 2; printf " +
  "'NESTED_BACKGROUND_SENTINEL\\n'` with run_in_background true. Wait for the background " +
  "command's completion notification, then reply exactly NESTED_DONE. Wait for nested_owner " +
  "to finish, then reply exactly DIRECT_DONE. Wait for direct_owner to finish, then reply " +
  "exactly ROOT_DONE.";

export async function launchNestedProviderSubagentOwnershipScenario(
  page: Page,
  cwd: string,
): Promise<AgentHandle> {
  const handle = await launchAgent({
    page,
    provider: "claude",
    cwd,
    mode: "full-access",
    providerConfig: { model: "claude-sonnet-5" },
  });
  await sendMessage(handle, NESTED_OWNERSHIP_PROMPT);
  await expect(
    page.getByTestId("assistant-message").filter({ hasText: "ROOT_DONE" }).last(),
  ).toBeVisible({ timeout: 120_000 });
  return handle;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function expectOnlySubagent(page: Page, label: string): Promise<Locator> {
  const rows = page.locator('[data-testid^="subagents-track-row-"]');
  await expect(rows).toHaveCount(1);
  const row = page.getByRole("button", { name: label, exact: true });
  await expect(row).toBeVisible();
  return row;
}

async function selectOnlyRootSubagent(page: Page, label: string): Promise<void> {
  await openSubagentsTrack(page);
  const row = await expectOnlySubagent(page, label);
  await row.click();
}

async function openOwnedSubagents(page: Page, ownerPanel: Locator): Promise<void> {
  await ownerPanel.getByTestId("subagents-track-header").click();
  await expect(page.getByTestId("subagents-track-header-panel")).toBeVisible();
}

export async function expectNestedProviderSubagentOwnership(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  await expect(page.getByText("Task notification", { exact: true })).toHaveCount(0);
  await selectOnlyRootSubagent(page, "direct_owner");
  const directPanel = page.getByTestId("provider-subagent-panel");
  await expect(directPanel).toBeVisible();

  await openOwnedSubagents(page, directPanel);
  const nestedRow = await expectOnlySubagent(page, "nested_owner");
  await attachScreenshot(page, testInfo, "nested-ownership-after-tree");
  await nestedRow.click();

  const nestedPanel = page.locator('[data-testid="provider-subagent-panel"]:visible');
  await expect(nestedPanel.getByText("Task notification", { exact: true })).toBeVisible();
  await expect(nestedPanel).toContainText("NESTED_BACKGROUND_SENTINEL");
  await attachScreenshot(page, testInfo, "nested-ownership-after-timeline");
}
