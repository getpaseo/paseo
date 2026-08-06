import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { expect, type Page } from "@playwright/test";
import type { SeededWorkspace } from "./seed-client";

export interface SeededSubagentPair {
  parent: {
    id: string;
    title: string;
  };
  child: {
    id: string;
    title: string;
  };
  workspaceId: string;
}

export interface SeededCrossWorkspaceSubagentPair {
  parent: {
    id: string;
    workspaceId: string;
  };
  child: {
    id: string;
    workspaceId: string;
  };
}

export async function seedParentWithSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId">,
  input: { parentTitle: string; childTitle: string },
): Promise<SeededSubagentPair> {
  const parent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.parentTitle,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const child = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.childTitle,
    modeId: "load-test",
    model: "ten-second-stream",
    labels: {
      [PARENT_AGENT_ID_LABEL]: parent.id,
    },
  });

  return {
    parent: {
      id: parent.id,
      title: input.parentTitle,
    },
    child: {
      id: child.id,
      title: input.childTitle,
    },
    workspaceId: workspace.workspaceId,
  };
}

export async function seedParentWithCrossWorkspaceSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId" | "projectId">,
  input: { parentTitle: string; childTitle: string },
): Promise<SeededCrossWorkspaceSubagentPair> {
  const parent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.parentTitle,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const createdWorkspace = await workspace.client.createWorkspace({
    source: {
      kind: "directory",
      path: workspace.repoPath,
      projectId: workspace.projectId,
    },
    title: "Subagent workspace",
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? "Failed to create subagent workspace");
  }

  const child = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: createdWorkspace.workspace.id,
    title: input.childTitle,
    modeId: "load-test",
    model: "five-minute-stream",
    initialPrompt: "stay running",
    labels: {
      [PARENT_AGENT_ID_LABEL]: parent.id,
    },
  });
  await workspace.client.waitForAgentUpsert(
    child.id,
    (snapshot) => snapshot.status === "running",
    15_000,
  );

  return {
    parent: {
      id: parent.id,
      workspaceId: workspace.workspaceId,
    },
    child: {
      id: child.id,
      workspaceId: createdWorkspace.workspace.id,
    },
  };
}

export async function openSubagentsTrack(page: Page): Promise<void> {
  await page.getByTestId("subagents-track-header").click();
}

export async function expectSubagentRowVisible(page: Page, childId: string): Promise<void> {
  await expect(page.getByTestId(`subagents-track-row-${childId}`)).toBeVisible({
    timeout: 30_000,
  });
}

export async function expectSubagentRowGone(page: Page, childId: string): Promise<void> {
  await expect(page.getByTestId(`subagents-track-row-${childId}`)).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function detachSubagentFromTrack(page: Page, childId: string): Promise<void> {
  const row = page.getByTestId(`subagents-track-row-${childId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Detach subagent?");
    void dialog.accept();
  });

  const detachButton = page.getByTestId(`subagents-track-detach-${childId}`);
  await expect(detachButton).toBeVisible({ timeout: 30_000 });
  await detachButton.click();
}
