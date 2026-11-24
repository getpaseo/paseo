import { expect, type Page } from "@playwright/test";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { SeededWorkspace } from "./seed-client";

/**
 * Starts a background agent the way a plugin helper does: in the workspace, under a parent,
 * streaming for about ten seconds. Resolves once the daemon reports it running.
 */
export async function startBackgroundAgent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId">,
  input: { parentId: string; title: string },
): Promise<{ id: string }> {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.title,
    modeId: "load-test",
    model: "ten-second-stream",
    initialPrompt: "classify the last turn",
    labels: { [PARENT_AGENT_ID_LABEL]: input.parentId },
    background: true,
  });
  await workspace.client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running");
  return { id: agent.id };
}

/** Waits for the agent's turn to end and archives it, as the plugin does with a helper's reply. */
export async function finishAndArchiveAgent(
  workspace: Pick<SeededWorkspace, "client">,
  agentId: string,
): Promise<void> {
  const finished = await workspace.client.waitForFinish(agentId, 60_000);
  expect(finished.status).toBe("idle");
  await workspace.client.archiveAgent(agentId);
}

export async function expectWorkspaceShownIdle(page: Page, workspaceName: string): Promise<void> {
  const row = page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(workspaceName)}(?:,|$)`),
  });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("workspace-status-indicator-running")).toHaveCount(0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
