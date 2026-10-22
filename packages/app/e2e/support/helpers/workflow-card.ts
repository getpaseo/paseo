import { expect, type Page, type TestInfo } from "@playwright/test";
import { seedMockAgentWorkspace, openAgentRoute } from "./mock-agent";

export async function openSyntheticWorkflow(input: {
  page: Page;
  nested: boolean;
  count: number;
  width: number;
}) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "workflow-card-",
    title: "Workflow audit",
    initialPrompt: `Emit synthetic workflow: ${input.nested ? "nested" : "root"} ${input.count}`,
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await input.page.setViewportSize({ width: input.width, height: 900 });
    await openAgentRoute(input.page, agent);
    return agent;
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}

export async function openWorkflowOwner(page: Page) {
  await page.getByTestId("subagents-track-header").click();
  await page.getByTestId("subagents-track-row-mock-owner").click();
  await expect(page.getByTestId("provider-subagent-panel").filter({ visible: true })).toBeVisible();
}

export async function expectWorkflowProgressAndNavigation(input: {
  page: Page;
  count: number;
  testInfo: TestInfo;
  name: string;
}) {
  const card = input.page.getByRole("button", {
    name: "View workflow: Accessibility audit",
    exact: true,
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`${input.count} agents`);
  await card.scrollIntoViewIfNeeded();
  const grid = card.getByTestId("workflow-agents-grid");
  const perState = input.count / 6;
  await expect(grid).toHaveAttribute(
    "aria-label",
    `${perState} of ${input.count} agents done, ${perState} running, ${perState} stalled, ${perState} stopped, ${perState} failed`,
  );
  await expect
    .poll(() =>
      grid.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.children].every((child) => {
          const cell = child.getBoundingClientRect();
          return cell.bottom <= bounds.bottom + 1 && cell.right <= bounds.right + 1;
        });
      }),
    )
    .toBe(true);
  for (const colorScheme of ["light", "dark"] as const) {
    await input.page.emulateMedia({ colorScheme });
    await input.page.screenshot({
      path: input.testInfo.outputPath(`${input.name}-${colorScheme}.png`),
    });
  }
  await card.click();
  await expect(
    input.page.getByTestId("provider-subagent-panel").filter({ hasText: "Workflow audit output" }),
  ).toBeVisible();
  await input.page.screenshot({ path: input.testInfo.outputPath(`${input.name}-opened.png`) });
}
