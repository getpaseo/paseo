import { expect, type Page } from "@playwright/test";
import type { SeededWorkspace } from "./seed-client";
import { openCommandCenter } from "./command-center";

export interface CommandCenterAgentControlChoice {
  query: string;
  choice: string;
}

export async function chooseCommandCenterAgentControl(input: {
  page: Page;
  query: string;
  choice: string;
}): Promise<void> {
  const panel = input.page.getByTestId("command-center-panel");
  await panel.getByRole("textbox").fill(input.query);
  const choice = panel.getByRole("button", { name: input.choice });
  await expect(choice).toBeVisible({ timeout: 30_000 });
  await choice.click();
}

export async function expectCommandCenterAgentControlSelected(input: {
  page: Page;
  query: string;
  choice: string;
}): Promise<void> {
  const panel = input.page.getByTestId("command-center-panel");
  await panel.getByRole("textbox").fill(input.query);
  const choice = panel.getByRole("button", { name: input.choice });
  await expect(choice).toHaveRole("button");
  await expect(choice).toHaveAttribute("aria-pressed", "true");
}

export async function applyCommandCenterAgentControls(
  page: Page,
  choices: readonly CommandCenterAgentControlChoice[],
): Promise<void> {
  for (const choice of choices) {
    await openCommandCenter(page);
    await chooseCommandCenterAgentControl({ page, ...choice });
  }
}

export async function expectFocusedAgentControls(
  page: Page,
  choices: readonly CommandCenterAgentControlChoice[],
): Promise<void> {
  await openCommandCenter(page);
  for (const choice of choices) {
    await expectCommandCenterAgentControlSelected({ page, ...choice });
  }
}

export async function submitDraftAgent(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  await expect(composer).toBeEditable({ timeout: 30_000 });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
}

export async function waitForDraftComposer(page: Page): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeEditable({
    timeout: 30_000,
  });
}

export async function expectWorkspaceAgentConfiguration(
  workspace: Pick<SeededWorkspace, "client" | "workspaceId">,
  expected: { id?: string; provider: string; model: string | null; modeId: string | null },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const entries = (await workspace.client.fetchAgents({ scope: "active" })).entries;
        const agent = entries
          .map((entry) => entry.agent)
          .find(
            (candidate) =>
              candidate.workspaceId === workspace.workspaceId &&
              (expected.id === undefined || candidate.id === expected.id),
          );
        return agent
          ? {
              id: agent.id,
              provider: agent.provider,
              model: agent.model,
              modeId: agent.currentModeId,
            }
          : null;
      },
      { timeout: 30_000 },
    )
    .toMatchObject(expected);
}
