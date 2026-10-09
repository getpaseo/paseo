import type { Page, TestInfo } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect } from "../fixtures";
import { seedWorkspace } from "./seed-client";
import { openAgentRoute } from "./mock-agent";
import { connectDaemonClient } from "./daemon-client-loader";

interface Scenario {
  name: string;
}
type Observer = Pick<
  DaemonClient,
  "connect" | "close" | "listProviderSubagents" | "fetchProviderSubagentTimeline"
>;
type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;

async function inspectLivePanels(
  page: Page,
  testInfo: TestInfo,
  scenario: Scenario,
  workspace: Workspace,
  agentId: string,
  alphaId: string,
  nestedId: string,
) {
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agentId });
  await page.getByTestId("subagents-track-header").click();
  const rootRows = page.locator('[data-testid^="subagents-track-row-"]');
  await expect(rootRows).toHaveCount(2);
  // Let the existing popover/sheet enter animation settle for readable QA captures.
  await page.waitForTimeout(350);
  await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-running.png`) });
  await page.getByTestId(`subagents-track-row-${alphaId}`).click();
  const panel = page.getByTestId("provider-subagent-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("[NO-MODEL FIXTURE] alpha public output");
  await expect(panel).toContainText("Started tool: terminal");
  await expect(panel.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await panel.getByTestId("subagents-track-header").click();
  await page.getByTestId(`subagents-track-row-${nestedId}`).click();
  await expect(page.getByTestId("provider-subagent-panel").last()).toContainText(
    "[NO-MODEL FIXTURE] nested public output",
  );
  await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-nested.png`) });
}

async function verifyRetainedChildren(
  page: Page,
  testInfo: TestInfo,
  scenario: Scenario,
  workspace: Workspace,
  observer: Observer,
  agentId: string,
  nestedId: string,
) {
  await workspace.client.sendAgentMessage(agentId, "fixture second turn");
  await workspace.client.waitForFinish(agentId, 30_000);
  await expect
    .poll(async () =>
      (await observer.listProviderSubagents(agentId)).subagents.map((child) => child.status).sort(),
    )
    .toEqual(["canceled", "completed", "failed"]);
  await page.reload();
  await expect(page.getByTestId("provider-subagent-panel").last()).toContainText(
    "[NO-MODEL FIXTURE] nested public output",
  );
  const retained = await observer.fetchProviderSubagentTimeline(agentId, nestedId);
  expect(
    retained.rows.some(
      (row) =>
        row.item.type === "assistant_message" && row.item.text.includes("nested public output"),
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-reconnected.png`) });
}

export async function verifyHermesFixturePanels(
  page: Page,
  testInfo: TestInfo,
  scenario: Scenario,
) {
  const workspace = await seedWorkspace({ repoPrefix: "hermes-subagent-fixture-" });
  const observer = await connectDaemonClient<
    Pick<
      DaemonClient,
      "connect" | "close" | "listProviderSubagents" | "fetchProviderSubagentTimeline"
    >
  >({ clientIdPrefix: "hermes-fixture" });

  try {
    const agent = await workspace.client.createAgent({
      provider: "hermes",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "NO-MODEL FIXTURE: Hermes progress",
    });
    await workspace.client.sendAgentMessage(agent.id, "fixture first turn");
    await workspace.client.waitForFinish(agent.id, 30_000);
    await expect
      .poll(async () => (await observer.listProviderSubagents(agent.id)).subagents.length)
      .toBe(3);
    const children = (await observer.listProviderSubagents(agent.id)).subagents;
    const alpha = children.find((child) => child.description === "Count files")!;
    const nested = children.find((child) => child.description === "Inspect data")!;
    expect(nested.parentSubagentId).toBe(alpha.id);
    expect(children.every((child) => child.status === "running")).toBe(true);

    await inspectLivePanels(page, testInfo, scenario, workspace, agent.id, alpha.id, nested.id);
    await verifyRetainedChildren(
      page,
      testInfo,
      scenario,
      workspace,
      observer,
      agent.id,
      nested.id,
    );
  } finally {
    await observer.close();
    await workspace.cleanup();
  }
}

export async function verifyHermesLimits(page: Page, testInfo: TestInfo) {
  const workspace = await seedWorkspace({ repoPrefix: "hermes-limit-fixture-" });
  const observer = await connectDaemonClient<Observer>({ clientIdPrefix: "hermes-limits" });
  try {
    const agent = await workspace.client.createAgent({
      provider: "hermes",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "NO-MODEL FIXTURE: incomplete record",
    });
    await workspace.client.sendAgentMessage(agent.id, "fixture limits");
    await workspace.client.waitForFinish(agent.id, 30000);
    await expect
      .poll(async () => (await observer.listProviderSubagents(agent.id)).subagents.length)
      .toBe(64);
    const alpha = (await observer.listProviderSubagents(agent.id)).subagents.find((child) =>
      child.id.endsWith(":alpha"),
    )!;
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await expect(page.getByText(/Additional Hermes subagents omitted/).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("limits-omitted-children.png") });
    await page.getByTestId("subagents-track-header").click();
    await page.getByTestId(`subagents-track-row-${alpha.id}`).click();
    const panel = page.getByTestId("provider-subagent-panel");
    await expect(page.getByText("Count files", { exact: true }).first()).toBeVisible();
    await expect(panel).toContainText("16,384 characters");
    await expect(panel).toContainText("32 tool starts");
    const outputNotice = panel.getByText(/Public output limit reached/);
    await outputNotice.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await outputNotice.scrollIntoViewIfNeeded();
    await expect(outputNotice).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("limits-output-incomplete.png") });
    await panel.getByText(/Activity limit reached/).scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.screenshot({ path: testInfo.outputPath("limits-incomplete-record.png") });
    await page.reload();
    await expect(page.getByTestId("provider-subagent-panel")).toContainText("record is incomplete");
  } finally {
    await observer.close();
    await workspace.cleanup();
  }
}
