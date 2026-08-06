import { expect, type Page } from "@playwright/test";
import { submitMessage } from "./composer";
import type { AgentHandle } from "./rewind-flow";
import { openSubagentsTrack } from "./subagents";

export const WORKFLOW_ROW_DESCRIPTION = "Verify the workflow row lifecycle";
export const WORKFLOW_ROW_MARKER = "PASEO_WORKFLOW_ROW_OK";

export async function askClaudeToRunWorkflow(
  handle: AgentHandle,
  scriptPath: string,
): Promise<void> {
  await submitMessage(
    handle.page,
    `Use Claude Code's Workflow tool exactly once with scriptPath ${JSON.stringify(
      scriptPath,
    )} and args {}. Wait for its completion notification, then reply with exactly ${WORKFLOW_ROW_MARKER}.`,
  );
  await expect(handle.page.getByTestId("subagents-track-header")).toBeVisible({ timeout: 60_000 });
  await openSubagentsTrack(handle.page);
}

export function workflowRow(page: Page) {
  // The parent transcript's Workflow tool card has the same accessible name. The track has no
  // separate landmark, so its established row test id is the only unambiguous scope.
  return page
    .getByTestId(/^subagents-track-row-/)
    .filter({ has: page.getByText(WORKFLOW_ROW_DESCRIPTION, { exact: true }) });
}

export async function expectWorkflowRunning(page: Page): Promise<void> {
  const row = workflowRow(page);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText(WORKFLOW_ROW_DESCRIPTION);
  await expect(row).toContainText(/Workflow(?: · .+)?/);
  await expect(row.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
}

export async function expectWorkflowCompleted(page: Page): Promise<void> {
  const row = workflowRow(page);
  await expect(row.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(page.getByTestId("subagents-track-archive-finished")).toBeVisible();
  await expect(
    page.getByTestId("assistant-message").filter({ hasText: WORKFLOW_ROW_MARKER }).last(),
  ).toBeVisible({ timeout: 120_000 });
}

export async function openWorkflowTimeline(page: Page): Promise<void> {
  await workflowRow(page).click();
  const panel = page.getByTestId("provider-subagent-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("provider-subagent-pane-subtitle")).toHaveText(
    /Workflow(?: · .+)?/,
  );
  await expect(panel.getByText("Start chatting with this agent...", { exact: true })).toHaveCount(
    0,
  );
}
