import { expect, type Page } from "@playwright/test";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { installDaemonWebSocketGate } from "./daemon-websocket-gate";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { waitForWorkspaceTabsVisible } from "./workspace-tabs";
import { expectReconnectingToastGone, expectReconnectingToastVisible } from "./workspace-ui";

interface SeededDirectoryAgent {
  id: string;
  title: string;
}

async function createRunningMockAgent(
  workspace: SeededWorkspace,
  title: string,
): Promise<SeededDirectoryAgent> {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
    modeId: "load-test",
    model: "five-minute-stream",
    initialPrompt: `Keep ${title} running for directory synchronization.`,
  });
  const running = await workspace.client.waitForAgentUpsert(
    agent.id,
    (snapshot) => snapshot.status === "running",
    30_000,
  );
  expect(running.status).toBe("running");
  return { id: agent.id, title };
}

async function openCommandCenter(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open command center" }).click();
}

export class DirectoryBootstrapScenario {
  private readonly workspaces: SeededWorkspace[] = [];
  private disconnectedWorkspace: SeededWorkspace | null = null;
  private disconnectedAgent: SeededDirectoryAgent | null = null;

  private constructor(
    private readonly page: Page,
    private readonly gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
  ) {}

  static async open(page: Page): Promise<DirectoryBootstrapScenario> {
    const gate = await installDaemonWebSocketGate(page);
    const scenario = new DirectoryBootstrapScenario(page, gate);
    const workspace = await scenario.seedWorkspace("directory-bootstrap-initial-");
    const agent = await createRunningMockAgent(workspace, "Initial directory agent");
    await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, workspace.workspaceId));
    await page.waitForURL(
      (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    );
    await waitForWorkspaceTabsVisible(page);
    await expect(page.getByRole("button", { name: agent.title, exact: true })).toBeVisible();
    return scenario;
  }

  async expectDirectoryStarts(expectedPerDirectory: number): Promise<void> {
    await expect
      .poll(() => this.gate.getDirectoryRequestStartCounts())
      .toEqual({
        subscribed: { agents: expectedPerDirectory, workspaces: expectedPerDirectory },
        unsubscribed: { agents: 0, workspaces: 0 },
        total: { agents: expectedPerDirectory, workspaces: expectedPerDirectory },
      });
  }

  async stayConnectedWithoutRefetchAndApplyDeltas(): Promise<void> {
    const workspace = await this.seedWorkspace("directory-bootstrap-background-");
    const agent = await createRunningMockAgent(workspace, "Background directory agent");

    const workspaceLink = this.page.getByText(workspace.projectDisplayName, { exact: true });
    await expect(workspaceLink).toHaveCount(1);
    await expect(workspaceLink).toBeVisible();
    await openCommandCenter(this.page);
    const agentLink = this.page.getByText(agent.title, { exact: true });
    await expect(agentLink).toHaveCount(1);
    await expect(agentLink).toBeVisible();
    await this.page.keyboard.press("Escape");
    await this.expectDirectoryStarts(1);
  }

  async disconnectMutateAndReconnect(): Promise<void> {
    await this.gate.drop();
    await expectReconnectingToastVisible(this.page);

    this.disconnectedWorkspace = await this.seedWorkspace("directory-bootstrap-reconnect-");
    this.disconnectedAgent = await createRunningMockAgent(
      this.disconnectedWorkspace,
      "Reconnected directory agent",
    );
    await expect(
      this.page.getByText(this.disconnectedWorkspace.projectDisplayName, { exact: true }),
    ).toHaveCount(0);
    await expect(this.page.getByText(this.disconnectedAgent.title, { exact: true })).toHaveCount(0);

    this.gate.restore();
    await expectReconnectingToastGone(this.page);
    await this.expectDirectoryStarts(2);
  }

  async expectVisibleReconciliationAndNavigateAgent(): Promise<void> {
    const workspace = this.requireDisconnectedWorkspace();
    const agent = this.requireDisconnectedAgent();
    const workspaceLink = this.page.getByText(workspace.projectDisplayName, { exact: true });
    await expect(workspaceLink).toHaveCount(1);
    await expect(workspaceLink).toBeVisible();
    await openCommandCenter(this.page);
    const agentLink = this.page.getByText(agent.title, { exact: true });
    await expect(agentLink).toHaveCount(1);
    await expect(agentLink).toBeVisible();
    await agentLink.click();
    await expect(this.page).toHaveURL(
      new RegExp(
        `/workspace/${workspace.workspaceId}/agent/${agent.id}|/workspace/${workspace.workspaceId}`,
      ),
    );
    await expect(this.page.getByRole("button", { name: agent.title, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const pings = this.gate.getClientRequestCount("ping");
    await expect
      .poll(() => this.gate.getClientRequestCount("ping"), { timeout: 30_000 })
      .toBeGreaterThan(pings);
    await this.expectDirectoryStarts(2);
  }

  async cleanup(): Promise<void> {
    this.gate.restore();
    await Promise.all(this.workspaces.map((workspace) => workspace.cleanup()));
  }

  private async seedWorkspace(prefix: string): Promise<SeededWorkspace> {
    const workspace = await seedWorkspace({ repoPrefix: prefix });
    this.workspaces.push(workspace);
    return workspace;
  }

  private requireDisconnectedWorkspace(): SeededWorkspace {
    if (!this.disconnectedWorkspace) throw new Error("Reconnect workspace was not seeded.");
    return this.disconnectedWorkspace;
  }

  private requireDisconnectedAgent(): SeededDirectoryAgent {
    if (!this.disconnectedAgent) throw new Error("Reconnect agent was not seeded.");
    return this.disconnectedAgent;
  }
}
