import type { Page } from "@playwright/test";
import { seedWorkspace, type SeedDaemonClient, type SeededWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { buildHostAgentDetailRoute } from "../../../src/utils/host-routes";

export interface MockAgentWorkspace {
  agentId: string;
  workspaceId: string;
  cwd: string;
  client: SeedDaemonClient;
  cleanup(): Promise<void>;
}

export interface MockAgentOptions {
  repoPrefix: string;
  title: string;
  repo?: Parameters<typeof seedWorkspace>[0]["repo"];
  port?: number;
  initialPrompt?: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  featureValues?: Record<string, unknown>;
}

export async function ensureWorkspaceHasContent(
  client: Pick<SeedDaemonClient, "createAgent">,
  workspaceId: string,
  cwd: string,
): Promise<void> {
  await client.createAgent({
    provider: "mock",
    cwd,
    workspaceId,
    title: "Sidebar fixture agent",
    modeId: "load-test",
    model: "e2e-fast-stream",
  });
}

export async function seedVisibleWorkspace(
  options: Parameters<typeof seedWorkspace>[0],
): Promise<SeededWorkspace> {
  const workspace = await seedWorkspace(options);
  try {
    await ensureWorkspaceHasContent(
      workspace.client,
      workspace.workspaceId,
      workspace.workspaceDirectory,
    );
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

export async function seedMockAgentWorkspace(
  options: MockAgentOptions,
): Promise<MockAgentWorkspace> {
  const workspace = await seedWorkspace({
    repoPrefix: options.repoPrefix,
    repo: options.repo,
    port: options.port,
  });
  try {
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: options.title,
      modeId: options.modeId ?? "load-test",
      model: options.model ?? "e2e-fast-stream",
      thinkingOptionId: options.thinkingOptionId,
      initialPrompt: options.initialPrompt,
      featureValues: options.featureValues,
    });
    return {
      agentId: agent.id,
      workspaceId: workspace.workspaceId,
      cwd: workspace.repoPath,
      client: workspace.client,
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

export async function seedRunningMockAgentWorkspace(
  options: MockAgentOptions,
): Promise<MockAgentWorkspace> {
  const agent = await seedMockAgentWorkspace(options);
  try {
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "running",
      15_000,
    );
    return agent;
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}

export function buildAgentRoute(
  workspaceId: string,
  agentId: string,
  serverId = getServerId(),
): string {
  return buildHostAgentDetailRoute(serverId, agentId, workspaceId);
}

export async function openAgentRoute(
  page: Page,
  input: { workspaceId: string; agentId: string },
): Promise<void> {
  await page.goto(buildAgentRoute(input.workspaceId, input.agentId), { waitUntil: "commit" });
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000, waitUntil: "commit" },
  );
}
